import net from "node:net";
import { execFileSync } from "node:child_process";

const TARGET = Number(process.env.FORWARD_PORT || 3010);
// wslrelay already binds 127.0.0.1 to the WSL listen port and often stalls.
// Keep the Windows listen port distinct so this proxy can own it.
const LISTEN = Number(process.env.LISTEN_PORT || 3011);
const DISTRO = process.env.WSL_DISTRO || "Ubuntu-24.04";

let ip = "";
let ipAt = 0;

function wslIp() {
  if (ip && Date.now() - ipAt < 20000) return ip;
  const out = execFileSync("wsl.exe", ["-d", DISTRO, "--", "hostname", "-I"], { encoding: "utf8" });
  const next = out.trim().split(/\s+/).find((part) => part.startsWith("172."));
  if (!next) throw new Error("no wsl ip");
  ip = next;
  ipAt = Date.now();
  return ip;
}

const server = net.createServer((client) => {
  let host;
  try {
    host = wslIp();
  } catch {
    client.destroy();
    return;
  }
  const upstream = net.connect({ host, port: TARGET });
  const drop = () => {
    ip = "";
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", drop);
  client.on("error", () => upstream.destroy());
  upstream.on("connect", () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });
});

server.listen(LISTEN, "127.0.0.1", () => {
  console.log(`127.0.0.1:${LISTEN} -> ${wslIp()}:${TARGET}`);
});
