"use strict";
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Add a Postgres database to the Railway project and reference its DATABASE_URL.");
  process.exit(1);
}

// Railway's private network does not use SSL; public proxy URLs do.
const useSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === "true";
const pool = new Pool({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : false, max: 10 });

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      token_version INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,3) NOT NULL DEFAULT 0,
      sku TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      photo_key TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      stripe_product_id TEXT,
      stripe_price_id TEXT,
      stripe_amount INTEGER,
      stripe_currency TEXT,
      stripe_error TEXT NOT NULL DEFAULT '',
      stripe_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE SEQUENCE IF NOT EXISTS order_no_seq START 1001;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      no INTEGER NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      staff_id INTEGER,
      staff_name TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL,
      subtotal NUMERIC(12,3) NOT NULL,
      discount NUMERIC(12,3) NOT NULL DEFAULT 0,
      total NUMERIC(12,3) NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash','qr','stripe')),
      received NUMERIC(12,3) NOT NULL DEFAULT 0,
      change NUMERIC(12,3) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      shopify BOOLEAN NOT NULL DEFAULT FALSE,
      shopify_exported_at TIMESTAMPTZ,
      stripe_session_id TEXT UNIQUE,
      stripe_payment_intent TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','expired','cancelled')),
      url TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      items JSONB NOT NULL,
      subtotal NUMERIC(12,3) NOT NULL,
      discount NUMERIC(12,3) NOT NULL DEFAULT 0,
      total NUMERIC(12,3) NOT NULL,
      currency TEXT NOT NULL,
      staff_id INTEGER,
      staff_name TEXT NOT NULL DEFAULT '',
      order_id TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, q, tx, migrate };
