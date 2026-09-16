const { Pool } = require('pg');

// === Connection ===
// Prefer a full Postgres connection string; fall back to discrete env vars;
// if nothing is set, spin up an embedded PostgreSQL instance.
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_URL;

let pool;
let embeddedPg = null;

async function ensureDb() {
  if (pool) return;
  if (connectionString) {
    pool = new Pool({ connectionString, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false } });
    return attachPool();
  }
  // Try discrete env vars first
  if (process.env.PGHOST) {
    pool = new Pool({
      host: process.env.PGHOST,
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'instantly_crm',
      user: process.env.PGUSER || process.env.USER,
      password: process.env.PGPASSWORD || undefined,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    return attachPool();
  }
  // Spin up embedded PostgreSQL (ESM module loaded via dynamic import)
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = parseInt(process.env.PGPORT || '5433', 10);
  const pgUser = 'postgres';
  const pgPass = 'postgres';
  const fs = require('node:fs');
  const baseDataDir = process.env.CRM_DATA_DIR || require('node:path').join(__dirname, '..', 'data');
  const dataDir = require('node:path').join(baseDataDir, 'pg-data');
  embeddedPg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: pgUser,
    password: pgPass,
  });
  console.log('[db] Starting embedded PostgreSQL...');
  if (!fs.existsSync(require('node:path').join(dataDir, 'PG_VERSION'))) {
    await embeddedPg.initialise();
  }
  await embeddedPg.start();
  const dbName = 'instantly_crm';
  try { await embeddedPg.createDatabase(dbName); } catch (err) { /* db already exists */ }
  pool = new Pool({ host: 'localhost', port, database: dbName, user: pgUser, password: pgPass });
  attachPool();
  console.log(`[db] Embedded PostgreSQL running on port ${port}`);
}

function attachPool() {
  if (pool) pool.on('error', (err) => console.error('[db] idle client error:', err.message));
}

// Stop the embedded Postgres cleanly so it doesn't leave a stale postmaster.pid
// lock file (or an orphaned process) behind when the app is stopped.
async function shutdownDb() {
  if (embeddedPg) {
    try { await embeddedPg.stop(); } catch (err) { console.error('[db] error stopping embedded Postgres:', err.message); }
  }
}

// Small convenience wrappers. All SQL in this app uses $1-style placeholders.
const query = (text, params = []) => pool.query(text, params);

// === Schema ===
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id             TEXT PRIMARY KEY,
      name           TEXT,
      status         TEXT,
      kind           TEXT DEFAULT 'campaign',
      raw            TEXT,
      synced_at      TEXT,
      context_offer  TEXT DEFAULT '',
      context_icp    TEXT DEFAULT '',
      context_tone   TEXT DEFAULT '',
      context_faqs   TEXT DEFAULT '',
      context_notes  TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS leads (
      id               TEXT PRIMARY KEY,
      email            TEXT,
      first_name       TEXT,
      last_name        TEXT,
      company_name     TEXT,
      job_title        TEXT,
      campaign_id      TEXT,
      list_id          TEXT,
      status           TEXT,
      interest_status  INTEGER,
      my_status        TEXT,
      priority         TEXT DEFAULT 'normal',
      opened_count     INTEGER DEFAULT 0,
      reply_count      INTEGER DEFAULT 0,
      clicked_count    INTEGER DEFAULT 0,
      last_reply_at    TEXT,
      last_contact_at  TEXT,
      last_open_at     TEXT,
      last_click_at    TEXT,
      last_touch_at    TEXT,
      payload_json     TEXT,
      raw              TEXT,
      updated_at       TEXT,
      manual_override  INTEGER DEFAULT 0,
      priority_manual  INTEGER DEFAULT 0,
      last_email_fetch_at TEXT,
      next_touch_at    TEXT,
      notes            TEXT DEFAULT '',
      deal_value       NUMERIC DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
    CREATE INDEX IF NOT EXISTS idx_leads_my_status ON leads(my_status);
    CREATE INDEX IF NOT EXISTS idx_leads_next_touch ON leads(next_touch_at);
    CREATE TABLE IF NOT EXISTS emails (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT,
      lead_id      TEXT,
      campaign_id  TEXT,
      subject      TEXT,
      body_text    TEXT,
      direction    TEXT,
      ue_type      INTEGER,
      from_email   TEXT,
      to_email     TEXT,
      is_unread    INTEGER DEFAULT 0,
      is_auto      INTEGER DEFAULT 0,
      timestamp    TEXT,
      raw          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_emails_lead ON emails(lead_id);
    CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
    CREATE INDEX IF NOT EXISTS idx_emails_ts ON emails(timestamp);
    CREATE TABLE IF NOT EXISTS drafts (
      id         SERIAL PRIMARY KEY,
      lead_id    TEXT,
      reply_to   TEXT,
      eaccount   TEXT,
      subject    TEXT,
      body       TEXT,
      status     TEXT DEFAULT 'draft',
      error      TEXT,
      created_at TEXT,
      sent_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_lead ON drafts(lead_id);
    CREATE TABLE IF NOT EXISTS activity_log (
      id          SERIAL PRIMARY KEY,
      lead_id     TEXT,
      campaign_id TEXT,
      type        TEXT,
      detail      TEXT,
      timestamp   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_lead ON activity_log(lead_id);
    CREATE TABLE IF NOT EXISTS templates (
      id          SERIAL PRIMARY KEY,
      name        TEXT,
      subject     TEXT,
      body        TEXT,
      campaign_id TEXT,
      created_at  TEXT,
      updated_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      endpoint   TEXT UNIQUE,
      p256dh     TEXT,
      auth       TEXT,
      created_at TEXT
    );
`;

async function initSchema() {
  await query(SCHEMA_SQL);
  // Migrations for databases created before these columns existed.
  await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS priority_manual INTEGER DEFAULT 0');
  await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS deal_value NUMERIC DEFAULT 0');
}

async function markStaleDrafts() {
  const staleCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await query("UPDATE drafts SET status = 'superseded' WHERE status = 'draft' AND created_at < $1", [staleCutoff]);
}

async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  );
}

async function logActivity({ leadId, campaignId, type, detail, at }) {
  await query(
    'INSERT INTO activity_log (lead_id, campaign_id, type, detail, timestamp) VALUES ($1, $2, $3, $4, $5)',
    [leadId || null, campaignId || null, type, detail, at || new Date().toISOString()]
  );
}

module.exports = { query, pool, initSchema, markStaleDrafts, getSetting, setSetting, logActivity, ensureDb, shutdownDb, SCHEMA_SQL };