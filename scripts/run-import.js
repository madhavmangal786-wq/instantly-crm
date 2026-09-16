// Simple launcher: reads the connection string from dbpass.txt (no special chars issues)
// then runs the real import. Usage:  node scripts/run-import.js
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const dbpassFile = path.join(__dirname, '..', 'dbpass.txt');
  let raw;
  try {
    raw = fs.readFileSync(dbpassFile, 'utf8');
  } catch {
    console.error('Could not find dbpass.txt. First run:  nano dbpass.txt  then paste your Supabase connection string and save (Ctrl+O, Enter, Ctrl+X).');
    process.exit(1);
  }
  const conn = raw.trim().replace(/^postgresql:\/\//i, '');
  if (!conn || conn.includes('YOUR-REAL') || conn.includes('<')) {
    console.error('dbpass.txt does not contain a valid connection string. Edit it:  nano dbpass.txt');
    process.exit(1);
  }
  process.env.DATABASE_URL = 'postgresql://' + conn;
  // eslint-disable-next-line global-require
  require('./import-pg.js');
}

main();