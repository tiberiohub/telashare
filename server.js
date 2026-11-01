// Servidor: serve os arquivos estáticos e faz a SINALIZAÇÃO WebRTC via WebSocket.
// O vídeo/áudio trafega direto entre os navegadores (peer-to-peer); aqui só passam mensagens.
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// salas: Map<codigoDaSala, Map<idDoUsuario, { ws, name, sharing, streamId }>>
const rooms = new Map();

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (room, msg, exceptId) => {
  for (const [id, p] of room) if (id !== exceptId) send(p.ws, msg);
};

wss.on('connection', (ws) => {
  let room = null;
  const id = crypto.randomUUID();

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // Entrada na sala
    if (m.type === 'join' && !room) {
      const code = String(m.room || 'geral').trim().slice(0, 30).toLowerCase();
      const name = String(m.name || 'Anônimo').trim().slice(0, 24) || 'Anônimo';
      if (!rooms.has(code)) rooms.set(code, new Map());
      room = rooms.get(code);
      room.code = code;
      const peers = [...room].map(([pid, p]) => ({ id: pid, name: p.name, sharing: p.sharing, streamId: p.streamId }));
      room.set(id, { ws, name, sharing: false, streamId: null });
      send(ws, { type: 'welcome', id, peers });
      broadcast(room, { type: 'peer-joined', id, name }, id);
      return;
    }
    if (!room) return;
    const me = room.get(id);

    switch (m.type) {
      case 'signal': // repassa ofertas/respostas/candidatos ICE a um destinatário
        room.get(m.to) && send(room.get(m.to).ws, { type: 'signal', from: id, data: m.data });
        break;
      case 'chat': // mensagem de texto para todos
        broadcast(room, { type: 'chat', from: id, name: me.name, text: String(m.text).slice(0, 500), time: Date.now() });
        break;
      case 'rename': { // troca de nome a qualquer momento; todos são avisados na hora
        const novo = String(m.name || '').trim().slice(0, 24);
        if (!novo || novo === me.name) break;
        const antigo = me.name; me.name = novo;
        broadcast(room, { type: 'renamed', id, oldName: antigo, name: novo }, id);
        send(ws, { type: 'rename-ok', name: novo });
        break;
      }
      case 'sharing': { // início/fim de transmissão (apenas um transmissor por vez)
        const other = [...room].find(([pid, p]) => pid !== id && p.sharing);
        if (m.sharing && other) return send(ws, { type: 'share-denied', name: other[1].name });
        me.sharing = !!m.sharing;
        me.streamId = m.sharing ? m.streamId : null;
        broadcast(room, { type: 'sharing', id, sharing: me.sharing, streamId: me.streamId }, id);
        send(ws, { type: 'share-ok' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.delete(id);
    broadcast(room, { type: 'peer-left', id });
    if (room.size === 0) rooms.delete(room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TelaShare rodando em http://localhost:${PORT}`));
