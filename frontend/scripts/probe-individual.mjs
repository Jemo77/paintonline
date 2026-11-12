/**
 * Reproduce el camino del canvas personal de un participante en INDIVIDUAL:
 * entra, dibuja un trazo, lo cierra y comprueba que el siguiente join se lo
 * devuelve. Es lo que el `CanvasStage` pinta en `/s/[sessionId]`.
 *
 *   node scripts/probe-individual.mjs [origen]
 */
import { io } from 'socket.io-client';

const origin = process.argv[2] ?? 'http://localhost:3002';
const PASSWORD = 'Password123';

const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
};

async function login(email) {
  const r = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return r.json();
}

/** Une un socket y espera el `session_state_sync`. */
function openSocket(token, sessionId) {
  const socket = io(`${origin}/session`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout en session_state_sync')), 12000);
    socket.on('connect', () => socket.emit('join_session', { sessionId }));
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('session_state_sync', (state) => {
      clearTimeout(timer);
      resolve({ socket, state });
    });
  });
}

async function main() {
  const ana = await login('ana@paintonline.dev');
  const spaces = await (
    await fetch(`${origin}/api/spaces`, { headers: { authorization: `Bearer ${ana.accessToken}` } })
  ).json();
  const space = (spaces.items ?? spaces)[0];

  const sessions = await (
    await fetch(`${origin}/api/spaces/${space.id}/sessions`, {
      headers: { authorization: `Bearer ${ana.accessToken}` },
    })
  ).json();
  const session = (sessions.items ?? sessions).find((s) => s.mode === 'INDIVIDUAL');
  check(Boolean(session), `sesión INDIVIDUAL (${session?.id})`);
  console.log(`      estado: ${session.status}`);

  // Ana entra a dibujar. En INDIVIDUAL el creador también es participante.
  await fetch(`${origin}/api/sessions/${session.id}/join`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ana.accessToken}` },
  });

  const { socket, state } = await openSocket(ana.accessToken, session.id);
  check(state.session.mode === 'INDIVIDUAL', `modo recibido: ${state.session.mode}`);
  check(state.viewer.canDraw === true, `canDraw: ${state.viewer.canDraw}`);

  // Traza un cuadrado, como lo haría el mouse.
  const strokeId = `probe-${Date.now()}`;
  socket.emit('stroke_start', {
    sessionId: session.id,
    strokeId,
    color: '#111827',
    brushSize: 6,
    tool: 'pen',
  });
  const pts = [];
  for (let i = 0; i <= 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    pts.push({ x: 960 + Math.cos(a) * 300, y: 540 + Math.sin(a) * 300, pressure: 0.5, t: Date.now() });
  }
  for (let i = 0; i < pts.length; i += 16) {
    socket.emit('stroke_points', { sessionId: session.id, strokeId, points: pts.slice(i, i + 16) });
  }
  socket.emit('stroke_end', { sessionId: session.id, strokeId });
  await new Promise((r) => setTimeout(r, 900));
  socket.close();

  // Nuevo socket: representa recargar la página.
  const second = await openSocket(ana.accessToken, session.id);
  const mine = (second.state.strokes ?? []).filter((s) => s.userId === ana.user.id);
  check(mine.length > 0, `el canvas personal recibe ${mine.length} trazo(s) propio(s)`);
  const last = mine[mine.length - 1];
  check(
    Boolean(last) && Array.isArray(last.points) && last.points.length === pts.length,
    `el trazo llegó completo: ${last?.points?.length}/${pts.length} puntos`,
  );
  check(last?.layerId === null || last?.layerId === undefined, `sin capa (orphan): ${last?.layerId}`);

  // Lo que el CanvasStage personal pinta: en INDIVIDUAL, `orphan` (sin capa).
  const orphan = (second.state.strokes ?? []).filter((s) => !s.layerId);
  check(orphan.length > 0, `hay ${orphan.length} trazo(s) en el grupo orphan que el Stage personal dibuja`);

  // Aislamiento: Ana es creadora, así que ve todos. Con Bruno debe ver 1.
  const bruno = await login('bruno@paintonline.dev');
  const asBruno = await openSocket(bruno.accessToken, session.id);
  const brunoSees = asBruno.state.strokes ?? [];
  check(
    brunoSees.every((s) => s.userId === bruno.user.id),
    `Bruno sólo recibe los suyos: ${brunoSees.length} trazo(s), todos suyos=${brunoSees.every((s) => s.userId === bruno.user.id)}`,
  );
  check(
    asBruno.state.visibleUserIds?.length === 1 && asBruno.state.visibleUserIds[0] === bruno.user.id,
    `Bruno ve sólo su miniatura: ${JSON.stringify(asBruno.state.visibleUserIds)}`,
  );
  asBruno.socket.close();
  second.socket.close();

  console.log(process.exitCode ? '\nTODO MAL' : '\nTODO OK');
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
