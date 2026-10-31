// TelaShare – cliente. Arquitetura: malha WebRTC (1 conexão por par de usuários).
// Cada conexão leva: o microfone (voz) e, quando alguém transmite, a tela (+ áudio do sistema).
// A renegociação segue o padrão "perfect negotiation" (a MDN o descreve), evitando colisões de ofertas.
const $ = (id) => document.getElementById(id);
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // em produção, adicione um servidor TURN

const state = {
  ws: null, meuId: null, meuNome: '',
  peers: new Map(),       // id -> { name, pc, polite, making, ignore, sharing, screenStreamId, audioEl, screenSenders }
  micStream: null, micLigado: true,
  telaStream: null,       // stream da minha transmissão (se eu estiver transmitindo)
  mostrando: null,        // id de quem está sendo exibido no vídeo
};

// ---------- Utilidades de interface ----------
function toast(msg, cor = 'bg-slate-700') {
  const el = document.createElement('div');
  el.className = `${cor} text-sm px-4 py-2 rounded-lg shadow-lg`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
const enviar = (msg) => state.ws.readyState === 1 && state.ws.send(JSON.stringify(msg));
const sinalizar = (to, data) => enviar({ type: 'signal', to, data });
const transmitindoAgora = () => !!state.telaStream;
const alguemTransmite = () => transmitindoAgora() || [...state.peers.values()].find((p) => p.sharing);

// ---------- Entrada na sala ----------
$('btnEntrar').onclick = async () => {
  const nome = $('nome').value.trim();
  if (!nome) return toast('Digite um nome de usuário para entrar.', 'bg-red-700');
  state.meuNome = nome;
  // Microfone (opcional: se negado, o usuário entra apenas como ouvinte)
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch { toast('Microfone indisponível ou negado. Você entrará sem voz.', 'bg-amber-700'); atualizarMic(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.onopen = () => enviar({ type: 'join', room: $('sala').value, name: nome });
  state.ws.onmessage = (e) => tratarMensagem(JSON.parse(e.data));
  state.ws.onclose = () => toast('Conexão com o servidor encerrada.', 'bg-red-700');
  $('salaAtual').textContent = $('sala').value.trim().toLowerCase() || 'geral';
  $('entrada').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderizar();
};
$('nome').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnEntrar').click());

// ---------- Mensagens do servidor ----------
async function tratarMensagem(m) {
  switch (m.type) {
    case 'welcome':
      state.meuId = m.id;
      for (const p of m.peers) {
        const peer = criarPeer(p.id, p.name);
        peer.sharing = p.sharing; peer.screenStreamId = p.streamId;
      }
      renderizar();
      break;
    case 'peer-joined': criarPeer(m.id, m.name); toast(`${m.name} entrou na sala.`); renderizar(); break;
    case 'peer-left': {
      const p = state.peers.get(m.id); if (!p) break;
      p.pc.close(); p.audioEl.srcObject = null; state.peers.delete(m.id);
      toast(`${p.name} saiu da sala.`);
      if (state.mostrando === m.id) mostrarVideo(null);
      renderizar(); break;
    }
    case 'signal': await tratarSinal(m.from, m.data); break;
    case 'sharing': {
      const p = state.peers.get(m.id); if (!p) break;
      p.sharing = m.sharing; p.screenStreamId = m.streamId;
      if (m.sharing) toast(`${p.name} começou a transmitir.`, 'bg-indigo-700');
      else { toast(`${p.name} parou a transmissão.`); if (state.mostrando === m.id) mostrarVideo(null); }
      renderizar(); break;
    }
    case 'share-denied': pararTransmissao(false); toast(`${m.name} já está transmitindo. Aguarde o término.`, 'bg-red-700'); break;
    case 'chat': adicionarMensagem(m.name, m.text, false); break;
  }
}

// ---------- WebRTC ----------
function criarPeer(id, name) {
  if (state.peers.has(id)) return state.peers.get(id);
  const pc = new RTCPeerConnection(ICE);
  const audioEl = new Audio(); audioEl.autoplay = true; // voz do participante
  const p = { name, pc, polite: state.meuId ? state.meuId > id : true, making: false, ignore: false, sharing: false, screenStreamId: null, audioEl, screenSenders: [] };
  state.peers.set(id, p);

  // Adiciona minhas mídias locais à nova conexão
  state.micStream?.getTracks().forEach((t) => pc.addTrack(t, state.micStream));
  if (state.telaStream) adicionarTela(p);

  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); sinalizar(id, { description: pc.localDescription }); }
    catch (e) { console.error(e); } finally { p.making = false; }
  };
  pc.onicecandidate = ({ candidate }) => candidate && sinalizar(id, { candidate });
  pc.ontrack = ({ track, streams: [stream] }) => {
    if (!stream) return;
    // Tela (vídeo + áudio do sistema) vem num stream; a voz do microfone vem em outro
    if (track.kind === 'video' || stream.id === p.screenStreamId) { p.telaStream = stream; mostrarVideo(id, stream); }
    else { p.audioEl.srcObject = stream; p.audioEl.play().catch(() => {}); }
  };
  return p;
}

async function tratarSinal(from, data) {
  const p = state.peers.get(from) || criarPeer(from, 'Participante');
  const { pc } = p;
  try {
    if (data.description) {
      const colisao = data.description.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && colisao;
      if (p.ignore) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') { await pc.setLocalDescription(); sinalizar(from, { description: pc.localDescription }); }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; }
    }
  } catch (e) { console.error('Erro de sinalização', e); }
}

// ---------- Transmissão de tela ----------
function adicionarTela(p) {
  state.telaStream.getTracks().forEach((t) => p.screenSenders.push(p.pc.addTrack(t, state.telaStream)));
}

async function iniciarTransmissao() {
  if (alguemTransmite()) return toast('Já existe uma transmissão em andamento.', 'bg-red-700');
  try {
    // displaySurface é apenas uma sugestão; o usuário escolhe no seletor do navegador
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: $('tipoTela').value, frameRate: { ideal: 30 } },
      audio: $('chkAudio').checked ? { echoCancellation: false, noiseSuppression: false } : false,
      systemAudio: 'include',
    });
    state.telaStream = stream;
    if ($('chkAudio').checked && stream.getAudioTracks().length === 0)
      toast('O áudio não foi capturado. No Chrome, marque “Compartilhar áudio” no seletor (melhor em Tela inteira ou Aba).', 'bg-amber-700');
    // Aviso ao servidor ANTES de enviar as trilhas, para os viewers saberem qual stream é a tela
    enviar({ type: 'sharing', sharing: true, streamId: stream.id });
    state.peers.forEach(adicionarTela);
    stream.getVideoTracks()[0].onended = () => pararTransmissao(true); // botão nativo "Parar compartilhamento"
    mostrarVideo(state.meuId, stream, true);
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Não foi possível iniciar a transmissão.', 'bg-red-700');
  }
  renderizar();
}

function pararTransmissao(avisar = true) {
  if (!state.telaStream) return;
  state.telaStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  state.peers.forEach((p) => { p.screenSenders.forEach((s) => { try { p.pc.removeTrack(s); } catch {} }); p.screenSenders = []; });
  state.telaStream = null;
  if (avisar) enviar({ type: 'sharing', sharing: false });
  if (state.mostrando === state.meuId) mostrarVideo(null);
  renderizar();
}

const alternarTransmissao = () => (transmitindoAgora() ? pararTransmissao(true) : iniciarTransmissao());

// ---------- Vídeo ----------
function mostrarVideo(id, stream, local = false) {
  const v = $('video');
  state.mostrando = id;
  v.srcObject = stream || null;
  v.muted = local; // evita eco do próprio áudio de sistema
  if (stream) v.play().catch(() => {});
  $('vazio').classList.toggle('hidden', !!stream);
  const rot = $('rotulo');
  rot.classList.toggle('hidden', !stream);
  rot.textContent = stream ? `🔴 ${local ? 'Você está transmitindo' : (state.peers.get(id)?.name || '') + ' está transmitindo'}` : '';
}

// ---------- Microfone ----------
function atualizarMic() {
  const txt = !state.micStream ? '🎤 Sem microfone' : state.micLigado ? '🎤 Microfone ligado' : '🔇 Microfone mudo';
  $('btnMic').textContent = txt; $('fsMic').textContent = txt;
  [$('btnMic'), $('fsMic')].forEach((b) => b.classList.toggle('text-red-400', !!state.micStream && !state.micLigado));
}
function alternarMic() {
  if (!state.micStream) return toast('Nenhum microfone disponível.', 'bg-amber-700');
  state.micLigado = !state.micLigado;
  state.micStream.getAudioTracks().forEach((t) => (t.enabled = state.micLigado));
  atualizarMic();
}

// ---------- Participantes e botões ----------
function renderizar() {
  const ul = $('listaParticipantes'); ul.innerHTML = '';
  const todos = [{ id: state.meuId, name: state.meuNome + ' (você)', sharing: transmitindoAgora() },
    ...[...state.peers].map(([id, p]) => ({ id, name: p.name, sharing: p.sharing }))];
  todos.forEach((u) => {
    const li = document.createElement('li');
    li.className = `flex items-center justify-between px-2 py-1.5 rounded-lg ${u.sharing ? 'bg-red-600/20 ring-1 ring-red-500' : 'bg-slate-800'}`;
    const nome = document.createElement('span'); nome.textContent = u.name; nome.className = 'truncate';
    li.appendChild(nome);
    if (u.sharing) { const b = document.createElement('span'); b.textContent = '🔴 Transmitindo'; b.className = 'text-xs font-semibold text-red-400 shrink-0 ml-2'; li.appendChild(b); }
    ul.appendChild(li);
  });
  $('contador').textContent = todos.length;
  const txt = transmitindoAgora() ? 'Parar transmissão' : 'Iniciar transmissão';
  [$('btnTransmitir'), $('fsTransmitir')].forEach((b) => {
    b.textContent = txt;
    b.classList.toggle('bg-red-600', transmitindoAgora()); b.classList.toggle('bg-indigo-600', !transmitindoAgora());
  });
  atualizarMic();
}

$('btnMic').onclick = $('fsMic').onclick = alternarMic;
$('btnTransmitir').onclick = $('fsTransmitir').onclick = alternarTransmissao;

// ---------- Tela cheia com barra flutuante ----------
const palco = $('palco'), barra = $('barraFlutuante');
let timerBarra;
$('btnTelaCheia').onclick = () => palco.requestFullscreen?.();
$('fsSair').onclick = () => document.exitFullscreen();
function mostrarBarra() {
  barra.classList.remove('opacity-0'); palco.style.cursor = 'default';
  clearTimeout(timerBarra);
  timerBarra = setTimeout(() => { barra.classList.add('opacity-0'); palco.style.cursor = 'none'; }, 2500);
}
palco.addEventListener('mousemove', () => document.fullscreenElement && mostrarBarra());
document.addEventListener('fullscreenchange', () => {
  const cheia = document.fullscreenElement === palco;
  barra.classList.toggle('hidden', !cheia); barra.classList.toggle('flex', cheia);
  $('btnTelaCheia').classList.toggle('hidden', cheia);
  clearTimeout(timerBarra); palco.style.cursor = 'default';
  if (cheia) mostrarBarra();
});

// ---------- Chat de texto ----------
function adicionarMensagem(autor, texto, minha) {
  const d = document.createElement('div');
  d.className = `rounded-lg px-3 py-1.5 ${minha ? 'bg-indigo-600/30 ml-6' : 'bg-slate-800 mr-6'}`;
  const a = document.createElement('div'); a.className = 'text-xs text-slate-400'; a.textContent = minha ? 'Você' : autor;
  const t = document.createElement('div'); t.className = 'break-words'; t.textContent = texto; // textContent evita injeção de HTML
  d.append(a, t); $('mensagens').appendChild(d);
  $('mensagens').scrollTop = $('mensagens').scrollHeight;
}
function enviarChat() {
  const texto = $('textoChat').value.trim(); if (!texto) return;
  enviar({ type: 'chat', text: texto }); adicionarMensagem('', texto, true); $('textoChat').value = '';
}
$('btnEnviar').onclick = enviarChat;
$('textoChat').addEventListener('keydown', (e) => e.key === 'Enter' && enviarChat());
