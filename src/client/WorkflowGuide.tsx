import { useState } from "react";
import "./optionsResearch.css";

const DISMISS_KEY = "workflowGuideDismissed";

function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

const tabs: Array<{ name: string; purpose: string; next: string }> = [
  { name: "E*TRADE", purpose: "Broker hub: market scan, Auto Options Research, order ticket, portfolio, ledger, NLQ, omnichannel and voice sub-tabs.", next: "Starting point. Scan the market, research options, then preview an order." },
  { name: "↳ Market Screener & Scanner", purpose: "Click Run Market Scan to screen stocks (nothing runs automatically).", next: "Pick a symbol, then research its options or open it in the order ticket." },
  { name: "↳ Auto Options Research", purpose: "Ask in plain English or fill the thesis form. NLQ fills the form so you can see how it was interpreted. Rank candidates, pick the best trade, compare Quant vs LLM, or run the LLM idea experiment. Requests keep running if you switch tabs.", next: "Click any recommendation to send it to the Fast Order Ticket." },
  { name: "↳ Fast Order Ticket & Preview", purpose: "Creates a signed preview of an order. Nothing is sent without human approval.", next: "Approve or reject, then follow the result in Portfolio and Ledger." },
  { name: "↳ Portfolio / Ledger", purpose: "Positions, orders and the audit trail of previews and executions.", next: "Review outcomes and feed new ideas back into research." },
  { name: "↳ NLQ / Omnichannel / Voice & Slack", purpose: "Same questions and reports through chat, Slack, voice, email and signed webhooks.", next: "Results from any channel match the web experience." },
  { name: "Yahoo Finance", purpose: "Free market data screener and quotes, loaded when you first open the tab.", next: "Use Trade to jump to the E*TRADE order flow." },
  { name: "API / MCP", purpose: "Endpoint and MCP tool explorer for integrating with the same capabilities.", next: "Automate the workflow from your own tools." },
];

export function WorkflowGuide() {
  return (
    <section className="workflow-guide" aria-label="How the tabs work together">
      <h3>How the tabs fit together</h3>
      <p>Typical flow: <b>Scan</b> → <b>Auto Options Research</b> (strategy universe → rank / best trade → Quant vs LLM) → <b>Order ticket preview</b> → <b>Approve</b> → <b>Portfolio &amp; Ledger</b>. Export or share any result as .xlsx by email, Slack, voice or webhook.</p>
      <dl>
        {tabs.map((tab) => (
          <div key={tab.name}>
            <dt>{tab.name}</dt>
            <dd>{tab.purpose} <em>Next: {tab.next}</em></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
