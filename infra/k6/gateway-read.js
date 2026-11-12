// k6: read path through the gateway (auth + rate limit + proxy). Written, not run (k6 was not available in the build sandbox).
//   k6 run -e BASE=http://localhost:8080 -e TOKEN=<access token> infra/k6/gateway-read.js
// Record: RPS per gateway pod at p99 < 150 ms, and the in-flight level where shedding starts. Put results in docs/capacity.md.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: { ramp: { executor: 'ramping-arrival-rate', startRate: 200, timeUnit: '1s', preAllocatedVUs: 500, maxVUs: 4000,
    stages: [{ target: 2000, duration: '2m' }, { target: 6000, duration: '3m' }, { target: 6000, duration: '3m' }] } },
  thresholds: { http_req_duration: ['p(99)<150'], http_req_failed: ['rate<0.01'] },
};

export default function () {
  const res = http.get(`${__ENV.BASE}/v1/credits`, { headers: { Authorization: `Bearer ${__ENV.TOKEN}`, 'X-Forwarded-For': `10.${__VU % 250}.${__ITER % 250}.1` } });
  check(res, { 'ok or shed': (r) => r.status === 200 || r.status === 429 || r.status === 503 });
}
