import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 1 << 15; // 32768: OWASP-recommended scrypt work factor
const PARAMS = { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 };

/** Hash format: scrypt$N$salt$hash (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, PARAMS);
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const cost = Number(n);
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, { N: cost, r: 8, p: 1, maxmem: 128 * cost * 8 * 2 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');
