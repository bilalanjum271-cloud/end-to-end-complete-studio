// Seeds plans and the local cell. Idempotent. Usage: DATABASE_URL=... node scripts/seed.mjs
import pg from 'pg';

export const PLANS = [
  { id: 'starter', name: 'Starter', monthly_price_cents: 0, monthly_credits: 300, max_revision_rounds: 1,
    max_video_seconds: 60, max_concurrent_jobs: 1, queue_priority: 10, rate_limit_rpm: 60, workspace_rate_rpm: 120,
    max_seats: 1, watermark: true, features: { studios: ['video'], export_1080p: false, api: false } },
  { id: 'creator', name: 'Creator', monthly_price_cents: 2900, monthly_credits: 3000, max_revision_rounds: 3,
    max_video_seconds: 600, max_concurrent_jobs: 3, queue_priority: 50, rate_limit_rpm: 240, workspace_rate_rpm: 600,
    max_seats: 3, watermark: false, features: { studios: ['video', 'animation'], export_1080p: true, api: false } },
  { id: 'studio', name: 'Studio', monthly_price_cents: 9900, monthly_credits: 12000, max_revision_rounds: 5,
    max_video_seconds: 1800, max_concurrent_jobs: 10, queue_priority: 90, rate_limit_rpm: 600, workspace_rate_rpm: 3000,
    max_seats: 15, watermark: false, features: { studios: ['video', 'animation', 'ar', 'vr', 'xr'], export_1080p: true, export_4k: true, api: true } },
];

export async function seed(client) {
  for (const p of PLANS) {
    await client.query(
      `INSERT INTO plans (id,name,monthly_price_cents,monthly_credits,max_revision_rounds,max_video_seconds,
         max_concurrent_jobs,queue_priority,rate_limit_rpm,workspace_rate_rpm,max_seats,watermark,features)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET name=excluded.name, monthly_price_cents=excluded.monthly_price_cents,
         monthly_credits=excluded.monthly_credits, max_revision_rounds=excluded.max_revision_rounds,
         max_video_seconds=excluded.max_video_seconds, max_concurrent_jobs=excluded.max_concurrent_jobs,
         queue_priority=excluded.queue_priority, rate_limit_rpm=excluded.rate_limit_rpm,
         workspace_rate_rpm=excluded.workspace_rate_rpm, max_seats=excluded.max_seats,
         watermark=excluded.watermark, features=excluded.features`,
      [p.id, p.name, p.monthly_price_cents, p.monthly_credits, p.max_revision_rounds, p.max_video_seconds,
        p.max_concurrent_jobs, p.queue_priority, p.rate_limit_rpm, p.workspace_rate_rpm, p.max_seats, p.watermark,
        JSON.stringify(p.features)],
    );
  }
  await client.query(
    `INSERT INTO cells (id, region, endpoint) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [process.env.CELL_ID ?? 'cell-local-1', process.env.CELL_REGION ?? 'local', process.env.GATEWAY_URL ?? 'http://localhost:8080'],
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await seed(client); console.log('seeded plans and local cell'); } finally { await client.end(); }
}
