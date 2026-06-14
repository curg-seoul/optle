import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "./wagmi";
import { App } from "./App";
import { Landing } from "./Landing";
import "./index.css";

const queryClient = new QueryClient();

// The app lives at /app (opened in a new tab from the landing page); everything
// else renders the landing page. SPA fallback (_redirects) serves index.html for
// any path, so this client-side check is all we need — no router dependency.
const isApp = window.location.pathname.startsWith("/app");

const root = isApp ? (
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <RainbowKitProvider theme={darkTheme({ accentColor: "#34d399", accentColorForeground: "#04231a" })}>
        <App />
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>
) : (
  <Landing />
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
