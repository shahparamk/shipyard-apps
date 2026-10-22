const os = require('os');
const { createApp } = require('./app');
const { createDb } = require('./db');
const { createQueue } = require('./queue');

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, service: 'api', msg, ...extra }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.QUEUE_URL) {
  log('error', 'missing required env var QUEUE_URL');
  process.exit(1);
}
if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  log('error', 'set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
  process.exit(1);
}

async function main() {
  const db = createDb();

  // The DB may start slower than the API; retry instead of crashing
  for (let attempt = 1; ; attempt++) {
    try {
      await db.migrate();
      break;
    } catch (err) {
      if (attempt >= 15) throw err;
      log('warn', 'database not ready, retrying', { attempt, error: err.message });
      await sleep(2000);
    }
  }

  const info = {
    service: 'api',
    version: process.env.APP_VERSION || 'dev',
    pod: process.env.POD_NAME || os.hostname(),
    node: process.env.NODE_NAME || 'local',
  };

  const app = createApp({ db, queue: createQueue(), info });
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, () => log('info', 'api listening', { port, ...info }));

  // Kubernetes sends SIGTERM before stopping a pod: stop accepting, finish in-flight, exit
  const shutdown = (signal) => {
    log('info', 'shutting down', { signal });
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log('error', 'fatal startup error', { error: err.message });
  process.exit(1);
});