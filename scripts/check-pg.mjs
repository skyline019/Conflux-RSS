import pg from "pg";

const url = process.env.DATABASE_URL || "postgresql://voyagerstar@/conflux?host=/var/run/postgresql";
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  const r = await pool.query("select 1 as ok");
  console.log("pgok", r.rows);
} catch (e) {
  console.error("pgfail", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
