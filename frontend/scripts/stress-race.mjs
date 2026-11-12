/**
 * Estrés de la carrera stroke_points / stroke_end.
 *
 * Emite todos los batches y el cierre sin esperar ningún ack, que es lo que
 * dispara la carrera en el servidor. Antes del fix a Lua + ack, los últimos
 * puntos de cada trazo se perdían (32/41, 9 puntos fuera).
 *
 *   node scripts/stress-race.mjs [origen] [trazos]
 */
import { io } from 'socket.io-client';

const origin = process.argv[2] ?? 'http://localhost:3002';
const strokes = Number(process.argv[3] ?? 20);
const POINTS = 41;
const BATCH = 16;
const PASSWORD = 'Password123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { accessToken, user } = await (
  await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ana@paintonline.dev', password: PASSWORD }),
  })
).json();

const spaces = await (
  await fetch(`${origin}/api/spaces`, { headers: { authorization: `Bearer ${accessToken}` } })
).json();
const space = (spaces.items ?? spaces)[0];
const sessions = await (
  await fetch(`${origin}/api/spaces/${space.id}/sessions`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
).json();
const session = (sessions.items ?? sessions).find((s) => s.mode === 'INDIVIDUAL');

const socket = io(`${origin}/session`, {
  auth: { token: accessToken },
  transports: ['websocket'],
  reconnection: false,
});
await new Promise((r) => socket.on('connect', r));
socket.emit('join_session', { sessionId: session.id });
await sleep(700);

const ids = [];
for (let n = 0; n < strokes; n += 1) {
  const strokeId = `race-${Date.now()}-${n}`;
  ids.push(strokeId);

  // Sin await entre eventos: máxima concurrencia en el servidor.
  socket.emit('stroke_start', {
    sessionId: session.id,
    strokeId,
    color: '#111827',
    brushSize: 5,
    tool: 'pen',
  });

  const pts = Array.from({ length: POINTS }, (_, i) => ({
    x: 100 + i * 5,
    y: 200 + n * 3 + Math.sin(i / 2) * 20,
    pressure: 0.5,
    t: Date.now(),
  }));
  for (let i = 0; i < pts.length; i += BATCH) {
    socket.emit('stroke_points', {
      sessionId: session.id,
      strokeId,
      points: pts.slice(i, i + BATCH),
    });
  }
  socket.emit('stroke_end', { sessionId: session.id, strokeId });
}
await sleep(2500);
socket.close();

// ── Verificación ──────────────────────────────────────────────────────────
const detail = await (
  await fetch(`${origin}/api/sessions/${session.id}/strokes`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
).json();
const all = detail.strokes ?? [];
const mine = all.filter((s) => ids.includes(s.id));

let complete = 0;
const short = [];
for (const id of ids) {
  const s = mine.find((x) => x.id === id);
  if (!s) short.push(`${id}: AUSENTE`);
  else if (s.points.length !== POINTS) short.push(`${id}: ${s.points.length}/${POINTS}`);
  else complete += 1;
}

console.log(`trazos enviados:   ${ids.length}`);
console.log(`persistidos:       ${mine.length}`);
console.log(`completos (${POINTS} pts): ${complete}`);
if (short.length) {
  console.log(`INCOMPLETOS (${short.length}):`);
  for (const s of short.slice(0, 10)) console.log(`  ${s}`);
  console.log('\nTODO MAL — se perdieron puntos');
  process.exit(1);
}
console.log('\nTODO OK — ningún trazo perdió puntos');
