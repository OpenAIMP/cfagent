import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useState } from "react";

interface User {
  login: string;
  name: string;
  avatar: string;
}

// --- Normalize tool-call query from various AI SDK payload shapes ---
function getToolQuery(part: any): string {
  const value =
    part.input?.query ??
    part.args?.query ??
    part.toolCall?.args?.query ??
    part.input ??
    part.args;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed.query ?? value;
    } catch {
      return value;
    }
  }

  return value?.query ?? "";
}

function getToolOutput(part: any): any {
  return part.output ?? part.result ?? null;
}

export function Chat({ user }: { user: User }) {
  const [input, setInput] = useState("");
  const agent = useAgent({
    agent: "SearchAgent",
    name: user.login,
  });

  const { messages, sendMessage, status } = useAgentChat({ agent });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || status !== "ready") return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="app">
      <header>
        <h1>🤖 AI Search Agent</h1>
        <div className="user-info">
          <img src={user.avatar} alt={user.login} />
          <span>{user.name}</span>
          <a href="/auth/logout" className="logout">Logout</a>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <h2>Ask me anything</h2>
            <p>I'll search your AI Search knowledge base and generate an answer with streaming responses.</p>
          </div>
        )}
        {messages.map((msg: any) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            {msg.role === "user" && (
              <div className="msg-content">
                {typeof msg.content === "string"
                  ? msg.content
                  : msg.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") || ""}
              </div>
            )}
            {msg.role === "assistant" && (
              <div className="msg-content">
                {typeof msg.content === "string"
                  ? msg.content
                  : msg.parts?.map((p: any, i: number) => {
                      if (p.type === "text") return <span key={i}>{p.text}</span>;
                      if (p.type === "tool-search" || p.type === "tool-call" || p.type === "tool-result") {
                        const query = getToolQuery(p);
                        const output = getToolOutput(p);
                        const label = query || "query unavailable";
                        return (
                          <details key={i} className="tool-call">
                            <summary>🔍 Searched: "{label}"</summary>
                            <pre>{JSON.stringify(output, null, 2)}</pre>
                          </details>
                        );
                      }
                      return null;
                    })}
              </div>
            )}
          </div>
        ))}
        {status === "streaming" && <div className="typing">Thinking...</div>}
      </div>

      <form className="input-area" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your question..."
          disabled={status !== "ready"}
        />
        <button type="submit" disabled={!input.trim() || status !== "ready"}>
          Send
        </button>
      </form>
    </div>
  );
}
