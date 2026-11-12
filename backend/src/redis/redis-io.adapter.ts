import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { RedisService } from './redis.service';

/**
 * IoAdapter que engancha el socket.io redis-adapter.
 * Sin esto, dos instancias del gateway no se ven entre sí: cada una mantendría
 * sus propias salas y los broadcasts de strokes no llegarían a todos.
 *
 * `createIOServer` es deliberadamente síncrono. Nest lo encadena con
 * `.of(namespace)` sin await, así que devolver una promesa rompería el arranque.
 * Los clientes de Redis se crean ya conectando, por eso no hace falta esperar.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly redis: RedisService;
  private adapted = false;

  constructor(app: INestApplicationContext) {
    super(app);
    this.redis = app.get(RedisService);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;

    // Sólo el primer `createIOServer` construye el server raíz; para los
    // namespaces Nest reusa la instancia y no pasa por acá.
    if (!this.adapted) {
      this.adapted = true;
      server.adapter(
        createAdapter(this.redis.createAuxClient(), this.redis.createAuxClient(), {
          requestsTimeout: 10_000,
        }),
      );
    }

    return server;
  }
}
