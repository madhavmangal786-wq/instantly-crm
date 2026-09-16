// Exports the LIVE Postgres DB (defaults to the embedded instance this app runs on)
// to the same SQL INSERT + manifest format that scripts/import-pg.js loads into Supabase.
// Run: node scripts/export-pg.js
const { Client } = require('pg');
const path = require('node:path');
const fs = require('node:fs');

const OUT = process.env.CRM_OUT || path.join(__dirname, '..', 'data', 'pg-export');
const conn = process.env.DATABASE_URL;
const opts = conn
  ? { connectionString: conn, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: 'localhost', port: parseInt(process.env.PGPORT || '5433', 10), database: 'instantly_crm', user: 'postgres', password: 'postgres' };

const TABLES = { campaigns: 'id', leads: 'id', emails: 'id', drafts: 'id', settings: 'key', templates: 'id', activity_log: 'id' };

function pgType(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(20);
  const s = String(v);
  if (s.includes('\n') || s.includes('\r') || s.includes('\\')) {
    // Backslashes must be escaped first: inside E'...' Postgres decodes \n, \", \t etc., so an
    // unescaped JSON escape like \n turns into a real newline and the stored JSON is invalid.
    const esc = s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    return "E'" + esc + "'";
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

async function main() {
  const client = new Client(opts);
  await client.connect();
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = {};
  for (const table of Object.keys(TABLES)) {
    const cols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name);
    const rows = (await client.query(`SELECT ${cols.map((c) => '"' + c + '"').join(', ')} FROM "${table}"`)).rows;
    manifest[table] = { columns: cols, count: rows.length };
    const parts = rows.map((r) =>
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => pgType(r[c])).join(', ')});`
    );
    const f = path.join(OUT, `table_${table}.sql`);
    fs.writeFileSync(f, parts.join('\n') + (parts.length ? '\n' : ''));
    console.log(`${table}: ${rows.length} rows -> ${f}`);
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Manifest written to', path.join(OUT, 'manifest.json'));
  await client.end();
}

main().catch((e) => { console.error('Export failed:', e.message); process.exit(1); });