import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useState } from "react";

interface User {
  login: string;
  name: string;
  avatar: string;
}

export function Chat({ user }: { user: User }) {
  const [input, setInput] = useState("");
  const agent = useAgent({
    agent: "SearchAgent",
    name: user.login,
  });

  const { messages, sendMessage, status } = useAgentChat({
    agent,
  });

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
            {msg.role === "user" && <div className="msg-content">{msg.parts?.map((p: any) => p.type === "text" ? p.text : "").join("")}</div>}
            {msg.role === "assistant" && (
              <div className="msg-content">
                {msg.parts?.map((p: any, i: number) => {
                  if (p.type === "text") return <span key={i}>{p.text}</span>;
                  if (p.type === "tool-search") return (
                    <details key={i} className="tool-call">
                      <summary>🔍 Searched: "{p.input?.query || p.args?.query}"</summary>
                      <pre>{JSON.stringify(p.output || p.result, null, 2)}</pre>
                    </details>
                  );
                  if (p.type === "tool-call") return (
                    <details key={i} className="tool-call">
                      <summary>🔍 Searched: "{p.input?.query || p.args?.query}"</summary>
                      <pre>{JSON.stringify(p.output || p.result, null, 2)}</pre>
                    </details>
                  );
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
          disabled={status !== "ready" && status !== "streaming"}
        />
        <button type="submit" disabled={!input.trim() || (status !== "ready" && status !== "streaming")}>
          Send
        </button>
      </form>
    </div>
  );
}
