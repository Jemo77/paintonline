import { Injectable, LoggerService } from '@nestjs/common';
import pino from 'pino';

/**
 * Logger estructurado (Pino) inyectado en el contenedor de Nest.
 * Los logs salen como JSON para que cualquier agregador los indexe.
 *
 * La instancia de Pino se llama `logger` a propósito: el método `log()` lo exige
 * la interfaz `LoggerService` y un campo privado con ese nombre colisionaría.
 */
@Injectable()
export class PinoLogger implements LoggerService {
  private readonly logger: pino.Logger;

  constructor() {
    const level =
      process.env.LOG_LEVEL ??
      (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

    this.logger = pino({
      level,
      base: { service: 'paintonline-api' },
      redact: {
        paths: ['req.headers.authorization', '*.password', '*.passwordHash'],
        remove: true,
      },
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino/file', options: { destination: 1 } },
    });
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  /**
   * Nest llama a los loggers como `log(contexto, mensaje)`. Tomamos el último
   * argumento string como mensaje y el resto como metadata estructurada.
   */
  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    rest: unknown[],
  ): void {
    const parts = rest.map((r) => (typeof r === 'string' ? r : r));
    const meta: Record<string, unknown> = {};

    for (const part of parts) {
      if (typeof part === 'string') continue;
      if (part instanceof Error) {
        meta.err = { message: part.message, stack: part.stack };
      } else if (typeof part === 'object' && part !== null) {
        Object.assign(meta, part);
      }
    }

    const text =
      typeof message === 'string' ? message : safeStringify(message);

    const context = typeof rest[0] === 'string' ? rest[0] : undefined;

    this.logger[level](
      { ...meta, ...(context ? { context } : {}) },
      text,
    );
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
