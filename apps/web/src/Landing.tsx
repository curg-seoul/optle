import { useEffect, useRef } from "react";
import { ThemeToggle } from "./theme";

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="4" y="4" width="24" height="24" rx="6" stroke="var(--accent)" strokeWidth="2.5" />
      <path d="M12 10L12 22M12 10L20 10M12 16L18 16" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="22" cy="22" r="3" fill="var(--accent)" />
    </svg>
  );
}

function HeroArt() {
  return (
    <div className="hero-visual-wrap">
      <div className="hero-glow" />
      <svg viewBox="0 0 400 300" className="hero-art" role="img" aria-label="Gas optimization visualization">
        <defs>
          <linearGradient id="path-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--text-dim)" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        
        {/* Background Grid Box */}
        <rect x="40" y="40" width="320" height="220" rx="24" fill="var(--panel)" stroke="var(--border-strong)" strokeWidth="1" />
        
        {/* Horizontal Grid Lines */}
        {[80, 120, 160, 200, 240].map(y => (
          <path key={y} d={`M40 ${y} H360`} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" opacity="0.5" />
        ))}
        
        {/* The "Gas Fee" Path - Trending Downward */}
        <path className="hero-path" d="M80 100 C 140 100, 180 220, 320 220" 
          stroke="url(#path-grad)" strokeWidth="4" fill="none" strokeLinecap="round" 
          style={{ filter: 'drop-shadow(0 0 12px var(--accent))' }} />
        
        {/* Start point (High Fee) */}
        <circle cx="80" cy="100" r="6" fill="var(--bg)" stroke="var(--text-dim)" strokeWidth="2" />
        <text x="80" y="85" fill="var(--muted)" fontSize="10" fontWeight="700" fontFamily="var(--mono)">BEFORE: 124K GAS</text>
        
        {/* End point (Low Fee) */}
        <circle cx="320" cy="220" r="6" fill="var(--accent)" />
        <text x="240" y="245" fill="var(--accent)" fontSize="10" fontWeight="900" fontFamily="var(--mono)">AFTER: 68K GAS</text>
        
        {/* Savings Callout */}
        <g transform="translate(260, 120)" className="savings-badge">
          <rect x="0" y="0" width="80" height="32" rx="16" fill="var(--accent)" />
          <text x="40" y="20" fill="var(--accent-fg)" fontSize="12" fontWeight="900" textAnchor="middle" fontFamily="var(--mono)">-45%</text>
        </g>
      </svg>
      <style>{`
        .hero-visual-wrap { position: relative; }
        .hero-glow {
          position: absolute;
          top: 50%; left: 50%;
          width: 80%; height: 80%;
          background: var(--accent);
          filter: blur(100px);
          opacity: 0.15;
          transform: translate(-50%, -50%);
          z-index: -1;
        }
      `}</style>
    </div>
  );
}

const FEATURES = [
  {
    title: "Pay-Per-Run Gas Audit",
    body: "Comprehensive gas optimization audits gated by a single native-MNT micropayment. Secure, automated, and verified on Mantle.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    title: "Foundry Verified",
    body: "Every rewrite is automatically validated against your test suite. Safety and correctness, guaranteed.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    title: "AI Optimization",
    body: "Leverage advanced neural patterns to identify deep storage and logic optimizations at scale.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a10 10 0 0 1 10 10" />
        <path d="M12 12L2.1 12.1" />
      </svg>
    ),
  },
];

export function Landing() {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const x = (e.clientX / window.innerWidth) * 100;
      const y = (e.clientY / window.innerHeight) * 100;
      document.documentElement.style.setProperty("--mouse-x", `${x}%`);
      document.documentElement.style.setProperty("--mouse-y", `${y}%`);
    };

    window.addEventListener("mousemove", handleMouseMove);

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
          }
        });
      },
      { threshold: 0.1 }
    );

    const elements = document.querySelectorAll(".reveal");
    elements.forEach((el) => observer.observe(el));

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="landing" ref={scrollRef}>
      <div className="bg-mesh" aria-hidden />
      <nav className="lp-nav">
        <a className="brand" href="/"><Logo /><span>Optle</span></a>
        <div className="lp-nav-right">
          <ThemeToggle />
          <a className="btn-primary" href="/app">Launch App</a>
        </div>
      </nav>

      <section className="hero reveal">
        <div className="hero-copy">
          <span className="eyebrow">Next-Gen Gas Optimization</span>
          <h1>Ship Cheaper Solidity.</h1>
          <p>
            Automatically optimize your smart contracts and verify savings with Foundry. 
            Powered by AI, paid per run in <span className="highlight-x402">native MNT</span> on Mantle.
          </p>
          <div className="hero-cta">
            <a className="btn-primary lg" href="/app" style={{ fontSize: '18px', padding: '16px 40px' }}>Start Optimizing →</a>
          </div>
        </div>
        <HeroArt />
      </section>

      <section className="features reveal">
        {FEATURES.map((f) => (
          <div className="feature" key={f.title}>
            <span className="feat-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="how reveal">
        <div className="how-step">
          <span className="how-n">1</span>
          <span>Upload ZIP</span>
        </div>
        <span className="how-arrow">→</span>
        <div className="how-step">
          <span className="how-n">2</span>
          <span>Pay MNT <small>(per run)</small></span>
        </div>
        <span className="how-arrow">→</span>
        <div className="how-step">
          <span className="how-n">3</span>
          <span>Download</span>
        </div>
      </section>

      <footer className="lp-foot reveal">
        <span className="brand" style={{ fontSize: '16px' }}><Logo size={24} /> Optle</span>
        <span>© 2024 Optle. Built for Mantle Hackathon.</span>
      </footer>
    </div>
  );
}
