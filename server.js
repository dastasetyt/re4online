// RE4 Online - room + relay server (Node.js, works on Render's free plan)
// Text frames = JSON (lobby). Binary frames = game data, relayed to the other players in the room.
// v2: rooms of 2..10 players. Each player has a fixed slot (0 = the host, who created the room).
//     Clients that say proto 2 get every relayed message as [0xBA, sender slot, data...] and may send
//     [0xBC, skip mask lo, skip mask hi, data...] to skip players they already reached phone to phone.
//     Older clients (2-player rooms) keep getting the raw data.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const rooms = new Map();          // code -> { max, players: [ws], ready: Map(ws->bool), bot: {...} | null, started }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`RE4 Online servidor ok (v2, salas até 10) - ${rooms.size} sala(s), ${wss.clients.size} jogador(es)\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 8192 });

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const code = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); } while (rooms.has(c)); return c; };
const count = (r) => r.players.length + (r.bot ? 1 : 0);
function freeSlot(r) { for (let s = 0; s < r.max; s++) if (!r.players.some((p) => p.slot === s) && !(r.bot && r.bot.slot === s)) return s; return -1; }

function roomState(code) {
  const r = rooms.get(code); if (!r) return;
  const players = r.players.map((p) => ({ name: p.name, ready: !!r.ready.get(p), slot: p.slot }));
  if (r.bot) players.push({ name: '🤖 Bot', ready: true, slot: r.bot.slot });
  players.sort((a, b) => a.slot - b.slot);
  const all = players.length >= 2 && players.every((p) => p.ready);
  for (const p of r.players) {
    // old clients find themselves by array index: give them the index; new ones get their slot
    const you = p.proto >= 2 ? p.slot : players.findIndex((q) => q.slot === p.slot);
    send(p, { t: 'room', code, max: r.max, players, you });
  }
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
function relay(ws, r, data) {
  let skip = 0, body = data;
  if (data.length >= 3 && data[0] === 0xBC) { skip = data[1] | (data[2] << 8); body = data.subarray(3); }
  let wrapped = null;
  for (const p of r.players) {
    if (p === ws || p.readyState !== 1 || (skip & (1 << p.slot))) continue;
    if (p.proto >= 2) { if (!wrapped) { wrapped = Buffer.allocUnsafe(body.length + 2); wrapped[0] = 0xBA; wrapped[1] = ws.slot; body.copy(wrapped, 2); } p.send(wrapped, { binary: true }); }
    else p.send(body, { binary: true });
  }
  if (r.bot) {
    if (body.length && body[0] === 0xB8) {          // phone-to-phone signals are not game data: the bot doesn't replay them
      if (body.length >= 11 && body[1] === 9 && ws.proto >= 2 && ws.readyState === 1) {   // but it answers the server ping right away
        const w = Buffer.allocUnsafe(body.length + 2); w[0] = 0xBA; w[1] = r.bot.slot; body.copy(w, 2); w[3] = 10; ws.send(w, { binary: true });
      }
      return;
    }
    r.bot.hist.push(Buffer.from(body)); if (r.bot.hist.length > 80) r.bot.hist.shift();
  }
}

wss.on('connection', (ws) => {
  ws.name = 'Leon'; ws.room = null; ws.alive = true; ws.proto = 1; ws.slot = 0;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', v: 2, msg: 'Conectado ao servidor RE4 Online' });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {                                   // game data -> the other players (or the bot)
      const r = ws.room && rooms.get(ws.room); if (!r) return;
      relay(ws, r, data); return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'name') { ws.name = String(m.name || 'Leon').slice(0, 16); if (m.proto) ws.proto = Number(m.proto) || 1; }
    else if (m.t === 'create') {
      leave(ws); const c = code(); const max = Math.max(2, Math.min(10, Number(m.max) || 2));
      rooms.set(c, { max, players: [ws], ready: new Map(), bot: null }); ws.room = c; ws.slot = 0; roomState(c);
    } else if (m.t === 'join') {
      const c = String(m.code || '').toUpperCase().trim(); const r = rooms.get(c);
      if (!r) return send(ws, { t: 'error', msg: 'Sala não existe' });
      if (ws.room === c) return roomState(c);
      if (count(r) >= r.max) return send(ws, { t: 'error', msg: `Sala cheia (${r.max} jogadores)` });
      if (r.max > 2 && ws.proto < 2) return send(ws, { t: 'error', msg: 'Atualize o RE4 Online: esta sala é para mais de 2 jogadores' });
      leave(ws); ws.slot = freeSlot(r); r.players.push(ws); ws.room = c; roomState(c);
    } else if (m.t === 'ready') { const r = ws.room && rooms.get(ws.room); if (r) { r.ready.set(ws, !!m.v); roomState(ws.room); } }
    else if (m.t === 'bot') {                         // server bot: sends your own moves back 2 s later
      const r = ws.room && rooms.get(ws.room); if (!r) return;
      if (m.v && !r.bot && count(r) < r.max) {
        const bot = { hist: [], slot: freeSlot(r) };
        bot.timer = setInterval(() => {
          if (bot.hist.length <= 40) return; const s = bot.hist[bot.hist.length - 41];
          for (const p of r.players) {
            if (p.readyState !== 1) continue;
            if (p.proto >= 2) { const w = Buffer.allocUnsafe(s.length + 2); w[0] = 0xBA; w[1] = bot.slot; s.copy(w, 2); p.send(w, { binary: true }); }
            else p.send(s, { binary: true });
          }
        }, 50);
        r.bot = bot;
      } else if (!m.v && r.bot) { clearInterval(r.bot.timer); r.bot = null; }
      roomState(ws.room);
    } else if (m.t === 'leave') { leave(ws); send(ws, { t: 'left' }); }
    else if (m.t === 'ping') send(ws, { t: 'pong', id: m.id });
  });
  ws.on('close', () => leave(ws));
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 20000);
server.listen(PORT, () => console.log('RE4 Online server on', PORT));
