import express from "express";
import { config } from "./config.js";
import { paymentGate } from "./x402.js";
import { optimize } from "./optimize.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Minimal CORS so a separately-hosted frontend can call us (dev uses a Vite
// proxy, so this mainly matters for direct cross-origin calls). X-PAYMENT is a
// custom request header; X-PAYMENT-RESPONSE must be readable by the client.
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.header("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Unprotected health check.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: config.payment.network,
    chainId: config.payment.chainId,
    asset: config.payment.asset.name,
    price: `${config.payment.priceHuman} ${config.payment.asset.name}`,
    payTo: config.payment.payTo,
  });
});

// x402 payment gate on the optimize route only.
// Unpaid → 402 with payment requirements; paid → verified/settled, then handler.
app.post("/api/optimize", paymentGate, async (req, res) => {
  const code = String(req.body?.code ?? "");
  if (!code.trim()) {
    res.status(400).json({ error: "No contract code provided." });
    return;
  }
  // TODO(deploy): swap optimize() for the real Claude Agent SDK call.
  res.json(optimize(code));
});

app.listen(config.port, () => {
  const p = config.payment;
  console.log(`x402 optimize server → http://localhost:${config.port}`);
  console.log(`  network:     ${p.network} (chainId ${p.chainId})`);
  console.log(`  price:       ${p.priceHuman} ${p.asset.name} (${p.amountBaseUnits} base units)`);
  console.log(`  asset:       ${p.asset.address}`);
  console.log(`  pay to:      ${p.payTo}`);
  console.log(`  facilitator: ${config.facilitator.url}${config.facilitator.apiKey ? "" : "  (no API key set)"}`);
  if (config.payment.mode === "bypass") {
    console.warn("  ⚠️  PAYMENT_MODE=bypass — x402 gate is OFF (local demo only).");
  }
});
