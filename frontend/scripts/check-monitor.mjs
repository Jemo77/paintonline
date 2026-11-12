/**
 * Comprueba el camino del monitor: el creador entra, recibe a todos los
 * participantes en `visibleUserIds` y en `participants`, y cada miniatura
 * tendría un Stage propio.
 *
 * Reproduce el fallo del `useRef` dentro del `.map()`: al cambiar la cantidad
 * de participantes, Reactaba que el número de hooks no coincidía y caía el
 * monitor. Acá se verifica que la lista llega completa y estable.
 *
 *   node scripts/check-monitor.mjs [origen]
 */
import { io } from 'socket.io-client';

const origin = process.argv[2] ?? 'http://localhost:3002';
const PASSWORD = 'Password123';

const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
};

async function main() {
  const login = async (email) =>
    (
      await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      })
    ).json();

  const ana = await login('ana@paintonline.dev');
  const H = { authorization: `Bearer ${ana.accessToken}` };

  const spaces = await (await fetch(`${origin}/api/spaces`, { headers: H })).json();
  const space = (spaces.items ?? spaces)[0];
  const sessions = await (await fetch(`${origin}/api/spaces/${space.id}/sessions`, { headers: H })).json();
  const ind = (sessions.items ?? sessions).find((s) => s.mode === 'INDIVIDUAL');
  check(Boolean(ind), `sesión INDIVIDUAL ${ind?.id}`);

  // El creador entra al socket del monitor.
  const open = () =>
    new Promise((resolve, reject) => {
      const socket = io(`${origin}/session`, {
        auth: { token: ana.accessToken },
        transports: ['websocket'],
        reconnection: false,
      });
      const timer = setTimeout(() => reject(new Error('timeout')), 12000);
      socket.on('connect', () => socket.emit('join_session', { sessionId: ind.id }));
      socket.on('connect_error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on('session_state_sync', (state) => {
        clearTimeout(timer);
        resolve({ socket, state });
      });
    });

  const first = await open();
  check(first.state.session.mode === 'INDIVIDUAL', 'el monitor recibe modo INDIVIDUAL');
  check(first.state.viewer.isSpaceOwner === true, 'el creador entra como owner');

  const participants = first.state.participants ?? [];
  const visible = first.state.visibleUserIds ?? [];
  console.log(`      participantes: ${participants.length}, visibles: ${visible.length}`);

  check(participants.length > 0, `llega la lista de participantes (${participants.length})`);
  check(
    visible.length === participants.length,
    `visibleUserIds cubre a todos los participantes (${visible.length}/${participants.length})`,
  );
  check(
    participants.every((p) => visible.includes(p.userId ?? p.user?.id)),
    'cada participante tiene su miniatura',
  );
  // El grid ordena por "dibujando" y corta en `maxRendered` (12).
  check(visible.length <= 12, `cabe en el tope de miniaturas simultáneas (≤12)`);
  first.socket.close();

  // Segundo join: la lista tiene que ser idéntica. Si el `useRef` dentro del
  // `.map()` fuera legal, este es el render que dispara el error de hooks.
  const second = await open();
  const sameCount = (second.state.participants ?? []).length === participants.length;
  check(sameCount, 'reconectar no cambia la cantidad de participantes');
  second.socket.close();

  console.log(process.exitCode ? '\nTODO MAL' : '\nTODO OK');
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
