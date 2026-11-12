import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

export interface PresenceEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** Room donde está el socket: define qué trazos ve. */
  room: string;
  joinedAt: number;
  lastSeen: number;
  drawing: boolean;
}

/**
 * Presencia en Redis, compartida entre instancias del gateway.
 *
 * Claves:
 *   presence:{sessionId}          hash  userId -> PresenceEntry
 *   presence:links:{sessionId}:{userId}  set  socketIds de ese usuario
 *
 * El hash tiene TTL holgado: si un proceso muere sin cerrar sus sockets, la
 * presencia de sus usuarios se cae sola en vez de quedar fantasma para siempre.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttlMs = config.get<number>('PRESENCE_TTL_MS', 30000);
  }

  private presenceKey(sessionId: string): string {
    return `presence:${sessionId}`;
  }

  private linksKey(sessionId: string, userId: string): string {
    return `presence:links:${sessionId}:${userId}`;
  }

  async add(
    sessionId: string,
    socketId: string,
    entry: Omit<PresenceEntry, 'joinedAt' | 'lastSeen'>,
  ): Promise<void> {
    const now = Date.now();
    const key = this.presenceKey(sessionId);

    await this.redis.client
      .multi()
      .sadd(this.linksKey(sessionId, entry.userId), socketId)
      .expire(this.linksKey(sessionId, entry.userId), Math.ceil(this.ttlMs / 1000) * 3)
      .hset(
        key,
        entry.userId,
        JSON.stringify({ ...entry, joinedAt: now, lastSeen: now }),
      )
      .expire(key, Math.ceil(this.ttlMs / 1000) * 3)
      .exec();

    await this.broadcastSnapshot(sessionId);
  }

  async touch(sessionId: string, userId: string): Promise<void> {
    const raw = await this.redis.client.hget(this.presenceKey(sessionId), userId);
    if (!raw) return;

    const entry = JSON.parse(raw) as PresenceEntry;
    entry.lastSeen = Date.now();

    await this.redis.client.hset(
      this.presenceKey(sessionId),
      userId,
      JSON.stringify(entry),
    );
  }

  async setDrawing(
    sessionId: string,
    userId: string,
    drawing: boolean,
  ): Promise<void> {
    const raw = await this.redis.client.hget(this.presenceKey(sessionId), userId);
    if (!raw) return;

    const entry = JSON.parse(raw) as PresenceEntry;
    entry.drawing = drawing;
    entry.lastSeen = Date.now();

    await this.redis.client.hset(
      this.presenceKey(sessionId),
      userId,
      JSON.stringify(entry),
    );
  }

  /**
   * Quita el socket. Sólo borra la presencia del usuario cuando se quedó sin
   * ningún socket abierto (pestañas múltiples no deben hacerlo desaparecer).
   */
  async remove(sessionId: string, userId: string, socketId: string): Promise<void> {
    const linksKey = this.linksKey(sessionId, userId);

    await this.redis.client.srem(linksKey, socketId);
    const remaining = await this.redis.client.scard(linksKey);

    if (remaining > 0) {
      await this.broadcastSnapshot(sessionId);
      return;
    }

    await this.redis.client.multi().srem(linksKey, socketId).hdel(this.presenceKey(sessionId), userId).exec();
    await this.redis.del(linksKey);
    await this.broadcastSnapshot(sessionId);
  }

  /** Lista de presentes, podando los que no mandan heartbeat. */
  async list(sessionId: string): Promise<PresenceEntry[]> {
    const all = await this.redis.hGetAll<PresenceEntry>(this.presenceKey(sessionId));
    const now = Date.now();

    const alive = Object.values(all).filter((e) => now - e.lastSeen <= this.ttlMs * 3);
    const stale = Object.values(all).filter((e) => now - e.lastSeen > this.ttlMs * 3);

    if (stale.length) {
      await this.redis.client.hdel(this.presenceKey(sessionId), ...stale.map((e) => e.userId));
      this.logger.debug(`Presencia podada en ${sessionId}: ${stale.length} entradas`);
    }

    return alive.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async count(sessionId: string): Promise<number> {
    return (await this.list(sessionId)).length;
  }

  /**
   * Publica el snapshot vía Redis pub/sub para que todas las instancias
   * Sumergan el evento `presence_update` a sus sockets.
   */
  private async broadcastSnapshot(sessionId: string): Promise<void> {
    const users = await this.list(sessionId);
    await this.redis.publisher.publish(
      `presence:events:${sessionId}`,
      JSON.stringify({ sessionId, users }),
    );
  }
}
