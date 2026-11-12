import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Pool } from 'pg';
import { CONFIG, Config, loadConfig } from './config';
import { AuthController, BillingController, OpsController, PlansController, WorkspacesController } from './controllers';
import { BillingService, PAYMENT_PROVIDER, paymentProviderFactory } from './billing';
import { POOL } from './db';
import { GatewayGuard } from './guards';
import { IdentityService } from './identity.service';
import { LedgerClient } from './ledger.client';

@Module({
  controllers: [OpsController, AuthController, PlansController, WorkspacesController, BillingController],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    { provide: POOL, inject: [CONFIG], useFactory: (cfg: Config) => new Pool({ connectionString: cfg.databaseUrl, max: 20 }) },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) },
    { provide: APP_GUARD, useClass: GatewayGuard },
    LedgerClient,
    IdentityService,
    { provide: PAYMENT_PROVIDER, inject: [CONFIG], useFactory: paymentProviderFactory },
    BillingService,
  ],
})
export class AppModule {}
