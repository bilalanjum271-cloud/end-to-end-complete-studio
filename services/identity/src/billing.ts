// Billing: Stripe behind a payment-provider interface, plus a mock provider so checkout works with no keys.
// The workspace's plan changes ONLY from a verified provider webhook, never from the browser.
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import type { Config } from './config';
import { POOL, tx } from './db';
import type { Actor } from './guards';
import { LedgerClient } from './ledger.client';

export interface CheckoutSession { id: string; url: string }
export type BillingEvent =
  | { type: 'subscription.active'; eventId: string; workspaceId: string; planId: string; providerRef: string; periodStart: number; periodEnd: number }
  | { type: 'subscription.canceled'; eventId: string; workspaceId: string; providerRef: string }
  | { type: 'ignored'; eventId: string };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: { workspaceId: string; planId: string; email: string; successUrl: string; cancelUrl: string; country: string }): Promise<CheckoutSession>;
  /** Verifies the signature and translates the provider's event. Throws on a bad signature. */
  parseWebhook(rawBody: string, signature: string): BillingEvent;
}

// ── Regional pricing (purchasing-power multipliers on the USD list price) ─────────
export const REGIONAL_MULTIPLIER: Record<string, number> = { PK: 0.35, IN: 0.4, BD: 0.35, NG: 0.4, EG: 0.4, ID: 0.5, PH: 0.5, BR: 0.6, TR: 0.55, MX: 0.6 };
export const regionalCents = (usdCents: number, country: string) => Math.round((usdCents * (REGIONAL_MULTIPLIER[country.toUpperCase()] ?? 1)) / 100) * 100;

// ── Stripe (REST, no SDK) ─────────────────────────────────────────────────────────
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  constructor(private readonly secretKey: string, private readonly webhookSecret: string, private readonly prices: Record<string, string>,
              private readonly fetchImpl: typeof fetch = fetch) {}

  async createCheckout(i: { workspaceId: string; planId: string; email: string; successUrl: string; cancelUrl: string; country: string }): Promise<CheckoutSession> {
    // A regional Stripe price (STRIPE_PRICE_PRO_PK) is used when one is configured, otherwise the global price.
    const price = this.prices[`${i.planId}_${i.country.toLowerCase()}`] ?? this.prices[i.planId];
    if (!price) throw new BadRequestException(`no Stripe price configured for plan ${i.planId}`);
    const form = new URLSearchParams({
      mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1', customer_email: i.email,
      success_url: i.successUrl, cancel_url: i.cancelUrl, client_reference_id: i.workspaceId,
      'subscription_data[metadata][workspace_id]': i.workspaceId, 'subscription_data[metadata][plan_id]': i.planId,
      'metadata[workspace_id]': i.workspaceId, 'metadata[plan_id]': i.planId, allow_promotion_codes: 'true',
    });
    const res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', body: form, signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `checkout:${i.workspaceId}:${i.planId}:${Math.floor(Date.now() / 60_000)}` },
    });
    const body = (await res.json()) as { id?: string; url?: string; error?: { message: string } };
    if (!res.ok || !body.id || !body.url) throw new BadRequestException(`Stripe: ${body.error?.message ?? res.status}`);
    return { id: body.id, url: body.url };
  }

  parseWebhook(raw: string, signature: string): BillingEvent {
    verifyStripeSignature(raw, signature, this.webhookSecret);
    const e = JSON.parse(raw) as { id: string; type: string; data: { object: Record<string, any> } };
    const o = e.data.object;
    if (e.type === 'customer.subscription.created' || e.type === 'customer.subscription.updated') {
      if (!['active', 'trialing'].includes(o.status)) return { type: 'ignored', eventId: e.id };
      return { type: 'subscription.active', eventId: e.id, workspaceId: o.metadata?.workspace_id, planId: o.metadata?.plan_id, providerRef: o.id,
               periodStart: o.current_period_start ?? o.items?.data?.[0]?.current_period_start, periodEnd: o.current_period_end ?? o.items?.data?.[0]?.current_period_end };
    }
    if (e.type === 'customer.subscription.deleted') return { type: 'subscription.canceled', eventId: e.id, workspaceId: o.metadata?.workspace_id, providerRef: o.id };
    return { type: 'ignored', eventId: e.id };
  }
}

/** Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">. Rejects signatures older than 5 minutes. */
export function verifyStripeSignature(raw: string, header: string, secret: string, now = Date.now()): void {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new ForbiddenException('missing webhook signature');
  if (Math.abs(now / 1000 - t) > 300) throw new ForbiddenException('stale webhook signature');
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest();
  const got = Buffer.from(parts.v1, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new ForbiddenException('invalid webhook signature');
}

// ── Mock provider: a local checkout page that "pays" by posting a signed webhook ──────
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';
  constructor(private readonly secret: string, private readonly webUrl: string) {}

  async createCheckout(i: { workspaceId: string; planId: string; successUrl: string }): Promise<CheckoutSession> {
    const id = `mock_cs_${randomUUID()}`;
    const q = new URLSearchParams({ session: id, workspace: i.workspaceId, plan: i.planId, return: i.successUrl });
    return { id, url: `${this.webUrl}/app/settings/mock-checkout?${q}` };
  }

  sign(raw: string, t = Math.floor(Date.now() / 1000)): string {
    return `t=${t},v1=${createHmac('sha256', this.secret).update(`${t}.${raw}`).digest('hex')}`;
  }

  parseWebhook(raw: string, signature: string): BillingEvent {
    verifyStripeSignature(raw, signature, this.secret); // same scheme as Stripe, so the webhook path is exercised for real
    const e = JSON.parse(raw) as { id: string; type: string; workspace_id: string; plan_id: string; subscription: string };
    const now = Math.floor(Date.now() / 1000);
    if (e.type === 'paid') return { type: 'subscription.active', eventId: e.id, workspaceId: e.workspace_id, planId: e.plan_id, providerRef: e.subscription, periodStart: now, periodEnd: now + 30 * 86400 };
    if (e.type === 'canceled') return { type: 'subscription.canceled', eventId: e.id, workspaceId: e.workspace_id, providerRef: e.subscription };
    return { type: 'ignored', eventId: e.id };
  }
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export function paymentProviderFactory(cfg: Config): PaymentProvider {
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
    const prices: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      const m = k.match(/^STRIPE_PRICE_([A-Z]+)(?:_([A-Z]{2}))?$/);
      if (m && v) prices[m[2] ? `${m[1].toLowerCase()}_${m[2].toLowerCase()}` : m[1].toLowerCase()] = v;
    }
    return new StripeProvider(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET, prices);
  }
  return new MockProvider(`mock-billing:${cfg.internalToken}`, process.env.WEB_URL ?? 'http://localhost:3000');
}

@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);
  constructor(@Inject(POOL) private readonly pool: Pool, @Inject(PAYMENT_PROVIDER) readonly provider: PaymentProvider,
              private readonly ledger: LedgerClient) {}

  async summary(actor: Actor) {
    const { rows } = await this.pool.query(
      `SELECT w.plan_id, p.name, p.monthly_price_cents, s.status, s.renews_at, s.provider
         FROM workspaces w JOIN plans p ON p.id = w.plan_id
         LEFT JOIN LATERAL (SELECT * FROM subscriptions s WHERE s.workspace_id = w.id ORDER BY s.updated_at DESC LIMIT 1) s ON true
        WHERE w.id = $1`, [actor.workspaceId]);
    if (!rows[0]) throw new NotFoundException('workspace not found');
    return { ...rows[0], provider: rows[0].provider ?? this.provider.name, payment_provider: this.provider.name };
  }

  async checkout(actor: Actor, planId: string, email: string, country: string) {
    const plan = await this.pool.query<{ monthly_price_cents: number }>(`SELECT monthly_price_cents FROM plans WHERE id = $1`, [planId]);
    if (!plan.rows[0] || plan.rows[0].monthly_price_cents === 0) throw new BadRequestException('choose a paid plan');
    const web = process.env.WEB_URL ?? 'http://localhost:3000';
    return this.provider.createCheckout({ workspaceId: actor.workspaceId, planId, email, country,
      successUrl: `${web}/app/settings?billing=success`, cancelUrl: `${web}/app/settings?billing=canceled` });
  }

  /** Applies a verified provider event exactly once (keyed by the provider's event id). */
  async handleWebhook(raw: string, signature: string): Promise<{ applied: boolean }> {
    const event = this.provider.parseWebhook(raw, signature);
    if (event.type === 'ignored') return { applied: false };
    if (!/^[0-9a-f-]{36}$/.test(event.workspaceId ?? '')) throw new BadRequestException('event has no workspace');
    let grant: { amount: number; key: string } | null = null;
    const applied = await tx(this.pool, async (c) => {
      const first = await c.query(
        `INSERT INTO idempotency_keys (workspace_id, key, request_hash, status_code) VALUES ($1, $2, $3, 200) ON CONFLICT DO NOTHING RETURNING key`,
        [event.workspaceId, `billing-event:${event.eventId}`, event.type]);
      if (!first.rowCount) return false; // duplicate delivery
      if (event.type === 'subscription.active') {
        const plan = await c.query<{ monthly_credits: string }>(`SELECT monthly_credits FROM plans WHERE id = $1`, [event.planId]);
        if (!plan.rows[0]) throw new BadRequestException('unknown plan in billing event');
        await c.query(`UPDATE workspaces SET plan_id = $2, updated_at = now() WHERE id = $1`, [event.workspaceId, event.planId]);
        await c.query(
          `INSERT INTO subscriptions (workspace_id, id, plan_id, status, provider, provider_ref, renews_at)
           VALUES ($1, $2, $3, 'active', $4, $5, to_timestamp($6))
           ON CONFLICT (workspace_id, id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', renews_at = excluded.renews_at, updated_at = now()`,
          [event.workspaceId, uuidFromRef(event.providerRef), event.planId, this.provider.name, event.providerRef, event.periodEnd]);
        // One credit grant per billing period; a re-delivered or updated event in the same period grants nothing extra.
        grant = { amount: Number(plan.rows[0].monthly_credits), key: `plan-grant:${event.workspaceId}:${event.providerRef}:${event.periodStart}` };
      } else {
        await c.query(`UPDATE workspaces SET plan_id = 'starter', updated_at = now() WHERE id = $1`, [event.workspaceId]);
        await c.query(`UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE workspace_id = $1 AND provider_ref = $2`, [event.workspaceId, event.providerRef]);
      }
      await c.query(`INSERT INTO outbox (workspace_id, id, topic, event_type, payload) VALUES ($1, $2, 'billing.events', $3, $4)`,
        [event.workspaceId, randomUUID(), event.type, JSON.stringify(event)]);
      await c.query(`INSERT INTO audit_logs (workspace_id, id, action, target, metadata) VALUES ($1, $2, $3, $4, $5)`,
        [event.workspaceId, randomUUID(), `billing.${event.type}`, event.providerRef, JSON.stringify({ provider: this.provider.name })]);
      return true;
    });
    if (grant) {
      const g = grant as { amount: number; key: string };
      if (!(await this.ledger.grant(event.workspaceId, g.amount, g.key, 'plan renewal'))) this.log.error(`credit grant pending for ${g.key}; reconciler will retry`);
    }
    return { applied };
  }
}

const uuidFromRef = (ref: string) => {
  const h = createHmac('sha256', 'xen-subscription').update(ref).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
