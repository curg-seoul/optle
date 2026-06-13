import express from "express";
import { config } from "./config.js";
import { paymentGate } from "./x402.js";
import { optimize } from "./optimize.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Unprotected health check.
app.get("/health", (_req, res) => {
  res.json({ ok: true, network: config.network, payTo: config.payTo });
});

// x402 payment gate — only matches the routes declared in paymentGate().
// Unpaid POST /api/optimize → 402 with payment requirements.
app.use(paymentGate());

// Reached only after x402 has verified payment.
app.post("/api/optimize", async (req, res) => {
  const code = String(req.body?.code ?? "");
  if (!code.trim()) {
    res.status(400).json({ error: "No contract code provided." });
    return;
  }
  // TODO(deploy): swap optimize() for the real Claude Agent SDK call.
  res.json(optimize(code));
});

app.listen(config.port, () => {
  console.log(`x402 optimize server → http://localhost:${config.port}`);
  console.log(`  pay to:      ${config.payTo}`);
  console.log(`  price:       ${config.price} on ${config.network}`);
  console.log(`  facilitator: ${config.facilitatorUrl ?? "(x402 default testnet)"}`);
});
