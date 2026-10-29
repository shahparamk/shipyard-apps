const request = require('supertest');
const { createApp } = require('../src/app');
const { clientIp } = require('../src/rateLimit');

const info = { service: 'api', version: 'test', pod: 'test-pod', node: 'test-node' };

function fakes() {
  let id = 0;
  return {
    db: {
      createOrder: async (item, quantity) => ({ id: ++id, item, quantity, status: 'pending' }),
      listOrders: async () => [],
      getOrder: async () => null,
      ping: async () => {},
    },
    queue: { sendOrder: async () => {} },
  };
}

const order = { item: 'widget', quantity: 1 };

describe('rate limiting on POST /api/orders', () => {
  test('rejects a client seen through the load balancer after the limit', async () => {
    const app = createApp({ ...fakes(), info, rateLimit: { max: 3, windowMs: 60000 } });
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/orders').set('X-Forwarded-For', '203.0.113.7').send(order).expect(201);
    }
    const res = await request(app).post('/api/orders').set('X-Forwarded-For', '203.0.113.7').send(order);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('keys on the last X-Forwarded-For entry (added by the ALB), so spoofing the header does not help', async () => {
    const app = createApp({ ...fakes(), info, rateLimit: { max: 1, windowMs: 60000 } });
    await request(app).post('/api/orders').set('X-Forwarded-For', '1.1.1.1, 203.0.113.7').send(order).expect(201);
    await request(app).post('/api/orders').set('X-Forwarded-For', '9.9.9.9, 203.0.113.7').send(order).expect(429);
  });

  test('different clients have separate limits', async () => {
    const app = createApp({ ...fakes(), info, rateLimit: { max: 1, windowMs: 60000 } });
    await request(app).post('/api/orders').set('X-Forwarded-For', '203.0.113.7').send(order).expect(201);
    await request(app).post('/api/orders').set('X-Forwarded-For', '198.51.100.9').send(order).expect(201);
  });

  test('does not limit in-cluster callers (no X-Forwarded-For), e.g. the k6 load test', async () => {
    const app = createApp({ ...fakes(), info, rateLimit: { max: 1, windowMs: 60000 } });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/orders').send(order).expect(201);
    }
  });

  test('does not limit reads', async () => {
    const app = createApp({ ...fakes(), info, rateLimit: { max: 1, windowMs: 60000 } });
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/orders').set('X-Forwarded-For', '203.0.113.7').expect(200);
    }
  });
});

describe('clientIp', () => {
  test('returns null without the header and the last entry otherwise', () => {
    expect(clientIp({ headers: {} })).toBeNull();
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('203.0.113.7');
    expect(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' } })).toBe('203.0.113.7');
  });
});
