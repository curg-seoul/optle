import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API + health to the x402 server so the browser stays same-origin
// (no CORS, and the X-PAYMENT custom header needs no preflight).
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to 0.0.0.0 so the dev server is reachable from the host machine when
    // running inside a dev container / remote VM (default is localhost-only).
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});
