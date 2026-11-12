import { Logger, UseFilters, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SessionsService } from '../sessions/sessions.service';
import { DrawingService } from './drawing.service';
import type { StrokePoint } from './drawing.service';
import { PresenceService } from './presence.service';
import type { PresenceEntry } from './presence.service';
import { LayerLockService } from './layer-lock.service';
import {
  HeartbeatDto,
  JoinSessionDto,
  LayerLockDto,
  LayerSwitchDto,
  StrokeEndDto,
  StrokePointsDto,
  StrokeStartDto,
  UndoRedoDto,
  isValidStrokeId,
} from './dto/gateway.dto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { WsClientErrorFilter } from '../common/filters/ws-client-error.filter';

type SessionMode = 'INDIVIDUAL' | 'LAYERED' | 'FREE';

interface SocketUser extends AuthUser {
  avatarUrl: string | null;
}

/** Contexto que el gateway cachea en el socket tras un join exitoso. */
interface SessionContext {
  sessionId: string;
  mode: SessionMode;
  userId: string;
  isSpaceOwner: boolean;
  canDraw: boolean;
  assignedLayerId: string | null;
  layerIds: string[];
}

/** Token bucket por socket: frena el abuso de eventos de dibujo. */
class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  tryConsume(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSecond,
    );
    this.lastRefill = now;

    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

const PIPE = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  validateCustomDecorators: true,
});

/**
 * Gateway de dibujo.
 *
 * Namespace: `/session`. Cada socket entra a salas y el routing de cada trazo se
 * resuelve con las salas (ver `DrawingService.broadcastTargets`), que es lo que
 * hace que el modo de la sesión sea la única variable que cambie entre
 * INDIVIDUAL, LAYERED y FREE.
 *
 * La identidad se valida UNA vez, en el handshake, y se cachea en
 * `client.data.user`. Ningún evento acepta `userId` desde el cliente: si lo
 * aceptara, cualquiera podría dibujar en nombre de otro.
 *
 * Los rechazos de negocio (sesión cerrada, capa ajena, rate limit) viajan al
 * cliente como un evento `error`: ver `WsClientErrorFilter`.
 */
@UseFilters(new WsClientErrorFilter())
@WebSocketGateway({
  namespace: '/session',
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class DrawingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(DrawingGateway.name);
  private readonly maxPointsPerEvent: number;
  private readonly sweepIntervalMs: number;
  private readonly ratePerSecond: number;
  private readonly rateBurst: number;

  private readonly presenceChannels = new Map<string, string>();
  private readonly presenceSubscribers = new Map<string, Redis>();
  private readonly limiters = new Map<string, RateLimiter>();

  /**
   * Cola por trazo. Ver `serializeStroke`.
   */
  private readonly strokeQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessionsService: SessionsService,
    private readonly drawingService: DrawingService,
    private readonly presenceService: PresenceService,
    private readonly layerLockService: LayerLockService,
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.maxPointsPerEvent = config.get<number>('MAX_POINTS_PER_EVENT', 256);
    this.sweepIntervalMs = config.get<number>('STROKE_FLUSH_MS', 40);
    this.ratePerSecond = config.get<number>('WS_RATE_LIMIT', 150);
    this.rateBurst = config.get<number>('WS_RATE_BURST', 600);
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  afterInit(): void {
    const timer = setInterval(() => {
      void this.sweepPresence();
    }, Math.max(2000, this.sweepIntervalMs * 10));
    timer.unref?.();
    this.logger.log('Gateway de dibujo listo en el namespace /session');
  }

  async handleConnection(client: Socket): Promise<void> {
    // La promesa se guarda de forma SÍNCRONA, antes del primer await. El
    // cliente emite `join_session` en cuanto recibe `connect`, así que sin esto
    // hay una carrera: el evento puede llegar antes de que la promesa de
    // verificación del token termine y `client.data.user` todavía no existe.
    client.data.authPromise = this.authenticateHandshake(client);

    const user = await client.data.authPromise;

    if (!user) {
      client.emit('error', { event: 'connection', message: 'Token inválido o expirado' });
      client.disconnect(true);
      return;
    }

    client.data.user = user;
    this.limiters.set(
      client.id,
      new RateLimiter(this.rateBurst, this.ratePerSecond),
    );
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.limiters.delete(client.id);

    const context = client.data.context as SessionContext | undefined;
    const user = client.data.user as SocketUser | undefined;
    if (!context || !user) return;

    // Suelta los locks antes de perder presencia: si no, la capa queda tomada
    // hasta que expire el TTL.
    await Promise.all(
      context.layerIds.map((layerId) =>
        this.layerLockService.release(layerId, client.id),
      ),
    );

    await this.presenceService.remove(context.sessionId, user.id, client.id);
  }

  private async authenticateHandshake(client: Socket): Promise<SocketUser | null> {
    try {
      const authToken = client.handshake.auth?.token;
      const header = client.handshake.headers.authorization;

      const raw =
        (typeof authToken === 'string' && authToken) ||
        (typeof header === 'string' && header) ||
        null;

      if (!raw) return null;

      const token = raw.replace(/^Bearer\s+/i, '');
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);

      return await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          avatarUrl: true,
        },
      });
    } catch {
      return null;
    }
  }

  // ── Guards internos ──────────────────────────────────────────────────────

  /**
   * Usuario del socket, esperando la verificación del handshake si todavía
   * está en curso. Ver `handleConnection`.
   */
  private async currentUser(client: Socket): Promise<SocketUser> {
    const pending = client.data.authPromise as Promise<SocketUser | null> | undefined;
    if (pending) {
      const resolved = await pending;
      if (resolved) return resolved;
    }

    const user = client.data.user as SocketUser | undefined;
    if (!user) throw new WsException('Socket no autenticado');
    return user;
  }

  private async contextFor(client: Socket, sessionId: string): Promise<SessionContext> {
    const user = await this.currentUser(client);
    const context = client.data.context as SessionContext | undefined;

    if (!context || context.sessionId !== sessionId) {
      throw new WsException('Primero tenés que unirte a la sesión');
    }
    if (context.userId !== user.id) {
      throw new WsException('El socket no pertenece a esa sesión');
    }
    return context;
  }

  private guardRate(client: Socket): void {
    if (!this.limiter(client).tryConsume(1)) {
      throw new WsException('Demasiados eventos de dibujo');
    }
  }

  private limiter(client: Socket): RateLimiter {
    let limiter = this.limiters.get(client.id);
    if (!limiter) {
      limiter = new RateLimiter(this.rateBurst, this.ratePerSecond);
      this.limiters.set(client.id, limiter);
    }
    return limiter;
  }

  // ── Join ─────────────────────────────────────────────────────────────────

  @SubscribeMessage('join_session')
  async handleJoin(
    @MessageBody(PIPE) dto: JoinSessionDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);

    const access = await this.sessionsService.resolveAccess(dto.sessionId, user.id);
    const session = await this.sessionsService.findBootstrap(dto.sessionId);

    await client.join(DrawingService.sessionRoom(dto.sessionId));
    if (access.isSpaceOwner) {
      // Sala de observadores: en INDIVIDUAL es la que le permite al creador
      // ver TODOS los canvas en simultáneo (su grid de miniaturas).
      await client.join(DrawingService.watchRoom(dto.sessionId));
    }
    await client.join(DrawingService.userRoom(user.id));

    const context: SessionContext = {
      sessionId: dto.sessionId,
      mode: access.mode as SessionMode,
      userId: user.id,
      isSpaceOwner: access.isSpaceOwner,
      canDraw: access.canDraw,
      assignedLayerId: access.assignedLayerId,
      layerIds: session.layers.map((l) => l.id),
    };
    client.data.context = context;

    await this.subscribePresence(dto.sessionId);
    await this.presenceService.add(dto.sessionId, client.id, {
      userId: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      room: this.presenceRoomFor(context.mode, access.isSpaceOwner),
      drawing: false,
    });

    return {
      event: 'session_state_sync',
      data: await this.buildStateSync(session, user.id, access),
    };
  }

  private presenceRoomFor(mode: SessionMode, isSpaceOwner: boolean): string {
    if (mode === 'INDIVIDUAL') return isSpaceOwner ? 'watch' : 'own';
    return 'room';
  }

  /**
   * Estado inicial (o de resincronización) que el cliente usa para repintar
   * desde cero. Sólo incluye los trazos que este usuario tiene permitidos ver.
   */
  private async buildStateSync(
    session: Awaited<ReturnType<SessionsService['findBootstrap']>>,
    userId: string,
    access: Awaited<ReturnType<SessionsService['resolveAccess']>>,
  ) {
    const participants = await this.prisma.sessionParticipant.findMany({
      where: { sessionId: session.id },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });

    const { strokes } = await this.sessionsService.listStrokes(session.id, userId, {
      limit: 5000,
    });

    const locks = await this.layerLockService.list(session.layers.map((l) => l.id));

    return {
      session: {
        id: session.id,
        spaceId: session.spaceId,
        title: session.title,
        theme: session.theme,
        mode: session.mode,
        status: session.status,
        canvasWidth: session.canvasWidth,
        canvasHeight: session.canvasHeight,
        spaceOwnerId: access.spaceOwnerId,
      },
      layers: session.layers,
      participants,
      /**
       * En INDIVIDUAL le dice al cliente a quién tiene que mostrar miniatura:
       * el creador ve a todos, cada participante sólo a sí mismo. En LAYERED y
       * FREE es `null` porque todos ven el mismo canvas combinado.
       */
      visibleUserIds:
        access.mode === 'INDIVIDUAL'
          ? access.isSpaceOwner
            ? participants.map((p) => p.userId)
            : [userId]
          : null,
      strokes,
      locks,
      viewer: {
        userId,
        isSpaceOwner: access.isSpaceOwner,
        isParticipant: access.isParticipant,
        assignedLayerId: access.assignedLayerId,
        canDraw: access.canDraw,
      },
      presence: await this.presenceService.list(session.id),
    };
  }

  // ── Trazos ───────────────────────────────────────────────────────────────

  /**
   * Serializa los eventos que pertenecen al mismo `strokeId`.
   *
   * Socket.io invoca los handlers en el orden en que llegaron, pero como todos
   * son `async` se intercalan en cada `await`. Sin esta cola, un
   * `stroke_points` podía ejecutarse antes de que el `stroke_start` terminara
   * de escribir la metadata del trazo, y como `appendPoints` la exige, el
   * batch se descartaba; si el que llegaba antes era el `stroke_end`, el trazo
   * se commiteaba vacío y no se guardaba ninguno. Ninguno de los dos casos
   * daba error, sólo un dibujo incompleto.
   *
   * Con la cola, start → points → end de un mismo trazo se procesan uno
   * detrás del otro. Trazos distintos siguen yendo en paralelo.
   */
  private serializeStroke<T>(strokeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.strokeQueues.get(strokeId) ?? Promise.resolve();
    // `then(task, task)`: si el anterior falló, el siguiente igual corre, así
    // un error en un batch no deja el trazo trabado.
    const settled = previous.then(task, task);
    this.strokeQueues.set(strokeId, settled);

    // Cuando la cola se vacía se saca la entrada, si no el Map crece con un
    // trazo por cada línea dibujada en toda la sesión.
    void settled.catch(() => undefined).then(() => {
      if (this.strokeQueues.get(strokeId) === settled) {
        this.strokeQueues.delete(strokeId);
      }
    });

    return settled;
  }

  @SubscribeMessage('stroke_start')
  handleStrokeStart(
    @MessageBody(PIPE) dto: StrokeStartDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    // El id se resuelve antes de encolar: es la clave de la cola y tiene que
    // ser el mismo que usarán los `stroke_points` siguientes.
    const strokeId = dto.strokeId ?? `s_${client.id}_${Date.now().toString(36)}`;
    return this.serializeStroke(strokeId, () => this.doStrokeStart(dto, client, strokeId));
  }

  private async doStrokeStart(
    dto: StrokeStartDto,
    client: Socket,
    strokeId: string,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    this.guardRate(client);

    const context = await this.contextFor(client, dto.sessionId);
    if (!context.canDraw) {
      throw new WsException('No podés dibujar en esta sesión');
    }

    const layerId = this.resolveLayerForDraw(context, dto.layerId ?? null);

    if (!isValidStrokeId(strokeId)) {
      throw new WsException('Id de trazo inválido');
    }

    if (context.mode === 'FREE' && layerId) {
      const lock = await this.layerLockService.acquire(
        layerId,
        user.id,
        client.id,
        user.name,
      );
      if (!lock.acquired && this.layerLockService.strict) {
        throw new WsException(`La capa está siendo usada por ${lock.lock.name}`);
      }
    }

    const started = await this.drawingService.beginStroke(strokeId, {
      sessionId: context.sessionId,
      layerId,
      userId: user.id,
      color: dto.color,
      brushSize: dto.brushSize,
      tool: dto.tool,
      startedAt: Date.now(),
    });

    if (!started) {
      throw new WsException('Ese trazo ya estaba abierto');
    }

    await this.presenceService.setDrawing(context.sessionId, user.id, true);

    return {
      event: 'stroke_started',
      data: {
        strokeId,
        userId: user.id,
        layerId,
        tool: dto.tool,
        color: dto.color,
        brushSize: dto.brushSize,
      },
    };
  }

  @SubscribeMessage('stroke_points')
  handleStrokePoints(
    @MessageBody(PIPE) dto: StrokePointsDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    return this.serializeStroke(dto.strokeId, () => this.doStrokePoints(dto, client));
  }

  private async doStrokePoints(
    dto: StrokePointsDto,
    client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    this.guardRate(client);

    const context = await this.contextFor(client, dto.sessionId);

    if (dto.points.length > this.maxPointsPerEvent) {
      throw new WsException('Demasiados puntos por evento');
    }

    // Sólo se aceptan puntos de un trazo abierto por el MISMO usuario. Evita
    // que alguien inyecte puntos en el trazo de otro.
    const meta = await this.drawingService.getActiveStroke(dto.strokeId);
    if (!meta || meta.userId !== user.id) {
      throw new WsException('Trazo inexistente o ajeno');
    }
    if (meta.sessionId !== context.sessionId) {
      throw new WsException('El trazo pertenece a otra sesión');
    }

    const points: StrokePoint[] = dto.points.map((p) => ({
      x: p.x,
      y: p.y,
      pressure: p.pressure ?? 0.5,
      t: p.t ?? Date.now(),
    }));

    const result = await this.drawingService.appendPoints(dto.strokeId, points);
    if (result.closed) {
      // `stroke_end` se procesó antes que este batch. Es una carrera normal
      // cuando el cliente manda el último batch y el cierre juntos: el trazo
      // ya está commiteado, así que estos puntos no tienen dónde ir. No es un
      // error para el usuario, se responde un ack vacío.
      return { event: 'ack', data: { strokeId: dto.strokeId, count: 0, dropped: true } };
    }
    if (result.overflow) {
      throw new WsException('El trazo alcanzó el máximo de puntos');
    }

    // El estilo viaja con cada batch: es la metadata del trazo abierto, y así
    // el receptor puede pintar la línea con el mismo color y grosor aunque el
    // `stroke_started` se haya perdido.
    await this.broadcastStroke(context, {
      strokeId: dto.strokeId,
      userId: user.id,
      layerId: meta.layerId,
      color: meta.color,
      brushSize: meta.brushSize,
      tool: meta.tool,
      points,
    });

    return { event: 'ack', data: { strokeId: dto.strokeId, count: result.total } };
  }

  @SubscribeMessage('stroke_end')
  handleStrokeEnd(
    @MessageBody(PIPE) dto: StrokeEndDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    return this.serializeStroke(dto.strokeId, () => this.doStrokeEnd(dto, client));
  }

  private async doStrokeEnd(
    dto: StrokeEndDto,
    client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    this.guardRate(client);

    const context = await this.contextFor(client, dto.sessionId);

    const meta = await this.drawingService.getActiveStroke(dto.strokeId);
    if (meta && meta.userId !== user.id) {
      throw new WsException('No podés cerrar un trazo ajeno');
    }

    const stroke = await this.drawingService.commitStroke(dto.strokeId);
    await this.presenceService.setDrawing(context.sessionId, user.id, false);

    if (!stroke) {
      return { event: 'ack', data: { strokeId: dto.strokeId, committed: false } };
    }

    // `stroke_broadcast` lleva el trazo ya persistido: es la señal de que pasó
    // a formar parte del historial.
    await this.broadcastStroke(context, { stroke, committed: true });

    return { event: 'ack', data: { strokeId: dto.strokeId, committed: true } };
  }

  /** El usuario levantó el dedo fuera del canvas: se descarta el trazo. */
  @SubscribeMessage('stroke_abort')
  async handleStrokeAbort(
    @MessageBody(PIPE) dto: StrokeEndDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    const meta = await this.drawingService.getActiveStroke(dto.strokeId);
    if (meta && meta.userId !== user.id) {
      throw new WsException('No podés abortar un trazo ajeno');
    }
    await this.drawingService.abortStroke(dto.strokeId);
    return { event: 'ack', data: { strokeId: dto.strokeId, aborted: true } };
  }

  @SubscribeMessage('undo')
  async handleUndo(
    @MessageBody(PIPE) dto: UndoRedoDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    const context = await this.contextFor(client, dto.sessionId);

    const target = dto.strokeId ?? (await this.lastOwnStroke(context));
    if (!target) throw new WsException('No hay nada que deshacer');

    const removed = await this.drawingService.eraseStroke(target, user.id);
    if (!removed) throw new WsException('No se pudo deshacer ese trazo');

    await this.broadcastRemoval(context, removed);
    return { event: 'ack', data: { strokeId: target, undone: true } };
  }

  @SubscribeMessage('redo')
  async handleRedo(
    @MessageBody(PIPE) dto: UndoRedoDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    const context = await this.contextFor(client, dto.sessionId);

    const target = dto.strokeId ?? (await this.lastErasedOwnStroke(context));
    if (!target) throw new WsException('No hay nada que rehacer');

    const stroke = await this.drawingService.restoreStroke(target, user.id);
    if (!stroke) throw new WsException('No se pudo rehacer ese trazo');

    await this.broadcastStroke(context, { stroke });
    return { event: 'ack', data: { strokeId: target, redone: true } };
  }

  // ── Capas (modo FREE) ───────────────────────────────────────────────────

  @SubscribeMessage('layer_switch')
  async handleLayerSwitch(
    @MessageBody(PIPE) dto: LayerSwitchDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    const context = await this.contextFor(client, dto.sessionId);

    if (context.mode !== 'FREE') {
      throw new WsException('El cambio de capa sólo existe en modo FREE');
    }
    if (!context.layerIds.includes(dto.layerId)) {
      throw new WsException('La capa no pertenece a esta sesión');
    }

    const result = await this.layerLockService.acquire(
      dto.layerId,
      user.id,
      client.id,
      user.name,
    );

    this.server
      .to(DrawingService.sessionRoom(context.sessionId))
      .emit('layer_lock_update', {
        layerId: dto.layerId,
        holder: result.lock,
        acquired: result.acquired,
      });

    if (!result.acquired && this.layerLockService.strict) {
      throw new WsException(`La capa está siendo usada por ${result.lock.name}`);
    }

    return { event: 'ack', data: { layerId: dto.layerId, acquired: result.acquired } };
  }

  @SubscribeMessage('release_layer_lock')
  async handleReleaseLock(
    @MessageBody(PIPE) dto: LayerLockDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    const context = await this.contextFor(client, dto.sessionId);

    await this.layerLockService.release(dto.layerId, client.id);
    this.server
      .to(DrawingService.sessionRoom(context.sessionId))
      .emit('layer_lock_update', { layerId: dto.layerId, holder: null, acquired: true });

    return { event: 'ack', data: { layerId: dto.layerId, released: true } };
  }

  // ── Presencia ────────────────────────────────────────────────────────────

  @SubscribeMessage('heartbeat')
  async handleHeartbeat(
    @MessageBody(PIPE) dto: HeartbeatDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    await this.contextFor(client, dto.sessionId);
    await this.presenceService.touch(dto.sessionId, user.id);
    return { event: 'ack', data: { ok: true } };
  }

  @SubscribeMessage('leave_session')
  async handleLeave(
    @MessageBody(PIPE) dto: JoinSessionDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ event: string; data: unknown }> {
    const user = await this.currentUser(client);
    const context = client.data.context as SessionContext | undefined;

    if (context?.sessionId === dto.sessionId) {
      await Promise.all(
        context.layerIds.map((id) => this.layerLockService.release(id, client.id)),
      );
    }

    await this.presenceService.remove(dto.sessionId, user.id, client.id);
    await client.leave(DrawingService.sessionRoom(dto.sessionId));
    delete client.data.context;

    return { event: 'ack', data: { left: true } };
  }

  // ── Routing por modo (el corazón del sistema) ────────────────────────────

  private async broadcastStroke(
    context: SessionContext,
    payload:
      | {
          strokeId: string;
          userId: string;
          layerId: string | null;
          color: string;
          brushSize: number;
          tool: string;
          points: StrokePoint[];
        }
      | { stroke: unknown; committed?: boolean },
  ): Promise<void> {
    const live = 'points' in payload;
    const event = live ? 'stroke_draft' : 'stroke_broadcast';
    const targets = DrawingService.broadcastTargets(
      context.mode,
      context.sessionId,
      context.userId,
    );

    for (const { room } of targets) {
      this.server.to(room).emit(event, payload);
    }
  }

  private broadcastRemoval(
    context: SessionContext,
    removed: { strokeId: string; userId: string; layerId: string | null },
  ): void {
    for (const { room } of DrawingService.broadcastTargets(
      context.mode,
      context.sessionId,
      context.userId,
    )) {
      this.server.to(room).emit('stroke_removed', removed);
    }
  }

  /**
   * Decide la capa destino según el modo:
   *   INDIVIDUAL → null. El aislamiento lo da `Stroke.userId`, no una capa.
   *   LAYERED    → siempre la propia. Se ignora lo que pida el cliente.
   *   FREE       → cualquiera de las capas de la sesión.
   */
  private resolveLayerForDraw(
    context: SessionContext,
    requestedLayerId: string | null,
  ): string | null {
    if (context.mode === 'INDIVIDUAL') return null;

    if (context.mode === 'LAYERED') {
      if (!context.assignedLayerId) {
        throw new WsException('No tenés una capa asignada en esta sesión');
      }
      return context.assignedLayerId;
    }

    if (!requestedLayerId) {
      throw new WsException('Elegí una capa para dibujar');
    }
    if (!context.layerIds.includes(requestedLayerId)) {
      throw new WsException('La capa no pertenece a esta sesión');
    }
    return requestedLayerId;
  }

  private async lastOwnStroke(context: SessionContext): Promise<string | null> {
    const row = await this.prisma.stroke.findFirst({
      where: { sessionId: context.sessionId, userId: context.userId, isErased: false },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private async lastErasedOwnStroke(context: SessionContext): Promise<string | null> {
    const row = await this.prisma.stroke.findFirst({
      where: { sessionId: context.sessionId, userId: context.userId, isErased: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  // ── Presencia compartida entre instancias ────────────────────────────────

  private async subscribePresence(sessionId: string): Promise<void> {
    if (this.presenceChannels.has(sessionId)) return;

    const channel = `presence:events:${sessionId}`;
    const subscriber = this.redis.createAuxClient();

    subscriber.on('message', (incoming: string, raw: string) => {
      if (incoming !== channel || !this.server) return;
      try {
        const payload = JSON.parse(raw) as { sessionId: string; users: PresenceEntry[] };
        this.server
          .to(DrawingService.sessionRoom(payload.sessionId))
          .emit('presence_update', { users: payload.users });
      } catch {
        this.logger.warn('No se pudo parsear un evento de presencia');
      }
    });

    await subscriber.subscribe(channel);
    this.presenceChannels.set(sessionId, channel);
    this.presenceSubscribers.set(sessionId, subscriber);
  }

  /** Reemite presencia a los sockets locales, por si algún pub/sub se perdió. */
  private async sweepPresence(): Promise<void> {
    if (!this.server) return;

    for (const sessionId of this.presenceChannels.keys()) {
      const room = DrawingService.sessionRoom(sessionId);
      const sockets = await this.server.in(room).fetchSockets().catch(() => []);
      if (sockets.length === 0) continue;

      const users = await this.presenceService.list(sessionId);
      this.server.to(room).emit('presence_update', { users });
    }
  }

  /**
   * Cierra los suscriptores de presencia. Sin esto cada sesión visitada deja
   * una conexión Redis colgada hasta que el proceso muere.
   */
  async onModuleDestroy(): Promise<void> {
    const subscribers = [...this.presenceSubscribers.values()];
    this.presenceSubscribers.clear();
    this.presenceChannels.clear();
    await Promise.allSettled(subscribers.map((s) => s.quit()));
  }
}
