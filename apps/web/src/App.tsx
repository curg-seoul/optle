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
      <summary>Runner Logs ({logs.length})</summary>
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
      <h3>Optimization Diff</h3>
      {diffs.map((d, i) => (
        <details key={d.file} open={i === 0} className="diff-file">
          <summary>{d.file}</summary>
          <pre className="diff">
            <div className="diff-body">
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
            </div>
          </pre>
        </details>
      ))}
    </div>
  );
}

type Phase = "idle" | "uploading" | "ready" | "paying" | "running" | "done" | "error";

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading Project",
  optimizing: "Optimizing Contracts",
  verifying: "Verifying Gas Savings",
  packaging: "Packaging Result",
  complete: "Complete",
};
const STAGE_ORDER = ["queued", "downloading", "optimizing", "verifying", "packaging", "complete"];

const STEPS = ["Upload & Analyze", "Optimization", "Results"];

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
        <a className="brand" href="/"><Logo size={28} /><span>Optle</span></a>
        <div className="net-badge-wrap">
          <span className="net-dot"></span>
          <span className="net-label">Mantle Sepolia</span>
        </div>
        <div className="header-right">
          <ThemeToggle />
          <UsdcBalance />
          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </header>

      <main className="app-wrap">
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
          {step === 1 && (
            <>
              <div className="card-head">
                <h2>Optimize Your Project</h2>
                <button className="ghost" onClick={loadSample} disabled={busy}>Load Sample</button>
              </div>

              <div className="level-select">
                <span className="level-label">Target Optimization Intensity</span>
                <div className="level-opts">
                  <button className={`level-opt${level === 1 ? " on" : ""}`} onClick={() => setLevel(1)} disabled={busy || phase !== "idle"}>
                    <strong>Standard</strong><span>Safe rewrites, fast results</span>
                  </button>
                  <button className={`level-opt${level === 2 ? " on" : ""}`} onClick={() => setLevel(2)} disabled={busy || phase !== "idle"}>
                    <strong>Aggressive</strong><span>Deeper storage & logic refactoring</span>
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
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dz-icon">
                      <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
                    </svg>
                    <strong>Drop Foundry Project .zip</strong>
                    <span>Must contain foundry.toml</span>
                  </div>
                )}
              </div>

              {phase === "uploading" && <p className="muted">Analyzing source files…</p>}

              {upload && (
                <div className="pay-confirm">
                  <div className="pay-line">
                    <div className="pay-details">
                      <span className="pay-label">{upload.solFiles} Files · {(upload.totalBytes / 1024).toFixed(1)} KB</span>
                      <div className="pay-tier">Tier {upload.tier} · Level {upload.level}</div>
                    </div>
                    <span className="pay-amount">${upload.priceUsd.toFixed(2)}</span>
                  </div>
                  <div className="pay-actions">
                    <button className="ghost" onClick={startOver} disabled={busy}>Cancel</button>
                    {phase === "paying"
                      ? <button className="primary" disabled>Awaiting Signature…</button>
                      : <button className="primary" onClick={onPay} disabled={busy}>{`Pay $${upload.priceUsd.toFixed(2)} & Optimize`}</button>}
                  </div>
                </div>
              )}

              {error && <p className="error">{error}</p>}
            </>
          )}

          {step === 2 && phase !== "error" && (
            <>
              <div className="card-head">
                <h2>Optimizing Contracts</h2>
                <button className="ghost" onClick={startOver}>Restart</button>
              </div>
              <ol className="stages">
                {STAGE_ORDER.filter((s) => s !== "complete").map((s) => {
                  const done = STAGE_ORDER.indexOf(curStage) > STAGE_ORDER.indexOf(s);
                  const active = curStage === s;
                  return <li key={s} className={done ? "done" : active ? "active" : ""}>{STAGE_LABEL[s]}</li>;
                })}
              </ol>
              <div className="running-msg">
                <span className="loader"></span>
                <p className="muted">Running {STAGE_LABEL[curStage]}...</p>
              </div>
              <LogPanel logs={status?.logs} />
            </>
          )}

          {step === 3 && result && (
            <>
              <div className="card-head">
                <h2>Optimization Successful</h2>
                <button className="ghost" onClick={startOver}>New Project</button>
              </div>

              <div className="gas-cards">
                {result.verified ? (
                  <>
                    <div className="card"><span className="label">Base Gas</span><span className="num">{result.gasBefore?.toLocaleString()}</span></div>
                    <div className="card"><span className="label">Optimized</span><span className="num">{result.gasAfter?.toLocaleString()}</span></div>
                  </>
                ) : (
                  <div className="card"><span className="label">Gas Savings</span><span className="num" style={{ fontSize: 16 }}>Estimated</span></div>
                )}
                <div className="card saved"><span className="label">Saved</span><span className="num">−{result.savedPct ?? 0}%</span></div>
              </div>

              {result.message && (
                <p className="estimate-note">
                  {result.message}
                </p>
              )}

              <DiffView diffs={result.diffs} />

              {downloadUrl && (
                <a className="btn-primary" href={downloadUrl} target="_blank" rel="noreferrer" style={{ width: '100%', marginTop: '24px' }}>
                  Download Optimized Project (.zip)
                </a>
              )}
            </>
          )}

          {phase === "error" && (
            <div className="error-block">
              <p className="error">{error}</p>
              <button className="primary" onClick={startOver}>Try Again</button>
              <LogPanel logs={status?.logs} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

