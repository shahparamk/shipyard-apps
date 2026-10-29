const request = require('supertest');
const { createApp } = require('../src/app');

const info = { service: 'api', version: 'test', pod: 'test-pod', node: 'test-node' };

test('GET /api/stats returns the live counts from the database', async () => {
  const stats = { total: 1284, pending: 37, processedLastMinute: 612, p95Ms: 1180 };
  const app = createApp({
    db: { stats: async () => stats, ping: async () => {} },
    queue: { sendOrder: async () => {} },
    info,
  });
  const res = await request(app).get('/api/stats').expect(200);
  expect(res.body).toEqual(stats);
});

test('GET /api/stats is not rate limited (reads are free)', async () => {
  const app = createApp({
    db: { stats: async () => ({ total: 0, pending: 0, processedLastMinute: 0, p95Ms: null }) },
    queue: { sendOrder: async () => {} },
    info,
    rateLimit: { max: 1, windowMs: 60000 },
  });
  for (let i = 0; i < 3; i++) {
    await request(app).get('/api/stats').set('X-Forwarded-For', '203.0.113.7').expect(200);
  }
});
