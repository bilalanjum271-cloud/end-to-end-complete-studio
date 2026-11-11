import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, Config } from './config';

@Injectable()
export class LedgerClient {
  private readonly log = new Logger(LedgerClient.name);
  constructor(@Inject(CONFIG) private readonly cfg: Config) {}

  /** Idempotent credit grant. Safe to retry with the same key; returns false if the ledger is unreachable. */
  async grant(workspaceId: string, amount: number, key: string, reason: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.cfg.ledgerUrl}/internal/v1/workspaces/${workspaceId}/credits/grant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': this.cfg.internalToken, 'idempotency-key': key },
          body: JSON.stringify({ amount, reason }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) return true;
        if (res.status < 500) {
          this.log.error(`ledger rejected grant ${key}: ${res.status}`);
          return false;
        }
      } catch (err) {
        this.log.warn(`ledger grant attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
    return false;
  }
}
