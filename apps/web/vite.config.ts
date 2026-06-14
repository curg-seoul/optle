import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API + health to the x402 server so the browser stays same-origin
// (no CORS, and the X-PAYMENT custom header needs no preflight).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});
