// Exports the local SQLite DB to a set of SQL INSERT files + a JSON manifest with row counts.
// Run: node scripts/export-sqlite.js
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SRC = process.env.CRM_SRC || path.join(__dirname, '..', 'data', 'crm.db');
const OUT = process.env.CRM_OUT || path.join(__dirname, '..', 'data', 'pg-export');

const db = new DatabaseSync(SRC);

const TABLES = {
  campaigns: 'id', // PK
  leads: 'id',
  emails: 'id',
  drafts: 'id', // numeric serial -> keep id values as-is
  settings: 'key', // PK
  templates: 'id',
  activity_log: 'id',
};

function sqliteType(v) {
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

fs.mkdirSync(OUT, { recursive: true });
const manifest = {};
for (const [table, pk] of Object.entries(TABLES)) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`).all();
  manifest[table] = { columns: cols, count: rows.length };
  const path2 = path.join(OUT, `table_${table}.sql`);
  const parts = rows.map((r) =>
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => sqliteType(r[c])).join(', ')});`
  );
  fs.writeFileSync(path2, parts.join('\n') + (parts.length ? '\n' : ''));
  console.log(`${table}: ${rows.length} rows -> ${path2}`);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Manifest written to', path.join(OUT, 'manifest.json'));