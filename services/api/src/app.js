const express = require('express');
const client = require('prom-client');

// Dependencies are injected so tests can use fakes instead of a real DB/queue
function createApp({ db, queue, info }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // ---------- Metrics ----------
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [register],
  });

  const ordersCreated = new client.Counter({
    name: 'orders_created_total',
    help: 'Orders accepted by the API',
    registers: [register],
  });

  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      end({ method: req.method, route, status: res.statusCode });
    });
    next();
  });

  // ---------- Health ----------
  // Liveness: is the process alive?
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  // Readiness: can it do real work (DB reachable)?
  app.get('/readyz', async (req, res) => {
    try {
      await db.ping();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not ready' });
    }
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  // Which pod/node served this request (for the dashboard's platform panel)
  app.get('/api/info', (req, res) => res.json(info));

  // ---------- Orders ----------
  app.post('/api/orders', async (req, res) => {
    const { item, quantity } = req.body || {};

    if (typeof item !== 'string' || item.trim() === '' || item.length > 100) {
      return res.status(400).json({ error: 'item must be a non-empty string (max 100 chars)' });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      return res.status(400).json({ error: 'quantity must be an integer between 1 and 1000' });
    }

    // Known gap: if the insert succeeds but enqueue fails, the order stays "pending".
    // Fix later with the outbox pattern (planned failure drill).
    const order = await db.createOrder(item.trim(), quantity);
    await queue.sendOrder(order.id);
    ordersCreated.inc();

    res.status(201).json(order);
  });

  app.get('/api/orders', async (req, res) => {
    res.json(await db.listOrders(50));
  });

  app.get('/api/orders/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const order = await db.getOrder(id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json(order);
  });

  // ---------- Errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(JSON.stringify({ level: 'error', service: 'api', msg: err.message }));
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };