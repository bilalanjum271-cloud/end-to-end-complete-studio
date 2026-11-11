// Writes services/identity/openapi.json without starting the HTTP listener.
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Xen Studio Identity').setVersion('0.1.0').addBearerAuth().build());
  writeFileSync(join(__dirname, '..', '..', 'openapi.json'), JSON.stringify(doc, null, 2));
  await app.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
