const { Pool } = require('pg');

function createDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

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