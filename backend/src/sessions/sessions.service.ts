import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, SessionMode, SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesService } from '../spaces/spaces.service';
import { SessionEventsService } from '../events/session-events.service';
import { RankingService } from '../ranking/ranking.service';
import type {
  CreateSessionDto,
  SetWinnersDto,
  StrokeQueryDto,
  UpdateSessionDto,
} from './dto/session.dto';

const LAYER_COLORS = [
  '#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b',
  '#06b6d4', '#ec4899', '#84cc16', '#8b5cf6', '#14b8a6',
];

/** Colores de capa que ve el cliente. No se persisten: la capa tiene nombre. */
export { LAYER_COLORS };

export interface StrokeDTO {
  id: string;
  sessionId: string;
  layerId: string | null;
  userId: string;
  points: Array<{ x: number; y: number; pressure: number; t: number }>;
  color: string;
  brushSize: number;
  tool: string;
  isErased: boolean;
  createdAt: string;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spacesService: SpacesService,
    private readonly events: SessionEventsService,
    private readonly rankingService: RankingService,
  ) {}

  // ── Cycle of life ────────────────────────────────────────────────────────

  async create(spaceId: string, userId: string, dto: CreateSessionDto) {
    await this.spacesService.assertOwner(spaceId, userId);

    const layerCount = this.resolveLayerCount(dto.mode, dto.layerCount);
    const canvasWidth = dto.canvasWidth ?? 1920;
    const canvasHeight = dto.canvasHeight ?? 1080;

    return this.prisma.drawingSession.create({
      data: {
        spaceId,
        title: dto.title.trim(),
        theme: dto.theme?.trim() ?? null,
        mode: dto.mode,
        status: 'DRAFT',
        maxParticipants: dto.maxParticipants ?? null,
        canvasWidth,
        canvasHeight,
        layers: {
          create: Array.from({ length: layerCount }, (_, i) => ({
            name: `Capa ${i + 1}`,
            order: i,
            visible: true,
            opacity: 1,
          })),
        },
      },
      include: { layers: { orderBy: { order: 'asc' } } },
    });
  }

  async findAll(spaceId: string, userId: string) {
    await this.spacesService.assertMember(spaceId, userId);

    return this.prisma.drawingSession.findMany({
      where: { spaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { participants: true, layers: true, strokes: true } },
        winners: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
          orderBy: { position: 'asc' },
        },
      },
    });
  }

  /**
   * Detalle de sesión. Incluye `viewer` con el rol y la capa asignada, que es
   * lo que el cliente necesita para decidir qué puede dibujar.
   */
  async findOne(sessionId: string, userId: string) {
    const session = await this.prisma.drawingSession.findUnique({
      where: { id: sessionId },
      include: {
        space: {
          select: { id: true, name: true, slug: true, ownerId: true },
        },
        layers: { orderBy: { order: 'asc' } },
        participants: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        winners: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!session) throw new NotFoundException('Sesión no encontrada');

    const isSpaceOwner = session.space.ownerId === userId;
    const membership = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: session.spaceId, userId } },
    });

    if (!membership && !isSpaceOwner && !session.space.ownerId) {
      throw new ForbiddenException('No tenés acceso a esta sesión');
    }

    const ownParticipation = session.participants.find((p) => p.userId === userId) ?? null;

    return {
      ...session,
      viewer: {
        userId,
        isSpaceOwner,
        isParticipant: Boolean(ownParticipation),
        // En LAYERED sólo se dibuja sobre la capa propia.
        assignedLayerId: ownParticipation?.layerId ?? null,
      },
    };
  }

  /** Vista ligera para el socket: sólo lo necesario para pintar. */
  async findBootstrap(sessionId: string) {
    const session = await this.prisma.drawingSession.findUnique({
      where: { id: sessionId },
      include: {
        layers: { orderBy: { order: 'asc' } },
        space: { select: { id: true, name: true, ownerId: true } },
      },
    });
    if (!session) throw new NotFoundException('Sesión no encontrada');
    return session;
  }
  /**
   * Resolución de permisos para el gateway. Devuelve lo mínimo que el socket
   * necesita para decidir a quién puede enviar trazos y a quién no, sin traer
   * participantes ni ganadores en cada reconexión.
   */
  async resolveAccess(sessionId: string, userId: string) {
    const session = await this.prisma.drawingSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        spaceId: true,
        mode: true,
        status: true,
        title: true,
        theme: true,
        canvasWidth: true,
        canvasHeight: true,
        space: { select: { ownerId: true, name: true } },
        layers: { orderBy: { order: 'asc' } },
        participants: {
          where: { userId },
          select: { layerId: true, isActive: true },
        },
      },
    });

    if (!session) throw new NotFoundException('Sesión no encontrada');

    const isSpaceOwner = session.space.ownerId === userId;

    if (!isSpaceOwner) {
      // Todo el mundo —no sólo los miembros— puede mirar una sesión abierta
      // de un espacio público; para dibujar hay que estar anotado.
      const member = await this.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: session.spaceId, userId } },
        select: { id: true },
      });
      if (!member) {
        throw new ForbiddenException('No pertenecés a este espacio');
      }
    }

    const isDrawable =
      session.status === 'OPEN' || session.status === 'LIVE';

    return {
      sessionId: session.id,
      spaceId: session.spaceId,
      mode: session.mode,
      status: session.status,
      title: session.title,
      theme: session.theme,
      canvasWidth: session.canvasWidth,
      canvasHeight: session.canvasHeight,
      spaceOwnerId: session.space.ownerId,
      isSpaceOwner,
      isParticipant: session.participants.length > 0,
      /** Capa propia en LAYERED; null en INDIVIDUAL y FREE. */
      assignedLayerId: session.participants[0]?.layerId ?? null,
      canDraw: isDrawable && (isSpaceOwner || session.participants.length > 0),
      canManage: isSpaceOwner,
    };
  }

  async update(sessionId: string, userId: string, dto: UpdateSessionDto) {
    const session = await this.loadSessionForOwner(sessionId, userId);

    // Transiciones válidas. Saltar de DRAFT directo a CLOSED no tiene sentido.
    const allowed: Record<SessionStatus, SessionStatus[]> = {
      DRAFT: ['OPEN', 'ARCHIVED'],
      OPEN: ['LIVE', 'DRAFT', 'ARCHIVED'],
      LIVE: ['CLOSED', 'OPEN'],
      CLOSED: ['ARCHIVED'],
      ARCHIVED: [],
    };

    if (dto.status && dto.status !== session.status) {
      if (!allowed[session.status].includes(dto.status)) {
        throw new BadRequestException(
          `No se puede pasar de ${session.status} a ${dto.status}`,
        );
      }
    }

    const updated = await this.prisma.drawingSession.update({
      where: { id: sessionId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.theme !== undefined ? { theme: dto.theme.trim() || null } : {}),
        ...(dto.maxParticipants !== undefined
          ? { maxParticipants: dto.maxParticipants }
          : {}),
        ...(dto.status !== undefined
          ? {
              status: dto.status,
              startTime:
                dto.status === 'LIVE' && !session.startTime
                  ? new Date()
                  : session.startTime,
              endTime: dto.status === 'CLOSED' ? new Date() : session.endTime,
            }
          : {}),
      },
      include: { layers: { orderBy: { order: 'asc' } } },
    });

    // Los participantes conectados se enteran al instante, sin recargar.
    this.events.sessionUpdated(sessionId, {
      id: updated.id,
      title: updated.title,
      theme: updated.theme,
      status: updated.status,
    });

    if (dto.status === 'CLOSED') {
      this.events.sessionClosed(sessionId);
      // Cerrar una sesión puede cambiar el ranking: el creator va a elegir
      // ganadores enseguida, pero el cache se limpia igual.
      await this.rankingService.invalidate(session.spaceId);
    }

    return updated;
  }

  async remove(sessionId: string, userId: string) {
    const session = await this.loadSessionForOwner(sessionId, userId);
    await this.rankingService.invalidate(session.spaceId);
    await this.prisma.drawingSession.delete({ where: { id: sessionId } });
    return { success: true };
  }

  // ── Participants ─────────────────────────────────────────────────────────

  /**
   * Alta de participante. En LAYERED le asigna una capa libre de forma atómica
   * (`updateMany` con condición `ownerUserId: null`): dos personas que entran
   * al mismo tiempo no pueden quedarse con la misma capa.
   */
  async joinSession(sessionId: string, userId: string) {
    const session = await this.loadOpenSession(sessionId);

    const existing = await this.prisma.sessionParticipant.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });

    if (existing) {
      if (!existing.isActive) {
        await this.prisma.sessionParticipant.update({
          where: { id: existing.id },
          data: { isActive: true, leftAt: null },
        });
      }
      return this.findOne(sessionId, userId);
    }

    if (session.maxParticipants) {
      const active = await this.prisma.sessionParticipant.count({
        where: { sessionId, isActive: true },
      });
      if (active >= session.maxParticipants) {
        throw new ForbiddenException('La sesión alcanzó el máximo de participantes');
      }
    }

    let layerId: string | null = null;

    if (session.mode === 'LAYERED') {
      const freeLayer = await this.prisma.layer.findFirst({
        where: { sessionId, ownerUserId: null },
        orderBy: { order: 'asc' },
        select: { id: true },
      });

      if (!freeLayer) {
        throw new ForbiddenException('No quedan capas libres en esta sesión');
      }

      // Asignación condicional: sólo uno gana la fila.
      const claimed = await this.prisma.layer.updateMany({
        where: { id: freeLayer.id, ownerUserId: null },
        data: { ownerUserId: userId },
      });

      if (claimed.count === 0) {
        throw new ConflictException('Otra persona tomó esa capa, reintentá');
      }
      layerId = freeLayer.id;
    }

    if (session.mode === 'INDIVIDUAL') {
      // Cada participante dibuja sobre un canvas lógico propio, aislado por
      // `Stroke.userId`. No hace falta crear capas.
      layerId = null;
    }

    await this.prisma.sessionParticipant.create({
      data: { sessionId, userId, layerId },
    });

    return this.findOne(sessionId, userId);
  }

  async leaveSession(sessionId: string, userId: string) {
    await this.loadSession(sessionId);
    await this.prisma.sessionParticipant.updateMany({
      where: { sessionId, userId },
      data: { isActive: false, leftAt: new Date() },
    });
    return { success: true };
  }

  async listParticipants(sessionId: string, userId: string) {
    const session = await this.loadSession(sessionId);
    await this.spacesService.assertMember(session.spaceId, userId);

    return this.prisma.sessionParticipant.findMany({
      where: { sessionId },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        layer: { select: { id: true, name: true, order: true } },
      },
    });
  }

  // ── Layers ───────────────────────────────────────────────────────────────

  async createLayer(sessionId: string, userId: string) {
    const session = await this.loadSessionForOwner(sessionId, userId);
    if (session.mode === 'INDIVIDUAL') {
      throw new BadRequestException('El modo INDIVIDUAL no usa capas');
    }

    const last = await this.prisma.layer.findFirst({
      where: { sessionId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    const created = await this.prisma.layer.create({
      data: {
        sessionId,
        name: `Capa ${(last?.order ?? -1) + 2}`,
        order: (last?.order ?? -1) + 1,
        visible: true,
        opacity: 1,
      },
    });

    this.events.layerChanged(sessionId, created);
    return created;
  }

  async updateLayer(
    sessionId: string,
    layerId: string,
    userId: string,
    dto: { name?: string; visible?: boolean; opacity?: number; order?: number },
  ) {
    const session = await this.loadSessionForOwner(sessionId, userId);

    // `loadSessionForOwner` ya garantiza que quien llega acá es el creador del
    // espacio, así que puede reconfigurar cualquier capa (incluidas las
    // asignadas de otros participantes en modo LAYERED).
    const existing = await this.prisma.layer.findFirst({
      where: { id: layerId, sessionId },
    });
    if (!existing) throw new NotFoundException('Capa no encontrada');

    const layer = await this.prisma.layer.update({
      where: { id: layerId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.visible !== undefined ? { visible: dto.visible } : {}),
        ...(dto.opacity !== undefined
          ? { opacity: Math.min(1, Math.max(0, dto.opacity)) }
          : {}),
        ...(dto.order !== undefined ? { order: dto.order } : {}),
      },
    });

    this.events.layerChanged(sessionId, layer);
    return layer;
  }

  async deleteLayer(sessionId: string, layerId: string, userId: string) {
    await this.loadSessionForOwner(sessionId, userId);
    const deleted = await this.prisma.layer.deleteMany({
      where: { id: layerId, sessionId },
    });
    if (deleted.count === 0) throw new NotFoundException('Capa no encontrada');
    this.events.layerRemoved(sessionId, layerId);
    return { success: true };
  }

  // ── Strokes (historial vectorial) ────────────────────────────────────────

  /**
   * Historial de trazos para reconstruir el canvas en el cliente.
   * NO se filtra a ciegas: en modo INDIVIDUAL un participante sólo puede pedir
   * sus propios trazos (o los de cualquiera, si es el creador del espacio).
   */
  async listStrokes(sessionId: string, userId: string, query: StrokeQueryDto) {
    const session = await this.loadSession(sessionId);
    const isSpaceOwner = session.space.ownerId === userId;

    const limit = query.limit ?? 2000;

    let userIdFilter: string | undefined;
    if (session.mode === 'INDIVIDUAL' && !isSpaceOwner) {
      // Aislamiento: en INDIVIDUAL cada quien sólo ve su propio canvas.
      userIdFilter = query.userId ?? userId;
      if (userIdFilter !== userId) {
        throw new ForbiddenException('No podés ver el canvas de otro participante');
      }
    } else if (query.userId) {
      userIdFilter = query.userId;
    }

    const rows = await this.prisma.stroke.findMany({
      where: {
        sessionId,
        isErased: false,
        ...(userIdFilter ? { userId: userIdFilter } : {}),
        ...(query.layerId ? { layerId: query.layerId } : {}),
        ...(query.before
          ? { createdAt: { lt: new Date(query.before) } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    return {
      strokes: rows.map((row) => this.toStrokeDTO(row)),
      // Si vino el tope de la página, hay más para pedir.
      hasMore: rows.length === limit,
      cursor:
        rows.length === limit
          ? (rows[rows.length - 1]?.createdAt.toISOString() ?? null)
          : null,
    };
  }

  async countStrokes(sessionId: string) {
    return this.prisma.stroke.count({
      where: { sessionId, isErased: false },
    });
  }

  // ── Export log (sólo analítica: nunca el binario) ────────────────────────

  async logExport(
    sessionId: string,
    userId: string,
    scope: 'own_canvas' | 'combined' | 'single_layer',
  ) {
    const session = await this.loadSession(sessionId);
    if (session.space.ownerId !== userId) {
      await this.spacesService.assertMember(session.spaceId, userId);
    }

    await this.prisma.exportLog.create({ data: { sessionId, userId, scope } });
    return { success: true };
  }

  // ── Winners & ranking ────────────────────────────────────────────────────

  /**
   * Registra los 3 ganadores y reparte puntos. Sólo aplica a INDIVIDUAL y
   * LAYERED: el modo FREE queda fuera de la premiación por diseño.
   */
  async setWinners(sessionId: string, userId: string, dto: SetWinnersDto) {
    const session = await this.loadSessionForOwner(sessionId, userId);

    if (session.mode === 'FREE') {
      throw new BadRequestException(
        'El modo FREE no participa del sistema de premiación',
      );
    }

    if (dto.winners.length === 0) {
      throw new BadRequestException('Elegí al menos un ganador');
    }

    const positions = dto.winners.map((w) => w.position);
    if (new Set(positions).size !== positions.length) {
      throw new BadRequestException('Hay posiciones repetidas');
    }
    if (positions.some((p) => p < 1 || p > 3)) {
      throw new BadRequestException('Las posiciones válidas son 1, 2 y 3');
    }

    const userIds = dto.winners.map((w) => w.userId);
    if (new Set(userIds).size !== userIds.length) {
      throw new BadRequestException('Una persona no puede ocupar dos puestos');
    }

    const participants = await this.prisma.sessionParticipant.findMany({
      where: { sessionId, userId: { in: userIds } },
      select: {
        userId: true,
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    const validIds = new Set(participants.map((p) => p.userId));
    const invalid = userIds.filter((id) => !validIds.has(id));
    if (invalid.length) {
      throw new BadRequestException(
        'Sólo se pueden premiar participantes de la sesión',
      );
    }

    const winnersByUser = new Map(participants.map((p) => [p.userId, p.user]));

    const scoring = await this.spacesService.getScoringConfig(session.spaceId);

    // Recalcular desde cero: si ya había ganadores, se revierten los puntos
    // anteriores antes de aplicar los nuevos (replace).
    const previous = await this.prisma.sessionWinner.findMany({
      where: { sessionId },
    });

    if (previous.length > 0 && !dto.replace) {
      throw new BadRequestException(
        'La sesión ya tiene ganadores. Enviá replace=true para reemplazarlos',
      );
    }

    for (const old of previous) {
      await this.applyScoreDelta(old.userId, -old.points, old.position);
    }
    await this.prisma.sessionWinner.deleteMany({ where: { sessionId } });

    const created = await this.prisma.$transaction(
      dto.winners.map((winner) =>
        this.prisma.sessionWinner.create({
          data: {
            sessionId,
            userId: winner.userId,
            position: winner.position,
            points: scoring[String(winner.position)] ?? 0,
          },
        }),
      ),
    );

    for (const winner of created) {
      await this.applyScoreDelta(
        winner.userId,
        winner.points,
        winner.position,
      );
    }

    await this.rankingService.invalidate(session.spaceId);

    this.logger.log(
      `Ganadores de ${sessionId}: ${created
        .map((w) => `${w.position}º=${w.userId.slice(0, 6)}(${w.points}pts)`)
        .join(', ')}`,
    );

    // Aviso en vivo a los participantes que sigan conectados.
    this.events.announceWinners(
      sessionId,
      created.map((w) => ({
        position: w.position,
        points: w.points,
        user: winnersByUser.get(w.userId)!,
      })),
    );

    return this.prisma.sessionWinner.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  private async applyScoreDelta(
    userId: string,
    deltaPoints: number,
    position: number,
  ): Promise<void> {
    const medalField =
      position === 1 ? 'goldCount' : position === 2 ? 'silverCount' : 'bronzeCount';
    const inverse = deltaPoints < 0 ? -1 : 1;

    await this.prisma.userScore.upsert({
      where: { userId },
      create: {
        userId,
        totalPoints: Math.max(0, deltaPoints),
        [medalField]: inverse,
      },
      update: {
        totalPoints: { increment: deltaPoints },
        [medalField]: { increment: inverse },
      },
    });

    // Nunca dejar contadores de medallas en negativo.
    await this.prisma.userScore.updateMany({
      where: { userId, [medalField]: { lt: 0 } },
      data: { [medalField]: 0, totalPoints: { increment: 0 } },
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private resolveLayerCount(mode: SessionMode, requested?: number): number {
    if (mode === 'INDIVIDUAL') return 0;
    if (mode === 'LAYERED') return requested ?? 12;
    return requested ?? 6;
  }

  private async loadSession(sessionId: string) {
    const session = await this.prisma.drawingSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        spaceId: true,
        mode: true,
        status: true,
        canvasWidth: true,
        canvasHeight: true,
        space: { select: { ownerId: true } },
      },
    });
    if (!session) throw new NotFoundException('Sesión no encontrada');
    return session;
  }

  private async loadSessionForOwner(sessionId: string, userId: string) {
    const session = await this.prisma.drawingSession.findUnique({
      where: { id: sessionId },
      include: { space: { select: { id: true, ownerId: true } } },
    });
    if (!session) throw new NotFoundException('Sesión no encontrada');
    if (session.space.ownerId !== userId) {
      throw new ForbiddenException('Sólo el creador del espacio puede hacer esto');
    }
    return session;
  }

  private async loadOpenSession(sessionId: string) {
    const session = await this.prisma.drawingSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        spaceId: true,
        mode: true,
        status: true,
        maxParticipants: true,
        space: { select: { ownerId: true } },
      },
    });
    if (!session) throw new NotFoundException('Sesión no encontrada');

    if (session.status === 'CLOSED' || session.status === 'ARCHIVED') {
      throw new ForbiddenException('La sesión está cerrada');
    }
    return session;
  }

  toStrokeDTO(row: {    id: string;
    sessionId: string;
    layerId: string | null;
    userId: string;
    points: Prisma.JsonValue;
    color: string;
    brushSize: number;
    tool: string;
    isErased: boolean;
    createdAt: Date;
  }): StrokeDTO {
    return {
      id: row.id,
      sessionId: row.sessionId,
      layerId: row.layerId,
      userId: row.userId,
      points: (row.points as StrokeDTO['points']) ?? [],
      color: row.color,
      brushSize: row.brushSize,
      tool: row.tool,
      isErased: row.isErased,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
