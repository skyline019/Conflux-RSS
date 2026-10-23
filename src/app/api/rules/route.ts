import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { filterRules, articles, feeds } from "@/db/schema";
import { eq, asc, desc } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import { matchRule, applyRules } from "@/lib/filters";
import type { FilterRule } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const rows = await db.select({
    rule: filterRules, feedTitle: feeds.title,
  }).from(filterRules).leftJoin(feeds, eq(feeds.id, filterRules.feedId)).orderBy(asc(filterRules.priority), asc(filterRules.id));
  return NextResponse.json({ rules: rows.map((r) => ({ ...r.rule, feedTitle: r.feedTitle })) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Partial<FilterRule> & { actionType?: string; testText?: string; applyNow?: boolean };

  // ---- test mode ----
  if (body.actionType === "test") {
    const probe: FilterRule = {
      id: 0, name: body.name || "测试规则", enabled: true,
      feedId: body.feedId ?? null, field: body.field || "title",
      operator: body.operator || "contains", pattern: body.pattern || "",
      action: body.action || "block", priority: body.priority || 10,
      hitCount: 0, lastHitAt: null, createdAt: new Date(),
    };
    if (probe.operator === "regex") {
      try { new RegExp(probe.pattern); } catch (e) {
        return NextResponse.json({ ok: false, error: `正则不合法：${e instanceof Error ? e.message : String(e)}` });
      }
    }
    // test against supplied text and recent real articles
    const textHit = body.testText ? matchRule(probe, { title: body.testText, content: body.testText, author: body.testText, feedId: probe.feedId ?? -1 }) : null;
    const sample = await db.select({ id: articles.id, title: articles.title, content: articles.content, author: articles.author, feedId: articles.feedId, rssSummary: articles.rssSummary })
      .from(articles).orderBy(desc(articles.createdAt)).limit(200);
    const matched = sample
      .filter((a) => matchRule(probe, { title: a.title, content: a.content || a.rssSummary || "", author: a.author, feedId: a.feedId }))
      .slice(0, 8).map((a) => ({ id: a.id, title: a.title }));
    return NextResponse.json({ ok: true, textHit, recentMatched: matched, recentTotal: sample.length });
  }

  // ---- apply all rules retroactively ----
  if (body.actionType === "apply_all") {
    const rules = await db.select().from(filterRules).where(eq(filterRules.enabled, true));
    const pool = await db.select().from(articles).orderBy(desc(articles.createdAt)).limit(1000);
    let blocked = 0, starred = 0, archived = 0, markedRead = 0;
    for (const a of pool) {
      const v = applyRules(rules, { title: a.title, content: a.content || a.rssSummary || "", author: a.author, feedId: a.feedId });
      if (v.blocked) { await db.delete(articles).where(eq(articles.id, a.id)); blocked++; continue; }
      const patch: Record<string, unknown> = {};
      if (v.starred && !a.isStarred) { patch.isStarred = true; starred++; }
      if (v.archive && !a.isArchived) { patch.isArchived = true; patch.archivedAt = new Date(); archived++; }
      if (v.markRead && !a.isRead) { patch.isRead = true; patch.readAt = new Date(); markedRead++; }
      if (Object.keys(patch).length) await db.update(articles).set(patch).where(eq(articles.id, a.id));
    }
    return NextResponse.json({ ok: true, scanned: pool.length, blocked, starred, archived, markedRead });
  }

  // ---- create ----
  if (!body.name?.trim() || !body.pattern?.trim()) {
    return NextResponse.json({ error: "规则名称与匹配内容不能为空" }, { status: 400 });
  }
  if (body.operator === "regex") {
    try { new RegExp(body.pattern); } catch (e) {
      return NextResponse.json({ error: `正则不合法：${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
  }
  const [row] = await db.insert(filterRules).values({
    name: body.name.trim(),
    enabled: body.enabled ?? true,
    feedId: body.feedId || null,
    field: body.field || "title",
    operator: body.operator || "contains",
    pattern: body.pattern.trim(),
    action: body.action || "block",
    priority: body.priority ?? 10,
  }).returning();
  return NextResponse.json({ rule: row }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Partial<FilterRule>;
  if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "enabled", "feedId", "field", "operator", "pattern", "action", "priority"] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  const [row] = await db.update(filterRules).set(patch).where(eq(filterRules.id, body.id)).returning();
  return NextResponse.json({ rule: row });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  await db.delete(filterRules).where(eq(filterRules.id, id));
  return NextResponse.json({ ok: true });
}
