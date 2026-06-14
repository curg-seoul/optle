import { ThemeToggle } from "./theme";

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="url(#lg)" strokeWidth="2" />
      <path d="M9 21V14M16 21V9M23 21V17" stroke="url(#lg)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M8 11l6-4 4 2 7-5" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function HeroArt() {
  // Before/after gas bars with a downward delta — communicates the value instantly.
  return (
    <svg viewBox="0 0 360 260" className="hero-art" role="img" aria-label="Gas reduced after optimization">
      <defs>
        <linearGradient id="barBefore" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--muted)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--muted)" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="barAfter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      {/* baseline */}
      <line x1="40" y1="210" x2="330" y2="210" stroke="var(--border)" strokeWidth="1.5" />
      {/* before bar */}
      <rect x="78" y="40" width="78" height="170" rx="8" fill="url(#barBefore)" />
      <text x="117" y="232" textAnchor="middle" className="art-label">before</text>
      <text x="117" y="30" textAnchor="middle" className="art-val">100%</text>
      {/* after bar */}
      <rect x="214" y="128" width="78" height="82" rx="8" fill="url(#barAfter)" />
      <text x="253" y="232" textAnchor="middle" className="art-label">after</text>
      <text x="253" y="118" textAnchor="middle" className="art-val art-accent">58%</text>
      {/* delta arrow */}
      <path d="M170 70 C 196 70, 196 118, 206 124" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 4" opacity="0.8" />
      <path d="M206 124l-7-4 1 8z" fill="var(--accent)" />
      <g transform="translate(150 86)">
        <rect x="-2" y="-16" width="64" height="26" rx="13" fill="var(--accent)" />
        <text x="30" y="2" textAnchor="middle" className="art-chip">−42%</text>
      </g>
    </svg>
  );
}

const FEATURES = [
  {
    title: "Pay per run, onchain",
    body: "Settle each optimization in USDC over x402 — no accounts, keys, or subscriptions.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" />
      </svg>
    ),
  },
  {
    title: "AI + Foundry-verified",
    body: "An agent rewrites your contracts; every change is checked against your tests and a gas snapshot.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    ),
  },
  {
    title: "Deployable output",
    body: "Get an optimized build with a per-file diff. Your original sources are never touched.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12M8 11l4 4 4-4M5 21h14" />
      </svg>
    ),
  },
];

export function Landing() {
  return (
    <div className="landing">
      <div className="bg-mesh" aria-hidden />
      <nav className="lp-nav">
        <div className="brand"><Logo /><span>Optle</span></div>
        <div className="lp-nav-right">
          <ThemeToggle />
          <a className="btn-primary" href="/app" target="_blank" rel="noopener noreferrer">Launch app</a>
        </div>
      </nav>

      <header className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Onchain gas optimization · x402</span>
          <h1>Ship cheaper Solidity.</h1>
          <p>
            Upload a Foundry project, pay per run with USDC, and get an AI-optimized
            build whose gas savings are verified by your own tests.
          </p>
          <div className="hero-cta">
            <a className="btn-primary lg" href="/app" target="_blank" rel="noopener noreferrer">Launch app →</a>
            <span className="hero-meta">Mantle Sepolia · USDC · pay-per-run</span>
          </div>
        </div>
        <div className="hero-visual"><HeroArt /></div>
      </header>

      <section className="features">
        {FEATURES.map((f) => (
          <div className="feature" key={f.title}>
            <span className="feat-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="how">
        <div className="how-step"><span className="how-n">1</span> Upload your project .zip</div>
        <span className="how-arrow">→</span>
        <div className="how-step"><span className="how-n">2</span> Pay with USDC (x402)</div>
        <span className="how-arrow">→</span>
        <div className="how-step"><span className="how-n">3</span> Download the optimized build</div>
      </section>

      <footer className="lp-foot">
        <span className="brand sm"><Logo size={18} /> Optle</span>
        <span>Gas optimization, settled onchain.</span>
      </footer>
    </div>
  );
}
