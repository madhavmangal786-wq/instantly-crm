const { Pool } = require('pg');

// === Connection ===
// Prefer a full Postgres connection string; fall back to discrete env vars.
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_URL;

let pool;
if (connectionString) {
  pool = new Pool({ connectionString, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false } });
} else {
  pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'instantly_crm',
    user: process.env.PGUSER || process.env.USER,
    password: process.env.PGPASSWORD || undefined,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// Small convenience wrappers. All SQL in this app uses $1-style placeholders.
const query = (text, params = []) => pool.query(text, params);

// === Schema ===
async function initSchema() {
  await query(`
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
      last_email_fetch_at TEXT,
      next_touch_at    TEXT,
      notes            TEXT DEFAULT ''
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
  `);
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

module.exports = { query, pool, initSchema, markStaleDrafts, getSetting, setSetting, logActivity };