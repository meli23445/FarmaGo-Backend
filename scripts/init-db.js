require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Falta DATABASE_URL en el entorno (.env o variables).');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'db', 'init-db.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    await client.query(sql);
    console.log('OK: Tablas creadas/actualizadas con db/init-db.sql');
  } catch (e) {
    console.error('Error inicializando base de datos:', e.message || e);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();

