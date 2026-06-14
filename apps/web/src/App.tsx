import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient, useReadContract } from "wagmi";
import { formatUnits, erc20Abi } from "viem";
import {
  uploadProject,
  requestPayment,
  payForJob,
  getStatus,
  getDownloadUrl,
  type UploadResult,
  type JobStatus,
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
      ? isLoading ? "…" : "—"
      : Number(formatUnits(data, USDC_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return <span className="usdc-balance">{text} USDC</span>;
}

function LogPanel({ logs }: { logs?: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);
  if (!logs || logs.length === 0) return null;
  return (
    <details className="logbox" open>
      <summary>Runner logs ({logs.length})</summary>
      <pre className="log" ref={ref}>
        {logs.map((l, i) => {
          let cls = "";
          if (l.startsWith("──")) cls = "stage";
          else if (l.startsWith("✗") || l.startsWith("[agent-stderr]")) cls = "err";
          else if (l.startsWith("[agent]")) cls = "agent";
          return <div key={i} className={`ll ${cls}`}>{l}</div>;
        })}
      </pre>
    </details>
  );
}

function DiffView({ diffs }: { diffs?: { file: string; diff: string }[] }) {
  if (!diffs || diffs.length === 0) return null;
  return (
    <div className="diffs">
      <h3>Changes (original → optimized)</h3>
      {diffs.map((d, i) => (
        <details key={d.file} open={i === 0} className="diff-file">
          <summary>{d.file}</summary>
          <pre className="diff">
            {d.diff.split("\n").map((line, j) => {
              if (
                line.startsWith("diff --git") || line.startsWith("index ") ||
                line.startsWith("--- ") || line.startsWith("+++ ")
              ) return null;
              let cls = "ctx";
              if (line.startsWith("@@")) cls = "hunk";
              else if (line.startsWith("+")) cls = "add";
              else if (line.startsWith("-")) cls = "del";
              return <div key={j} className={`dl ${cls}`}>{line || " "}</div>;
            })}
          </pre>
        </details>
      ))}
    </div>
  );
}

type Phase = "idle" | "uploading" | "ready" | "paying" | "running" | "done" | "error";

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  downloading: "Loading project",
  optimizing: "Optimizing",
  verifying: "Verifying (forge test)",
  packaging: "Packaging result",
  complete: "Complete",
};
const STAGE_ORDER = ["queued", "downloading", "optimizing", "verifying", "packaging", "complete"];

export function App() {
  const { address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [file, setFile] = useState<File | null>(null);
  const [level, setLevel] = useState<1 | 2>(1);
  const [phase, setPhase] = useState<Phase>("idle");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.getAttribute("data-theme") as "light" | "dark") || "dark",
  );

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch { /* ignore */ }
  }

  function reset() {
    setFile(null); setPhase("idle"); setUpload(null); setStatus(null);
    setDownloadUrl(null); setError(null);
  }

  // Load the bundled sample project (no manual upload) to demo the payment flow.
  async function loadSample() {
    setError(null);
    try {
      const res = await fetch("/sample.zip");
      if (!res.ok) throw new Error("sample not available");
      const blob = await res.blob();
      await onPickFile(new File([blob], "staking-demo.zip", { type: "application/zip" }), level);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const onPickFile = useCallback(async (f: File, lvl: 1 | 2) => {
    if (!f.name.toLowerCase().endsWith(".zip")) {
      setError("Please upload a .zip of your Solidity project.");
      return;
    }
    setError(null);
    setFile(f);
    setPhase("uploading");
    try {
      const result = await uploadProject(f, lvl);
      setUpload(result);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }, []);

  async function onPay() {
    if (!upload) return;
    setError(null);
    setPhase("paying");
    try {
      const step = await requestPayment(upload.jobId);
      if (step.kind === "challenge") {
        await payForJob(upload.jobId, step.requirements as PaymentRequirements, walletClient ?? undefined, address, chainId);
      }
      setPhase("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("ready");
    }
  }

  // Poll status while running.
  useEffect(() => {
    if (phase !== "running" || !upload) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getStatus(upload.jobId);
        if (!alive) return;
        setStatus(s);
        if (s.status === "done") {
          const url = await getDownloadUrl(upload.jobId);
          if (!alive) return;
          setDownloadUrl(url);
          setPhase("done");
        } else if (s.status === "error") {
          setError(s.error ?? "Optimization failed.");
          setPhase("error");
        }
      } catch (e) {
        if (alive) { setError(e instanceof Error ? e.message : String(e)); setPhase("error"); }
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [phase, upload]);

  const result = status?.result;
  const busy = phase === "uploading" || phase === "paying" || phase === "running";

  return (
    <>
      <header>
        <h1>⛽ Solidity Gas Optimizer</h1>
        <span className="mock-badge">Mantle Sepolia · x402</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <UsdcBalance />
          <ConnectButton />
        </div>
      </header>

      <main>
        <section className="panel">
          <div className="panel-head">
            <h2>Project</h2>
            <button className="ghost" onClick={loadSample} disabled={busy}>Load sample</button>
          </div>

          <div className="level-select">
            <span className="level-label">Optimization level</span>
            <div className="level-opts">
              <button
                className={`level-opt${level === 1 ? " on" : ""}`}
                onClick={() => setLevel(1)}
                disabled={busy || phase !== "idle"}
              >
                <strong>Level 1</strong>
                <span>function-body only · fast</span>
              </button>
              <button
                className={`level-opt${level === 2 ? " on" : ""}`}
                onClick={() => setLevel(2)}
                disabled={busy || phase !== "idle"}
              >
                <strong>Level 2</strong>
                <span>+ storage redesign · deeper, slower</span>
              </button>
            </div>
          </div>

          <div
            className={`dropzone${dragOver ? " over" : ""}${file ? " has-file" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) onPickFile(f, level); }}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef} type="file" accept=".zip" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f, level); }}
            />
            {file ? (
              <div className="dz-file">
                <strong>{file.name}</strong>
                <span>{(file.size / 1024).toFixed(1)} KB</span>
              </div>
            ) : (
              <div className="dz-empty">
                <strong>Drop your project .zip here</strong>
                <span>or click to choose — a Foundry project (with foundry.toml) gets verified</span>
              </div>
            )}
          </div>

          {phase === "uploading" && <p className="muted">Uploading & analyzing…</p>}

          {upload && phase !== "idle" && (
            <div className="pay-confirm">
              <div className="pay-line">
                <span className="pay-label">{upload.solFiles} .sol files · {(upload.totalBytes / 1024).toFixed(1)} KB · tier <b>{upload.tier}</b> · Level <b>{upload.level}</b></span>
                <span className="pay-amount">${upload.priceUsd.toFixed(2)}</span>
              </div>
              <div className="pay-actions">
                <button className="ghost" onClick={reset} disabled={busy}>Reset</button>
                {phase === "ready" && (
                  <button className="primary" onClick={onPay} disabled={busy}>
                    {`Confirm & pay $${upload.priceUsd.toFixed(2)} →`}
                  </button>
                )}
                {phase === "paying" && <button className="primary" disabled>Signing…</button>}
              </div>
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Result</h2></div>

          {phase === "idle" || phase === "uploading" || phase === "ready" || phase === "paying" ? (
            <div className="empty">Upload a project and pay to start the optimizer.</div>
          ) : (
            <div className="result">
              {/* progress */}
              <ol className="stages">
                {STAGE_ORDER.filter((s) => s !== "complete").map((s) => {
                  const cur = status?.stage ?? "queued";
                  const done = STAGE_ORDER.indexOf(cur) > STAGE_ORDER.indexOf(s) || phase === "done";
                  const active = cur === s && phase === "running";
                  return (
                    <li key={s} className={done ? "done" : active ? "active" : ""}>
                      {STAGE_LABEL[s]}
                    </li>
                  );
                })}
              </ol>

              {phase === "running" && <p className="muted">Working… ({STAGE_LABEL[status?.stage ?? "queued"]})</p>}

              <LogPanel logs={status?.logs} />

              {phase === "done" && result && (
                <>
                  <div className="gas-cards">
                    {result.verified ? (
                      <>
                        <div className="card"><span className="label">Gas before</span><span className="num">{result.gasBefore?.toLocaleString()}</span></div>
                        <div className="card"><span className="label">Gas after</span><span className="num">{result.gasAfter?.toLocaleString()}</span></div>
                      </>
                    ) : (
                      <div className="card"><span className="label">Verification</span><span className="num" style={{ fontSize: 16 }}>estimate</span></div>
                    )}
                    <div className="card saved"><span className="label">Saved</span><span className="num">−{result.savedPct ?? 0}%</span></div>
                  </div>
                  {result.message && (
                    <p className="estimate-note">
                      {result.engine === "claude" && <span className="tag applied">Claude</span>}{" "}
                      {result.message}
                      {typeof result.costUsd === "number" && ` (AI cost: $${result.costUsd.toFixed(4)})`}
                    </p>
                  )}

                  <h3>Changes</h3>
                  <ul className="changes">
                    {(!result.changes || result.changes.length === 0) && <li>No optimization opportunities detected.</li>}
                    {result.changes?.map((c, i) => (
                      <li key={i}>
                        <span className={`tag ${c.kind}`}>{c.kind}</span>
                        <span>{c.description}</span>
                        <span className="count">×{c.count}</span>
                      </li>
                    ))}
                  </ul>

                  <DiffView diffs={result.diffs} />

                  {downloadUrl && (
                    <a className="primary download" href={downloadUrl} target="_blank" rel="noreferrer">
                      Download optimized project (.zip) ↓
                    </a>
                  )}
                  <button className="ghost" onClick={reset} style={{ marginTop: 10 }}>Optimize another</button>
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
