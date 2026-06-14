import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient, useReadContract } from "wagmi";
import { formatUnits, erc20Abi } from "viem";
import { ThemeToggle } from "./theme";
import { Logo } from "./Landing";
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

// Payment token (e.g. TestUSDC on Mantle Sepolia). Configured per deployment;
// when unset, the header balance is simply hidden.
const USDC_ADDRESS = import.meta.env.VITE_USDC_ADDRESS as `0x${string}` | undefined;
const USDC_DECIMALS = Number(import.meta.env.VITE_USDC_DECIMALS ?? 6);

function UsdcBalance() {
  const { address } = useAccount();
  const { data, isLoading } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!USDC_ADDRESS, refetchInterval: 10_000 },
  });
  if (!address || !USDC_ADDRESS) return null;
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

const STEPS = ["Upload & pay", "Optimize", "Result"];

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

  function startOver() {
    setFile(null); setPhase("idle"); setUpload(null); setStatus(null);
    setDownloadUrl(null); setError(null);
  }

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
  const busy = phase === "uploading" || phase === "paying";
  const step = phase === "done" ? 3 : phase === "running" || phase === "error" ? 2 : 1;
  const curStage = status?.stage ?? "queued";

  return (
    <div className="app-shell">
      <div className="bg-mesh" aria-hidden />
      <header className="app-header">
        <a className="brand" href="/" aria-label="Optle home"><Logo /><span>Optle</span></a>
        <span className="net-badge">Mantle Sepolia · x402</span>
        <div className="header-right">
          <ThemeToggle />
          <UsdcBalance />
          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </header>

      <main className="app-wrap">
        {/* stepper */}
        <ol className="stepper">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const cls = step > n ? "done" : step === n ? "active" : "";
            return (
              <li key={label} className={cls}>
                <span className="step-dot">{step > n ? "✓" : n}</span>
                <span className="step-label">{label}</span>
              </li>
            );
          })}
        </ol>

        <section className="step-card">
          {/* ---------- STEP 1: upload & pay ---------- */}
          {step === 1 && (
            <>
              <div className="card-head">
                <h2>Upload a Foundry project</h2>
                <button className="ghost" onClick={loadSample} disabled={busy}>Load sample</button>
              </div>

              <div className="level-select">
                <span className="level-label">Optimization level</span>
                <div className="level-opts">
                  <button className={`level-opt${level === 1 ? " on" : ""}`} onClick={() => setLevel(1)} disabled={busy || phase !== "idle"}>
                    <strong>Level 1</strong><span>function-body only · fast</span>
                  </button>
                  <button className={`level-opt${level === 2 ? " on" : ""}`} onClick={() => setLevel(2)} disabled={busy || phase !== "idle"}>
                    <strong>Level 2</strong><span>+ storage redesign · deeper</span>
                  </button>
                </div>
              </div>

              <div
                className={`dropzone${dragOver ? " over" : ""}${file ? " has-file" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) onPickFile(f, level); }}
                onClick={() => !busy && phase === "idle" && inputRef.current?.click()}
              >
                <input ref={inputRef} type="file" accept=".zip" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f, level); }} />
                {file ? (
                  <div className="dz-file"><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(1)} KB</span></div>
                ) : (
                  <div className="dz-empty">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="dz-icon">
                      <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
                    </svg>
                    <strong>Drop your project .zip here</strong>
                    <span>or click to choose — a Foundry project (foundry.toml) gets verified</span>
                  </div>
                )}
              </div>

              {phase === "uploading" && <p className="muted">Uploading &amp; analyzing…</p>}

              {upload && (
                <div className="pay-confirm">
                  <div className="pay-line">
                    <span className="pay-label">{upload.solFiles} .sol files · {(upload.totalBytes / 1024).toFixed(1)} KB · tier <b>{upload.tier}</b> · Level <b>{upload.level}</b></span>
                    <span className="pay-amount">${upload.priceUsd.toFixed(2)}</span>
                  </div>
                  <div className="pay-actions">
                    <button className="ghost" onClick={startOver} disabled={busy}>Reset</button>
                    {phase === "paying"
                      ? <button className="primary" disabled>Signing…</button>
                      : <button className="primary" onClick={onPay} disabled={busy}>{`Confirm & pay $${upload.priceUsd.toFixed(2)} →`}</button>}
                  </div>
                </div>
              )}

              {error && <p className="error">{error}</p>}
            </>
          )}

          {/* ---------- STEP 2: optimize ---------- */}
          {step === 2 && phase !== "error" && (
            <>
              <div className="card-head">
                <h2>Optimizing</h2>
                <button className="ghost" onClick={startOver}>Start over</button>
              </div>
              <ol className="stages">
                {STAGE_ORDER.filter((s) => s !== "complete").map((s) => {
                  const done = STAGE_ORDER.indexOf(curStage) > STAGE_ORDER.indexOf(s);
                  const active = curStage === s;
                  return <li key={s} className={done ? "done" : active ? "active" : ""}>{STAGE_LABEL[s]}</li>;
                })}
              </ol>
              <p className="muted">Working… ({STAGE_LABEL[curStage]})</p>
              <LogPanel logs={status?.logs} />
            </>
          )}

          {/* ---------- STEP 3: result ---------- */}
          {step === 3 && result && (
            <>
              <div className="card-head">
                <h2>Optimized {result.engine === "claude" && <span className="tag applied">Claude</span>}</h2>
                <button className="ghost" onClick={startOver}>Start over</button>
              </div>

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
                  {result.message}
                  {typeof result.costUsd === "number" && ` (AI cost: $${result.costUsd.toFixed(4)})`}
                </p>
              )}

              <DiffView diffs={result.diffs} />

              {downloadUrl && (
                <a className="primary download" href={downloadUrl} target="_blank" rel="noreferrer">
                  Download optimized project (.zip) ↓
                </a>
              )}
            </>
          )}

          {/* error during a running job */}
          {phase === "error" && (
            <div className="error-block">
              <p className="error">{error}</p>
              <button className="ghost" onClick={startOver}>Start over</button>
              <LogPanel logs={status?.logs} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
