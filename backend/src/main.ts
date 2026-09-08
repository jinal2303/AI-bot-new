import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({
    origin: corsOrigin.split(',').map((origin) => origin.trim()),
    methods: ['GET'],
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);

  logger.log(`🚀 Nifty Options Signal API listening on http://localhost:${port}/api`);
  logger.log(`📡 Latest signal endpoint: http://localhost:${port}/api/signals/latest`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error while bootstrapping the application:', error);
  process.exit(1);
});
