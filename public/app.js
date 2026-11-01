// TelaShare v2 – cliente. Malha WebRTC (1 conexão por par), com renegociação "perfect negotiation".
// Novidades: áudio por tipo de fonte, volume local por usuário (até 200%), horário no chat,
// avisos de entrada/saída e troca de nome em tempo real.
const $ = (id) => document.getElementById(id);
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // em produção, adicione um servidor TURN

const state = {
  ws: null, meuId: null, meuNome: '', ctx: null,
  peers: new Map(),   // id -> { name, pc, polite, making, ignore, sharing, screenStreamId, gain, volume, holders, screenSources, screenSenders }
  micStream: null, micLigado: true, telaStream: null, mostrando: null,
};

// ---------- Utilidades ----------
const hora = (t = Date.now()) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const enviar = (msg) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg));
const sinalizar = (to, data) => enviar({ type: 'signal', to, data });
const transmitindoAgora = () => !!state.telaStream;
const alguemTransmite = () => transmitindoAgora() || [...state.peers.values()].some((p) => p.sharing);
function toast(msg, cor = 'bg-slate-700') {
  const el = document.createElement('div');
  el.className = `${cor} text-sm px-4 py-2 rounded-lg shadow-lg max-w-xs`;
  el.textContent = msg; $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ---------- Entrada ----------
$('btnEntrar').onclick = async () => {
  const nome = $('nome').value.trim();
  if (!nome) return toast('Digite um nome de usuário para entrar.', 'bg-red-700');
  state.meuNome = nome;
  // O AudioContext precisa ser criado/retomado após um clique (política de autoplay dos navegadores)
  state.ctx = new (window.AudioContext || window.webkitAudioContext)(); state.ctx.resume();
  try { state.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
  catch { toast('Microfone indisponível ou negado. Você entrará sem voz.', 'bg-amber-700'); }
  state.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  state.ws.onopen = () => enviar({ type: 'join', room: $('sala').value, name: nome });
  state.ws.onmessage = (e) => tratarMensagem(JSON.parse(e.data));
  state.ws.onclose = () => toast('Conexão com o servidor encerrada.', 'bg-red-700');
  $('salaAtual').textContent = $('sala').value.trim().toLowerCase() || 'geral';
  $('entrada').classList.add('hidden'); $('app').classList.remove('hidden');
  renderizar();
};
$('nome').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnEntrar').click());

// ---------- Mensagens do servidor ----------
async function tratarMensagem(m) {
  switch (m.type) {
    case 'welcome':
      state.meuId = m.id;
      for (const p of m.peers) { const peer = criarPeer(p.id, p.name); peer.sharing = p.sharing; peer.screenStreamId = p.streamId; }
      adicionarSistema('Você entrou na sala');
      renderizar(); break;
    case 'peer-joined': criarPeer(m.id, m.name); adicionarSistema(`${m.name} entrou na sala`); renderizar(); break;
    case 'peer-left': {
      const p = state.peers.get(m.id); if (!p) break;
      p.pc.close(); p.gain.disconnect(); p.holders.forEach((el) => (el.srcObject = null)); state.peers.delete(m.id);
      adicionarSistema(`${p.name} saiu da sala`);
      if (state.mostrando === m.id) mostrarVideo(null);
      renderizar(); break;
    }
    case 'signal': await tratarSinal(m.from, m.data); break;
    case 'sharing': {
      const p = state.peers.get(m.id); if (!p) break;
      p.sharing = m.sharing; p.screenStreamId = m.streamId;
      if (m.sharing) toast(`${p.name} começou a transmitir.`, 'bg-indigo-700');
      else { p.screenSources.forEach((s) => s.disconnect()); p.screenSources = []; if (state.mostrando === m.id) mostrarVideo(null); }
      renderizar(); break;
    }
    case 'renamed': { // outro usuário trocou de nome
      const p = state.peers.get(m.id); if (p) p.name = m.name;
      adicionarSistema(`${m.oldName} agora se chama ${m.name}`);
      if (state.mostrando === m.id) mostrarVideo(m.id, $('video').srcObject); // atualiza o rótulo
      renderizar(); break;
    }
    case 'rename-ok': state.meuNome = m.name; adicionarSistema(`Você agora se chama ${m.name}`); renderizar(); break;
    case 'share-denied': pararTransmissao(false); toast(`${m.name} já está transmitindo. Aguarde o término.`, 'bg-red-700'); break;
    case 'chat': adicionarMensagem(m.name, m.text, false, m.time); break;
  }
}

// ---------- WebRTC ----------
function criarPeer(id, name) {
  if (state.peers.has(id)) return state.peers.get(id);
  const pc = new RTCPeerConnection(ICE);
  // Cadeia de áudio LOCAL deste usuário: fontes -> GainNode (0–200%) -> alto-falantes. Não afeta ninguém mais.
  const gain = state.ctx.createGain(); gain.gain.value = 1; gain.connect(state.ctx.destination);
  const p = { name, pc, polite: state.meuId ? state.meuId > id : true, making: false, ignore: false, sharing: false,
              screenStreamId: null, gain, volume: 100, holders: new Map(), screenSources: [], screenSenders: [] };
  state.peers.set(id, p);
  state.micStream?.getTracks().forEach((t) => pc.addTrack(t, state.micStream));
  if (state.telaStream) adicionarTela(p);

  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); sinalizar(id, { description: pc.localDescription }); }
    catch (e) { console.error(e); } finally { p.making = false; }
  };
  pc.onicecandidate = ({ candidate }) => candidate && sinalizar(id, { candidate });
  pc.ontrack = ({ track, streams: [stream] }) => {
    if (!stream) return;
    const ehTela = track.kind === 'video' || stream.id === p.screenStreamId || stream.getVideoTracks().length > 0;
    if (track.kind === 'video') mostrarVideo(id, stream);
    else rotearAudio(p, track, stream, ehTela);
  };
  return p;
}

// Envia o áudio remoto pelo GainNode do participante (voz e áudio da tela compartilham o mesmo controle)
function rotearAudio(p, track, stream, ehTela) {
  state.ctx.resume();
  const src = state.ctx.createMediaStreamSource(new MediaStream([track]));
  src.connect(p.gain);
  if (ehTela) p.screenSources.push(src);
  // Alguns navegadores só entregam o áudio ao Web Audio se o stream estiver ligado a um elemento (mudo)
  if (!p.holders.has(stream.id)) { const el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => {}); p.holders.set(stream.id, el); }
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

// ---------- Transmissão ----------
function adicionarTela(p) { state.telaStream.getTracks().forEach((t) => p.screenSenders.push(p.pc.addTrack(t, state.telaStream))); }

async function iniciarTransmissao() {
  if (alguemTransmite()) return toast('Já existe uma transmissão em andamento.', 'bg-red-700');
  const tipo = $('tipoTela').value, querAudio = $('chkAudio').checked;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: tipo, frameRate: { ideal: 30 } },
      // Áudio sem processamento de voz; o áudio local continua tocando para quem transmite
      audio: querAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } : false,
      // Tela inteira: permite áudio do sistema. Aba/janela: não oferece áudio do sistema, apenas o da própria fonte.
      systemAudio: tipo === 'monitor' ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude', // não deixa compartilhar esta própria aba (evita efeito espelho)
    });
    state.telaStream = stream;
    // Descobre o que o usuário realmente escolheu no seletor (pode diferir da sugestão)
    const real = stream.getVideoTracks()[0].getSettings().displaySurface || tipo;
    const temAudio = stream.getAudioTracks().length > 0;
    if (querAudio && !temAudio)
      toast(real === 'window' ? 'Janelas não transmitem áudio no navegador. Use “Aba” ou “Tela inteira”.' : 'Áudio não capturado. Marque “Compartilhar áudio” no seletor do navegador.', 'bg-amber-700');
    else if (temAudio) toast(real === 'browser' ? 'Transmitindo apenas o áudio da aba.' : real === 'monitor' ? 'Transmitindo o áudio do sistema.' : 'Transmitindo o áudio da fonte escolhida.', 'bg-emerald-700');
    enviar({ type: 'sharing', sharing: true, streamId: stream.id }); // avisa ANTES das trilhas
    state.peers.forEach(adicionarTela);
    stream.getVideoTracks()[0].onended = () => pararTransmissao(true); // botão nativo "Parar compartilhamento"
    mostrarVideo(state.meuId, stream, true);
  } catch (e) { if (e.name !== 'NotAllowedError') toast('Não foi possível iniciar a transmissão.', 'bg-red-700'); }
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
  const v = $('video'); state.mostrando = id; v.srcObject = stream || null;
  v.muted = true; // o áudio remoto sai pelo Web Audio (controle de volume); o local fica mudo para evitar eco
  if (stream) v.play().catch(() => {});
  $('vazio').classList.toggle('hidden', !!stream);
  const rot = $('rotulo'); rot.classList.toggle('hidden', !stream);
  rot.textContent = stream ? `🔴 ${id === state.meuId ? 'Você está transmitindo' : (state.peers.get(id)?.name || '') + ' está transmitindo'}` : '';
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

// ---------- Participantes + volume individual (somente local) ----------
const iconeVol = (v) => (v === 0 ? '🔇' : v < 100 ? '🔉' : '🔊');
function controleVolume(id, p) {
  const box = document.createElement('div'); box.className = 'group flex items-center shrink-0 ml-2';
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = iconeVol(p.volume);
  btn.title = `Volume de ${p.name} (somente para você)`; btn.className = 'px-1 rounded hover:bg-slate-700';
  // O slider aparece ao passar o mouse (ou focar/tocar) no ícone
  const area = document.createElement('div'); area.className = 'flex items-center gap-1 overflow-hidden w-0 group-hover:w-36 group-focus-within:w-36 transition-all duration-200';
  const r = document.createElement('input'); Object.assign(r, { type: 'range', min: 0, max: 200, step: 5, value: p.volume });
  r.className = 'w-20 accent-indigo-500'; r.title = 'Volume: 0% a 200%';
  const pct = document.createElement('span'); pct.className = 'text-xs w-9 text-right text-slate-300'; pct.textContent = `${p.volume}%`;
  r.oninput = () => { // GainNode: 1.0 = 100%, 2.0 = 200%. Só altera o áudio deste navegador.
    p.volume = +r.value; p.gain.gain.value = p.volume / 100; pct.textContent = `${p.volume}%`; btn.textContent = iconeVol(p.volume);
  };
  area.append(r, pct); box.append(btn, area); return box;
}

function renderizar() {
  const ul = $('listaParticipantes'); ul.innerHTML = '';
  const todos = [{ id: state.meuId, name: state.meuNome + ' (você)', sharing: transmitindoAgora(), eu: true },
    ...[...state.peers].map(([id, p]) => ({ id, name: p.name, sharing: p.sharing, p }))];
  todos.forEach((u) => {
    const li = document.createElement('li');
    li.className = `flex items-center justify-between px-2 py-1.5 rounded-lg ${u.sharing ? 'bg-red-600/20 ring-1 ring-red-500' : 'bg-slate-800'}`;
    const nome = document.createElement('span'); nome.textContent = u.name; nome.className = 'truncate flex-1';
    li.appendChild(nome);
    if (u.sharing) { const b = document.createElement('span'); b.textContent = '🔴 Transmitindo'; b.className = 'text-xs font-semibold text-red-400 shrink-0 ml-2'; li.appendChild(b); }
    if (!u.eu) li.appendChild(controleVolume(u.id, u.p));
    ul.appendChild(li);
  });
  $('contador').textContent = todos.length;
  const txt = transmitindoAgora() ? 'Parar transmissão' : 'Iniciar transmissão';
  [$('btnTransmitir'), $('fsTransmitir')].forEach((b) => {
    b.textContent = txt; b.classList.toggle('bg-red-600', transmitindoAgora()); b.classList.toggle('bg-indigo-600', !transmitindoAgora());
  });
  atualizarMic();
}

$('btnMic').onclick = $('fsMic').onclick = alternarMic;
$('btnTransmitir').onclick = $('fsTransmitir').onclick = alternarTransmissao;

// ---------- Troca de nome (a qualquer momento) ----------
function renomear() {
  const novo = $('novoNome').value.trim();
  if (!novo) return toast('Digite o novo nome.', 'bg-red-700');
  enviar({ type: 'rename', name: novo }); $('novoNome').value = '';
}
$('btnRenomear').onclick = renomear;
$('novoNome').addEventListener('keydown', (e) => e.key === 'Enter' && renomear());

// ---------- Tela cheia com barra flutuante ----------
const palco = $('palco'), barra = $('barraFlutuante'); let timerBarra;
$('btnTelaCheia').onclick = () => palco.requestFullscreen?.();
$('fsSair').onclick = () => document.exitFullscreen();
function mostrarBarra() {
  barra.classList.remove('opacity-0'); palco.style.cursor = 'default'; clearTimeout(timerBarra);
  timerBarra = setTimeout(() => { barra.classList.add('opacity-0'); palco.style.cursor = 'none'; }, 2500);
}
palco.addEventListener('mousemove', () => document.fullscreenElement && mostrarBarra());
document.addEventListener('fullscreenchange', () => {
  const cheia = document.fullscreenElement === palco;
  barra.classList.toggle('hidden', !cheia); barra.classList.toggle('flex', cheia);
  $('btnTelaCheia').classList.toggle('hidden', cheia);
  clearTimeout(timerBarra); palco.style.cursor = 'default'; if (cheia) mostrarBarra();
});

// ---------- Chat: mensagens com horário e avisos do sistema ----------
function adicionarMensagem(autor, texto, minha, t) {
  const d = document.createElement('div');
  d.className = `rounded-lg px-3 py-1.5 ${minha ? 'bg-indigo-600/30 ml-6' : 'bg-slate-800 mr-6'}`;
  const topo = document.createElement('div'); topo.className = 'flex justify-between gap-2 text-xs text-slate-400';
  const a = document.createElement('span'); a.textContent = minha ? 'Você' : autor;
  const h = document.createElement('time'); h.textContent = hora(t); // horário exato do envio
  const msg = document.createElement('div'); msg.className = 'break-words'; msg.textContent = texto; // textContent evita injeção de HTML
  topo.append(a, h); d.append(topo, msg); anexar(d);
}
function adicionarSistema(texto) {
  const d = document.createElement('div'); d.className = 'text-center text-xs text-slate-400 italic';
  d.textContent = `${texto} · ${hora()}`; anexar(d);
}
function anexar(el) { const box = $('mensagens'); box.appendChild(el); box.scrollTop = box.scrollHeight; }
function enviarChat() {
  const texto = $('textoChat').value.trim(); if (!texto) return;
  enviar({ type: 'chat', text: texto }); adicionarMensagem('', texto, true, Date.now()); $('textoChat').value = '';
}
$('btnEnviar').onclick = enviarChat;
$('textoChat').addEventListener('keydown', (e) => e.key === 'Enter' && enviarChat());
