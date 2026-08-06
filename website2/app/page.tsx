"use client";

import { useState } from "react";

const moments = {
  approval: {
    label: "Permission",
    eyebrow: "NEEDS APPROVAL",
    title: "Run the production migration?",
    detail: "npm run db:migrate -- --production",
    primary: "Allow",
    secondary: "Deny",
    color: "green",
  },
  question: {
    label: "Question",
    eyebrow: "ASKING YOU",
    title: "Which rate-limit store should I use?",
    detail: "Redis — shared across instances",
    primary: "Choose Redis",
    secondary: "Other answer",
    color: "yellow",
  },
  review: {
    label: "Review",
    eyebrow: "FINISHED",
    title: "Auth refresh is fixed. 42 tests pass.",
    detail: "3 files changed · +47 / −12",
    primary: "Looks good",
    secondary: "Send feedback",
    color: "blue",
  },
} as const;

type Moment = keyof typeof moments;

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const asset = (path: string) => `${basePath}${path}`;

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function Home() {
  const [activeMoment, setActiveMoment] = useState<Moment>("approval");
  const [copied, setCopied] = useState(false);
  const moment = moments[activeMoment];

  async function copyInstall() {
    await navigator.clipboard.writeText(
      "npm install\nnpm run hooks:install\nnpm start",
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main>
      <nav className="nav shell" aria-label="Main navigation">
        <a className="brand" href="#top" aria-label="Clippy home">
          <span className="brand-mark">
            <img src={asset("/buddies/clip-wave.gif")} alt="" />
          </span>
          <span>Clippy</span>
        </a>
        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <a href="#install">Install</a>
        </div>
        <a
          className="button button-small button-dark"
          href="https://github.com/AISocratic/clippy"
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub <Arrow />
        </a>
      </nav>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" /> Claude Code + Codex · macOS
          </div>
          <h1>
            Your coding agents have a <em>tiny teammate.</em>
          </h1>
          <p className="hero-lede">
            Clippy watches every coding session and pops up only when you’re
            needed. Approve, answer, review—then get right back to what you were
            doing.
          </p>
          <div className="hero-actions">
            <a
              className="button button-primary"
              href="https://github.com/AISocratic/clippy/releases/latest/download/Clippy-for-Claude-Code.dmg"
            >
              Download for macOS — free <span aria-hidden="true">↓</span>
            </a>
            <a className="text-link" href="#how-it-works">
              See how it works <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className="trust-row" aria-label="Product benefits">
            <span>Open source</span>
            <span>100% local</span>
            <span>No account</span>
          </div>
        </div>

        <div className="hero-product" aria-label="Interactive Clippy preview">
          <div className="window-shadow window-back-one" />
          <div className="window-shadow window-back-two" />
          <div className="desktop-window">
            <div className="window-bar">
              <div className="traffic-lights" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span>my-app — terminal</span>
              <span className="window-live">● LIVE</span>
            </div>
            <div className="terminal">
              <p><b>❯</b> fix the flaky retry scheduler test</p>
              <p className="term-muted">● Reproduced across 200 runs.</p>
              <p className="term-muted">● Editing src/retry-scheduler.ts</p>
              <p className="term-success">✓ 20 / 20 tests passing</p>
              <span className="cursor" />
            </div>
            <div className={`clippy-card card-${moment.color}`}>
              <div className="clippy-card-top">
                <span>● my-app</span>
                <b>{moment.eyebrow}</b>
              </div>
              <h3>{moment.title}</h3>
              <div className="command-line">{moment.detail}</div>
              <div className="card-actions">
                <button type="button">{moment.primary}</button>
                <button type="button">{moment.secondary}</button>
              </div>
              <span className="speech-tail" />
            </div>
            <div className="buddy-perch">
              <div className="buddy-label">● my-app</div>
              <img src={asset("/buddies/clip-idle.gif")} alt="Animated Clippy buddy" />
              <span className="buddy-badge">1</span>
              <p>waiting for you</p>
            </div>
          </div>
          <div className="moment-picker" aria-label="Choose a Clippy moment">
            {(Object.keys(moments) as Moment[]).map((key) => (
              <button
                key={key}
                type="button"
                className={activeMoment === key ? "active" : ""}
                onClick={() => setActiveMoment(key)}
                aria-pressed={activeMoment === key}
              >
                {moments[key].label}
              </button>
            ))}
          </div>
          <div className="spark spark-one">✦</div>
          <div className="spark spark-two">✦</div>
        </div>
      </section>

      <section className="problem-band">
        <div className="shell problem-grid">
          <div>
            <span className="section-kicker">THE TEN-MINUTE PROBLEM</span>
            <h2>Your agent isn’t slow. It’s waiting for you.</h2>
          </div>
          <p>
            You kick off a long task, switch to Slack, and come back to find it
            blocked on one tiny decision. Clippy closes that gap without asking
            you to move your work into another app.
          </p>
        </div>
      </section>

      <section className="workflow shell" id="how-it-works">
        <div className="section-heading centered">
          <span className="section-kicker">HOW IT WORKS</span>
          <h2>Out of the way.<br />Until it matters.</h2>
          <p>Clippy follows the rhythm of your existing coding workflow.</p>
        </div>

        <div className="workflow-track">
          <article className="workflow-step">
            <span className="step-number">01</span>
            <div className="step-visual code-visual">
              <div className="mini-terminal">
                <span>❯ claude</span>
                <span className="term-muted">Working on auth…</span>
                <span className="term-success">● Editing refresh.ts</span>
              </div>
            </div>
            <h3>Start your agents</h3>
            <p>Use Claude Code or Codex exactly the way you do today.</p>
          </article>
          <article className="workflow-step">
            <span className="step-number">02</span>
            <div className="step-visual buddies-visual">
              <div className="mini-buddy orange"><img src={asset("/buddies/clip-idle.gif")} alt="" /><span>api</span></div>
              <div className="mini-buddy green"><img src={asset("/buddies/cat-wave.gif")} alt="" /><span>docs</span></div>
              <div className="mini-buddy pink"><img src={asset("/buddies/clod-cheer.gif")} alt="" /><span>web</span></div>
            </div>
            <h3>Clippy keeps watch</h3>
            <p>Every session gets a distinct buddy, status, and project name.</p>
          </article>
          <article className="workflow-step">
            <span className="step-number">03</span>
            <div className="step-visual answer-visual">
              <div className="mini-alert">
                <b>Claude needs approval</b>
                <span>Run npm test?</span>
                <div><i>Deny</i><i>Allow</i></div>
              </div>
            </div>
            <h3>Answer and move on</h3>
            <p>Approve, deny, answer, or review right from the card.</p>
          </article>
        </div>
      </section>

      <section className="features-section" id="features">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <span className="section-kicker">BUILT FOR PARALLEL WORK</span>
              <h2>Small buddy.<br />Serious range.</h2>
            </div>
            <p>
              The control you need for agent-heavy work, without replacing your
              terminal, editor, or habits.
            </p>
          </div>

          <div className="bento-grid">
            <article className="bento bento-wide blue-card">
              <div className="bento-copy">
                <span className="feature-icon">↗</span>
                <h3>Always on the right window</h3>
                <p>
                  Each buddy perches on its session’s own terminal or editor and
                  follows it when the window moves. One click takes you back.
                </p>
              </div>
              <div className="window-stack" aria-hidden="true">
                <div className="stack-card stack-back">billing-api</div>
                <div className="stack-card stack-mid">docs-refresh</div>
                <div className="stack-card stack-front">
                  <img src={asset("/buddies/clip-wave.gif")} alt="" />
                  <b>my-app</b>
                  <span>finished — your turn</span>
                </div>
              </div>
            </article>

            <article className="bento yellow-card">
              <span className="feature-icon">◎</span>
              <h3>Quiet by default</h3>
              <p>
                No ambient tool spam. A buddy appears when a session needs a
                decision, finishes a turn, or is waiting for your reply.
              </p>
              <div className="quiet-meter" aria-hidden="true">
                <span>working</span><i /><i /><i /><i className="lit" /><b>needs you</b>
              </div>
            </article>

            <article className="bento dark-card">
              <span className="feature-icon">⌘</span>
              <h3>Answer the whole loop</h3>
              <p>
                Permission requests, plan approvals, questions, and final review
                all become useful, actionable cards.
              </p>
              <div className="loop-list">
                <span><i>✓</i> Approve a command</span>
                <span><i>✓</i> Revise a plan</span>
                <span><i>✓</i> Send feedback</span>
              </div>
            </article>

            <article className="bento bento-wide coral-card">
              <div className="bento-copy">
                <span className="feature-icon">◌</span>
                <h3>One cast. Many sessions.</h3>
                <p>
                  Run five agents in one folder and you’ll get five
                  distinguishable characters—not one confused paperclip.
                </p>
              </div>
              <div className="cast-row" aria-hidden="true">
                <div><img src={asset("/buddies/clip-cheer.gif")} alt="" /><span>frontend</span></div>
                <div><img src={asset("/buddies/cat-wave.gif")} alt="" /><span>api</span></div>
                <div><img src={asset("/buddies/clod-cheer.gif")} alt="" /><span>tests</span></div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="real-product shell">
        <div className="section-heading centered">
          <span className="section-kicker">REAL CLIPPY. REAL CARDS.</span>
          <h2>It doesn’t just notify.<br />It lets you decide.</h2>
        </div>
        <div className="product-gallery">
          <figure className="shot shot-plan">
            <img src={asset("/product/plan-card.png")} alt="Clippy plan review card" />
            <figcaption><span>01</span><b>Review the plan</b></figcaption>
          </figure>
          <figure className="shot shot-question">
            <img src={asset("/product/question-card.png")} alt="Clippy question card" />
            <figcaption><span>02</span><b>Answer a question</b></figcaption>
          </figure>
          <figure className="shot shot-review">
            <img src={asset("/product/review-card.png")} alt="Clippy finished review card" />
            <figcaption><span>03</span><b>Close the loop</b></figcaption>
          </figure>
        </div>
      </section>

      <section className="local-section">
        <div className="shell local-grid">
          <div className="local-copy">
            <span className="section-kicker light">LOCAL BY DESIGN</span>
            <h2>Your code stays between you and your agent.</h2>
            <p>
              Clippy runs entirely on your Mac and talks to Claude Code and
              Codex over localhost. No account, no cloud relay, no telemetry.
            </p>
            <div className="local-points">
              <span><i>✓</i> Uses native agent hooks</span>
              <span><i>✓</i> Fails safely to terminal prompts</span>
              <span><i>✓</i> Nothing is ever auto-approved</span>
            </div>
          </div>
          <div className="local-diagram" aria-label="Local data flow diagram">
            <div className="diagram-node mac-node">
              <span className="node-icon">⌘</span>
              <b>Your Mac</b>
              <small>Everything stays here</small>
            </div>
            <div className="diagram-flow"><span>localhost</span></div>
            <div className="agent-nodes">
              <div className="diagram-node"><b>Claude Code</b><small>native hooks</small></div>
              <div className="diagram-node"><b>Codex</b><small>native hooks</small></div>
            </div>
          </div>
        </div>
      </section>

      <section className="install-section shell" id="install">
        <div className="install-card">
          <div className="install-copy">
            <span className="section-kicker">UP AND RUNNING IN MINUTES</span>
            <h2>Give your agents a buddy.</h2>
            <p>
              Clippy is open source and built for macOS. Download the app, drag
              it into Applications (right-click → Open the first time — it’s
              unsigned), click “Install hooks” when it offers, and your next
              agent session gets a tiny teammate. Prefer source? The terminal
              path works too.
            </p>
            <a
              className="button button-dark"
              href="https://github.com/AISocratic/clippy/releases/latest/download/Clippy-for-Claude-Code.dmg"
            >
              Download Clippy for macOS <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className="install-terminal">
            <div className="install-terminal-bar">
              <span>Terminal</span>
              <button type="button" onClick={copyInstall} aria-live="polite">
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre><span>$</span> npm install{"\n"}<span>$</span> npm run hooks:install{"\n"}<span>$</span> npm start</pre>
            <div className="install-success">✓ Clippy is watching 2 sessions</div>
          </div>
          <img className="install-buddy" src={asset("/buddies/clip-cheer.gif")} alt="Clippy cheering" />
        </div>
      </section>

      <footer className="footer shell">
        <a className="brand" href="#top">
          <span className="brand-mark"><img src={asset("/buddies/clip-wave.gif")} alt="" /></span>
          <span>Clippy</span>
        </a>
        <p>A tiny teammate for Claude Code + Codex.</p>
        <div>
          <a href="https://github.com/AISocratic/clippy" target="_blank" rel="noreferrer">GitHub <Arrow /></a>
          <a href="https://aisocratic.org" target="_blank" rel="noreferrer">AI Socratic <Arrow /></a>
        </div>
      </footer>
    </main>
  );
}
