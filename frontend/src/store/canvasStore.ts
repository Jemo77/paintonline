import { create } from 'zustand';
import type {
  Layer,
  LayerLock,
  Participant,
  PresenceEntry,
  SessionMode,
  SessionStatus,
  Stroke,
  StrokePoint,
  Tool,
} from '@/types';

/**
 * Trazo en curso, sólo local. Vive fuera de `strokes` porque todavía no
 * pertenece a la sesión: se emite al servidor y recién al confirmarse
 * (`stroke_broadcast`) pasa a ser historial.
 */
export interface LiveStroke {
  strokeId: string;
  userId: string;
  layerId: string | null;
  color: string;
  brushSize: number;
  tool: Tool;
  points: StrokePoint[];
}

interface CanvasState {
  // ── Sesión ──────────────────────────────────────────────────────────────
  sessionId: string | null;
  mode: SessionMode;
  status: SessionStatus;
  title: string;
  theme: string | null;
  canvasWidth: number;
  canvasHeight: number;
  spaceOwnerId: string | null;
  connected: boolean;

  // ── Colecciones ─────────────────────────────────────────────────────────
  layers: Layer[];
  participants: Participant[];
  presence: PresenceEntry[];
  locks: Record<string, LayerLock | null>;

  /**
   * Trazos confirmados, indexados por id para repintar rápido y para que
   * undo/redo sea una operación O(1).
   */
  strokes: Record<string, Stroke>;
  strokeOrder: string[];

  /** Trazos en vuelo (propios o ajenos) que aún no están persistidos. */
  live: Record<string, LiveStroke>;

  /** Sólo en INDIVIDUAL: array con [userId] de las miniaturas a mostrar. */
  visibleUserIds: string[] | null;

  // ── Permisos del viewer ─────────────────────────────────────────────────
  viewerId: string | null;
  isSpaceOwner: boolean;
  assignedLayerId: string | null;
  canDraw: boolean;

  // ── Configuración de dibujo ─────────────────────────────────────────────
  tool: Tool;
  color: string;
  brushSize: number;
  /** Capa activa. En FREE es elegible; en LAYERED la fuerza el servidor. */
  activeLayerId: string | null;

  // ── Historial de undo/redo (sólo trazos propios) ────────────────────────
  undoStack: string[];
  redoStack: string[];

  // ── Acciones ────────────────────────────────────────────────────────────
  hydrate: (payload: {
    session: {
      id: string;
      spaceId: string;
      title: string;
      theme: string | null;
      mode: SessionMode;
      status: SessionStatus;
      canvasWidth: number;
      canvasHeight: number;
      spaceOwnerId: string;
    };
    layers: Layer[];
    participants: Participant[];
    visibleUserIds: string[] | null;
    strokes: Stroke[];
    locks: Record<string, LayerLock | null>;
    viewer: {
      userId: string;
      isSpaceOwner: boolean;
      isParticipant: boolean;
      assignedLayerId: string | null;
      canDraw: boolean;
    };
    presence: PresenceEntry[];
  }) => void;

  setConnected: (connected: boolean) => void;
  setStatus: (status: SessionStatus) => void;

  beginStroke: (stroke: LiveStroke) => void;
  appendPoints: (strokeId: string, points: StrokePoint[]) => void;
  endStroke: (strokeId: string) => void;
  dropStroke: (strokeId: string) => void;

  commitStroke: (stroke: Stroke) => void;
  removeStroke: (strokeId: string) => void;

  setPresence: (users: PresenceEntry[]) => void;
  setLocks: (locks: Record<string, LayerLock | null>) => void;
  setLayerLock: (layerId: string, lock: LayerLock | null) => void;
  upsertLayer: (layer: Layer) => void;
  removeLayer: (layerId: string) => void;

  setTool: (tool: Tool) => void;
  setColor: (color: string) => void;
  setBrushSize: (size: number) => void;
  setActiveLayer: (layerId: string) => void;

  pushUndo: (strokeId: string) => void;
  popUndo: () => string | null;
  pushRedo: (strokeId: string) => void;
  popRedo: () => string | null;

  reset: () => void;
}

const initialState = {
  sessionId: null,
  mode: 'INDIVIDUAL' as SessionMode,
  status: 'DRAFT' as SessionStatus,
  title: '',
  theme: null,
  canvasWidth: 1920,
  canvasHeight: 1080,
  spaceOwnerId: null,
  connected: false,
  layers: [] as Layer[],
  participants: [] as Participant[],
  presence: [] as PresenceEntry[],
  locks: {} as Record<string, LayerLock | null>,
  strokes: {} as Record<string, Stroke>,
  strokeOrder: [] as string[],
  live: {} as Record<string, LiveStroke>,
  visibleUserIds: null as string[] | null,
  viewerId: null,
  isSpaceOwner: false,
  assignedLayerId: null,
  canDraw: false,
  tool: 'pen' as Tool,
  color: '#111827',
  brushSize: 6,
  activeLayerId: null,
  undoStack: [] as string[],
  redoStack: [] as string[],
};

export const useCanvasStore = create<CanvasState>((set, get) => ({
  ...initialState,

  /**
   * Reemplaza todo el estado tras un join o una reconexión.
   *
   * Se reconstruye el índice de trazos desde cero en vez de fusionar: en una
   * reconexión el servidor manda el historial completo y lo que había en
   * memoria puede estar desactualizado.
   */
  hydrate: (payload) => {
    const strokes: Record<string, Stroke> = {};
    const order: string[] = [];
    for (const stroke of payload.strokes) {
      strokes[stroke.id] = stroke;
      order.push(stroke.id);
    }

    const mode = payload.session.mode;

    set({
      sessionId: payload.session.id,
      mode,
      status: payload.session.status,
      title: payload.session.title,
      theme: payload.session.theme,
      canvasWidth: payload.session.canvasWidth,
      canvasHeight: payload.session.canvasHeight,
      spaceOwnerId: payload.session.spaceOwnerId,
      layers: payload.layers,
      participants: payload.participants,
      visibleUserIds: payload.visibleUserIds,
      locks: payload.locks ?? {},
      presence: payload.presence,
      strokes,
      strokeOrder: order,
      live: {},
      undoStack: [],
      redoStack: [],
      viewerId: payload.viewer.userId,
      isSpaceOwner: payload.viewer.isSpaceOwner,
      assignedLayerId: payload.viewer.assignedLayerId,
      canDraw: payload.viewer.canDraw,
      // LAYERED: la capa activa es siempre la asignada. FREE: la primera
      // visible. INDIVIDUAL: null (no hay capas).
      activeLayerId:
        mode === 'INDIVIDUAL'
          ? null
          : mode === 'LAYERED'
            ? payload.viewer.assignedLayerId
            : (payload.layers.find((l) => l.visible)?.id ?? null),
    });
  },

  setConnected: (connected) => set({ connected }),
  setStatus: (status) => set({ status }),

  beginStroke: (stroke) =>
    set((state) => ({
      live: { ...state.live, [stroke.strokeId]: stroke },
    })),

  appendPoints: (strokeId, points) =>
    set((state) => {
      const current = state.live[strokeId];
      if (!current) return state;
      return {
        live: {
          ...state.live,
          [strokeId]: { ...current, points: [...current.points, ...points] },
        },
      };
    }),

  endStroke: (strokeId) =>
    set((state) => {
      const live = { ...state.live };
      delete live[strokeId];
      return { live };
    }),

  /** Descarta un trazo que nunca llegó a confirmarse. */
  dropStroke: (strokeId) => get().endStroke(strokeId),

  /**
   * Un trazo pasó a estar persistido. Se saca de `live` y entra en el
   * historial: a partir de acá ya se puede hacer undo sobre él.
   */
  commitStroke: (stroke) =>
    set((state) => {
      const live = { ...state.live };
      delete live[stroke.id];

      if (state.strokes[stroke.id]) {
        return { live };
      }

      return {
        live,
        strokes: { ...state.strokes, [stroke.id]: stroke },
        strokeOrder: [...state.strokeOrder, stroke.id],
      };
    }),

  removeStroke: (strokeId) =>
    set((state) => {
      if (!state.strokes[strokeId]) return state;
      const strokes = { ...state.strokes };
      delete strokes[strokeId];
      return {
        strokes,
        strokeOrder: state.strokeOrder.filter((id) => id !== strokeId),
      };
    }),

  setPresence: (users) => set({ presence: users }),

  setLocks: (locks) => set({ locks }),

  setLayerLock: (layerId, lock) =>
    set((state) => ({ locks: { ...state.locks, [layerId]: lock } })),

  upsertLayer: (layer) =>
    set((state) => {
      const exists = state.layers.some((l) => l.id === layer.id);
      return {
        layers: exists
          ? state.layers.map((l) => (l.id === layer.id ? layer : l))
          : [...state.layers, layer].sort((a, b) => a.order - b.order),
      };
    }),

  removeLayer: (layerId) =>
    set((state) => ({
      layers: state.layers.filter((l) => l.id !== layerId),
      activeLayerId: state.activeLayerId === layerId ? null : state.activeLayerId,
    })),

  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setBrushSize: (brushSize) => set({ brushSize }),

  setActiveLayer: (layerId) => set({ activeLayerId: layerId }),

  pushUndo: (strokeId) =>
    set((state) => ({
      undoStack: [...state.undoStack, strokeId],
      // Un trazo nuevo invalida la rama de redo.
      redoStack: [],
    })),

  popUndo: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return null;
    const last = undoStack[undoStack.length - 1];
    set({ undoStack: undoStack.slice(0, -1) });
    return last;
  },

  pushRedo: (strokeId) =>
    set((state) => ({ redoStack: [...state.redoStack, strokeId] })),

  popRedo: () => {
    const { redoStack } = get();
    if (redoStack.length === 0) return null;
    const last = redoStack[redoStack.length - 1];
    set({ redoStack: redoStack.slice(0, -1) });
    return last;
  },

  reset: () => set({ ...initialState }),
}));

/**
 * Trazos que unStage debe pintar, ya filtrados por las reglas del modo.
 *
 *  INDIVIDUAL → sólo los del userId pedido (el mío, o cada miniatura del creador)
 *  LAYERED/FREE → todos, agrupados por capa
 */
export function selectStrokesForCanvas(
  state: CanvasState,
  targetUserId?: string,
): Stroke[] {
  const all = state.strokeOrder
    .map((id) => state.strokes[id])
    .filter((s): s is Stroke => Boolean(s));

  if (state.mode === 'INDIVIDUAL') {
    const wanted = targetUserId ?? state.viewerId;
    if (!wanted) return [];
    return all.filter((s) => s.userId === wanted);
  }

  return all;
}

export function selectLiveForCanvas(
  state: CanvasState,
  targetUserId?: string,
): LiveStroke[] {
  const all = Object.values(state.live);
  if (state.mode === 'INDIVIDUAL') {
    const wanted = targetUserId ?? state.viewerId;
    if (!wanted) return [];
    return all.filter((s) => s.userId === wanted);
  }
  return all;
}
