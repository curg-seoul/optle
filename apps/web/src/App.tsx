import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient } from "wagmi";
import { payAndOptimize, type OptimizeResult } from "./x402";

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

  async function onOptimize() {
    if (!code.trim()) {
      setError("Paste a contract first (or click “Load sample”).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await payAndOptimize(code, walletClient ?? undefined, address, chainId);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header>
        <h1>⛽ Solidity Gas Optimizer</h1>
        <span className="mock-badge">Mantle Sepolia · x402 · 0.01 USDC</span>
        <div style={{ marginLeft: "auto" }}>
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
          <button className="primary" onClick={onOptimize} disabled={busy}>
            {busy ? "Working…" : "Optimize gas — pay 0.01 USDC →"}
          </button>
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
