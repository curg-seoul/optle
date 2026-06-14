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

function buildRequirements(req: Request, amountBaseUnits: string) {
  const p = config.payment;
  return {
    scheme: "exact",
    network: p.network,
    maxAmountRequired: amountBaseUnits,
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

function send402(req: Request, res: Response, error: string, amountBaseUnits: string) {
  res.status(402).json({
    x402Version: X402_VERSION,
    error,
    accepts: [buildRequirements(req, amountBaseUnits)],
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

/**
 * Route-specific middleware factory: gate an endpoint behind x402 payment.
 *
 * `resolveAmount` returns the price (USDC base units) for this request — e.g.
 * the per-job tier price. If it returns undefined the resource is unknown (404).
 * Omit it to charge the static config price.
 */
export function paymentGate(resolveAmount?: (req: Request) => string | undefined) {
  return async function gate(req: Request, res: Response, next: NextFunction) {
    const amount = resolveAmount ? resolveAmount(req) : config.payment.amountBaseUnits;
    if (amount === undefined) {
      res.status(404).json({ error: "unknown job" });
      return;
    }

    // Local-demo escape hatch: skip payment entirely (no facilitator needed).
    if (config.payment.mode === "bypass") {
      next();
      return;
    }

    const header = req.header("X-PAYMENT");
    if (!header) {
      send402(req, res, "X-PAYMENT header is required", amount);
      return;
    }

    let paymentPayload: unknown;
    try {
      paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      send402(req, res, "Invalid X-PAYMENT header (expected base64-encoded JSON)", amount);
      return;
    }

    const paymentRequirements = buildRequirements(req, amount);

    try {
      const verify = await facilitator("/verify", {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      });
      if (!verify?.isValid) {
        send402(req, res, verify?.invalidReason ?? "payment verification failed", amount);
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
  };
}
