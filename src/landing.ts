const capabilities: Array<{ icon: string; title: string; body: string }> = [
  { icon: "📈", title: "Market screening", body: "Screen stocks and options chains on demand from E*TRADE and Yahoo Finance data, with filters for price, market cap, liquidity, spreads and quote freshness." },
  { icon: "🧠", title: "Natural-language research", body: "Ask in plain English, for example “list all strategies evaluated for NVDA bullish target $260”. The question is translated into a visible, editable set of parameters." },
  { icon: "🧮", title: "Quant strategy engine", body: "A deterministic engine builds and scores 60+ options strategies (calls, spreads, condors, straddles, calendars and more) with payoff curves, Greeks, break-evens and probability of profit." },
  { icon: "⚖️", title: "Quant vs LLM comparison", body: "Give the same option data to an LLM and compare its rankings and rationale side by side with the quant scores. The LLM can only choose from validated candidates." },
  { icon: "⚡", title: "Fast order ticket & preview", body: "Turn a recommendation into a signed order preview in one click. Every order requires explicit human approval and is stamped with an auditable identity." },
  { icon: "🗂️", title: "Portfolio & ledger", body: "Track positions, drafts and executions with a full audit trail of who proposed, approved or rejected each order." },
  { icon: "📤", title: "Export & share", body: "Download results as .xlsx, or send them by email, Slack, voice or signed webhooks. Every channel gives the same answers as the web app." },
  { icon: "🔌", title: "API & MCP endpoints", body: "Integrate the same capabilities into your own tools through documented API and Model Context Protocol endpoints." },
];

const steps = ["Scan the market", "Research options", "Rank & compare strategies", "Preview an order", "Approve & track"];

export function renderLandingPage(appName?: string): string {
  const name = appName || "Agentic Trading";
  const cards = capabilities.map((c) => `<article class="cap"><div class="ic">${c.icon}</div><h3>${c.title}</h3><p>${c.body}</p></article>`).join("");
  const flow = steps.map((s, i) => `<li><b>${i + 1}</b>${s}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} — Agentic analysis &amp; trading</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, #0b0f19 55%, #030712 100%); color: #f3f4f6; line-height: 1.6; }
    header.hero { text-align: center; padding: 4rem 1.5rem 2rem; max-width: 820px; margin: 0 auto; }
    h1 { font-size: 2.4rem; letter-spacing: -0.02em; margin-bottom: .75rem; }
    .hero p { color: #94a3b8; font-size: 1.05rem; margin-bottom: 1.75rem; }
    .btn { display: inline-block; background: #fff; color: #0f172a; font-weight: 600; text-decoration: none; padding: .8rem 1.8rem; border-radius: 12px; }
    main { max-width: 1100px; margin: 0 auto; padding: 1rem 1.5rem 3rem; }
    h2 { margin: 2rem 0 1rem; font-size: 1.3rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
    .cap { background: rgba(17,24,39,.75); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; padding: 1.25rem; }
    .cap .ic { font-size: 1.6rem; } .cap h3 { margin: .4rem 0; font-size: 1.05rem; } .cap p { color: #94a3b8; font-size: .9rem; }
    ol.flow { list-style: none; display: flex; flex-wrap: wrap; gap: .75rem; }
    ol.flow li { background: rgba(56,189,248,.1); border: 1px solid rgba(56,189,248,.3); border-radius: 999px; padding: .4rem 1rem; font-size: .9rem; }
    ol.flow b { margin-right: .5rem; color: #38bdf8; }
    .safety { background: rgba(16,185,129,.08); border: 1px solid rgba(16,185,129,.3); border-radius: 14px; padding: 1rem 1.25rem; color: #cbd5e1; font-size: .92rem; }
    footer { text-align: center; padding: 2rem 1rem 3rem; color: #64748b; font-size: .8rem; }
  </style>
</head>
<body>
  <header class="hero">
    <h1>${name}</h1>
    <p>Agentic analysis and trading: screen the market, research options strategies with a transparent quant engine and an LLM cross-check, then preview and approve trades through E*TRADE, all with a human in the loop.</p>
    <a class="btn" href="/login">Sign in with GitHub to get started</a>
  </header>
  <main>
    <h2>What you can do</h2>
    <section class="grid">${cards}</section>
    <h2>How it works</h2>
    <ol class="flow">${flow}</ol>
    <h2>Safety first</h2>
    <p class="safety">Research outputs are informational, not financial advice. Orders are never sent autonomously: each trade is previewed, signed and requires your explicit approval, and every action is recorded in an audit ledger. Start in the E*TRADE sandbox (TEST) before using production.</p>
  </main>
  <footer>Sign in to access the platform. <a href="/login" style="color:#38bdf8">Sign in</a></footer>
</body>
</html>`;
}
