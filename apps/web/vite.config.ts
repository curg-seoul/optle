import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxies /api + /health so the browser stays same-origin in development
// (no CORS, no preflight for the X-PAYMENT header). DEV_API_TARGET (read from
// .env or the shell) points dev at a backend; defaults to a local one. In
// production the frontend calls VITE_API_BASE directly — see src/x402.ts.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const API_TARGET = env.DEV_API_TARGET || "http://localhost:8080";
  return {
    plugins: [react()],
    server: {
      // Bind to 0.0.0.0 so the dev server is reachable from the host machine
      // when running inside a dev container / remote VM.
      host: true,
      port: 5173,
      proxy: {
        "/api": { target: API_TARGET, changeOrigin: true, secure: true },
        "/health": { target: API_TARGET, changeOrigin: true, secure: true },
      },
    },
  };
});
