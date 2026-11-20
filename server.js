// RE4 Online - room + relay server (Node.js, works on Render's free plan)
// Text frames = JSON (lobby). Binary frames = game state, relayed to the other player in the room.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const rooms = new Map();          // code -> { players: [ws], ready: Map(ws->bool), bot: {...} | null }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`RE4 Online servidor ok - ${rooms.size} sala(s), ${wss.clients.size} jogador(es)\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const code = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); } while (rooms.has(c)); return c; };

function roomState(code) {
  const r = rooms.get(code); if (!r) return;
  const players = r.players.map((p) => ({ name: p.name, ready: !!r.ready.get(p) }));
  if (r.bot) players.push({ name: '🤖 Bot', ready: true });
  const all = players.length === 2 && players.every((p) => p.ready);
  for (const p of r.players) send(p, { t: 'room', code, players, you: r.players.indexOf(p) });
  if (all && !r.started) { r.started = true; for (const p of r.players) send(p, { t: 'go' }); }
  if (!all) r.started = false;
}
function leave(ws) {
  const c = ws.room; if (!c) return; const r = rooms.get(c); ws.room = null; if (!r) return;
  r.players = r.players.filter((p) => p !== ws); r.ready.delete(ws);
  if (!r.players.length) { if (r.bot) clearInterval(r.bot.timer); rooms.delete(c); return; }
  for (const p of r.players) send(p, { t: 'info', msg: `${ws.name} saiu da sala` });
  roomState(c);
}

wss.on('connection', (ws) => {
  ws.name = 'Leon'; ws.room = null; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', msg: 'Conectado ao servidor RE4 Online' });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {                                   // game state -> the other player (or the bot)
      const r = ws.room && rooms.get(ws.room); if (!r) return;
      for (const p of r.players) if (p !== ws && p.readyState === 1) p.send(data, { binary: true });
      if (r.bot) { r.bot.hist.push(Buffer.from(data)); if (r.bot.hist.length > 80) r.bot.hist.shift(); }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'name') ws.name = String(m.name || 'Leon').slice(0, 16);
    else if (m.t === 'create') { leave(ws); const c = code(); rooms.set(c, { players: [ws], ready: new Map(), bot: null }); ws.room = c; roomState(c); }
    else if (m.t === 'join') {
      const c = String(m.code || '').toUpperCase().trim(); const r = rooms.get(c);
      if (!r) return send(ws, { t: 'error', msg: 'Sala não existe' });
      if (r.players.length + (r.bot ? 1 : 0) >= 2) return send(ws, { t: 'error', msg: 'Sala cheia' });
      leave(ws); r.players.push(ws); ws.room = c; roomState(c);
    } else if (m.t === 'ready') { const r = ws.room && rooms.get(ws.room); if (r) { r.ready.set(ws, !!m.v); roomState(ws.room); } }
    else if (m.t === 'bot') {                         // server bot: sends your own moves back 2 s later
      const r = ws.room && rooms.get(ws.room); if (!r) return;
      if (m.v && !r.bot && r.players.length < 2) {
        r.bot = { hist: [], timer: setInterval(() => { if (r.bot.hist.length > 40) { const s = r.bot.hist[r.bot.hist.length - 41]; for (const p of r.players) if (p.readyState === 1) p.send(s, { binary: true }); } }, 50) };
      } else if (!m.v && r.bot) { clearInterval(r.bot.timer); r.bot = null; }
      roomState(ws.room);
    } else if (m.t === 'leave') { leave(ws); send(ws, { t: 'left' }); }
    else if (m.t === 'ping') send(ws, { t: 'pong', id: m.id });
  });
  ws.on('close', () => leave(ws));
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 20000);
server.listen(PORT, () => console.log('RE4 Online server on', PORT));
