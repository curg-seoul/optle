import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

/**
 * Minimal, chain-agnostic x402 server gate.
 *
 * Why hand-rolled instead of `x402-express`: that package's `Network` is a fixed
 * zod enum that does NOT include Mantle, so it rejects Mantle Sepolia outright.
 * The x402 wire protocol itself is simple, so we drive it directly here and let
 * config.ts point us at any chain + facilitator.
 *
 * Flow:
 *   - no X-PAYMENT header  → HTTP 402 with payment requirements
 *   - X-PAYMENT present    → facilitator /verify, then /settle, then next()
 *
 * NOTE: real verify/settle needs a facilitator that supports the configured
 * network and a funded EIP-3009 payment. Untested here by design.
 */

const X402_VERSION = 1;

function buildRequirements(req: Request) {
  const p = config.payment;
  return {
    scheme: "exact",
    network: p.network,
    maxAmountRequired: p.amountBaseUnits,
    resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    description: "Optimize a single Solidity contract's gas usage",
    mimeType: "application/json",
    payTo: p.payTo,
    maxTimeoutSeconds: p.maxTimeoutSeconds,
    asset: p.asset.address,
    outputSchema: { input: { type: "http", method: "POST", discoverable: true } },
    // EIP-712 domain hints the client needs to sign the EIP-3009 authorization.
    extra: { name: p.asset.name, version: p.asset.eip712Version },
  };
}

function send402(req: Request, res: Response, error: string) {
  res.status(402).json({
    x402Version: X402_VERSION,
    error,
    accepts: [buildRequirements(req)],
  });
}

async function facilitator(path: "/verify" | "/settle", body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.facilitator.apiKey) {
    headers.Authorization = `Bearer ${config.facilitator.apiKey}`;
  }
  const res = await fetch(`${config.facilitator.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`facilitator ${path} returned ${res.status}`);
  }
  return res.json() as Promise<any>;
}

/** Route-specific middleware: gate one endpoint behind x402 payment. */
export async function paymentGate(req: Request, res: Response, next: NextFunction) {
  // Local-demo escape hatch: skip payment entirely (no facilitator needed).
  if (config.payment.mode === "bypass") {
    next();
    return;
  }

  const header = req.header("X-PAYMENT");
  if (!header) {
    send402(req, res, "X-PAYMENT header is required");
    return;
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    send402(req, res, "Invalid X-PAYMENT header (expected base64-encoded JSON)");
    return;
  }

  const paymentRequirements = buildRequirements(req);

  try {
    const verify = await facilitator("/verify", {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
    });
    if (!verify?.isValid) {
      send402(req, res, verify?.invalidReason ?? "payment verification failed");
      return;
    }

    const settlement = await facilitator("/settle", {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
    });
    // Standard x402: hand the settlement receipt back to the client.
    res.setHeader(
      "X-PAYMENT-RESPONSE",
      Buffer.from(JSON.stringify(settlement)).toString("base64"),
    );
    next();
  } catch (err) {
    res.status(502).json({ error: "facilitator error", detail: String(err) });
  }
}
