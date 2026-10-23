import { NextResponse } from "next/server";
import { rebuildClusters } from "@/lib/cluster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const result = await rebuildClusters();
  return NextResponse.json({ ok: true, ...result });
}
