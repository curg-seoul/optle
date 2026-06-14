import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { defineChain } from "viem";

// Mantle Sepolia testnet (chainId 5003). Defined explicitly so we don't depend
// on a specific viem/chains export name.
export const mantleSepolia = defineChain({
  id: 5003,
  name: "Mantle Sepolia Testnet",
  nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.sepolia.mantle.xyz"] } },
  blockExplorers: {
    default: { name: "Mantle Sepolia Explorer", url: "https://explorer.sepolia.mantle.xyz" },
  },
  testnet: true,
});

export const wagmiConfig = getDefaultConfig({
  appName: "Gas Optimizer",
  // Injected wallets (MetaMask) work without this; a real id enables WalletConnect.
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "demo-placeholder-project-id",
  chains: [mantleSepolia],
  ssr: false,
});
