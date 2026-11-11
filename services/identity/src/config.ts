export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  accessTtl: number;
  refreshTtl: number;
  gatewayToken: string;
  internalToken: string;
  ledgerUrl: string;
}

export const CONFIG = Symbol('CONFIG');

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): Config {
  const jwtSecret = required('JWT_SECRET');
  if (Buffer.byteLength(jwtSecret) < 32) throw new Error('JWT_SECRET must be at least 32 bytes');
  const internalToken = required('INTERNAL_SERVICE_TOKEN');
  return {
    port: Number(process.env.IDENTITY_PORT ?? 8101),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    accessTtl: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTtl: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 2_592_000),
    gatewayToken: internalToken,
    internalToken,
    ledgerUrl: process.env.LEDGER_URL ?? 'http://localhost:8102',
  };
}
