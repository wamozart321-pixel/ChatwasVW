import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { env } from './config/env';
import { GraphErrorFilter } from './whatsapp/graph-error.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Imprescindible: la firma de Meta se calcula sobre los bytes exactos del body.
    rawBody: true,
    logger:
      env.NODE_ENV === 'production'
        ? ['log', 'warn', 'error']
        : ['log', 'warn', 'error', 'debug'],
  });

  // La bandeja compilada (web/) se sirve desde el mismo proceso: un solo
  // despliegue, sin servidor web aparte. En desarrollo se usa el dev server de
  // Vite en :5173, que proxea /api y /socket.io hacia aca.
  const publico = join(__dirname, 'public');
  if (existsSync(publico)) {
    app.useStaticAssets(publico);
  }

  // Los rechazos de Meta salen con el motivo real y no como "Internal server
  // error": la causa casi nunca esta de este lado, y el asesor necesita saber
  // si el problema es el numero, la ventana de 24 h o la plantilla.
  app.useGlobalFilters(new GraphErrorFilter());

  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  const log = new Logger('bootstrap');
  log.log(`escuchando en http://localhost:${env.PORT}`);
  log.log(`bandeja:   ${existsSync(publico) ? 'servida desde dist/public' : 'no compilada (npm run web:build)'}`);
  log.log(`webhook:   POST /webhooks/whatsapp`);
  log.log(`graph api: ${env.META_GRAPH_VERSION}  numero: ${env.META_PHONE_NUMBER_ID}`);
}

void bootstrap();
