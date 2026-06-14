import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxies /api + /health so the browser stays same-origin in development
// (no CORS, no preflight for the X-PAYMENT header). Defaults to a local backend;
// set DEV_API_TARGET to point dev at a deployed backend instead. (In production
// the frontend calls VITE_API_BASE directly — see src/x402.ts.)
const API_TARGET = process.env.DEV_API_TARGET || "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to 0.0.0.0 so the dev server is reachable from the host machine when
    // running inside a dev container / remote VM (default is localhost-only).
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true, secure: true },
      "/health": { target: API_TARGET, changeOrigin: true, secure: true },
    },
  },
});
