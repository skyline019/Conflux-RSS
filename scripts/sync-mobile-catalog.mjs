import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "src/lib/seed.ts"), "utf8");
const start = src.indexOf("export const DEFAULT_FEEDS");
const end = src.indexOf("const DEMO_FEEDS");
const block = src.slice(start, end);
const re = /\{\s*title:\s*"([^"]+)",\s*url:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*color:\s*"([^"]+)",\s*desc:\s*"([^"]+)"/g;
const items = [];
for (const m of block.matchAll(re)) {
  items.push({ title: m[1], url: m[2], category: m[3], color: m[4], desc: m[5] });
}

const oldPath = path.join(root, "desktop/catalog.mjs");
const old = fs.readFileSync(oldPath, "utf8");
const oldItems = [];
for (const m of old.matchAll(re)) {
  oldItems.push({ title: m[1], url: m[2], category: m[3], color: m[4], desc: m[5] });
}

const urls = new Set(items.map((i) => i.url));
const extra = oldItems.filter((i) => !urls.has(i.url));
const all = [...items, ...extra];
const body = all.map((f) => `  ${JSON.stringify(f)}`).join(",\n");
const out = `/** Synced from web DEFAULT_FEEDS, keeping desktop-only extras. */
export const CATALOG = [
${body}
];
export const CATALOG_REV = "2026-10-23-ref";
`;
fs.writeFileSync(oldPath, out);
console.log(`web=${items.length} extra=${extra.length} total=${all.length}`);
if (extra.length) {
  console.log("kept extras:");
  for (const e of extra) console.log(`  - ${e.title} (${e.category})`);
}
