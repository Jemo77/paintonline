'use client';

import { useCallback, useEffect, useRef } from 'react';
import { createSessionSocket, type DrawSocket, type StrokeStyle } from '@/lib/socket';
import { useCanvasStore } from '@/store/canvasStore';
import type { PresenceEntry, Stroke, StrokePoint, Tool } from '@/types';

/**
 * Batching de puntos.
 *
 * Enviar un evento WebSocket por punto multiplica el tráfico sin ganar nada:
 * a 120 Hz eso son 120 viajes de ida y vuelta por segundo. Se agrupan los
 * puntos que llegaron en el mismo frame y se manda un array.
 */
const BATCH_INTERVAL_MS = 24; // ~42 eventos/segundo, muy por debajo del límite
/** Margen para el ack del último batch antes de cerrar el trazo. */
const ACK_TIMEOUT_MS = 1500;

/**
 * Errores del servidor que no son un problema para quien dibuja.
 *
 * "Trazo inexistente o ajeno" aparece cuando el `stroke_start` original no
 * llegó a abrirse (lock de capa, rate limit, una reconexión en medio del
 * trazo). El dibujo es recuperable: se reabre el trazo y se sigue. Antes
 * este error se le mostraba al usuario y el trazo se perdía entero.
 */
const RECOVERABLE_STROKE_ERRORS = [
  'trazo inexistente',
  'trazo ya estaba abierto',
  'ese trazo ya estaba abierto',
];

function isRecoverableStrokeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return RECOVERABLE_STROKE_ERRORS.some((fragment) => normalized.includes(fragment));
}

export interface UseCanvasSyncOptions {
  sessionId: string;
  /** El creador no dibuja: sólo mira. */
  readOnly?: boolean;
  onSessionClosed?: () => void;
  onError?: (message: string) => void;
}

export function useCanvasSync(options: UseCanvasSyncOptions) {
  const { sessionId, readOnly = false, onSessionClosed, onError } = options;

  const socketRef = useRef<DrawSocket | null>(null);
  const pendingPoints = useRef<Map<string, StrokePoint[]>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeStrokeRef = useRef<{ strokeId: string; layerId: string | null } | null>(null);
  /**
   * Estilo del trazo en curso. Se guarda aparte porque hace falta para
   * reabrirlo si el servidor lo rechaza (ver `reopenStroke`), y el store puede
   * haber cambiado de color a mitad de trazo.
   */
  const activeStrokeStyle = useRef<StrokeStyle>({ color: '#111827', brushSize: 4, tool: 'pen' });

  // El socket vive en refs para que los handlers no cambien de identidad en
  // cada render: si no, se reconectaría en loop.
  const callbacks = useRef({ onSessionClosed, onError });
  callbacks.current = { onSessionClosed, onError };

  useEffect(() => {
    if (!sessionId) return;

    const store = useCanvasStore.getState();
    // El modo sólo se conoce después del join; se usa el del store.
    const mode = store.mode;

    const socket = createSessionSocket(sessionId, mode, {
      onState: (payload: never) => {
        useCanvasStore.getState().hydrate(payload as never);
      },

      /**
       * Trazo en vivo de otra persona. Se fusiona con lo que ya haya en el
       * store para que la línea se vea continua mientras llega por partes.
       */
      onDraft: (payload) => {
        const state = useCanvasStore.getState();
        const existing = state.live[payload.strokeId];

        if (existing) {
          state.appendPoints(payload.strokeId, payload.points);
          return;
        }

        // El `stroke_draft` puede llegar antes que el `stroke_started`.
        state.beginStroke({
          strokeId: payload.strokeId,
          userId: payload.userId,
          layerId: payload.layerId,
          color: payload.color,
          brushSize: payload.brushSize,
          tool: payload.tool,
          points: payload.points,
        });
      },

      /** Trazo confirmado: pasa a formar parte del historial persistido. */
      onStroke: (payload) => {
        const stroke = (payload as { stroke: Stroke }).stroke;
        if (!stroke) return;
        useCanvasStore.getState().commitStroke(stroke);
      },

      onRemoved: (payload) => {
        const state = useCanvasStore.getState();
        // Sólo se saca del historial si está confirmado; si era un trazo en
        // vivo que se abortó, alcanza con limpiar `live`.
        state.removeStroke(payload.strokeId);
        state.dropStroke(payload.strokeId);
      },

      onPresence: (payload) => {
        useCanvasStore.getState().setPresence(payload.users as PresenceEntry[]);
      },

      onLock: (payload) => {
        const state = useCanvasStore.getState();
        state.setLayerLock(
          payload.layerId,
          (payload.holder ?? null) as never,
        );
      },

      onClosed: () => {
        useCanvasStore.getState().setStatus('CLOSED');
        callbacks.current.onSessionClosed?.();
      },

      onError: (payload) => {
        // 'connection' no es un problema de dibujo: no interrumpe.
        if (payload.event === 'connection') return;

        // El servidor no conoce el trazo en curso. Es recuperable: se reabre
        // con el mismo id y el dibujo sigue, así que no se molesta al usuario.
        if (isRecoverableStrokeError(payload.message)) {
          const active = activeStrokeRef.current;
          if (active) {
            reopenStroke(active.strokeId, sessionId, activeStrokeStyle.current);
          }
          return;
        }

        callbacks.current.onError?.(payload.message);
      },

      onConnectionChange: (connected) => {
        useCanvasStore.getState().setConnected(connected);
      },
    });

    socketRef.current = socket;

    // Flush periódico del buffer de puntos.
    flushTimer.current = setInterval(() => {
      const active = socketRef.current;
      if (!active || pendingPoints.current.size === 0) return;

      const batch = new Map(pendingPoints.current);
      pendingPoints.current.clear();

      for (const [strokeId, points] of batch) {
        if (points.length === 0) continue;
        active.emit('stroke_points', { sessionId, strokeId, points });
      }
    }, BATCH_INTERVAL_MS);

    // Heartbeat de presencia: mantiene viva la entrada en Redis.
    const heartbeat = setInterval(() => {
      socketRef.current?.emit('heartbeat', { sessionId });
    }, 10_000);

    return () => {
      if (flushTimer.current) clearInterval(flushTimer.current);
      clearInterval(heartbeat);
      // Se sueltan los locks antes de cerrar el socket.
      const { activeLayerId } = useCanvasStore.getState();
      if (activeLayerId) {
        socketRef.current?.emit('release_layer_lock', {
          sessionId,
          layerId: activeLayerId,
        });
      }
      socketRef.current?.emit('leave_session', { sessionId });
      socketRef.current?.disconnect();
      socketRef.current = null;
      pendingPoints.current.clear();
      activeStrokeRef.current = null;
    };
  }, [sessionId]);

  // ── API de dibujo ────────────────────────────────────────────────────────

  const beginStroke = useCallback(
    (
      points: StrokePoint[],
      options: { color: string; brushSize: number; tool: Tool; layerId: string | null },
    ) => {
      const socket = socketRef.current;
      if (!socket) return null;

      // Id del cliente: evita esperar un round-trip antes del primer punto.
      const strokeId = `s_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;

      activeStrokeStyle.current = {
        color: options.color,
        brushSize: options.brushSize,
        tool: options.tool,
      };

      socket.emit('stroke_start', {
        sessionId,
        strokeId,
        layerId: options.layerId ?? undefined,
        color: options.color,
        brushSize: options.brushSize,
        tool: options.tool,
      });

      const state = useCanvasStore.getState();
      state.beginStroke({
        strokeId,
        userId: state.viewerId ?? '',
        layerId: options.layerId,
        color: options.color,
        brushSize: options.brushSize,
        tool: options.tool,
        points,
      });

      pendingPoints.current.set(strokeId, [...points]);
      activeStrokeRef.current = { strokeId, layerId: options.layerId };

      return strokeId;
    },
    [sessionId],
  );

  const addPoint = useCallback(
    (point: StrokePoint) => {
      const active = activeStrokeRef.current;
      if (!active) return;

      // Se ve al instante de forma local; la red sólo confirma después.
      useCanvasStore.getState().appendPoints(active.strokeId, [point]);

      const queue = pendingPoints.current.get(active.strokeId) ?? [];
      queue.push(point);
      pendingPoints.current.set(active.strokeId, queue);
    },
    [],
  );

  /**
   * Reabre un trazo que el servidor no conoce.
   *
   * Si el `stroke_start` original falló (lock de capa en FREE, rate limit,
   * una reconexión en medio) el servidor no tiene metadata del `strokeId` y
   * rechaza cada `stroke_points` con "Trazo inexistente o ajeno". Con esto el
   * dibujo continúa: se manda un `stroke_start` nuevo y se reintentan los
   * puntos que ya se habían acumulado. El trazo se dibuja normal y el error
   * deja de aparecer.
   */
  const reopenStroke = useCallback(
    (strokeId: string, sessionIdArg: string, style: StrokeStyle) => {
      const socket = socketRef.current;
      if (!socket) return false;
      socket.emit('stroke_start', {
        sessionId: sessionIdArg,
        strokeId,
        color: style.color,
        brushSize: style.brushSize,
        tool: style.tool,
      });
      return true;
    },
    [],
  );

  const endStroke = useCallback(() => {
    const active = activeStrokeRef.current;
    const socket = socketRef.current;
    if (!active) return;

    const queue = pendingPoints.current.get(active.strokeId) ?? [];
    pendingPoints.current.delete(active.strokeId);

    // Se manda el último batch con acknowledgement y recién ahí el cierre.
    // Socket.io no garantiza orden de procesamiento entre handlers del
    // servidor: si `stroke_end` se atiende antes que este `stroke_points`,
    // el trazo se commitea sin los últimos puntos y el dibujo queda truncado
    // (se perdía justo el tramo final de cada línea). Encadenar con el ack
    // obliga al servidor a haber guardado el batch antes de cerrar.
    const close = () => socket?.emit('stroke_end', { sessionId, strokeId: active.strokeId });

    if (socket && queue.length > 0) {
      socket.timeout(ACK_TIMEOUT_MS).emit(
        'stroke_points',
        { sessionId, strokeId: active.strokeId, points: queue },
        (err: Error | null) => {
          // Con timeout el punto se perdió, pero cerrar igual: si no, el trazo
          // queda abierto en el servidor hasta que expire el TTL.
          if (err) console.warn('stroke_points sin ack, cerrando igual', err.message);
          close();
        },
      );
    } else {
      close();
    }

    // El `stroke_broadcast` de confirmación es lo que lo mete al historial; acá
    // sólo se lo saca de `live` para no dibujarlo dos veces.
    useCanvasStore.getState().endStroke(active.strokeId);
    activeStrokeRef.current = null;
  }, [sessionId]);

  const undo = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const strokeId = useCanvasStore.getState().popUndo();
    if (!strokeId) return;
    socket.emit('undo', { sessionId, strokeId });
  }, [sessionId]);

  const redo = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const strokeId = useCanvasStore.getState().popRedo();
    if (!strokeId) return;
    socket.emit('redo', { sessionId, strokeId });
  }, [sessionId]);

  const switchLayer = useCallback(
    (layerId: string) => {
      useCanvasStore.getState().setActiveLayer(layerId);
      socketRef.current?.emit('layer_switch', { sessionId, layerId });
    },
    [sessionId],
  );

  return {
    beginStroke,
    addPoint,
    endStroke,
    undo,
    redo,
    switchLayer,
    readOnly,
  };
}
