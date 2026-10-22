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