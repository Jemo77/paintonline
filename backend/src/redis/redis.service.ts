import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export type RedisClient = Redis;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /** Cliente principal: comandos, buffers, presencia, locks y cache. */
  readonly client: Redis;

  /** Cliente dedicado a pub/sub (ioredis no comparte conexión entre modos). */
  readonly publisher: Redis;

  readonly url: string;

  constructor(config: ConfigService) {
    this.url = config.get<string>('REDIS_URL', 'redis://localhost:6379');

    this.client = new Redis(this.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.publisher = new Redis(this.url, { maxRetriesPerRequest: null });

    this.client.on('error', (err) => this.logger.error(`Redis: ${err.message}`));
    this.publisher.on('error', (err) => this.logger.error(`Redis pub: ${err.message}`));
  }

  /**
   * Cliente adicional para los consumidores que no pueden compartir conexión
   * con el principal (pub/sub y el adapter de socket.io).
   *
   * Devuelve el cliente ya conectando, no una promesa a propósito: el
   * `IoAdapter.createIOServer` de Nest es síncrono y encadena `.of(namespace)`
   * sobre lo que devuelve, así que no puede esperar un `await`.
   */
  createAuxClient(): Redis {
    const aux = this.client.duplicate({ maxRetriesPerRequest: null });
    aux.on('error', (err) => this.logger.error(`Redis aux: ${err.message}`));
    return aux;
  }

  // ── Helpers de hash usados por presencia ────────────────────────────────
  async hSet(key: string, field: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.multi().hset(key, field, value).expire(key, ttlSeconds).exec();
  }
  async hGetAll<T = string>(key: string): Promise<Record<string, T>> {
    const raw = await this.client.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return {};
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => {
        try {
          return [k, JSON.parse(v) as T];
        } catch {
          return [k, v as unknown as T];
        }
      }),
    );
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.publisher.quit()]);
  }
}
