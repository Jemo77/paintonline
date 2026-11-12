import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

/**
 * Convierte los errores del gateway en un evento `error` para el socket que los
 * Provocó.
 *
 * El filtro por defecto de Nest sólo responde si el cliente pasó un callback de
 * ack, y `socket.io-client` no lo hace: una sesión cerrada o un trazo sobre una
 * capa ajena fallarían en silencio. Con esto el cliente siempre sabe por qué no
 * puede dibujar.
 */
@Catch()
export class WsClientErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(WsClientErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const message = extractMessage(exception);

    // `WsException` con status de negocio (403, 400) es esperable: no es un
    // fallo del servidor, sólo un rechazo esperado.
    if (exception instanceof WsException || exception instanceof HttpException) {
      this.logger.debug(`[ws] ${message}`);
    } else {
      this.logger.error(`[ws] ${message}`, exception as Error);
    }

    if (client) {
      client.emit('error', { event: 'gateway', message });
    }
  }
}

function extractMessage(exception: unknown): string {
  if (exception instanceof WsException) {
    return exception.message;
  }
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && 'message' in response) {
      const { message } = response as { message: string | string[] };
      return Array.isArray(message) ? message.join(', ') : message;
    }
  }
  if (exception instanceof Error) return exception.message;
  return 'Error inesperado';
}
