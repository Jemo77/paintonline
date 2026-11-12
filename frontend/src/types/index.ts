export type Role = 'CREATOR' | 'VIEWER' | 'ADMIN';
export type SessionMode = 'INDIVIDUAL' | 'LAYERED' | 'FREE';
export type SessionStatus = 'DRAFT' | 'OPEN' | 'LIVE' | 'CLOSED' | 'ARCHIVED';
export type Tool = 'pen' | 'marker' | 'eraser' | 'line' | 'rect' | 'ellipse';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  ownerId: string;
  isPublic: boolean;
  scoringConfig: Record<string, number>;
  createdAt: string;
  owner?: { id: string; name: string; avatarUrl: string | null };
  membership?: { role: Role } | null;
  _count?: { members: number; sessions: number };
  sessions?: PublicSessionSummary[];
}

export interface PublicSessionSummary {
  id: string;
  title: string;
  theme: string | null;
  mode: SessionMode;
  status: SessionStatus;
  canvasWidth: number;
  canvasHeight: number;
  createdAt: string;
}

export interface Layer {
  id: string;
  sessionId: string;
  name: string;
  order: number;
  /** null = capa libre (modo FREE). seteado = capa asignada (modo LAYERED). */
  ownerUserId: string | null;
  visible: boolean;
  opacity: number;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

export interface Stroke {
  id: string;
  sessionId: string;
  layerId: string | null;
  userId: string;
  points: StrokePoint[];
  color: string;
  brushSize: number;
  tool: Tool;
  isErased: boolean;
  createdAt: string;
}

export interface Participant {
  id: string;
  sessionId: string;
  userId: string;
  layerId: string | null;
  isActive: boolean;
  joinedAt: string;
  user: { id: string; name: string; avatarUrl: string | null };
}

export interface SpaceMember {
  id: string;
  spaceId: string;
  userId: string;
  role: Role;
  joinedAt: string;
  user: {
    id: string;
    name: string;
    avatarUrl: string | null;
    score: { totalPoints: number; goldCount: number; silverCount: number; bronzeCount: number } | null;
  };
}

export interface Winner {
  id: string;
  sessionId: string;
  userId: string;
  position: number;
  points: number;
  user: { id: string; name: string; avatarUrl: string | null };
}

export interface SessionDetail {
  id: string;
  spaceId: string;
  title: string;
  theme: string | null;
  mode: SessionMode;
  status: SessionStatus;
  maxParticipants: number | null;
  startTime: string | null;
  endTime: string | null;
  canvasWidth: number;
  canvasHeight: number;
  createdAt: string;
  space: { id: string; name: string; slug: string; ownerId: string };
  layers: Layer[];
  participants: Participant[];
  winners: Winner[];
  /** Sólo en el listado por espacio. */
  _count?: { participants: number; layers: number; strokes: number };
  viewer: {
    userId: string;
    isSpaceOwner: boolean;
    isParticipant: boolean;
    /** Capa propia en LAYERED; null en INDIVIDUAL y FREE. */
    assignedLayerId: string | null;
  };
}

export interface PresenceEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  room: 'own' | 'watch' | 'room';
  joinedAt: number;
  lastSeen: number;
  drawing: boolean;
}

export interface LayerLock {
  layerId: string;
  userId: string;
  socketId: string;
  name: string;
  acquiredAt: number;
  expiresAt: number;
}

/** Payload de `session_state_sync`, la respuesta al join. */
export interface StateSync {
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
  /**
   * Sólo en INDIVIDUAL. `null` en LAYERED/FREE porque todos ven el mismo
   * canvas combinado. Cuando es un array, el cliente muestra miniatura para
   * cada userId listado.
   */
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
}

export interface RankingEntry {
  position: number;
  user: { id: string; name: string; avatarUrl: string | null };
  totalPoints: number;
  goldCount: number;
  silverCount: number;
  bronzeCount: number;
  isMember: boolean;
}

export interface RankingResponse {
  space?: { id: string; name: string };
  entries: RankingEntry[];
  page: number;
  pageSize: number;
  total: number;
  cached: boolean;
}

export interface UserScore {
  userId: string;
  totalPoints: number;
  goldCount: number;
  silverCount: number;
  bronzeCount: number;
}
