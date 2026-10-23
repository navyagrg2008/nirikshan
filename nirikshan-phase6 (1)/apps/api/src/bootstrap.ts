import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

export async function createApp(): Promise<NestExpressApplication> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'], bodyParser: true });
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' }, referrerPolicy: { policy: 'no-referrer' } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '256kb' });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  if (env.ENABLE_SWAGGER && env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(app as INestApplication, new DocumentBuilder().setTitle('Nirikshan API').setVersion('0.2.0').build());
    SwaggerModule.setup('api/docs', app as INestApplication, doc);
  }
  return app;
}
