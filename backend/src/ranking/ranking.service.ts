import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SpacesService } from '../spaces/spaces.service';

export interface RankingEntry {
  position: number;
  user: { id: string; name: string; avatarUrl: string | null };
  totalPoints: number;
  goldCount: number;
  silverCount: number;
  bronzeCount: number;
  isMember: boolean;
}

const CACHE_TTL_SECONDS = 60;

@Injectable()
export class RankingService {
  private readonly logger = new Logger(RankingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly spacesService: SpacesService,
  ) {}

  /**
   * Ranking de un espacio: usa los puntos globales de cada usuario (tabla
   * `UserScore`) y filtra al conjunto de miembros del espacio.
   * `isMember` permite resaltar en la UI a los usuarios del espacio cuando se
   * muestra el ranking global.
   */
  async forSpace(spaceId: string, userId: string, page = 1, pageSize = 25) {
    await this.spacesService.assertMember(spaceId, userId);

    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { id: true, name: true, ownerId: true },
    });
    if (!space) throw new NotFoundException('Espacio no encontrado');

    const cacheKey = `ranking:space:${spaceId}:${page}:${pageSize}`;

    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      return { ...JSON.parse(cached), cached: true };
    }

    const members = await this.prisma.spaceMember.findMany({
      where: { spaceId },
      select: { userId: true },
    });
    const memberIds = members.map((m) => m.userId);

    // Los puntos son globales por usuario (tabla UserScore). El ranking "por
    // espacio" filtra ese total al conjunto de miembros del espacio.
    const rows = await this.prisma.userScore.findMany({
      where: { userId: { in: memberIds } },
      orderBy: [{ totalPoints: 'desc' }, { goldCount: 'desc' }, { updatedAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    const total = await this.prisma.userScore.count({
      where: { userId: { in: memberIds } },
    });

    const payload = {
      space: { id: space.id, name: space.name },
      entries: rows.map((row, i) => this.toEntry(row, (page - 1) * pageSize + i + 1, true)),
      page,
      pageSize,
      total,
      cached: false,
    };

    await this.redis.client.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
    return payload;
  }

  /** Ranking global. `isMember` indica si el usuario pertenece a `spaceId`. */
  async global(userId: string, spaceId?: string, page = 1, pageSize = 25) {
    const cacheKey = `ranking:global:${spaceId ?? 'all'}:${page}:${pageSize}`;

    const cached = await this.redis.client.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), cached: true };

    const memberIds = spaceId
      ? (
          await this.prisma.spaceMember.findMany({
            where: { spaceId },
            select: { userId: true },
          })
        ).map((m) => m.userId)
      : null;

    const rows = await this.prisma.userScore.findMany({
      where: memberIds
        ? { userId: { in: memberIds } }
        : { totalPoints: { gt: 0 } },
      orderBy: [{ totalPoints: 'desc' }, { goldCount: 'desc' }, { updatedAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });

    const total = await this.prisma.userScore.count({
      where: memberIds
        ? { userId: { in: memberIds } }
        : { totalPoints: { gt: 0 } },
    });

    const payload = {
      entries: rows.map((row, i) =>
        this.toEntry(row, (page - 1) * pageSize + i + 1, !memberIds || memberIds.includes(row.userId)),
      ),
      page,
      pageSize,
      total,
      cached: false,
    };

    await this.redis.client.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
    return payload;
  }

  async myScore(userId: string) {
    const score = await this.prisma.userScore.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return score;
  }

  /** Historial de premios de un usuario, para su perfil. */
  async historyOf(userId: string) {
    return this.prisma.sessionWinner.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        session: { select: { id: true, title: true, mode: true } },
      },
    });
  }

  /**
   * Invalida el cache. Se llama al cerrar sesiones y al elegir ganadores.
   * Redis no expande comodines en DEL, así que primero hay que buscar las claves.
   */
  async invalidate(spaceId?: string): Promise<void> {
    const pattern = spaceId ? `ranking:space:${spaceId}*` : 'ranking:*';
    const found = await this.scanKeys(pattern);
    if (found.length > 0) {
      await this.redis.client.del(...found);
      this.logger.debug(`Cache de ranking invalidado (${found.length} claves)`);
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  private toEntry(
    row: {
      userId: string;
      totalPoints: number;
      goldCount: number;
      silverCount: number;
      bronzeCount: number;
      user: { id: string; name: string; avatarUrl: string | null };
    },
    position: number,
    isMember: boolean,
  ): RankingEntry {
    return {
      position,
      user: row.user,
      totalPoints: row.totalPoints,
      goldCount: row.goldCount,
      silverCount: row.silverCount,
      bronzeCount: row.bronzeCount,
      isMember,
    };
  }
}
