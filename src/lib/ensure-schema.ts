import { pool } from "@/db";

let ensured = false;

/** 幂等补齐运行期新增列（避免每次都要求手动 migrate） */
export async function ensureRuntimeSchema() {
  if (ensured) return;
  await pool.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS ai_json jsonb`);
  await pool.query(`ALTER TABLE feeds ADD COLUMN IF NOT EXISTS http_etag text`);
  await pool.query(`ALTER TABLE feeds ADD COLUMN IF NOT EXISTS http_last_modified text`);
  ensured = true;
}
