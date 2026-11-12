import type {
  AuthResult,
  Layer,
  Participant,
  RankingResponse,
  SessionDetail,
  SessionMode,
  SessionStatus,
  Space,
  SpaceMember,
  Stroke,
  User,
  UserScore,
  Winner,
} from '@/types';

/**
 * Base de la API.
 *
 * Vacío = mismo origen, que es lo que queremos por defecto: el frontend
 * proxea `/api` al backend (ver `rewrites` en `next.config.ts`), así el
 * navegador nunca necesita saber dónde vive el backend ni configurarse CORS.
 *
 * `NEXT_PUBLIC_API_URL` existe para el caso raro de que el frontend se sirva
 * en un host distinto al backend; entonces se pone la URL absoluta
 * (`https://api.example.com`) y hay que añadir ese origen a `CORS_ORIGINS`
 * del backend.
 */
const RAW_BASE_URL = process.env.NEXT_PUBLIC_API_URL?.trim() ?? '';

export const IS_SAME_ORIGIN_API =
  RAW_BASE_URL === '' || RAW_BASE_URL.startsWith('/') || RAW_BASE_URL.startsWith('.');

const BASE_URL = IS_SAME_ORIGIN_API ? '' : RAW_BASE_URL.replace(/\/+$/, '');

export const API_PREFIX = `${BASE_URL}/api`;

const ACCESS_KEY = 'paintonline.accessToken';
const REFRESH_KEY = 'paintonline.refreshToken';

export const tokenStore = {
  get access(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_KEY);
  },
  get refresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCESS_KEY, access);
    window.localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string | string[],
  ) {
    super(Array.isArray(message) ? message.join(', ') : message);
    this.name = 'ApiError';
  }
}

/** Se dispara cuando el refresh falla; el provider de auth cierra la sesión. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Un refresh a la vez. Sin esto, varias requests en paralelo que reciben 401
 * dispararían N refrescos y sólo uno ganaría: los otros tokens quedarían viejos.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;

      const data = (await res.json()) as AuthResult;
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Uso interno: evita el bucle infinito de reintentos tras un refresh. */
  _retry?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, _retry, headers, ...rest } = options;

  const res = await fetch(`${API_PREFIX}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(tokenStore.access ? { Authorization: `Bearer ${tokenStore.access}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  if (res.status === 401 && !_retry) {
    const renewed = await refreshSession();
    if (renewed) return request<T>(path, { ...options, _retry: true });
    tokenStore.clear();
    onUnauthorized?.();
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      payload?.message ?? `Error ${res.status}`,
    );
  }

  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body });
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

// ── Auth ────────────────────────────────────────────────────────────────────

export const authApi = {
  register: (input: {
    email: string;
    password: string;
    name: string;
    spaceSlug?: string;
  }) => post<AuthResult>('/auth/register', input),

  login: (email: string, password: string) =>
    post<AuthResult>('/auth/login', { email, password }),

  logout: () => post<void>('/auth/logout'),

  me: () => get<User>('/auth/me'),
};

// ── Spaces ──────────────────────────────────────────────────────────────────

export const spacesApi = {
  list: () => get<Space[]>('/spaces'),

  create: (input: { name: string; description?: string; slug?: string }) =>
    post<Space>('/spaces', input),

  get: (spaceId: string) => get<Space>(`/spaces/${spaceId}`),

  /** Vista pública (no requiere token). Es la que usa /join/[spaceSlug]. */
  publicBySlug: (slug: string) => get<Space>(`/spaces/public/${slug}`),

  members: (spaceId: string) => get<SpaceMember[]>(`/spaces/${spaceId}/members`),

  join: (spaceId: string) => post<Space>(`/spaces/${spaceId}/join`),

  leave: (spaceId: string) => post<{ success: boolean }>(`/spaces/${spaceId}/leave`),

  update: (spaceId: string, input: Partial<{ name: string; description: string; isPublic: boolean }>) =>
    patch<Space>(`/spaces/${spaceId}`, input),
};

// ── Sessions ────────────────────────────────────────────────────────────────

export const sessionsApi = {
  list: (spaceId: string) => get<SessionDetail[]>(`/spaces/${spaceId}/sessions`),

  create: (
    spaceId: string,
    input: {
      title: string;
      theme?: string;
      mode: SessionMode;
      layerCount?: number;
      maxParticipants?: number;
      canvasWidth?: number;
      canvasHeight?: number;
    },
  ) => post<SessionDetail>(`/spaces/${spaceId}/sessions`, input),

  get: (sessionId: string) => get<SessionDetail>(`/sessions/${sessionId}`),

  update: (sessionId: string, input: { status?: SessionStatus; title?: string; theme?: string }) =>
    patch<SessionDetail>(`/sessions/${sessionId}`, input),

  join: (sessionId: string) => post<SessionDetail>(`/sessions/${sessionId}/join`),

  leave: (sessionId: string) => post<{ success: boolean }>(`/sessions/${sessionId}/leave`),

  participants: (sessionId: string) => get<Participant[]>(`/sessions/${sessionId}/participants`),

  /**
   * Historial vectorial. El cliente lo repinta en Konva; de ahí sale el PNG
   * cuando el usuario descarga. El servidor nunca genera imágenes.
   */
  strokes: (sessionId: string, params?: { userId?: string; layerId?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.userId) query.set('userId', params.userId);
    if (params?.layerId) query.set('layerId', params.layerId);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return get<{ strokes: Stroke[]; hasMore: boolean; cursor: string | null }>(
      `/sessions/${sessionId}/strokes${qs ? `?${qs}` : ''}`,
    );
  },

  createLayer: (sessionId: string) => post<Layer>(`/sessions/${sessionId}/layers`),

  updateLayer: (
    sessionId: string,
    layerId: string,
    input: { name?: string; visible?: boolean; opacity?: number },
  ) => put<Layer>(`/sessions/${sessionId}/layers/${layerId}`, input),

  deleteLayer: (sessionId: string, layerId: string) =>
    del<{ success: boolean }>(`/sessions/${sessionId}/layers/${layerId}`),

  setWinners: (
    sessionId: string,
    winners: Array<{ userId: string; position: number }>,
    replace = true,
  ) => put<Winner[]>(`/sessions/${sessionId}/winners`, { winners, replace }),

  /** Sólo analítica: registra que hubo una descarga. Nunca la imagen. */
  logExport: (
    sessionId: string,
    scope: 'own_canvas' | 'combined' | 'single_layer',
  ) => post<{ success: boolean }>(`/sessions/${sessionId}/exports`, { scope }),
};

// ── Ranking ─────────────────────────────────────────────────────────────────

export const rankingApi = {
  forSpace: (spaceId: string, page = 1, pageSize = 25) =>
    get<RankingResponse>(`/ranking/space/${spaceId}?page=${page}&pageSize=${pageSize}`),

  global: (spaceId?: string, page = 1, pageSize = 25) => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (spaceId) qs.set('spaceId', spaceId);
    return get<RankingResponse>(`/ranking/global?${qs}`);
  },

  me: () => get<UserScore>('/ranking/me'),
};
