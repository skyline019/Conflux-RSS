import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version || "0.0.0";

const jdk21 = process.env.JAVA_HOME_21
  || "C:\\Program Files\\Microsoft\\jdk-21.0.12.101-hotspot";
if (existsSync(jdk21)) {
  process.env.JAVA_HOME = jdk21;
  process.env.PATH = `${join(jdk21, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`;
}
process.env.ANDROID_HOME = process.env.ANDROID_HOME
  || process.env.ANDROID_SDK_ROOT
  || join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
process.env.ANDROID_SDK_ROOT = process.env.ANDROID_HOME;

const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit", env: process.env, shell: true });

run("node scripts/ensure-keystore.mjs");
run("npm run build");
run("npx cap sync android");

const androidDir = join(root, "android");
const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
run(`${gradlew} assembleRelease --no-daemon`, androidDir);

const built = join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
if (!existsSync(built)) {
  console.error("APK not found:", built);
  process.exit(1);
}
const outDir = join(root, "apk");
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `conflux-${version}-release.apk`);
copyFileSync(built, dest);
console.log("\nAPK_OK", dest);
