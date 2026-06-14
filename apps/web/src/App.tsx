import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient, useReadContract } from "wagmi";
import { formatUnits, erc20Abi } from "viem";
import {
  startOptimize,
  payAndOptimize,
  type OptimizeResult,
  type PaymentRequirements,
} from "./x402";

// TestUSDC on Mantle Sepolia (6 decimals).
const USDC_ADDRESS = "0x65F83bDA796401f15AC9e290Ab39B1157b86451B" as const;
const USDC_DECIMALS = 6;

function UsdcBalance() {
  const { address } = useAccount();
  const { data, isLoading } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  if (!address) return null;
  const text =
    data === undefined
      ? isLoading
        ? "…"
        : "—"
      : Number(formatUnits(data, USDC_DECIMALS)).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        });
  return <span className="usdc-balance">{text} USDC</span>;
}

const SAMPLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Rewards {
    address public owner;
    uint256[] public amounts;
    uint256 public total;

    constructor() {
        owner = msg.sender;
    }

    function add(uint256 amount) public {
        require(amount > 0, "amount must be greater than zero");
        amounts.push(amount);
    }

    function computeTotal() public returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            sum = sum + amounts[i];
        }
        total = sum;
        return sum;
    }

    function count() public view returns (uint256) {
        return amounts.length;
    }
}
`;

export function App() {
  const { address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  // When set, we've fetched the x402 challenge and are awaiting the user's
  // confirmation to sign & pay (step 2).
  const [pending, setPending] = useState<PaymentRequirements | null>(null);

  // Step 1: ask the server what it costs (or run free if PAYMENT_MODE=bypass).
  async function onOptimize() {
    if (!code.trim()) {
      setError("Paste a contract first (or click “Load sample”).");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setPending(null);
    try {
      const start = await startOptimize(code);
      if (start.kind === "result") {
        setResult(start.result); // free (bypass mode) — no payment needed
      } else {
        setPending(start.requirements); // show the price, await confirm
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Step 2: user confirmed — sign the EIP-3009 authorization and pay.
  async function onConfirmPay() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const r = await payAndOptimize(code, pending, walletClient ?? undefined, address, chainId);
      setResult(r);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Human-readable price from the actual 402 challenge (6-decimal USDC).
  const priceText = pending
    ? `${Number(formatUnits(BigInt(pending.maxAmountRequired), USDC_DECIMALS)).toLocaleString(
        undefined,
        { maximumFractionDigits: 6 },
      )} USDC`
    : null;

  return (
    <>
      <header>
        <h1>⛽ Solidity Gas Optimizer</h1>
        <span className="mock-badge">Mantle Sepolia · x402</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <UsdcBalance />
          <ConnectButton />
        </div>
      </header>

      <main>
        <section className="panel">
          <div className="panel-head">
            <h2>Contract</h2>
            <button className="ghost" onClick={() => setCode(SAMPLE)}>Load sample</button>
          </div>
          <textarea
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste a single Solidity contract here…"
          />
          {!pending ? (
            <button className="primary" onClick={onOptimize} disabled={busy}>
              {busy ? "Working…" : "Optimize gas →"}
            </button>
          ) : (
            <div className="pay-confirm">
              <div className="pay-line">
                <span className="pay-label">Payment required</span>
                <span className="pay-amount">{priceText}</span>
              </div>
              <div className="pay-actions">
                <button className="ghost" onClick={() => setPending(null)} disabled={busy}>
                  Cancel
                </button>
                <button className="primary" onClick={onConfirmPay} disabled={busy}>
                  {busy ? "Signing…" : `Confirm & pay ${priceText} →`}
                </button>
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Result</h2>
          </div>
          {!result ? (
            <div className="empty">Pay &amp; run the optimizer to see results.</div>
          ) : (
            <div className="result">
              <div className="gas-cards">
                <div className="card">
                  <span className="label">Gas before</span>
                  <span className="num">{result.gasBefore.toLocaleString()}</span>
                </div>
                <div className="card">
                  <span className="label">Gas after</span>
                  <span className="num">{result.gasAfter.toLocaleString()}</span>
                </div>
                <div className="card saved">
                  <span className="label">Saved</span>
                  <span className="num">−{result.savedPct}%</span>
                </div>
              </div>
              {result.mock && (
                <p className="estimate-note">
                  Optimization is currently a <strong>mock</strong> (no AI called).
                  Gas figures are estimates; the real pipeline measures with
                  <code> forge test --gas-report</code>.
                </p>
              )}

              <h3>Changes</h3>
              <ul className="changes">
                {result.changes.length === 0 && <li>No optimization opportunities detected.</li>}
                {result.changes.map((c, i) => (
                  <li key={i}>
                    <span className={`tag ${c.kind}`}>{c.kind}</span>
                    <span>{c.description}</span>
                    <span className="count">×{c.count}</span>
                  </li>
                ))}
              </ul>

              <h3>Optimized code</h3>
              <pre>{result.optimized}</pre>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
