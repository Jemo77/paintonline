import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis/redis-io.adapter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PinoLogger } from './common/logger/pino-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const logger = new PinoLogger();
  app.useLogger(logger);

  app.setGlobalPrefix(process.env.API_PREFIX ?? 'api', {
    exclude: ['health', 'health/ready'],
  });

  app.use(helmet());
  app.enableCors({
    origin: parseOrigins(process.env.CORS_ORIGINS),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Sin esto, el raw body de Express no está disponible y algunos middlewares
  // de observabilidad fallan silenciosamente.
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.set('trust proxy', 1);

  // El redis-adapter es lo que permite escalar el gateway a varias instancias.
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');

  logger.log(`API escuchando en http://localhost:${port}/api`, {
    port,
  });
  logger.log(`Gateway de dibujo en ws://localhost:${port}/session`, {
    namespace: '/session',
  });
}

function parseOrigins(raw?: string): true | string[] {
  if (!raw || raw === '*') return true;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

void bootstrap();
