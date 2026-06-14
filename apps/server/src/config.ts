import "dotenv/config";

/**
 * Server + x402 payment config, loaded from .env (placeholders are fine to BOOT).
 * No secrets hardcoded. Defaults target Mantle Sepolia testnet.
 */
const decimals = Number(process.env.PAYMENT_ASSET_DECIMALS ?? 6);
const priceHuman = Number(process.env.PAYMENT_PRICE ?? 0.01);

export const config = {
  port: Number(process.env.PORT ?? 8080),

  payment: {
    // Network identifier as the FACILITATOR expects it (friendly name or CAIP-2
    // "eip155:5003"). x402's typed npm enum lacks Mantle, so we drive the wire
    // protocol ourselves — see x402.ts.
    network: process.env.PAYMENT_NETWORK ?? "mantle-sepolia",
    chainId: Number(process.env.PAYMENT_CHAIN_ID ?? 5003), // Mantle Sepolia

    payTo: process.env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000000",

    // Chosen coin: USDC — the canonical EIP-3009 token the x402 `exact` scheme
    // assumes (gasless transferWithAuthorization). Fill the real Mantle Sepolia
    // address; it MUST implement EIP-3009.
    asset: {
      address: process.env.PAYMENT_ASSET_ADDRESS ?? "0xUSDC_ON_MANTLE_SEPOLIA",
      name: process.env.PAYMENT_ASSET_NAME ?? "USDC",
      decimals,
      eip712Version: process.env.PAYMENT_EIP712_VERSION ?? "2",
    },

    priceHuman,
    // human price → token base units (0.01 * 10^6 = 10000)
    amountBaseUnits: Math.round(priceHuman * 10 ** decimals).toString(),
    maxTimeoutSeconds: 60,
  },

  facilitator: {
    // Questflow is the multi-chain facilitator that announced Mantle support.
    url: process.env.FACILITATOR_URL ?? "https://facilitator.questflow.ai",
    apiKey: process.env.FACILITATOR_API_KEY, // Bearer; required for live verify/settle
  },

  // AI — read only after deploy; dev uses the mock (no API calls).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
};
