// k6 load test for the orders API.
// Ramps the ARRIVAL RATE (orders per second), not the number of virtual users,
// so a slow server can't hide behind fewer requests.
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://orders-api.shipyard.svc.cluster.local';

export const options = {
  scenarios: {
    rush: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { target: 15, duration: '1m' }, // warm up
        { target: 30, duration: '2m' }, // ramp to peak
        { target: 30, duration: '2m' }, // hold the peak: autoscalers should react here
        { target: 0, duration: '30s' }, // ramp down
      ],
    },
  },
  // Same SLOs as the PrometheusRule: the test FAILS if they're breached
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% errors
    http_req_duration: ['p(95)<500'], // 95% of requests under 500 ms
  },
};

export default function () {
  const payload = JSON.stringify({ item: `k6-${__VU}-${__ITER}`, quantity: 1 });
  const res = http.post(`${BASE_URL}/api/orders`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'order accepted (201)': (r) => r.status === 201 });
}