import "dotenv/config";

/**
 * Server configuration, loaded from .env (placeholders are fine for dev/boot).
 * No secrets are hardcoded — everything sensitive comes from the environment.
 */
export const config = {
  port: Number(process.env.PORT ?? 8080),

  // x402
  payTo: (process.env.PAY_TO_ADDRESS ??
    "0x0000000000000000000000000000000000000000") as `0x${string}`,
  price: process.env.PAYMENT_PRICE ?? "$0.01",
  // NOTE: x402 v1.2 supported networks do NOT include Mantle — default to
  // base-sepolia so the demo works. See PLAN §9 for the Mantle path.
  network: process.env.PAYMENT_NETWORK ?? "base-sepolia",
  // Empty → x402's default testnet facilitator.
  facilitatorUrl: process.env.FACILITATOR_URL || undefined,

  // AI — only read after deploy; dev path never calls the API.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
};
