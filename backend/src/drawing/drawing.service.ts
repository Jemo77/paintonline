import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { SessionMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { StrokeDTO } from '../sessions/sessions.service';
import type { Tool } from './dto/gateway.dto';

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

export interface ActiveStrokeMeta {
  sessionId: string;
  layerId: string | null;
  userId: string;
  color: string;
  brushSize: number;
  tool: Tool;
  startedAt: number;
}

const BUFFER_PREFIX = 'stroke:buf:';
const META_PREFIX = 'stroke:meta:';
/** Un trazo sin `stroke_end` no debe quedar occupying memoria para siempre. */
const BUFFER_TTL_SECONDS = 300;

/**
 * Acumula puntos en el buffer de forma atómica.
 *
 * Todo el guionado va en un único script Lua porque los eventos de socket.io
 * se atienden concurrentemente. Con `EXISTS` + `LLEN` + `RPUSH` como
 * round-trips separados, un `stroke_end` podía intercalar su `DEL` entre el
 * chequeo y el `RPUSH`: el batch se escribía en un buffer ya borrado y esos
 * puntos se perdían del trazo, sin error visible. Redis ejecuta el script como
 * una unidad, así que o entra entero o no entra.
 *
 * - devuelve: {1} = appended, {2} = total, {3} = -1 si el trazo ya se cerró
 */
const APPEND_POINTS_LUA = `
-- ARGV[1] = maxPointsPerStroke, ARGV[2] = ttl, ARGV[3..] = puntos
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 0, -1}
end
local incoming = #ARGV - 2
local before = redis.call('LLEN', KEYS[2])
if before + incoming > tonumber(ARGV[1]) then
  return {0, before, 1}
end
local args = {}
for i = 3, #ARGV do
  args[#args + 1] = ARGV[i]
end
redis.call('RPUSH', KEYS[2], unpack(args))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return {incoming, before + incoming, 0}
`;

@Injectable()
export class DrawingService implements OnModuleDestroy {
  private readonly logger = new Logger(DrawingService.name);
  private readonly maxPointsPerStroke: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.maxPointsPerStroke = config.get<number>('MAX_POINTS_PER_STROKE', 20000);
  }

  // ── Rooms ────────────────────────────────────────────────────────────────
  // El routing por modo se resuelve con salas, no con ifs por socket:
  //   session:<id>        → todos los conectados (LAYERED / FREE)
  //   session:<id>:watch  → creador del espacio (ve TODOS los canvas INDIVIDUAL)
  //   user:<userId>       → todos los sockets de un usuario (su canvas propio)
  static sessionRoom(sessionId: string): string {
    return `session:${sessionId}`;
  }

  static watchRoom(sessionId: string): string {
    return `session:${sessionId}:watch`;
  }

  static userRoom(userId: string): string {
    return `user:${userId}`;
  }

  /**
   * Destinatarios de un trazo, según el modo. Éste es el corazón del sistema:
   *
   *   INDIVIDUAL → sólo el autor y el creador. Nadie más puede ver ese canvas,
   *                ni siquiera otros participantes de la misma sesión.
   *   LAYERED    → toda la sala. Cada quien ve el combinado en tiempo real.
   *   FREE       → toda la sala.
   */
  static broadcastTargets(
    mode: SessionMode,
    sessionId: string,
    authorUserId: string,
  ): { room: string; except?: string }[] {
    if (mode === 'INDIVIDUAL') {
      return [
        { room: DrawingService.userRoom(authorUserId) },
        { room: DrawingService.watchRoom(sessionId) },
      ];
    }
    return [{ room: DrawingService.sessionRoom(sessionId) }];
  }

  // ── Stroke lifecycle ─────────────────────────────────────────────────────

  /**
   * Abre un trazo. El buffer de puntos y la metadata viven en Redis (no en
   * memoria del proceso) para que cualquier instancia del gateway pueda
   * cerrar el trazo aunque haya pasado por otro nodo.
   */
  async beginStroke(strokeId: string, meta: ActiveStrokeMeta): Promise<boolean> {
    const already = await this.redis.client.exists(`${BUFFER_PREFIX}${strokeId}`);
    if (already) {
      this.logger.warn(`stroke_start duplicado para ${strokeId}`);
      return false;
    }

    const key = `${BUFFER_PREFIX}${strokeId}`;
    const metaKey = `${META_PREFIX}${strokeId}`;

    await this.redis.client
      .multi()
      .set(metaKey, JSON.stringify(meta), 'EX', BUFFER_TTL_SECONDS)
      .del(key)
      .exec();

    return true;
  }

  /**
   * Acumula puntos en el buffer. Todo el chequeo y el `RPUSH` ocurren en un
   * único script de Lua (ver `APPEND_POINTS_LUA`): es la única forma de que un
   * `stroke_end` concurrente no se coma el batch.
   *
   * `closed: true` significa que el trazo ya no está abierto —o sea, que
   * `stroke_end` corrió primero— y el batch se descarta a propósito.
   */
  async appendPoints(
    strokeId: string,
    points: StrokePoint[],
  ): Promise<{ appended: number; total: number; overflow: boolean; closed: boolean }> {
    const payload = points.map((p) => JSON.stringify(p));
    const [appended, total, flag] = (await this.redis.client.eval(
      APPEND_POINTS_LUA,
      2,
      `${META_PREFIX}${strokeId}`,
      `${BUFFER_PREFIX}${strokeId}`,
      String(this.maxPointsPerStroke),
      String(BUFFER_TTL_SECONDS),
      ...payload,
    )) as [number, number, number];

    return { appended, total, overflow: flag === 1, closed: flag === -1 };
  }

  /**
   * Cierra el trazo: lee el buffer, persiste el vector completo y devuelve el
   * registro ya normalizado para hacer broadcast a los destinatarios correctos.
   */
  async commitStroke(strokeId: string): Promise<StrokeDTO | null> {
    const metaKey = `${META_PREFIX}${strokeId}`;
    const rawMeta = await this.redis.client.get(metaKey);
    if (!rawMeta) {
      this.logger.warn(`stroke_end sin stroke_start: ${strokeId}`);
      return null;
    }

    const meta = JSON.parse(rawMeta) as ActiveStrokeMeta;
    const key = `${BUFFER_PREFIX}${strokeId}`;

    // `exec()` devuelve un array de tuplas [error, result] por comando.
    const results = await this.redis.client
      .multi()
      .lrange(key, 0, -1)
      .del(key)
      .del(metaKey)
      .exec();

    const rawPoints = results?.[0]?.[1];
    const rawList = Array.isArray(rawPoints) ? (rawPoints as string[]) : [];

    const points: StrokePoint[] = rawList.flatMap((raw) => {
      try {
        return [JSON.parse(raw) as StrokePoint];
      } catch {
        return [];
      }
    });

    if (points.length === 0) {
      // Trazo sin puntos (p. ej. un clic sin movimiento): no se persiste.
      return null;
    }

    try {
      const row = await this.prisma.stroke.create({
        data: {
          id: strokeId,
          sessionId: meta.sessionId,
          layerId: meta.layerId,
          userId: meta.userId,
          points: points as unknown as Prisma.InputJsonValue,
          color: meta.color,
          brushSize: meta.brushSize,
          tool: meta.tool,
        },
        include: { user: { select: { id: true, name: true } } },
      });

      return {
        id: row.id,
        sessionId: row.sessionId,
        layerId: row.layerId,
        userId: row.userId,
        points: row.points as unknown as StrokeDTO['points'],
        color: row.color,
        brushSize: row.brushSize,
        tool: row.tool,
        isErased: row.isErased,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.warn(`Id de trazo duplicado (${strokeId}), se descarta`);
        return null;
      }
      throw error;
    }
  }

  async abortStroke(strokeId: string): Promise<void> {
    await this.redis.del(`${BUFFER_PREFIX}${strokeId}`, `${META_PREFIX}${strokeId}`);
  }

  async getActiveStroke(strokeId: string): Promise<ActiveStrokeMeta | null> {
    const raw = await this.redis.client.get(`${META_PREFIX}${strokeId}`);
    return raw ? (JSON.parse(raw) as ActiveStrokeMeta) : null;
  }

  /** Trazos activos de una sesión (para diagnóstico / métricas). */
  async countActiveStrokes(): Promise<number> {
    let cursor = '0';
    let total = 0;
    do {
      const [next, keys] = await this.redis.client.scan(
        cursor,
        'MATCH',
        `${META_PREFIX}*`,
        'COUNT',
        200,
      );
      cursor = next;
      total += keys.length;
    } while (cursor !== '0');
    return total;
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────

  /**
   * Undo del cliente = "deshacé este trazo mío". El servidor lo marca como
   * borrado y avisa; cada cliente lo saca de su Konva. Un usuario sólo puede
   * deshacer lo suyo.
   */
  async eraseStroke(
    strokeId: string,
    requesterId: string,
  ): Promise<{ strokeId: string; userId: string; layerId: string | null } | null> {
    const updated = await this.prisma.stroke.updateMany({
      where: { id: strokeId, userId: requesterId, isErased: false },
      data: { isErased: true },
    });

    if (updated.count === 0) return null;

    const row = await this.prisma.stroke.findUnique({
      where: { id: strokeId },
      select: { id: true, userId: true, layerId: true },
    });

    return row ? { strokeId: row.id, userId: row.userId, layerId: row.layerId } : null;
  }

  /** Re-hace un trazo que el propio usuario había deshecho. */
  async restoreStroke(
    strokeId: string,
    requesterId: string,
  ): Promise<StrokeDTO | null> {
    const row = await this.prisma.stroke.findFirst({
      where: { id: strokeId, userId: requesterId },
    });
    if (!row) return null;

    const updated = await this.prisma.stroke.updateMany({
      where: { id: strokeId, isErased: true },
      data: { isErased: false },
    });
    if (updated.count === 0) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      layerId: row.layerId,
      userId: row.userId,
      points: row.points as unknown as StrokeDTO['points'],
      color: row.color,
      brushSize: row.brushSize,
      tool: row.tool,
      isErased: false,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    // Los buffers expiran solos; no hace falta limpiar al apagar.
  }
}
