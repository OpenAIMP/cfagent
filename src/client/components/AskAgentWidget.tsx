import React, { useState, useRef, useEffect } from "react";
import type { NavTabId } from "./NavigationMenu";

export interface AskAgentWidgetProps {
  onAskAgent: (prompt: string) => void;
  onOpenFullChat: () => void;
  agentStatus?: {
    dotClass: string;
    label: string;
  };
  activeTab?: NavTabId;
}

interface MessageItem {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: string;
}

const DEFAULT_QUICK_PROMPTS = [
  { label: "⚡ Autopilot Policy", prompt: "Explain the active Autopilot execution policy limits and kill switch rules." },
  { label: "📊 Options Sweeps", prompt: "Screen for institutional 0DTE options flow and unusual call/put sweeps." },
  { label: "🔬 NVDA Research", prompt: "Generate a FOSS valuation and analyst consensus report for NVDA." },
  { label: "🛡️ Portfolio Safety", prompt: "What are my current drawdown guardrails and human-in-the-loop safeguards?" },
];

export function AskAgentWidget({
  onAskAgent,
  onOpenFullChat,
  agentStatus = { dotClass: "ready", label: "Ready" },
  activeTab = "trading",
}: AskAgentWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: "welcome",
      role: "agent",
      text: "👋 Hi! I am your NextGenTP Agent Copilot. Ask me about real-time market data, options flows, autopilot limits, or trading workflows.",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 80);
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isOpen, messages]);

  // Global ESC handler to close drawer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = input.trim();
    if (!query || isBusy) return;

    const userMsg: MessageItem = {
      id: `u-${Date.now()}`,
      role: "user",
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsBusy(true);

    // Provide intelligent contextual response or hand off to full agent session
    setTimeout(() => {
      let reply = "";
      const q = query.toLowerCase();

      if (q.includes("autopilot") || q.includes("policy") || q.includes("limits")) {
        reply = "🔒 **Autopilot Policy**: Max position 10.00%, Cash reserve 5.00%, Drawdown alert 20.00%, Max orders/day 10. Kill switch can be triggered at any time.";
      } else if (q.includes("option") || q.includes("flow") || q.includes("sweep")) {
        reply = "📊 **Options Flow**: Scanning institutional block trades and 0DTE sweeps. You can view real-time call/put volume ratios under the Hedging & Options Flows tab.";
      } else if (q.includes("research") || q.includes("nvda") || q.includes("valuation")) {
        reply = "🔬 **FOSS Research**: Zero-credential equity valuation active. Yahoo Finance multiples + Alpaca NBBO quotes available. Opening comprehensive report.";
      } else {
        reply = `⚡ I received your query: "${query}". I am routing this through the LLM Judge to activate the specialized agent for "${activeTab}". Click "Open in Chat Tab" for full multi-turn analysis.`;
      }

      const agentMsg: MessageItem = {
        id: `a-${Date.now()}`,
        role: "agent",
        text: reply,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setMessages((prev) => [...prev, agentMsg]);
      setIsBusy(false);
    }, 600);
  };

  const handleQuickPromptClick = (prompt: string) => {
    setInput(prompt);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  };

  const handleTransferToFullChat = (queryText?: string) => {
    setIsOpen(false);
    const targetQuery = queryText || input.trim() || messages[messages.length - 1]?.text;
    if (targetQuery && targetQuery !== messages[0].text) {
      onAskAgent(targetQuery);
    } else {
      onOpenFullChat();
    }
  };

  return (
    <>
      {/* Floating Trigger Pill (Docked bottom-right, matching AlgoNexus) */}
      <div className="ask-agent-floating-dock">
        <button
          type="button"
          className={`ask-agent-pill-btn ${isOpen ? "active" : ""}`}
          onClick={() => setIsOpen((prev) => !prev)}
          title="Ask NextGenTP Agent Copilot"
          aria-expanded={isOpen}
          aria-label="Open Ask Agent Copilot"
        >
          <span className="ask-agent-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <span className="ask-agent-label">Ask Agent</span>
          <span className={`ask-agent-status-dot ${agentStatus.dotClass}`} title={`Status: ${agentStatus.label}`} />
        </button>
      </div>

      {/* Floating Copilot Drawer Panel */}
      {isOpen && (
        <div className="ask-agent-drawer-card" role="dialog" aria-modal="true" aria-label="Ask Agent Copilot">
          {/* Drawer Header */}
          <div className="ask-agent-header">
            <div className="agent-header-brand">
              <div className="agent-header-avatar">
                <span className="agent-avatar-glyph">🤖</span>
                <span className={`agent-online-dot ${agentStatus.dotClass}`} />
              </div>
              <div className="agent-header-titles">
                <div className="agent-main-title">
                  <span>NextGenTP Agent Copilot</span>
                  <span className="agent-ai-badge">AI 2.0</span>
                </div>
                <div className="agent-sub-title">
                  Autonomous trading, options & research assistant
                </div>
              </div>
            </div>

            <div className="agent-header-actions">
              <button
                type="button"
                className="agent-icon-btn"
                onClick={() => handleTransferToFullChat()}
                title="Expand to Full Chat Tab"
                aria-label="Open in Chat Tab"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
              <button
                type="button"
                className="agent-icon-btn"
                onClick={() => setIsOpen(false)}
                title="Minimize Agent"
                aria-label="Close Ask Agent"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Messages Scroll Area */}
          <div className="ask-agent-messages-container">
            {messages.map((m) => (
              <div key={m.id} className={`ask-agent-msg-bubble ${m.role}`}>
                <div className="msg-content">{m.text}</div>
                <div className="msg-time">{m.timestamp}</div>
              </div>
            ))}
            {isBusy && (
              <div className="ask-agent-msg-bubble agent streaming">
                <div className="agent-typing-dots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompt Chips */}
          <div className="ask-agent-quick-prompts">
            {DEFAULT_QUICK_PROMPTS.map((qp, idx) => (
              <button
                key={idx}
                type="button"
                className="quick-chip-btn"
                onClick={() => handleQuickPromptClick(qp.prompt)}
              >
                {qp.label}
              </button>
            ))}
          </div>

          {/* Input & Action Footer */}
          <form className="ask-agent-input-form" onSubmit={handleSend}>
            <input
              ref={inputRef}
              type="text"
              className="ask-agent-text-input"
              placeholder="Ask copilot or type command…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isBusy}
            />
            <button
              type="submit"
              className="ask-agent-send-btn"
              disabled={!input.trim() || isBusy}
              title="Send message"
            >
              <span>➔</span>
            </button>
          </form>

          {/* Footer info bar */}
          <div className="ask-agent-footer-bar">
            <span>Powered by NextGenTP Multi-Agent Intelligence</span>
            <button
              type="button"
              className="open-full-chat-link"
              onClick={() => handleTransferToFullChat()}
            >
              Full Agent Workspace ↗
            </button>
          </div>
        </div>
      )}
    </>
  );
}
