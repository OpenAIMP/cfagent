# AI Search Agent — Cloudflare Agents SDK

A stateful AI agent built with the Cloudflare Agents SDK that searches your AI Search knowledge base using tool calling, with streaming responses and persistent conversation memory.

## What's different from the chat proxy

| Feature | Chat proxy (existing) | This Agent (new) |
|---|---|---|
| SDK | None — plain Worker | Cloudflare Agents SDK (`agents` + `@cloudflare/ai-chat`) |
| State | Stateless — no memory | Persistent — conversations stored in SQLite, survive restarts |
| Streaming | No — waits for full response | Yes — tokens stream in real-time via WebSocket |
| Tool use | No — AI Search does RAG internally | Yes — agent calls `search()` as a tool, decides when to search |
| Model | AI Search's built-in model | Workers AI (`llama-3.3-70b`) — no API keys needed |
| Architecture | Worker → proxy | Durable Object (Agent) + React client + WebSocket |

## Architecture

```
Browser (React) → WebSocket → SearchAgent (Durable Object)
                              ├─ Workers AI (llama-3.3-70b) for generation
                              ├─ AI Search /search as a tool
                              └─ SQLite for conversation persistence
```

## Setup

### 1. Create a new GitHub repo

```bash
git clone <command-from-card>
cd ai-search-agent
git remote set-url origin https://github.com/OpenAIMP/<new-repo-name>.git
git push -u origin main
```

### 2. Add GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions**:

| Secret Name | Value |
|---|---|
| `CF_API_TOKEN` | Create at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → "Edit Cloudflare Workers" template + Zone Workers Routes Edit + DNS Edit |
| `CF_ACCOUNT_ID` | `1e7e9bb45eca8d59ec86bbd6dac9b900` |
| `GH_CLIENT_ID` | From your GitHub OAuth App |
| `GH_CLIENT_SECRET` | From your GitHub OAuth App |
| `APP_BASE_URL` | `https://ai-search-agent.openaimp.workers.dev` |
| `SESSION_SECRET` | `openssl rand -hex 32` |

### 3. Create a GitHub OAuth App

Go to [github.com/settings/applications/new](https://github.com/settings/applications/new):
- **Homepage URL**: `https://ai-search-agent.openaimp.workers.dev`
- **Callback URL**: `https://ai-search-agent.openaimp.workers.dev/auth/callback`

### 4. Auto-deploy

Every push to `main` triggers:
1. `npm install` + `vite build` (React frontend)
2. Create/find KV namespace (`AGENT_SESSIONS`)
3. `wrangler deploy` (Worker + Durable Object + assets)
4. Set all secrets

## Local Development

```bash
npm install
npm run dev    # Vite dev server for frontend
# In another terminal:
npx wrangler dev  # Worker + Agent
```

Create a `.dev.vars` file:
```
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
APP_BASE_URL=http://localhost:8787
SESSION_SECRET=your_random_secret_string
```

## File Structure

```
ai-search-agent/
├── .github/workflows/
│   ├── ci.yml              # Type check on PRs
│   └── deploy.yml          # Build + deploy on push to main
├── src/
│   ├── server.ts           # Agent class + Worker entry point
│   ├── oauth.ts            # GitHub OAuth
│   ├── session.ts          # KV session management
│   ├── types.ts            # TypeScript interfaces
│   └── client/
│       ├── main.tsx        # React entry point
│       ├── Chat.tsx        # Chat UI with useAgentChat
│       └── styles.css      # Dark theme styles
├── index.html              # Vite HTML entry
├── vite.config.ts          # Vite + React config
├── wrangler.jsonc          # Worker + Durable Object + AI binding config
├── package.json
├── tsconfig.json
└── README.md
```

## How the Agent works

1. User sends a message via WebSocket
2. `SearchAgent.onChatMessage()` is called
3. Workers AI (`llama-3.3-70b`) processes the message with tool calling
4. If the model decides to search, it calls the `search` tool
5. The tool fetches from your AI Search `/search` endpoint
6. Results are fed back to the model
7. The model generates a final answer, streamed token-by-token
8. Conversation is persisted in SQLite — survives restarts

## Key dependencies

- `agents` — Cloudflare Agents SDK (Durable Objects, WebSocket, state)
- `@cloudflare/ai-chat` — `AIChatAgent` class with message persistence + streaming
- `ai` — Vercel AI SDK for tool calling + streaming
- `workers-ai-provider` — Workers AI model provider for the AI SDK
- `@ai-sdk/react` — React hooks for AI chat
- `zod` — Schema validation for tool parameters
