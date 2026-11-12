import { io, type Socket } from 'socket.io-client';
import { tokenStore } from './api';
import type { SessionMode, StrokePoint, Tool } from '@/types';

/**
 * Origen del gateway de dibujo.
 *
 * Por defecto el socket se conecta al mismo origen que la página y usa el
 * path `/socket.io` que Next proxea al backend, así el túnel de Cloudflare
 * (o cualquier otro host) no necesita exponer el backend por separado.
 *
 * `NEXT_PUBLIC_WS_URL` / `NEXT_PUBLIC_API_URL` absolutos siguen funcionando
 * para despliegues con hosts separados; ahí el backend tiene que permitir el
 * origen del frontend en `CORS_ORIGINS`.
 */
function resolveWsOrigin(): string {
  const raw = (
    process.env.NEXT_PUBLIC_WS_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    ''
  ).replace(/\/+$/, '');

  if (/^https?:\/\//i.test(raw)) return raw;
  return '';
}

/**
 * Origen efectivo del gateway.
 *
 * `createSessionSocket` sólo se llama desde efectos del cliente, así que
 * `window.location.origin` está siempre disponible: el socket va al mismo
 * origen que la página y el túnel alcanza el backend por el proxy. El último
 * retorno es un guard para que el módulo no rompa al importarse en el servidor
 * (socket.io no resuelve un origen relativo sin `location`).
 */
function wsEndpoint(): string {
  const configured = resolveWsOrigin();
  if (configured) return `${configured}/session`;
  if (typeof window !== 'undefined') return `${window.location.origin}/session`;
  return 'http://localhost:3001/session';
}

/** Estilo de un trazo en vuelo. Viaja con cada batch de puntos. */
export interface StrokeStyle {
  color: string;
  brushSize: number;
  tool: Tool;
}

/** Eventos que el cliente emite hacia el servidor. */
export interface ClientToServer {
  join_session: (payload: { sessionId: string }) => void;
  leave_session: (payload: { sessionId: string }) => void;
  stroke_start: (payload: {
    sessionId: string;
    strokeId?: string;
    layerId?: string;
    color: string;
    brushSize: number;
    tool: Tool;
  }) => void;
  /**
   * El servidor acusa recibo de cada batch. Se usa con acknowledgement
   * (`emit(..., cb)`) para encadenar el `stroke_end` detrás del último
   * `stroke_points`; ver `endStroke` en `useCanvasSync`.
   *
   * Con `socket.timeout(...)` el callback recibe primero el error de timeout
   * (o `null`) y después la respuesta del servidor.
   */
  stroke_points: (
    payload: {
      sessionId: string;
      strokeId: string;
      points: StrokePoint[];
    },
    ack?: (
      err: Error | null,
      response?: { strokeId: string; count: number; dropped?: boolean },
    ) => void,
  ) => void;
  stroke_end: (payload: { sessionId: string; strokeId: string }) => void;
  stroke_abort: (payload: { sessionId: string; strokeId: string }) => void;
  undo: (payload: { sessionId: string; strokeId?: string }) => void;
  redo: (payload: { sessionId: string; strokeId?: string }) => void;
  layer_switch: (payload: { sessionId: string; layerId: string }) => void;
  release_layer_lock: (payload: { sessionId: string; layerId: string }) => void;
  heartbeat: (payload: { sessionId: string }) => void;
}

/** Eventos que el servidor emite hacia el cliente. */
export interface ServerToClient {
  session_state_sync: (payload: unknown) => void;
  stroke_started: (payload: StrokeStyle & {
    strokeId: string;
    userId: string;
    layerId: string | null;
  }) => void;
  stroke_draft: (payload: StrokeStyle & {
    strokeId: string;
    userId: string;
    layerId: string | null;
    points: StrokePoint[];
  }) => void;
  stroke_broadcast: (payload: { stroke: unknown; committed?: boolean }) => void;
  stroke_removed: (payload: { strokeId: string; userId: string; layerId: string | null }) => void;
  presence_update: (payload: { users: unknown[] }) => void;
  layer_lock_update: (payload: { layerId: string; holder: unknown; acquired: boolean }) => void;
  layer_changed: (payload: { layer: unknown }) => void;
  layer_removed: (payload: { layerId: string }) => void;
  winners_announced: (payload: { sessionId: string; winners: unknown[] }) => void;
  session_closed: (payload: { sessionId: string }) => void;
  session_updated: (payload: { sessionId: string; session: { status?: string } }) => void;
  error: (payload: { event: string; message: string }) => void;
  ack: (payload: unknown) => void;
  connect_error: (payload: { message: string }) => void;
}

type DrawSocket = Socket<ServerToClient, ClientToServer>;

/**
 * Un socket por sesión, sobre el namespace `/session`.
 *
 * El token viaja en el handshake (`auth.token`) y el backend valida la
 * identidad una sola vez. Si el access token se renueva mientras el socket está
 * abierto, se reconecta: la reconexión dispara `join_session` de nuevo y el
 * servidor reenvía el estado completo.
 *
 * `_mode` queda en la firma porque documenta el por qué: el enrutado de cada
 * trazo (autor + creador vs. sala entera) lo decide el servidor según el modo.
 */
export function createSessionSocket(
  sessionId: string,
  _mode: SessionMode,
  handlers: {
    onState: (payload: never) => void;
    onDraft?: (
      payload: StrokeStyle & {
        strokeId: string;
        userId: string;
        layerId: string | null;
        points: StrokePoint[];
      },
    ) => void;
    onStroke?: (payload: { stroke: unknown; committed?: boolean }) => void;
    onRemoved?: (payload: { strokeId: string; userId: string; layerId: string | null }) => void;
    onPresence?: (payload: { users: unknown[] }) => void;
    onLock?: (payload: { layerId: string; holder: unknown; acquired: boolean }) => void;
    onError?: (payload: { event: string; message: string }) => void;
    onClosed?: (payload: { sessionId: string }) => void;
    onConnectionChange?: (connected: boolean) => void;
  },
): DrawSocket {
  const socket: DrawSocket = io(wsEndpoint(), {
    auth: { token: tokenStore.access },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4000,
    // Si el backend reinició y la sesión ya no existe, no tiene sentido
    // reconectar en bucle.
    reconnectionAttempts: 20,
  });

  socket.on('connect', () => {
    handlers.onConnectionChange?.(true);
    socket.emit('join_session', { sessionId });
  });

  socket.on('disconnect', () => handlers.onConnectionChange?.(false));
  socket.on('connect_error', (err) => {
    handlers.onConnectionChange?.(false);
    // Mismo `event` que usa el gateway para "no autorizado": el hook lo ignora
    // porque un fallo de conexión es transitorio y lo resuelve la reconexión.
    handlers.onError?.({ event: 'connection', message: err.message });
  });

  socket.on('session_state_sync', handlers.onState as never);
  if (handlers.onDraft) socket.on('stroke_draft', handlers.onDraft);
  if (handlers.onStroke) socket.on('stroke_broadcast', handlers.onStroke);
  if (handlers.onRemoved) socket.on('stroke_removed', handlers.onRemoved);
  if (handlers.onPresence) socket.on('presence_update', handlers.onPresence);
  if (handlers.onLock) socket.on('layer_lock_update', handlers.onLock);
  if (handlers.onError) socket.on('error', handlers.onError);
  if (handlers.onClosed) socket.on('session_closed', handlers.onClosed);

  return socket;
}

export type { DrawSocket };
