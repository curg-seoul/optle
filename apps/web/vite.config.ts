import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxies /api + /health to the backend so the browser stays same-origin
// (no CORS, and the custom X-PAYMENT header needs no preflight). Defaults to the
// deployed backend, so `npm run dev` works without running the backend locally.
// Override with DEV_API_TARGET=http://localhost:8080 to use a local server.
const API_TARGET = process.env.DEV_API_TARGET || "https://api.optle.hanjun.kim";

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
