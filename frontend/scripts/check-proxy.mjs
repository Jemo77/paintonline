/**
 * Comprueba que el gateway de dibujo se puede alcanzar a través del proxy de
 * Next (mismo origen), que es como lo ve el navegador detrás de un túnel.
 *
 *   node scripts/check-proxy.mjs [origen]
 *
 * Origen por defecto: http://localhost:3000 (el dev server, que proxea).
 * Contra el backend directo se puede pasar http://localhost:3001.
 */
import { io } from 'socket.io-client';

const origin = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = 'ana@paintonline.dev';
const PASSWORD = 'Password123';

const check = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

async function main() {
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const { accessToken } = await res.json();
  check(Boolean(accessToken), `REST por ${origin} devuelve token`);

  const spaces = await (await fetch(`${origin}/api/spaces`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })).json();
  const space = (spaces.items ?? spaces)[0];

  const sessions = await (await fetch(`${origin}/api/spaces/${space.id}/sessions`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })).json();
  const session = (sessions.items ?? sessions).find((s) => s.status === 'LIVE') ?? (sessions.items ?? sessions)[0];
  check(Boolean(session), `sesión LIVE disponible (${session?.mode})`);

  const socket = io(`${origin}/session`, {
    auth: { token: accessToken },
    transports: ['websocket', 'polling'],
    reconnection: false,
  });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, why: 'timeout de 12s' }), 12000);

    socket.on('connect', () => socket.emit('join_session', { sessionId: session.id }));
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, why: `connect_error: ${err.message}` });
    });
    socket.on('session_state_sync', (state) => {
      clearTimeout(timer);
      resolve({ ok: true, state, transport: socket.io.engine.transport.name });
    });
  });

  if (!result.ok) {
    check(false, `WebSocket por ${origin} — ${result.why}`);
    socket.close();
    process.exit(1);
  }

  const { state } = result;
  check(true, `WebSocket por ${origin} conecta (transporte: ${result.transport})`);
  check(Array.isArray(state.layers) && state.layers.length > 0, `recibe capas: ${state.layers.length}`);
  check(Array.isArray(state.strokes), `recibe trazos: ${state.strokes.length}`);
  check(Boolean(state.session?.mode), `recibe modo: ${state.session?.mode}`);
  check(Boolean(state.viewer?.userId), `identifica al viewer: ${state.viewer?.isSpaceOwner ? 'creador' : 'participante'}`);

  socket.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR', err);
  process.exit(1);
});
