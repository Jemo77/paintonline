import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

export interface LayerLock {
  layerId: string;
  userId: string;
  socketId: string;
  name: string;
  acquiredAt: number;
  expiresAt: number;
}

export type LockResult =
  | { acquired: true; lock: LayerLock }
  | { acquired: false; lock: LayerLock };

/**
 * Lock optimista de capa para el modo FREE.
 *
 * No es un mutex estricto: es una señal de "estoy dibujando acá" con expiración
 * corta (5s). Si el cliente deja de refrescar, la capa se libera sola. Con
 * volumen bajo, la alternativa `last write wins` es perfectamente válida y
 * `LAYER_LOCK_STRICT=false` la deja disponible.
 */
@Injectable()
export class LayerLockService {
  private readonly logger = new Logger(LayerLockService.name);
  private readonly ttlMs: number;
  readonly strict: boolean;

  /** Libera sólo si el lock sigue siendo del socket que lo tomó (evita robos). */
  private static readonly RELEASE_LUA = `
    if redis.call("GET", KEYS[1]) == false then return 0 end
    local current = cjson.decode(redis.call("GET", KEYS[1]))
    if current.socketId == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;

  private static readonly REFRESH_LUA = `
    if redis.call("GET", KEYS[1]) == false then return 0 end
    local current = cjson.decode(redis.call("GET", KEYS[1]))
    if current.socketId == ARGV[1] then
      current.expiresAt = tonumber(ARGV[2])
      redis.call("SET", KEYS[1], cjson.encode(current), "PX", ARGV[2])
      return 1
    end
    return 0
  `;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttlMs = config.get<number>('LAYER_LOCK_TTL_MS', 5000);
    this.strict = config.get<boolean>('LAYER_LOCK_STRICT', false);
  }

  private key(layerId: string): string {
    return `lock:layer:${layerId}`;
  }

  async acquire(
    layerId: string,
    userId: string,
    socketId: string,
    name: string,
  ): Promise<LockResult> {
    const lock: LayerLock = {
      layerId,
      userId,
      socketId,
      name,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };

    const ok = await this.redis.client.set(
      this.key(layerId),
      JSON.stringify(lock),
      'PX',
      this.ttlMs,
      'NX',
    );

    if (ok === 'OK') {
      return { acquired: true, lock };
    }

    const holder = await this.get(layerId);

    // Reentrante: el mismo usuario puede renovar su propio lock.
    if (holder && holder.userId === userId) {
      await this.refresh(layerId, socketId);
      const refreshed = await this.get(layerId);
      return { acquired: true, lock: refreshed ?? lock };
    }

    this.logger.debug(`Capa ${layerId} tomada por ${holder?.userId ?? '?'}`);
    return { acquired: false, lock: holder ?? lock };
  }

  async refresh(layerId: string, socketId: string): Promise<boolean> {
    const result = await this.redis.client.eval(
      LayerLockService.REFRESH_LUA,
      1,
      this.key(layerId),
      socketId,
      String(this.ttlMs),
    );
    return result === 1;
  }

  async release(layerId: string, socketId: string): Promise<boolean> {
    const result = await this.redis.client.eval(
      LayerLockService.RELEASE_LUA,
      1,
      this.key(layerId),
      socketId,
    );
    return result === 1;
  }

  async get(layerId: string): Promise<LayerLock | null> {
    const raw = await this.redis.client.get(this.key(layerId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LayerLock;
    } catch {
      return null;
    }
  }

  async list(sessionLayerIds: string[]): Promise<Record<string, LayerLock | null>> {
    if (sessionLayerIds.length === 0) return {};
    const pipeline = this.redis.client.pipeline();
    for (const id of sessionLayerIds) pipeline.get(this.key(id));
    const results = await pipeline.exec();

    const out: Record<string, LayerLock | null> = {};
    sessionLayerIds.forEach((id, i) => {
      const raw = results?.[i]?.[1] as string | null | undefined;
      out[id] = raw ? (safeParse(raw) as LayerLock) : null;
    });
    return out;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
