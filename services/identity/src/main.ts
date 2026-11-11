import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { CONFIG, Config } from './config';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Xen Studio Identity').setVersion('0.1.0').addBearerAuth().build());
  SwaggerModule.setup('docs', app, doc);
  const cfg = app.get<Config>(CONFIG);
  await app.listen(cfg.port);
  console.log(JSON.stringify({ level: 'info', service: 'identity', msg: 'listening', port: cfg.port }));
}
main().catch((err) => { console.error(err); process.exit(1); });
