/**
 * Create a local release keystore + keystore.properties if missing.
 * For sideload only — replace with your own keystore for wider distribution.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const android = join(root, "android");
const storeFile = join(android, "conflux-release.keystore");
const propsFile = join(android, "keystore.properties");

const password = "conflux-mobile";
const alias = "conflux";

if (!existsSync(storeFile)) {
  execFileSync(
    "keytool",
    [
      "-genkeypair", "-v",
      "-keystore", storeFile,
      "-alias", alias,
      "-keyalg", "RSA", "-keysize", "2048",
      "-validity", "10000",
      "-storepass", password,
      "-keypass", password,
      "-dname", "CN=Conflux Mobile, OU=Dev, O=Conflux, L=Local, ST=Local, C=CN",
    ],
    { stdio: "inherit" },
  );
  console.log("Created", storeFile);
} else {
  console.log("Keystore exists:", storeFile);
}

if (!existsSync(propsFile)) {
  writeFileSync(
    propsFile,
    [
      `storeFile=conflux-release.keystore`,
      `storePassword=${password}`,
      `keyAlias=${alias}`,
      `keyPassword=${password}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log("Created", propsFile);
} else {
  console.log("Properties exist:", propsFile);
}
