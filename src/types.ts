export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SESSIONS: KVNamespace;
  KV: KVNamespace;
  SEARCH_AGENT: DurableObjectNamespace;
  PAYMENTS_AGENT: DurableObjectNamespace;
  TASKS_AGENT: DurableObjectNamespace;
  MEMORY_AGENT: DurableObjectNamespace;
  AI_SEARCH_ENDPOINT: string;
  APP_NAME: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_BASE_URL: string;
  SESSION_SECRET: string;
  MAS_MAX_STEPS?: string;
}

export interface SessionData {
  githubLogin: string;
  githubAvatar: string;
  githubName: string;
  createdAt: number;
}

export type AgentName = "search" | "payments" | "tasks" | "general";

export interface AuditEvent {
  requestId: string;
  sessionId: string;
  type: string;
  agent: AgentName | "judge" | "nlq";
  payload: Record<string, unknown>;
  createdAt: string;
}
