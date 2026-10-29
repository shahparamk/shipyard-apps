const fs = require('fs');
const { Pool } = require('pg');

// TLS to the database: off locally, verified against the RDS CA bundle in AWS
function sslConfig() {
  if ((process.env.DB_SSL || 'disable') === 'disable') return false;
  const caPath = process.env.DB_SSL_CA || '/app/certs/rds-global-bundle.pem';
  return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

// Use DATABASE_URL if set (local); otherwise pg reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT
// (avoids URL-encoding problems with generated passwords)
function poolConfig(max) {
  const config = { max, ssl: sslConfig() };
  if (process.env.DATABASE_URL) config.connectionString = process.env.DATABASE_URL;
  return config;
}

function createDb() {
  const pool = new Pool(poolConfig(10));

  return {
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id           SERIAL PRIMARY KEY,
          item         TEXT        NOT NULL,
          quantity     INTEGER     NOT NULL CHECK (quantity > 0),
          status       TEXT        NOT NULL DEFAULT 'pending',
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at TIMESTAMPTZ,
          processed_by TEXT
        )
      `);
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async createOrder(item, quantity) {
      const { rows } = await pool.query(
        'INSERT INTO orders (item, quantity) VALUES ($1, $2) RETURNING *',
        [item, quantity]
      );
      return rows[0];
    },

    async listOrders(limit) {
      const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT $1', [limit]);
      return rows;
    },

    // Live counts for the dashboard (the order list is capped at 50 rows, so it can't count)
    async stats() {
      const { rows } = await pool.query(`
        SELECT
          count(*)                                                        AS total,
          count(*) FILTER (WHERE status = 'pending')                      AS pending,
          count(*) FILTER (WHERE processed_at > now() - interval '60 seconds') AS processed_last_minute,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY extract(epoch FROM processed_at - created_at) * 1000
          ) FILTER (WHERE processed_at > now() - interval '5 minutes')    AS p95_ms
        FROM orders
      `);
      const r = rows[0];
      return {
        total: Number(r.total),
        pending: Number(r.pending),
        processedLastMinute: Number(r.processed_last_minute),
        p95Ms: r.p95_ms === null ? null : Math.round(Number(r.p95_ms)),
      };
    },

    async getOrder(id) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDb };