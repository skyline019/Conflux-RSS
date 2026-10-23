import { NextResponse } from "next/server";
import { db } from "@/db";
import { clusters } from "@/db/schema";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 轻量元数据：仅 id + articleCount，供首页启动用（避免 N+1 与 comparison 大包） */
export async function GET() {
  const rows = await db
    .select({
      id: clusters.id,
      articleCount: clusters.articleCount,
    })
    .from(clusters)
    .where(sql`${clusters.articleCount} >= 2`);
  return NextResponse.json({ clusters: rows });
}
