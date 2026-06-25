import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// While the `tsx watch` backend restarts on a file change (≈2s), the proxy can't connect. Instead of
// letting the request hang or dumping a stack trace, answer with a fast 503 so the client's retry wrapper
// (web/client/api.ts) picks it up the moment the server is back. Keeps the dev console quiet across restarts.
const quietProxy = (proxy: any) => {
  proxy.on("error", (_err: unknown, _req: unknown, res: any) => {
    try {
      if (res && typeof res.writeHead === "function" && !res.headersSent) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("backend restarting");
      } else if (res && typeof res.destroy === "function") {
        res.destroy();
      }
    } catch { /* socket already gone */ }
  });
};

// The web app is fully independent of the Electron desktop app. It runs on its OWN ports (client 5273,
// server 8788) so it never collides with the desktop dev server (Vite 5173) or its MCP server (8787).
// In dev, Vite serves the React app and proxies API + auth to the Express backend; in prod Express serves both.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // 127.0.0.1 (not "localhost") so the proxy doesn't try IPv6 ::1 first and get ECONNREFUSED.
  const apiTarget = `http://127.0.0.1:${env.PORT || "8788"}`;
  return {
    plugins: [react()],
    root: ".",
    build: { outDir: "dist" },
    server: {
      port: 5273,
      strictPort: true, // fail loudly instead of silently moving to another port
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, configure: quietProxy },
        "/auth": { target: apiTarget, changeOrigin: true, configure: quietProxy },
        // Composio connect + OAuth callback live here (not under /api) — must reach the server, not Vite.
        "/integrations": { target: apiTarget, changeOrigin: true, configure: quietProxy },
      },
    },
  };
});
