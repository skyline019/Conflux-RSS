#!/usr/bin/env node
/**
 * Strict hygiene gates for Conflux-RSS CI.
 * Fail hard on secrets tracked by git, version drift, or schema doc drift.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const errors = [];

function fail(msg) {
  errors.push(msg);
}

// 1) Forbidden secret / credential files — only what git tracks (local .env OK if ignored)
const forbiddenName = /(\.env$|\.env\.|keystore\.properties|\.keystore$|\.jks$|^id_rsa$|^id_ed25519$)/i;
const tracked = execSync("git ls-files -z", { cwd: root, encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
for (const rel of tracked) {
  const base = rel.split("/").pop() || rel;
  if (rel === ".env.example") continue;
  if (forbiddenName.test(base) || forbiddenName.test(rel)) {
    fail(`forbidden file tracked by git: ${rel}`);
  }
}

// 2) Version triad: mobile/package.json ↔ android versionName/versionCode
const pkgPath = join(root, "mobile/package.json");
const gradlePath = join(root, "mobile/android/app/build.gradle");
if (!existsSync(pkgPath) || !existsSync(gradlePath)) {
  fail("missing mobile/package.json or android/app/build.gradle");
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const gradle = readFileSync(gradlePath, "utf8");
  const name = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
  const code = gradle.match(/versionCode\s+(\d+)/)?.[1];
  if (pkg.version !== name) fail(`version drift: package.json=${pkg.version} versionName=${name}`);
  if (!code || Number(code) < 1) fail(`invalid versionCode: ${code}`);
  console.log(`version ok: ${pkg.version} (versionCode ${code})`);
}

// 3) Schema version documented
const dbSrc = readFileSync(join(root, "mobile/src/db.ts"), "utf8");
const arch = readFileSync(join(root, "mobile/docs/ARCHITECTURE.md"), "utf8");
const schema = dbSrc.match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
if (!schema) fail("SCHEMA_VERSION not found in mobile/src/db.ts");
else if (!arch.includes(`SCHEMA_VERSION = ${schema}`) && !arch.includes(`SCHEMA_VERSION=${schema}`)) {
  fail(`ARCHITECTURE.md missing SCHEMA_VERSION = ${schema}`);
} else {
  console.log(`schema ok: v${schema}`);
}

// 4) README points at Releases
const readme = readFileSync(join(root, "README.md"), "utf8");
if (!/releases/i.test(readme)) fail("root README.md should link to GitHub Releases");

if (errors.length) {
  console.error("\nCI guard FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("CI guard OK");
