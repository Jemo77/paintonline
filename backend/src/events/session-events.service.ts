import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnGatewayInit } from '@nestjs/websockets';
import { WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Server } from 'socket.io';
import { DrawingService } from '../drawing/drawing.service';

export interface WinnerAnnouncement {
  position: number;
  points: number;
  user: { id: string; name: string; avatarUrl: string | null };
}

/**
 * Emisor de eventos de ciclo de vida de sesión hacia los sockets ya conectados.
 * Lo consume la API REST (cerrar sesión, elegir ganadores) para que los
 * participantes conectados reaccionen sin tener que recargar.
 */
@Injectable()
export class SessionEventsService implements OnGatewayInit, OnModuleInit {
  private readonly logger = new Logger(SessionEventsService.name);
  private namespace: Namespace | null = null;

  @WebSocketServer()
  private server!: Server;

  afterInit(server: Server): void {
    this.namespace = server.of('/session');
  }

  onModuleInit(): void {
    // El namespace se registra después del init; si aún no está listo, los
    // emisores lo resuelven en el momento de publicar.
  }

  private get ns(): Namespace | null {
    return this.namespace ?? this.server?.of('/session') ?? null;
  }

  emitToSession(sessionId: string, event: string, payload: unknown): void {
    this.ns?.to(DrawingService.sessionRoom(sessionId)).emit(event, payload);
  }

  /** El creador eligió los 3 ganadores. */
  announceWinners(sessionId: string, winners: WinnerAnnouncement[]): void {
    this.emitToSession(sessionId, 'winners_announced', { sessionId, winners });
  }

  /** La sesión pasó a CLOSED: los clientes bloquean el dibujo. */
  sessionClosed(sessionId: string): void {
    this.emitToSession(sessionId, 'session_closed', { sessionId });
  }

  sessionUpdated(sessionId: string, session: Record<string, unknown>): void {
    this.emitToSession(sessionId, 'session_updated', { sessionId, session });
  }

  layerChanged(sessionId: string, layer: Record<string, unknown>): void {
    this.emitToSession(sessionId, 'layer_changed', { layer });
  }

  layerRemoved(sessionId: string, layerId: string): void {
    this.emitToSession(sessionId, 'layer_removed', { layerId });
  }
}
