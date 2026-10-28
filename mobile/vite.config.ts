import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

function devFetchProxy(): Plugin {
  return {
    name: "conflux-dev-fetch",
    configureServer(server) {
      server.middlewares.use("/__fetch", (req, res) => {
        const target = new URL(req.url || "", "http://local").searchParams.get("url");
        if (!target) { res.statusCode = 400; res.end("missing url"); return; }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", async () => {
          try {
            const headers: Record<string, string> = {};
            if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
            if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
            const body = Buffer.concat(chunks);
            const response = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
            res.statusCode = response.status;
            const type = response.headers.get("content-type");
            if (type) res.setHeader("content-type", type);
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (err) {
            res.statusCode = 502;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), devFetchProxy()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../src"),
      // Shared UI lives in ../src; force deps into mobile/node_modules (CI has no root install).
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "lucide-react": path.resolve(__dirname, "node_modules/lucide-react"),
      "hls.js": path.resolve(__dirname, "node_modules/hls.js"),
    },
    dedupe: ["react", "react-dom", "lucide-react"],
  },
  optimizeDeps: {
    // CJS wrapper that loads dist/sql-wasm.js + FTS5 wasm
    include: ["fts5-sql-bundle"],
  },
  assetsInclude: ["**/*.wasm"],
  server: { port: 5176, strictPort: true },
});
