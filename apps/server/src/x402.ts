import { paymentMiddleware, type Network, type FacilitatorConfig } from "x402-express";
import { config } from "./config.js";

/**
 * Builds the x402 payment middleware. It gates only the routes listed here;
 * every other route passes through untouched.
 *
 * Unpaid request to a gated route → automatic HTTP 402 with payment
 * requirements. A request carrying a valid `X-PAYMENT` header is verified
 * against the facilitator, then allowed through to the handler.
 */
export function paymentGate() {
  const facilitator: FacilitatorConfig | undefined = config.facilitatorUrl
    ? { url: config.facilitatorUrl as `${string}://${string}` }
    : undefined; // undefined → x402 default testnet facilitator

  return paymentMiddleware(
    config.payTo,
    {
      "POST /api/optimize": {
        price: config.price,
        network: config.network as Network,
        config: {
          description: "Optimize a single Solidity contract's gas usage",
        },
      },
    },
    facilitator,
  );
}
