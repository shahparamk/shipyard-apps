const request = require('supertest');
const { createApp } = require('../src/app');

function fakes({ dbDown = false } = {}) {
  const orders = [];
  const sent = [];
  return {
    sent,
    db: {
      ping: async () => {
        if (dbDown) throw new Error('db down');
      },
      createOrder: async (item, quantity) => {
        const order = { id: orders.length + 1, item, quantity, status: 'pending' };
        orders.push(order);
        return order;
      },
      listOrders: async () => [...orders].reverse(),
      getOrder: async (id) => orders.find((o) => o.id === id) || null,
    },
    queue: {
      sendOrder: async (id) => {
        sent.push(id);
      },
    },
  };
}

const info = { service: 'api', version: 'test', pod: 'test-pod', node: 'test-node' };

describe('health', () => {
  test('GET /healthz returns ok', async () => {
    const { db, queue } = fakes();
    const res = await request(createApp({ db, queue, info })).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /readyz returns 503 when the database is down', async () => {
    const { db, queue } = fakes({ dbDown: true });
    const res = await request(createApp({ db, queue, info })).get('/readyz');
    expect(res.status).toBe(503);
  });
});

describe('orders', () => {
  test('POST /api/orders creates an order and enqueues it', async () => {
    const f = fakes();
    const app = createApp({ db: f.db, queue: f.queue, info });
    const res = await request(app).post('/api/orders').send({ item: 'widget', quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, item: 'widget', quantity: 2, status: 'pending' });
    expect(f.sent).toEqual([1]);
  });

  test.each([
    [{ quantity: 2 }],
    [{ item: '', quantity: 2 }],
    [{ item: 'widget', quantity: 0 }],
    [{ item: 'widget', quantity: 1.5 }],
    [{ item: 'x'.repeat(101), quantity: 1 }],
  ])('POST /api/orders rejects invalid body %j', async (body) => {
    const f = fakes();
    const res = await request(createApp({ db: f.db, queue: f.queue, info }))
      .post('/api/orders')
      .send(body);
    expect(res.status).toBe(400);
    expect(f.sent).toEqual([]);
  });

  test('GET /api/orders/:id returns 404 for unknown order', async () => {
    const { db, queue } = fakes();
    const res = await request(createApp({ db, queue, info })).get('/api/orders/999');
    expect(res.status).toBe(404);
  });

  test('GET /metrics exposes Prometheus metrics', async () => {
    const { db, queue } = fakes();
    const res = await request(createApp({ db, queue, info })).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_request_duration_seconds');
  });
});