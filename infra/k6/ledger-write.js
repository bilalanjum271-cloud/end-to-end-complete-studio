// k6: ledger write path (reserve -> commit), many workspaces. Written, not run.
//   k6 run -e LEDGER=http://localhost:8102 -e TOKEN=<INTERNAL_SERVICE_TOKEN> infra/k6/ledger-write.js
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = { vus: 200, duration: '5m', thresholds: { http_req_duration: ['p(99)<80'], checks: ['rate>0.999'] } };
const H = (key) => ({ headers: { 'X-Internal-Token': __ENV.TOKEN, 'Idempotency-Key': key, 'Content-Type': 'application/json' } });

export function setup() {
  const ws = Array.from({ length: 1000 }, () => uuidv4());
  ws.forEach((w) => http.post(`${__ENV.LEDGER}/internal/v1/workspaces/${w}/credits/grant`, JSON.stringify({ amount: 1e9, reason: 'k6' }), H(`grant-${w}`)));
  return { ws };
}

export default function ({ ws }) {
  const w = ws[Math.floor(Math.random() * ws.length)];
  const job = uuidv4();
  const r = http.post(`${__ENV.LEDGER}/internal/v1/workspaces/${w}/credits/reserve`, JSON.stringify({ amount: 3, job_id: job }), H(`${job}:r`));
  check(r, { reserved: (x) => x.status === 201 });
  const c = http.post(`${__ENV.LEDGER}/internal/v1/workspaces/${w}/reservations/${r.json('reservation_id')}/commit`, '{}', H(`${job}:c`));
  check(c, { committed: (x) => x.status === 201 });
}
