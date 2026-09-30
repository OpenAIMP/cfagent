import React, { useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

interface User {
  login: string;
  name: string;
  avatar: string;
}

interface AuditLogEvent {
  id: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface MemoryItem {
  key: string;
  value: string;
  updatedAt: string;
}

function extractText(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("") || "";
  }
  return "";
}

/**
 * Lightweight markdown formatter for bold, code blocks, inline code, and lists.
 */
function MarkdownContent({ text }: { text: string }) {
  if (!text) return null;

  // Split text by markdown code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);

  return (
    <div className="markdown-body">
      {parts.map((part, idx) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const lines = part.slice(3, -3).trim().split("\n");
          const firstLine = lines[0].trim();
          const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
          const lang = hasLang ? firstLine : "";
          const code = (hasLang ? lines.slice(1) : lines).join("\n");

          return (
            <div key={idx} className="code-block-container">
              {lang && <div className="code-lang-tag">{lang}</div>}
              <pre className="code-block">
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Inline formatting for non-code block segments
        const paragraphs = part.split(/\n\n+/);
        return (
          <React.Fragment key={idx}>
            {paragraphs.map((p, pIdx) => {
              const lines = p.split("\n");
              return (
                <p key={pIdx} className="message-p">
                  {lines.map((line, lIdx) => {
                    const isListItem = line.trim().startsWith("- ") || line.trim().startsWith("* ");
                    const content = isListItem ? line.trim().slice(2) : line;

                    return (
                      <span key={lIdx} className={isListItem ? "list-item" : "inline-line"}>
                        {isListItem && <span className="bullet">• </span>}
                        {renderInlineFormatted(content)}
                        {lIdx < lines.length - 1 && !isListItem && <br />}
                      </span>
                    );
                  })}
                </p>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function renderInlineFormatted(text: string) {
  // Split on bold (**text**) and inline code (`code`)
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, i) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      return <code key={i} className="inline-code">{token.slice(1, -1)}</code>;
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return <strong key={i} className="bold-text">{token.slice(2, -2)}</strong>;
    }
    return token;
  });
}

function ToolResultView({ toolType, data }: { toolType: string; data: any }) {
  const [open, setOpen] = useState(false);

  // Search Knowledge tool
  if (toolType.includes("search") || data?.source?.includes("Search")) {
    const query = data?.query || data?.input?.query;
    return (
      <div className="tool-card search-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">🔍</span>
          <div className="tool-summary">
            <strong>Knowledge Search:</strong> <em>"{query || "query"}"</em>
          </div>
          <span className="tool-status-pill success">RAG Retrieved</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data.results || data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // Payment Draft tool
  if (toolType.includes("Payment") || data?.status === "awaiting_confirmation" || data?.action) {
    const amount = data?.amount || data?.input?.amount;
    const currency = data?.currency || data?.input?.currency || "USD";
    const customer = data?.customer || data?.input?.customer;
    const action = data?.action || data?.input?.action || "transaction";

    return (
      <div className="tool-card payment-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">💳</span>
          <div className="tool-summary">
            <strong>Payment Intent ({action.toUpperCase()}):</strong> {amount ? `$${amount} ${currency}` : ""} for {customer || "customer"}
          </div>
          <span className="tool-status-pill warning">Awaiting Confirmation</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="payment-notice">
          🛡️ <strong>Safety Guarantee:</strong> No money has been moved. An explicit human authorization is required before execution.
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // Task Draft tool
  if (toolType.includes("Task") || data?.taskId || data?.status === "draft") {
    const title = data?.title || data?.input?.title;
    const priority = data?.priority || data?.input?.priority || "medium";
    const dueDate = data?.dueDate || data?.input?.dueDate;

    return (
      <div className="tool-card task-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">📋</span>
          <div className="tool-summary">
            <strong>Task Proposal:</strong> {title}
          </div>
          <span className={`tool-status-pill priority-${priority}`}>{priority.toUpperCase()}</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {dueDate && <div className="task-deadline">📅 Target: {dueDate}</div>}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // Memory Fact tool
  if (toolType.includes("remember") || toolType.includes("recall") || data?.key) {
    return (
      <div className="tool-card memory-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">🧠</span>
          <div className="tool-summary">
            <strong>Session Memory:</strong> <code>{data.key}</code> = "{data.value}"
          </div>
          <span className="tool-status-pill info">SQLite Stored</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // Generic tool fallback
  return (
    <details className="tool-call generic-tool">
      <summary>🔧 Tool Call: {toolType}</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

export function Chat({ user }: { user: User }) {
  const [tab, setTab] = useState<"chat" | "nlq" | "audit">("chat");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Agent connection
  const agent = useAgent({ agent: "SearchAgent", name: user.login });
  const { messages, sendMessage, status, clearHistory } = useAgentChat({ agent });

  const isBusy = status === "streaming" || status === "submitted";
  const statusLabel = isBusy ? "Thinking…" : status === "error" ? "Error" : "Ready";
  const statusDotClass = isBusy ? "streaming" : status === "error" ? "error" : "ready";

  // NLQ state
  const [nlqInput, setNlqInput] = useState("");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqResult, setNlqResult] = useState<any>(null);

  // Audit state
  const [auditEvents, setAuditEvents] = useState<AuditLogEvent[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Auto-scroll on new messages
  useEffect(() => {
    if (tab === "chat") {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, status, tab]);

  // Load audit and memory data when Audit tab is opened
  useEffect(() => {
    if (tab === "audit") {
      fetchAuditData();
    }
  }, [tab]);

  const fetchAuditData = async () => {
    setAuditLoading(true);
    try {
      const [auditResp, memResp] = await Promise.all([
        fetch("/api/audit?limit=30").then((r) => r.json() as Promise<{ events?: AuditLogEvent[] }>).catch(() => ({ events: [] })),
        fetch("/api/memory").then((r) => r.json() as Promise<{ memories?: MemoryItem[] }>).catch(() => ({ memories: [] })),
      ]);
      setAuditEvents(auditResp.events || []);
      setMemories(memResp.memories || []);
    } finally {
      setAuditLoading(false);
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isBusy) return;
    sendMessage({ text: input.trim() });
    setInput("");
  };

  const handleChipClick = (prompt: string) => {
    if (isBusy) return;
    sendMessage({ text: prompt });
  };

  const handleRunNLQ = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nlqInput.trim() || nlqLoading) return;
    setNlqLoading(true);
    setNlqResult(null);
    try {
      const resp = await fetch("/api/nlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: nlqInput.trim() }),
      });
      setNlqResult(await resp.json());
    } catch (err) {
      setNlqResult({ error: "Failed to connect to NLQ endpoint" });
    } finally {
      setNlqLoading(false);
    }
  };

  const handleClearChat = async (skipConfirm?: boolean | React.MouseEvent) => {
    const shouldSkip = skipConfirm === true;
    if (!shouldSkip && !confirm("Are you sure you want to clear this conversation history?")) return;
    try {
      await fetch("/api/clear", { method: "POST" });
      if (typeof clearHistory === "function") {
        clearHistory();
      }
    } catch {
      // Ignore
    }
  };

  const handleDeleteMemory = async (key: string) => {
    try {
      await fetch(`/api/memory?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.key !== key));
    } catch {
      // Ignore
    }
  };

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">🤖</div>
          <div className="brand-text">
            <h2>Multi-Agent Assistant</h2>
            <div className="agent-status-badge">
              <span className={`status-dot ${statusDotClass}`} />
              <span>{statusLabel}</span>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="tab-nav">
          <button
            className={`tab-btn ${tab === "chat" ? "active" : ""}`}
            onClick={() => setTab("chat")}
          >
            💬 Chat & Agents
          </button>
          <button
            className={`tab-btn ${tab === "nlq" ? "active" : ""}`}
            onClick={() => setTab("nlq")}
          >
            📊 Analytics (NLQ)
          </button>
          <button
            className={`tab-btn ${tab === "audit" ? "active" : ""}`}
            onClick={() => setTab("audit")}
          >
            🛡️ Inspector & Memory
          </button>
        </nav>

        {/* User Badge */}
        <div className="user-profile">
          <img src={user.avatar} alt={user.login} className="user-avatar" />
          <div className="user-meta">
            <span className="user-name">{user.name}</span>
            <span className="user-login">@{user.login}</span>
          </div>
          <a href="/auth/logout" className="logout-btn" title="Sign out">
            Logout
          </a>
        </div>
      </header>

      {/* Main Tab Content */}
      <main className="tab-viewport">
        {tab === "chat" && (
          <div className="chat-view">
            <div className="chat-action-bar">
              <span className="chat-subtitle">Stateful Durable Object SQLite Session</span>
              {messages.length > 0 && (
                <button className="clear-btn" onClick={handleClearChat} title="Clear conversation">
                  🗑️ Clear chat
                </button>
              )}
            </div>

            <div className="messages-stream">
              {messages.length === 0 ? (
                <div className="hero-welcome">
                  <div className="hero-icon">⚡</div>
                  <h3>Enterprise Multi-Agent Studio</h3>
                  <p>
                    Your prompt is analyzed by an <strong>LLM Judge</strong> router and orchestrated across specialized sub-agents with Cloudflare Workers AI and transactional SQLite persistence.
                  </p>
                  <div className="quick-chips">
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Search the knowledge base: What features are available in Cloudflare Workers AI?")}
                    >
                      🔍 Search Knowledge Base
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Draft a payment refund of $120.00 USD for customer Acme Logistics")}
                    >
                      💳 Prepare Payment Draft
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Draft a high-priority task: Complete SOC2 compliance review by next Monday")}
                    >
                      📋 Draft High-Priority Task
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Remember that our enterprise team prefers TypeScript and dark-mode designs")}
                    >
                      🧠 Store Session Fact
                    </button>
                  </div>
                </div>
              ) : (
                messages.map((msg: any) => {
                  const isUser = msg.role === "user";
                  const text = extractText(msg);

                  // Extract non-text parts (tool calls/results)
                  const toolParts = !isUser && Array.isArray(msg.parts)
                    ? msg.parts.filter((p: any) => p && p.type !== "text")
                    : [];

                  // Handle empty assistant message from failed stream
                  if (!isUser && !text && toolParts.length === 0) {
                    return (
                      <div key={msg.id || Math.random()} className="message-row assistant error-row">
                        <div className="message-avatar">
                          <span className="bot-avatar error">⚠️</span>
                        </div>
                        <div className="message-bubble error-bubble">
                          <div className="message-header">
                            <span className="author-name">Multi-Agent Orchestrator</span>
                            <span className="agent-tag error-tag">Turn Interrupted</span>
                          </div>
                          <p className="error-text">
                            A previous turn was interrupted before completing. Click{" "}
                            <button type="button" className="inline-clear-btn" onClick={() => handleClearChat(false)}>
                              Clear chat
                            </button>{" "}
                            to reset the session state.
                          </p>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={msg.id || Math.random()} className={`message-row ${msg.role}`}>
                      <div className="message-avatar">
                        {isUser ? (
                          <img src={user.avatar} alt="User" />
                        ) : (
                          <span className="bot-avatar">🤖</span>
                        )}
                      </div>
                      <div className="message-bubble">
                        <div className="message-header">
                          <span className="author-name">{isUser ? user.name : "Multi-Agent Orchestrator"}</span>
                          {isUser ? null : <span className="agent-tag">Workers AI</span>}
                        </div>

                        {text && <MarkdownContent text={text} />}

                        {toolParts.length > 0 && (
                          <div className="tool-results-list">
                            {toolParts.map((part: any, pIdx: number) => (
                              <ToolResultView
                                key={pIdx}
                                toolType={part.type || part.toolName || "tool"}
                                data={part.output ?? part.result ?? part.input ?? {}}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}

              {status === "streaming" && (
                <div className="message-row assistant">
                  <div className="message-avatar">
                    <span className="bot-avatar pulsing">🤖</span>
                  </div>
                  <div className="message-bubble streaming-bubble">
                    <div className="typing-indicator">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {status === "error" && (
              <div className="chat-error-banner">
                <span className="error-banner-icon">⚠️</span>
                <span className="error-banner-text">Agent connection or stream error. Try sending a message or reset session:</span>
                <button type="button" className="error-banner-btn" onClick={() => handleClearChat(true)}>
                  Reset & Clear History
                </button>
              </div>
            )}

            {/* Chat Input Bar */}
            <form className="chat-input-bar" onSubmit={handleSendChat}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={isBusy ? "Agent is processing response…" : "Ask a question, query knowledge base, draft a task, or save a memory…"}
                disabled={isBusy}
                autoFocus
              />
              <button
                type="submit"
                className="send-button"
                disabled={!input.trim() || isBusy}
              >
                {isBusy ? "Thinking…" : "Send ➔"}
              </button>
            </form>
          </div>
        )}

        {tab === "nlq" && (
          <div className="nlq-view">
            <div className="nlq-header">
              <h3>📊 Natural Language Message Analytics</h3>
              <p>
                Query your conversation transcript directly with natural language. The system converts your query into a read-only query plan executed securely over SQLite.
              </p>
            </div>

            <div className="nlq-presets">
              <span className="preset-label">Try asking:</span>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("How many total messages are in this conversation?")}
              >
                🔢 Count all messages
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("Find all assistant messages containing search results")}
              >
                🔍 Search for knowledge references
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("List all user questions asked")}
              >
                💬 List user questions
              </button>
            </div>

            <form className="chat-input-bar nlq-bar" onSubmit={handleRunNLQ}>
              <input
                type="text"
                value={nlqInput}
                onChange={(e) => setNlqInput(e.target.value)}
                placeholder="e.g. Count messages or search topics discussed…"
                disabled={nlqLoading}
              />
              <button
                type="submit"
                className="send-button"
                disabled={!nlqInput.trim() || nlqLoading}
              >
                {nlqLoading ? "Analyzing…" : "Run Query"}
              </button>
            </form>

            {nlqResult && (
              <div className="nlq-results-card">
                {nlqResult.plan && (
                  <div className="plan-badge-group">
                    <span className="plan-badge">Operation: <strong>{nlqResult.plan.operation}</strong></span>
                    {nlqResult.plan.terms && <span className="plan-badge">Terms: <strong>"{nlqResult.plan.terms}"</strong></span>}
                    <span className="plan-badge">Role: <strong>{nlqResult.plan.role}</strong></span>
                    <span className="plan-badge count-badge">Matched: <strong>{nlqResult.count}</strong></span>
                  </div>
                )}

                {nlqResult.rows && nlqResult.rows.length > 0 ? (
                  <div className="results-table-container">
                    <table className="results-table">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Agent</th>
                          <th>Content</th>
                          <th>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nlqResult.rows.map((row: any, i: number) => (
                          <tr key={i}>
                            <td><span className={`role-pill ${row.role}`}>{row.role || (row.count !== undefined ? "count" : "")}</span></td>
                            <td>{row.agent || "—"}</td>
                            <td className="content-cell">{row.content || (row.count !== undefined ? `Count: ${row.count}` : JSON.stringify(row))}</td>
                            <td className="timestamp-cell">{row.created_at ? new Date(row.created_at).toLocaleTimeString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-results">No conversation records matched the query criteria.</div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "audit" && (
          <div className="audit-view">
            <div className="audit-header">
              <div>
                <h3>🛡️ System Audit & Memory Vault</h3>
                <p>Live observability stream into router decisions, sub-agent executions, LLM Judge evaluations, and SQLite memory state.</p>
              </div>
              <button className="refresh-btn" onClick={fetchAuditData} disabled={auditLoading}>
                {auditLoading ? "Refreshing…" : "🔄 Refresh Data"}
              </button>
            </div>

            <div className="audit-grid">
              {/* Memory Vault Panel */}
              <div className="audit-panel memory-panel">
                <div className="panel-title">
                  <span>🧠 Persistent Memory Vault</span>
                  <span className="badge-count">{memories.length} facts</span>
                </div>
                <div className="memory-list">
                  {memories.length === 0 ? (
                    <div className="empty-notice">No memories saved yet. Try asking the assistant to "Remember that..."</div>
                  ) : (
                    memories.map((m) => (
                      <div key={m.key} className="memory-card-item">
                        <div className="mem-header">
                          <span className="mem-key">🔑 {m.key}</span>
                          <button
                            className="delete-mem-btn"
                            onClick={() => handleDeleteMemory(m.key)}
                            title="Delete memory"
                          >
                            ×
                          </button>
                        </div>
                        <div className="mem-value">{m.value}</div>
                        <div className="mem-date">{new Date(m.updatedAt).toLocaleString()}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Audit Events Panel */}
              <div className="audit-panel events-panel">
                <div className="panel-title">
                  <span>📋 Real-time Event Log</span>
                  <span className="badge-count">{auditEvents.length} events</span>
                </div>
                <div className="events-stream">
                  {auditEvents.length === 0 ? (
                    <div className="empty-notice">No audit events logged yet.</div>
                  ) : (
                    auditEvents.map((e) => (
                      <div key={e.id} className="event-item">
                        <div className="event-header">
                          <span className={`event-agent-tag ${e.agent}`}>{e.agent.toUpperCase()}</span>
                          <span className="event-type">{e.type}</span>
                          <span className="event-time">{new Date(e.created_at).toLocaleTimeString()}</span>
                        </div>
                        <pre className="event-payload">{JSON.stringify(e.payload, null, 2)}</pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
