/**
 * Prueba end-to-end del gateway: login, join, dibujo, y verificación del
 * aislamiento por modo. No es parte del build; se corre a mano.
 *
 *   node scripts/e2e.mjs
 */
import { io } from 'socket.io-client';

const API = process.env.API ?? 'http://localhost:3001/api';
const WS = process.env.WS ?? 'http://localhost:3001/session';

let failures = 0;
function check(label, condition, extra = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
}

async function rest(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function connect(token) {
  return io(WS, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
}

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function collect(socket, event, ms) {
  const received = [];
  const handler = (payload) => received.push(payload);
  socket.on(event, handler);
  return { received, stop: () => socket.off(event, handler) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n─── REST: auth ───');
  const alice = await rest('/auth/login', {
    method: 'POST',
    body: { email: 'ana@paintonline.dev', password: 'Password123' },
  });
  const bruno = await rest('/auth/login', {
    method: 'POST',
    body: { email: 'bruno@paintonline.dev', password: 'Password123' },
  });
  const caro = await rest('/auth/login', {
    method: 'POST',
    body: { email: 'carla@paintonline.dev', password: 'Password123' },
  });
  check('login de 3 usuarios', Boolean(alice.accessToken && bruno.accessToken && caro.accessToken));

  const spaces = await rest('/spaces', { token: alice.accessToken });
  const space = spaces.find((s) => s.slug === 'club-de-dibujo') ?? spaces[0];
  check('espacio disponible', Boolean(space?.id), space?.slug);

  const sessions = await rest(`/spaces/${space.id}/sessions`, { token: alice.accessToken });
  const byMode = Object.fromEntries(sessions.map((s) => [s.mode, s]));
  check(
    'hay una sesión por modo',
    byMode.INDIVIDUAL && byMode.LAYERED && byMode.FREE,
    Object.keys(byMode).join(','),
  );

  // El creador de las sesiones es Ana (owner del espacio).
  for (const mode of ['INDIVIDUAL', 'LAYERED', 'FREE']) {
    const s = byMode[mode];
    if (s.status === 'DRAFT') {
      await rest(`/sessions/${s.id}`, {
        method: 'PATCH',
        token: alice.accessToken,
        body: { status: 'OPEN' },
      });
    }
    if (s.status === 'OPEN') {
      await rest(`/sessions/${s.id}`, {
        method: 'PATCH',
        token: alice.accessToken,
        body: { status: 'LIVE' },
      });
    }
  }
  check('sesiones en vivo', true);

  // ─── INDIVIDUAL ───────────────────────────────────────────────────────────
  console.log('\n─── INDIVIDUAL: aislamiento ───');
  const ind = byMode.INDIVIDUAL.id;
  await rest(`/sessions/${ind}/join`, { method: 'POST', token: bruno.accessToken });
  await rest(`/sessions/${ind}/join`, { method: 'POST', token: caro.accessToken });

  const aSock = connect(alice.accessToken);
  const bSock = connect(bruno.accessToken);
  const cSock = connect(caro.accessToken);
  await Promise.all([once(aSock, 'connect'), once(bSock, 'connect'), once(cSock, 'connect')]);

  const aSync = once(aSock, 'session_state_sync');
  const bSync = once(bSock, 'session_state_sync');
  const cSync = once(cSock, 'session_state_sync');
  aSock.emit('join_session', { sessionId: ind });
  bSock.emit('join_session', { sessionId: ind });
  cSock.emit('join_session', { sessionId: ind });
  const [aState, bState, cState] = await Promise.all([aSync, bSync, cSync]);

  check('state sync a todos', Boolean(aState && bState && cState));
  check('modo INDIVIDUAL correcto', aState.session.mode === 'INDIVIDUAL');
  // El número de participantes varía según quién más se haya anotado antes, así
  // que la aserción es sobre quiénes están, no sobre cuántos.
  const participants = aState.participants ?? [];
  const nameOf = (p) => (p.user?.name ?? p.name ?? '').toLowerCase();
  const idOf = (p) => p.userId ?? p.user?.id;

  check(
    'el creador ve a Bruno, Carla y Diego en visibleUserIds',
    ['bruno', 'carla', 'diego'].every(
      (n) =>
        participants.some((p) => nameOf(p).startsWith(n)) &&
        aState.visibleUserIds?.includes(idOf(participants.find((p) => nameOf(p).startsWith(n)))),
    ),
    `visibleUserIds=${JSON.stringify(aState.visibleUserIds)} de ${participants.length} anotados`,
  );
  check(
    'el participante sólo se ve a sí mismo',
    bState.visibleUserIds?.length === 1 && bState.visibleUserIds[0] === bState.viewer.userId,
  );

  const bDrafts = collect(bSock, 'stroke_draft', 0);
  const bBroadcasts = collect(bSock, 'stroke_broadcast', 0);
  const aBroadcasts = collect(aSock, 'stroke_broadcast', 0);
  const cDrafts = collect(cSock, 'stroke_draft', 0);
  const cBroadcasts = collect(cSock, 'stroke_broadcast', 0);

  const brunoStrokeId = `e2e_ind_${Date.now().toString(36)}`;
  bSock.emit('stroke_start', {
    sessionId: ind,
    strokeId: brunoStrokeId,
    color: '#ff0000',
    brushSize: 5,
    tool: 'pen',
  });
  await sleep(120);
  bSock.emit('stroke_points', {
    sessionId: ind,
    strokeId: brunoStrokeId,
    points: [
      { x: 10, y: 10, pressure: 0.5, t: Date.now() },
      { x: 20, y: 20, pressure: 0.5, t: Date.now() },
      { x: 30, y: 15, pressure: 0.5, t: Date.now() },
    ],
  });
  await sleep(250);
  bSock.emit('stroke_end', { sessionId: ind, strokeId: brunoStrokeId });
  await sleep(350);

  check('el autor recibe su propio draft', bDrafts.received.length > 0, `${bDrafts.received.length} batches`);
  check('el autor recibe su stroke_broadcast', bBroadcasts.received.length === 1);
  check(
    'el draft trae el estilo del trazo',
    bDrafts.received[0]?.color === '#ff0000' && bDrafts.received[0]?.brushSize === 5,
    JSON.stringify({ c: bDrafts.received[0]?.color, b: bDrafts.received[0]?.brushSize }),
  );
  check(
    'el creador del espacio ve el trazo ajeno (sala :watch)',
    aBroadcasts.received.some((p) => p?.stroke?.id === brunoStrokeId),
    `${aBroadcasts.received.length} recibidos`,
  );
  check(
    'un tercero NO ve el canvas ajeno en INDIVIDUAL',
    cDrafts.received.length === 0 && cBroadcasts.received.length === 0,
    `${cDrafts.received.length} drafts, ${cBroadcasts.received.length} commits`,
  );

  // El creador sí debe haberlo recibido por la sala :watch.
  check(
    'el creador ve el trazo ajeno vía :watch',
    aBroadcasts.received.some((p) => p?.stroke?.id === brunoStrokeId),
  );

  const ownStrokes = await rest(`/sessions/${ind}/strokes?limit=50`, { token: bruno.accessToken });
  check('el trazo quedó persistido', ownStrokes.strokes.some((s) => s.id === brunoStrokeId));

  const creatorStrokes = await rest(`/sessions/${ind}/strokes?limit=50`, { token: alice.accessToken });
  check(
    'el creador puede listar los trazos de todos',
    creatorStrokes.strokes.some((s) => s.id === brunoStrokeId),
    `${creatorStrokes.strokes.length} trazos`,
  );

  const forbidden = await fetch(`${API}/sessions/${ind}/strokes?userId=${cState.viewer.userId}`, {
    headers: { Authorization: `Bearer ${bruno.accessToken}` },
  });
  check('Bruno no puede leer el canvas de Carla', forbidden.status === 403, `status ${forbidden.status}`);

  aSock.disconnect();
  bSock.disconnect();
  cSock.disconnect();

  // ─── LAYERED ──────────────────────────────────────────────────────────────
  console.log('\n─── LAYERED: canvas compartido ───');
  const lay = byMode.LAYERED.id;
  await rest(`/sessions/${lay}/join`, { method: 'POST', token: bruno.accessToken });
  await rest(`/sessions/${lay}/join`, { method: 'POST', token: caro.accessToken });

  const lA = connect(alice.accessToken);
  const lB = connect(bruno.accessToken);
  const lC = connect(caro.accessToken);
  await Promise.all([once(lA, 'connect'), once(lB, 'connect'), once(lC, 'connect')]);

  const lAState = once(lA, 'session_state_sync');
  const lBState = once(lB, 'session_state_sync');
  const lCState = once(lC, 'session_state_sync');
  lA.emit('join_session', { sessionId: lay });
  lB.emit('join_session', { sessionId: lay });
  lC.emit('join_session', { sessionId: lay });
  const [lsA, lsB, lsC] = await Promise.all([lAState, lBState, lCState]);

  check('visibleUserIds es null en LAYERED', lsA.visibleUserIds === null);
  check('cada quien tiene capa asignada', Boolean(lsB.viewer.assignedLayerId && lsC.viewer.assignedLayerId));
  check(
    'las capas asignadas son distintas',
    lsB.viewer.assignedLayerId !== lsC.viewer.assignedLayerId,
    `${lsB.viewer.assignedLayerId} vs ${lsC.viewer.assignedLayerId}`,
  );

  const cL = collect(lC, 'stroke_draft', 0);
  const cLStroke = collect(lC, 'stroke_broadcast', 0);

  const layStrokeId = `e2e_lay_${Date.now().toString(36)}`;
  // Carla intenta dibujar sobre la capa de Bruno: el servidor debe ignorarla.
  lC.emit('stroke_start', {
    sessionId: lay,
    strokeId: layStrokeId,
    layerId: lsB.viewer.assignedLayerId,
    color: '#00ff00',
    brushSize: 8,
    tool: 'pen',
  });
  await sleep(120);
  lC.emit('stroke_points', {
    sessionId: lay,
    strokeId: layStrokeId,
    points: [
      { x: 1, y: 1, pressure: 0.5, t: Date.now() },
      { x: 2, y: 2, pressure: 0.5, t: Date.now() },
    ],
  });
  await sleep(250);
  lC.emit('stroke_end', { sessionId: lay, strokeId: layStrokeId });
  await sleep(350);

  check('en LAYERED el trazo se difunde a la sala', cLStroke.received.length === 1);
  check(
    'el servidor redirigió el trazo a la capa propia de Carla',
    cLStroke.received[0]?.stroke?.layerId === lsC.viewer.assignedLayerId,
    `${cLStroke.received[0]?.stroke?.layerId} vs pedido ${lsB.viewer.assignedLayerId}`,
  );

  // ─── FREE ─────────────────────────────────────────────────────────────────
  console.log('\n─── FREE: capas compartidas + lock ───');
  const free = byMode.FREE.id;
  await rest(`/sessions/${free}/join`, { method: 'POST', token: bruno.accessToken });
  await rest(`/sessions/${free}/join`, { method: 'POST', token: caro.accessToken });

  const fB = connect(bruno.accessToken);
  const fC = connect(caro.accessToken);
  await Promise.all([once(fB, 'connect'), once(fC, 'connect')]);

  const fsB = once(fB, 'session_state_sync');
  const fsC = once(fC, 'session_state_sync');
  fB.emit('join_session', { sessionId: free });
  fC.emit('join_session', { sessionId: free });
  const [fStateB, fStateC] = await Promise.all([fsB, fsC]);
  check('FREE expone las capas a todos', fStateB.layers.length > 0);

  const targetLayer = fStateB.layers[0].id;
  const lockSeen = collect(fC, 'layer_lock_update', 0);
  fB.emit('layer_switch', { sessionId: free, layerId: targetLayer });
  await sleep(300);
  check('el cambio de capa emite lock a la sala', lockSeen.received.length >= 1);
  check(
    'el lock es del usuario que lo tomó',
    lockSeen.received[0]?.holder?.userId === fStateB.viewer.userId,
    JSON.stringify(lockSeen.received[0]?.holder?.name),
  );

  const badSwitch = once(fB, 'error', 2000).catch(() => null);
  fB.emit('layer_switch', { sessionId: free, layerId: 'capa-inexistente' });
  const err = await badSwitch;
  check('cambiar a una capa ajena se rechaza', Boolean(err), err ? 'error recibido' : 'sin error');

  fB.disconnect();
  fC.disconnect();
  lA.disconnect();
  lB.disconnect();
  lC.disconnect();

  // ─── Undo ────────────────────────────────────────────────────────────────
  console.log('\n─── undo/redo ───');
  const uSock = connect(bruno.accessToken);
  await once(uSock, 'connect');
  const uState = once(uSock, 'session_state_sync');
  uSock.emit('join_session', { sessionId: ind });
  await uState;

  const removedSeen = once(uSock, 'stroke_removed', 3000).catch(() => null);
  uSock.emit('undo', { sessionId: ind, strokeId: brunoStrokeId });
  const removed = await removedSeen;
  check('undo emite stroke_removed', removed?.strokeId === brunoStrokeId);

  const afterUndo = await rest(`/sessions/${ind}/strokes?limit=50`, { token: bruno.accessToken });
  check('el trazo deshecho desaparece del historial', !afterUndo.strokes.some((s) => s.id === brunoStrokeId));

  const redoneSeen = once(uSock, 'stroke_broadcast', 3000).catch(() => null);
  uSock.emit('redo', { sessionId: ind, strokeId: brunoStrokeId });
  const redone = await redoneSeen;
  check('redo vuelve a emitir el trazo', redone?.stroke?.id === brunoStrokeId);

  const foreignUndo = once(uSock, 'error', 2000).catch(() => null);
  uSock.emit('undo', { sessionId: ind, strokeId: 'no-existe' });
  check('undo sobre un id ajeno se rechaza', Boolean(await foreignUndo));

  uSock.disconnect();

  // ───isolate: nadie sin token ────────────────────────────────────────────
  console.log('\n─── auth ───');
  const anon = connect(null);
  const anonErr = await once(anon, 'error', 3000).catch(() => null);
  check('socket sin token es rechazado', anonErr !== null, anonErr?.message ?? 'sin error');
  anon.disconnect();

  const badRest = await fetch(`${API}/sessions/${ind}`, {
    headers: { Authorization: 'Bearer no-es-un-jwt' },
  });
  check('REST con token inválido da 401', badRest.status === 401, `status ${badRest.status}`);

  // ─── FREE no se premia ───────────────────────────────────────────────────
  console.log('\n─── premios ───');
  const brunoId = await me(bruno.accessToken);
  const prizeSession = await rest(`/spaces/${space.id}/sessions`, {
    method: 'POST',
    token: alice.accessToken,
    body: { title: 'Sesión para probar premios', mode: 'INDIVIDUAL' },
  });
  await rest(`/sessions/${prizeSession.id}/join`, { method: 'POST', token: bruno.accessToken });
  await rest(`/sessions/${prizeSession.id}`, {
    method: 'PATCH',
    token: alice.accessToken,
    body: { status: 'OPEN' },
  });

  const winnersOk = await rest(`/sessions/${prizeSession.id}/winners`, {
    method: 'PUT',
    token: alice.accessToken,
    body: { winners: [{ userId: brunoId, position: 1 }] },
  });
  check('se pueden elegir ganadores', winnersOk.length === 1 && winnersOk[0].points > 0, `${winnersOk[0]?.points} pts`);

  const ranking = await rest(`/ranking/space/${space.id}?page=1&pageSize=10`, { token: alice.accessToken });
  check(
    'el ranking refleja los puntos',
    ranking.entries.some((e) => e.user.id === brunoId && e.goldCount >= 1 && e.totalPoints > 0),
    JSON.stringify(ranking.entries.map((e) => [e.user.name, e.totalPoints, e.goldCount])),
  );

  const cachedRanking = await rest(`/ranking/space/${space.id}?page=1&pageSize=10`, { token: alice.accessToken });
  check('el segundo request viene de caché', cachedRanking.cached === true);

  const replace = await rest(`/sessions/${prizeSession.id}/winners`, {
    method: 'PUT',
    token: alice.accessToken,
    body: { winners: [{ userId: brunoId, position: 1 }], replace: true },
  }).catch((e) => e);
  check(
    'replace=true vuelve a repartir sin duplicar',
    Array.isArray(replace) && replace.length === 1,
    Array.isArray(replace) ? `${replace.length} ganador(es)` : `status ${replace.status}`,
  );

  const noReplace = await rest(`/sessions/${prizeSession.id}/winners`, {
    method: 'PUT',
    token: alice.accessToken,
    body: { winners: [{ userId: brunoId, position: 1 }], replace: false },
  }).catch((e) => e);
  check('sin replace se rechaza', noReplace.status === 400, `status ${noReplace.status}`);

  const freeWinners = await rest(`/sessions/${free}/winners`, {
    method: 'PUT',
    token: alice.accessToken,
    body: { winners: [{ userId: brunoId, position: 1 }] },
  }).catch((e) => e);
  check('el modo FREE no se premia', freeWinners.status === 400, freeWinners.message);

  const nonOwner = await rest(`/sessions/${prizeSession.id}/winners`, {
    method: 'PUT',
    token: bruno.accessToken,
    body: { winners: [{ userId: brunoId, position: 1 }] },
  }).catch((e) => e);
  check('un no-creador no elige ganadores', nonOwner.status === 403, `status ${nonOwner.status}`);

  await rest(`/sessions/${prizeSession.id}`, { method: 'DELETE', token: alice.accessToken });

  console.log(`\n${failures === 0 ? 'TODO OK' : `${failures} FALLAS`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function me(token) {
  return (await rest('/auth/me', { token })).id;
}

main().catch((err) => {
  console.error('\nERROR FATAL:', err.message);
  process.exit(1);
});
