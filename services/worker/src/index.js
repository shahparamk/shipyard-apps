const fs = require('fs');
const http = require('http');
const os = require('os');
const client = require('prom-client');
const { Pool } = require('pg');
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require('@aws-sdk/client-sqs');

const podName = process.env.POD_NAME || os.hostname();
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, service: 'worker', pod: podName, msg, ...extra }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.QUEUE_URL) {
  log('error', 'missing required env var QUEUE_URL');
  process.exit(1);
}
if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  log('error', 'set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
  process.exit(1);
}

const queueUrl = process.env.QUEUE_URL;
const processingMs = Number(process.env.PROCESSING_MS || 500);

const sqs = new SQSClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT } : {}),
});

// TLS to the database: off locally, verified against the RDS CA bundle in AWS
function sslConfig() {
  if ((process.env.DB_SSL || 'disable') === 'disable') return false;
  const caPath = process.env.DB_SSL_CA || '/app/certs/rds-global-bundle.pem';
  return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

// Use DATABASE_URL if set (local); otherwise pg reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT
const poolConfig = { max: 5, ssl: sslConfig() };
if (process.env.DATABASE_URL) poolConfig.connectionString = process.env.DATABASE_URL;
const pool = new Pool(poolConfig);

// ---------- Metrics ----------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const processed = new client.Counter({
  name: 'orders_processed_total',
  help: 'Orders handled by the worker',
  labelNames: ['result'],
  registers: [register],
});

const duration = new client.Histogram({
  name: 'order_processing_duration_seconds',
  help: 'Time to process one order',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// ---------- Processing ----------
async function handle(message) {
  const end = duration.startTimer();
  const { orderId } = JSON.parse(message.Body);

  await sleep(processingMs); // simulated work

  // Idempotent: SQS is at-least-once, so only update orders still "pending"
  const { rowCount } = await pool.query(
    `UPDATE orders
        SET status = 'processed', processed_at = now(), processed_by = $2
      WHERE id = $1 AND status = 'pending'`,
    [orderId, podName]
  );

  // Delete only after the DB update succeeded; otherwise the message reappears and is retried
  await sqs.send(
    new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle })
  );

  end();
  const result = rowCount === 1 ? 'processed' : 'duplicate';
  processed.inc({ result });
  log('info', result === 'processed' ? 'order processed' : 'duplicate message ignored', { orderId });
}

let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      // Long polling: waits up to 20s for messages instead of hammering the API (cheaper, faster)
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 30,
        })
      );
      for (const message of Messages) {
        try {
          await handle(message);
        } catch (err) {
          processed.inc({ result: 'failed' });
          log('error', 'processing failed; message will be retried', { error: err.message });
        }
      }
    } catch (err) {
      log('error', 'receive failed', { error: err.message });
      await sleep(5000);
    }
  }
}

// ---------- Health + metrics server ----------
const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } else if (req.url === '/healthz') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
server.listen(Number(process.env.METRICS_PORT || 9091));

// ---------- Graceful shutdown ----------
const shutdown = (signal) => {
  log('info', 'shutdown requested; finishing current batch', { signal });
  stopping = true;
  setTimeout(() => process.exit(1), 25000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  log('info', 'worker starting', { queueUrl, processingMs });
  await loop();
  await pool.end();
  server.close();
  log('info', 'worker stopped');
  process.exit(0);
}

main().catch((err) => {
  log('error', 'fatal error', { error: err.message });
  process.exit(1);
});