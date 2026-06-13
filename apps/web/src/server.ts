import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mockOptimize } from "./mockOptimizer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(HERE, "..", "public")));

// MOCK optimize endpoint — no AI/API call. Swapped for the real agent post-deploy.
app.post("/api/optimize", async (req, res) => {
  const code = String(req.body?.code ?? "");
  if (!code.trim()) {
    res.status(400).json({ error: "No contract code provided." });
    return;
  }
  // simulate the agent taking a moment to work
  await new Promise((r) => setTimeout(r, 600));
  res.json(mockOptimize(code));
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`gas-optimizer web (MOCK) → http://localhost:${PORT}`);
});
