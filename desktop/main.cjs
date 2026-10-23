const { app, BrowserWindow, shell } = require("electron");
app.setName("conflux-desktop");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = 3217;
let server;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - started > 20000) reject(new Error("桌面服务没有启动"));
      else setTimeout(tick, 250);
    };
    tick();
  });
}

function openWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "汇阅",
    icon: path.join(__dirname, "build", "icon.ico"),
    backgroundColor: "#f6f3ec",
    autoHideMenuBar: true,
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  const packaged = app.isPackaged;
  const env = {
    ...process.env,
    CONFLUX_PORT: String(PORT),
    CONFLUX_HOME: path.join(app.getPath("userData"), "conflux"),
  };
  if (packaged) env.ELECTRON_RUN_AS_NODE = "1";
  server = spawn(packaged ? process.execPath : (process.env.CONFLUX_NODE || "node"), ["--experimental-sqlite", path.join(__dirname, "server.mjs")], {
    cwd: __dirname,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  await waitForServer();
  openWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}).catch((err) => {
  console.error(err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (server && !server.killed) server.kill();
});
