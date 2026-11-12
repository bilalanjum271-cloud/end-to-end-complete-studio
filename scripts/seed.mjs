// Seeds plans and the local cell. Idempotent. Usage: DATABASE_URL=... node scripts/seed.mjs
import pg from 'pg';

// Limits follow the "Plan limits (draft)" table of the Master Stack document.
// 1 video minute = 10 credits, so monthly_credits = video_minutes * 10.
// Prices are provisional: the document leaves them open until cost per video minute is measured in Phase 2.
export const PLANS = [
  { id: 'starter', name: 'Starter', monthly_price_cents: 0, video_minutes: 20, monthly_credits: 200, max_revisions: 2,
    max_video_seconds: 180, max_resolution: '720p', max_languages: 10, voice_clones: 0, animation_access: 'limited', xr_access: 'none',
    max_seats: 1, queue_priority: 10, publish_channels: 1, api_access: false, watermark: true,
    max_concurrent_jobs: 1, rate_limit_rpm: 60, workspace_rate_rpm: 120 },
  { id: 'pro', name: 'Pro', monthly_price_cents: 2900, video_minutes: 100, monthly_credits: 1000, max_revisions: 5,
    max_video_seconds: 900, max_resolution: '1080p', max_languages: 30, voice_clones: 1, animation_access: 'full', xr_access: 'preview',
    max_seats: 5, queue_priority: 50, publish_channels: 5, api_access: false, watermark: false,
    max_concurrent_jobs: 3, rate_limit_rpm: 240, workspace_rate_rpm: 600 },
  { id: 'studio', name: 'Studio', monthly_price_cents: 9900, video_minutes: 500, monthly_credits: 5000, max_revisions: 5,
    max_video_seconds: 3600, max_resolution: '4k', max_languages: null, voice_clones: 10, animation_access: 'full', xr_access: 'full',
    max_seats: 25, queue_priority: 90, publish_channels: null, api_access: true, watermark: false,
    max_concurrent_jobs: 10, rate_limit_rpm: 600, workspace_rate_rpm: 3000 },
];

const COLS = ['id', 'name', 'monthly_price_cents', 'video_minutes', 'monthly_credits', 'max_revisions', 'max_video_seconds', 'max_resolution',
  'max_languages', 'voice_clones', 'animation_access', 'xr_access', 'max_seats', 'queue_priority', 'publish_channels', 'api_access',
  'watermark', 'max_concurrent_jobs', 'rate_limit_rpm', 'workspace_rate_rpm'];

export async function seed(client) {
  for (const p of PLANS) {
    await client.query(
      `INSERT INTO plans (${COLS.join(',')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')})
       ON CONFLICT (id) DO UPDATE SET ${COLS.slice(1).map((c) => `${c}=excluded.${c}`).join(', ')}`,
      COLS.map((c) => p[c]),
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
