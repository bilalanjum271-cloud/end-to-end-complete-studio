// Grants platform staff access (Admin & Analytics) to an existing account.
//   DATABASE_URL=... node scripts/make-staff.mjs you@example.com [staff|superadmin]
import pg from 'pg';

const [email, role = 'superadmin'] = process.argv.slice(2);
if (!email || !['staff', 'superadmin', 'user'].includes(role)) {
  console.error('usage: node scripts/make-staff.mjs <email> [staff|superadmin|user]');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const res = await client.query('UPDATE users SET platform_role = $2, updated_at = now() WHERE email = lower($1) RETURNING id', [email, role]);
await client.end();
if (!res.rowCount) { console.error(`no account with email ${email}`); process.exit(1); }
console.log(`${email} is now ${role}. Sign out and in again to see Admin & Analytics.`);
