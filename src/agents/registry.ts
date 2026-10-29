/**
 * Agent Mesh G0 fleet registry (issue #2322, programme #2225).
 *
 * A code-derived, drift-pinned inventory of the mesh: agent classes,
 * their A2A surfaces, channels, tool families, doors, and workflows.
 * This module is a CHECKED PROJECTION, not a source of truth — the
 * facts live in wrangler.jsonc (bindings), src/a2a/ (cards and
 * resolutions), src/mcp/ (the command catalog), and the class
 * declarations under src/. tests/mesh_registry_s1_2322.test.ts pins
 * every section below against those sources; if a source moves, the
 * pin fails and this file is updated in the same PR (gitops §7).
 *
 * Vocabulary follows docs/architecture/agentic/doors-and-layers.md:
 * an A2A card is a SURFACE of its owning agent class, not an agent
 * (mesh survey contradiction 9); a channel is an ingress a person or
 * external system starts from; a door is an invocation surface with
 * its own enforcement point.
 *
 * Consumers: later mesh slices — the S4 conformance-matrix doc and
 * the S20 Agents view — read the typed accessors at the bottom.
 * Nothing at runtime depends on this module in this slice; it makes
 * no decisions and changes no behavior.
 */

export type MeshAgentKind = "agent" | "durable-object" | "mcp-agent";

export interface MeshAgentEntry {
  className: string;
  kind: MeshAgentKind;
  /** Declared base class the drift pin verifies in source. */
  base: "PortThink" | "DurableObject" | "McpAgent";
  /** wrangler.jsonc durable_objects binding names for this class. */
  bindings: string[];
  sourceFile: string;
  role: string;
  notes?: string;
}

export interface MeshSurfaceEntry {
  /** A2A surface name (card name / dispatch name). */
  name: string;
  /** The agent class that owns this surface. */
  ownerClass: string;
  /** Published in AGENT_CARDS (src/a2a/agent-cards.ts). */
  card: boolean;
  /** Reachable through A2A_RESOLUTIONS (src/a2a/resolution.ts). */
  dispatch: boolean;
}

export interface MeshChannelEntry {
  id: "web-chat" | "slack" | "email" | "voice" | "webhook";
  name: string;
  /** Where the channel enters the Worker. */
  ingress: string;
  /** What the channel terminates at. */
  terminatesAt: string;
  /** Survey §7 posture vocabulary. */
  posture: "FORWARDER" | "MIXED";
  notes?: string;
}

export interface MeshCommandSource {
  file: string;
  kind: "readonly-name" | "deprecated-alias";
}

export type MeshToolFamilyStatus = "live" | "degraded" | "absent";

export interface MeshToolFamilyEntry {
  id: string;
  name: string;
  /** Defining module or owning surface. */
  source: string;
  status: MeshToolFamilyStatus;
  /**
   * McpToolFactory command names this family accounts for. Only the
   * seven factory-module families carry commands; every factory tool
   * is accounted for by exactly one family (pinned).
   */
  commands: string[];
  /** Where the test reads this family's command-name literals. */
  commandSources?: MeshCommandSource[];
  /** Non-factory tool sets (the MAS family) list their tool names. */
  toolNames?: string[];
  notes?: string;
}

export interface MeshDoorEntry {
  id: "chat-turn" | "http-routes" | "mcp" | "a2a" | "agent-as-a-tool";
  name: string;
  entryPoint: string;
  /** The door's own enforcement point. */
  gate: string;
}

export interface MeshWorkflowEntry {
  className: string;
  /** wrangler.jsonc workflows binding name. */
  binding: string;
  sourceFile: string;
  /** Who starts the workflow (modules/callers). */
  starters: string[];
  role: string;
}

export interface MeshNonRenameEntry {
  names: string[];
  decision: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Agents — every Durable Object class behind a wrangler DO binding.
// ---------------------------------------------------------------------------

export const MESH_AGENTS: MeshAgentEntry[] = [
  {
    className: "OrchestratorAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SEARCH_AGENT", "ORCHESTRATOR_AGENT"],
    sourceFile: "src/agents/orchestrator.ts",
    role: "Primary conversational agent: chat turns, the MAS tool surface, NLQ and goal/chain execution; owns the mas_* SQL ledger the fleet reads from.",
    notes:
      "Exported from src/server.ts both as OrchestratorAgent and under the legacy alias SearchAgent (the SEARCH_AGENT binding's class_name). Service and A2A addressing uses the shared orchestrator instance.",
  },
  {
    className: "ResearchAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["RESEARCH_AGENT"],
    sourceFile: "src/agents/research-agent.ts",
    role: "Deep-research runs: discovery, source gathering, synthesis, optional publication.",
  },
  {
    className: "TradingAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["TRADING_AGENT"],
    sourceFile: "src/agents/trading-agent.ts",
    role: "E*TRADE trading agent: quotes, previews, and the human approval door; starts TradingTradeWorkflow for approved executions.",
    notes:
      "Chat reaches the proposal side through the G1 door (#2349, src/agents/orchestrator/meshDoors.ts), addressed to the acting user's own instance (trading:<login>): trade proposals via the preview-only stock_trading/options_trading services plus the accounts/positions/quote reads. The approval door (executeApprovedOrder/startTradeApproval/decideTradeApproval) has no chat caller by design — S9/G4 wires the workflow run behind it.",
  },
  {
    className: "PaymentsAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["PAYMENTS_AGENT"],
    sourceFile: "src/agents/payments-agent.ts",
    role: "Payments agent: DID-attested drafts and x402/MPP premium legs over the payments ledger.",
    notes:
      "Chat reaches budgetCheck + the read side (todaySpent/listPayments) through the G1 door (#2341, src/agents/orchestrator/meshDoors.ts), checks attributed to AGENTIC_SPEND_AGENT_ID; processPaidRequest has no chat caller by design — the chat paid-request flow is S10/G5 (PaymentWorkflow).",
  },
  {
    className: "ScreenerAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SCREENER_AGENT"],
    sourceFile: "src/agents/screener-agent.ts",
    role: "Screening execution agent: stock and options screens; hosts ScreenerScreenWorkflow steps.",
  },
  {
    className: "ScheduledAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SCHEDULED_AGENT"],
    sourceFile: "src/agents/scheduled-agent.ts",
    role: "Schedule catalogue and synthesized schedules/goals; singleton instance \"default\"; fires screens, research, and QA runs.",
    notes:
      "Chat reaches the goal catalogue through the G1 door (#2341, src/agents/orchestrator/meshDoors.ts): list/inspect + trigger, acting identity required. Add/remove/enable stay on the session-gated /api/schedule/* routes.",
  },
  {
    className: "ReportAssetAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["REPORT_ASSET_AGENT"],
    sourceFile: "src/agents/report-asset-agent.ts",
    role: "Report asset storage and serving; blobs in R2 (REPORTS_BUCKET) when bound, metadata in DO storage.",
    notes:
      "Chat reaches the user's assets through the G1 door (#2349, src/agents/orchestrator/meshDoors.ts), addressed to the acting user's own instance (assets:<login>): list (listAssets metadata) + get, replacing the turn's indirect reach through the report pipeline. Generation stays with the pipeline/A2A callers.",
  },
  {
    className: "BrowserAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["BROWSER_AGENT"],
    sourceFile: "src/agents/browserAgent.ts",
    role: "Browser fetch, inspect, and screenshot over the Browser Rendering binding (BROWSER, declared in wrangler.jsonc).",
  },
  {
    className: "SlackAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SLACK_AGENT"],
    sourceFile: "src/agents/slackAgent.ts",
    role: "Slack app agent: slash commands, events, interactions, approval buttons.",
    notes:
      "Production Slack ingress currently arrives via the src/server.ts forwarder routes; the agent's own gated ingress is a parallel implementation (channel posture MIXED; G10 completes it in a later slice).",
  },
  {
    className: "AiSearchAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["AI_SEARCH_AGENT"],
    sourceFile: "src/agents/aiSearchAgent.ts",
    role: "AI Search agent (#2223): three-path search — Cloudflare AI Search namespace binding, the shared instance's MCP endpoint, REST fallback (src/agents/aiSearchPaths.ts).",
    notes:
      "Landed after the mesh survey base (migration v12). The ai_search_namespaces binding is NOT declared in wrangler.jsonc — its namespace value is dashboard-issued (see src/types.ts) — so the namespace path is config-gated and degrades honestly to the other two paths.",
  },
  {
    className: "TickerAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["TICKER_AGENT"],
    sourceFile: "src/agents/ticker-agent.ts",
    role: "Public market-quotes tape: one shared instance (\"ticker\") broadcasting quote ticks over WebSocket (#2230).",
    notes: "Landed after the mesh survey base (migration v11). Not routed through routeAgentRequest; no A2A surface.",
  },
  {
    className: "SandboxAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SANDBOX_AGENT"],
    sourceFile: "src/agents/sandbox-agent.ts",
    role: "Sandbox command agent (#2253): delegates execution to ETradeSandboxService.",
    notes:
      "Landed after the mesh survey base (migration v13). No container backend is configured, so runs honestly return executed:false; an A2A surface for this class is a recorded follow-up, not part of this slice.",
  },
  {
    className: "SessionStore",
    kind: "durable-object",
    base: "DurableObject",
    bindings: ["SESSION_STORE"],
    sourceFile: "src/security/sessionStore.ts",
    role: "Session, identity, and broker-token store: app sessions, OAuth tokens, channel identity mappings. A plain Durable Object, not an agent.",
  },
  {
    className: "OptionsScannerMCP",
    kind: "mcp-agent",
    base: "McpAgent",
    bindings: ["OPTIONS_SCANNER_MCP"],
    sourceFile: "src/services/cloudflareWalletsScanner.ts",
    role: "Paid options-scanner MCP server (x402).",
    notes: "Registered for binding completeness; OUT of mesh scope per #2225 (no changes to this class in the programme).",
  },
];

// ---------------------------------------------------------------------------
// A2A surfaces — names an A2A caller can address, each owned by a class.
// ---------------------------------------------------------------------------

export const MESH_SURFACES: MeshSurfaceEntry[] = [
  { name: "orchestrator", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  { name: "search", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  { name: "tasks", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  { name: "memory", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  // Dispatch-only surface: resolvable via A2A_RESOLUTIONS but no card
  // is published for it in AGENT_CARDS.
  { name: "nlq", ownerClass: "OrchestratorAgent", card: false, dispatch: true },
  { name: "payments", ownerClass: "PaymentsAgent", card: true, dispatch: true },
  { name: "trading", ownerClass: "TradingAgent", card: true, dispatch: true },
  { name: "aisearch", ownerClass: "AiSearchAgent", card: true, dispatch: true },
  { name: "screener", ownerClass: "ScreenerAgent", card: true, dispatch: true },
  { name: "scheduled", ownerClass: "ScheduledAgent", card: true, dispatch: true },
  { name: "research", ownerClass: "ResearchAgent", card: true, dispatch: true },
  { name: "report-asset", ownerClass: "ReportAssetAgent", card: true, dispatch: true },
  { name: "browser", ownerClass: "BrowserAgent", card: true, dispatch: true },
  { name: "slack", ownerClass: "SlackAgent", card: true, dispatch: true },
];

// ---------------------------------------------------------------------------
// Channels — ingresses a person or external system starts from (§7).
// ---------------------------------------------------------------------------

export const MESH_CHANNELS: MeshChannelEntry[] = [
  {
    id: "web-chat",
    name: "Web chat (SPA)",
    ingress: "Agents SDK routing (routeAgentRequest) in src/server.ts",
    terminatesAt: "OrchestratorAgent (per-login instance)",
    posture: "FORWARDER",
  },
  {
    id: "slack",
    name: "Slack",
    ingress: "POST /slack and /slack/events routes in src/server.ts",
    terminatesAt: "OrchestratorAgent (per-team orchestrator instances; approvals via the shared approval engine)",
    posture: "MIXED",
    notes:
      "SlackAgent's own gated ingress (src/agents/slackAgent.ts) is a parallel implementation the production routes bypass; completing the channel is G10, a later slice.",
  },
  {
    id: "email",
    name: "Email",
    ingress: "Worker email() handler in src/server.ts",
    terminatesAt: "OrchestratorAgent (sender-mapped login instance)",
    posture: "FORWARDER",
    notes: "Trading actions over email are identity-hardened (#1262): sender-to-login mapping plus signed approval links.",
  },
  {
    id: "voice",
    name: "Voice",
    ingress: "/voice/trade WebSocket and /api/trading/voice/* routes in src/server.ts",
    terminatesAt: "OrchestratorAgent (per-login instance, via the voice turn forwarder)",
    posture: "FORWARDER",
  },
  {
    id: "webhook",
    name: "Webhooks (payments + trading)",
    ingress: "Webhook routes in src/server.ts (payment gateway callbacks, trading report webhooks)",
    terminatesAt: "OrchestratorAgent (draft-owner instance, addressed via the webhook receiver identity)",
    posture: "FORWARDER",
  },
];

// ---------------------------------------------------------------------------
// Tool families — survey §8's fifteen, plus the three families the
// #2225 reference-set update added (web_search, web_fetch, AI Search
// platform), plus the mesh-door family the G1 slices add (#2341).
// The McpToolFactory module families carry the catalog's command
// names; the rest describe their surface in notes.
// ---------------------------------------------------------------------------

export const MESH_TOOL_FAMILIES: MeshToolFamilyEntry[] = [
  {
    id: "core-mcp-commands",
    name: "Core MCP commands",
    source: "src/mcp/commands.ts",
    status: "live",
    commands: [
      "knowledge_search",
      "query_platform_knowledge",
      "draft_payment",
      "confirm_payment_draft",
      "get_payment_gateways",
      "get_transactions",
      "execute_nlq",
      "get_async_job",
      "list_async_jobs",
      "list_database_tables",
      "query_table_data",
      "manage_categories",
      "manage_referrals",
      "manage_external_ads",
      "get_revenue_summary",
      "manage_session_memory",
      "get_audit_events",
    ],
    commandSources: [{ file: "src/mcp/commands.ts", kind: "readonly-name" }],
  },
  {
    id: "cloudflare-agent-mcp-commands",
    name: "Cloudflare-agent MCP commands",
    source: "src/mcp/cloudflareAgentCommands.ts",
    status: "live",
    commands: [
      "browser_inspect_page",
      "browser_screenshot",
      "dispatch_trading_webhook",
      "run_sandbox_command",
      "run_quant_backtest",
      "think_trade_validation",
      "ai_search_financial_docs",
      "execute_durable_twap",
      "ai_search_agent_search",
    ],
    commandSources: [{ file: "src/mcp/cloudflareAgentCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "etrade-mcp-commands",
    name: "E*TRADE MCP commands",
    source: "src/mcp/etradeCommands.ts",
    status: "live",
    commands: [
      "etrade_market_scan",
      "etrade_get_quote",
      "etrade_preview_order",
      "etrade_execute_order",
      "etrade_get_positions",
      "etrade_auth_status",
      "etrade_account_discovery",
    ],
    commandSources: [{ file: "src/mcp/etradeCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "agentic-payment-mcp-commands",
    name: "Agentic-payment MCP commands",
    source: "src/mcp/agenticPaymentCommands.ts",
    status: "live",
    commands: ["paid_options_screener", "paid_market_research", "agentic_wallet_status"],
    commandSources: [{ file: "src/mcp/agenticPaymentCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "goal-chain-mcp-commands",
    name: "Goal/chain MCP commands",
    source: "src/mcp/goalChainCommands.ts",
    status: "live",
    commands: ["goal.compile", "goal.schedule", "chain.run"],
    commandSources: [{ file: "src/mcp/goalChainCommands.ts", kind: "readonly-name" }],
    notes: "chain.run reports unimplemented in the MCP context; the server-route binding is the recorded follow-up.",
  },
  {
    id: "market-data-mcp-commands",
    name: "Market-data MCP commands",
    source: "src/mcp/marketDataCommands.ts",
    status: "live",
    commands: [
      "market_data_get_quote",
      "market_data_company_fundamentals",
      "market_data_historical_bars",
      "market_data_research",
      "alpaca_snapshot",
      "alpaca_account",
      "alpaca_positions",
      "alpaca_orders",
      "alpaca_place_order",
      "foss_get_quote",
      "foss_company_fundamentals",
      "foss_historical_bars",
      "foss_market_research",
      "foss_alpaca_snapshot",
      "foss_alpaca_account",
      "foss_alpaca_positions",
      "foss_alpaca_orders",
      "foss_alpaca_place_order",
    ],
    commandSources: [
      { file: "src/mcp/marketDataCommands.ts", kind: "readonly-name" },
      { file: "src/mcp/commands.ts", kind: "deprecated-alias" },
    ],
    notes:
      "The foss_* names are deprecated aliases (#1906) wrapping the canonical commands; each foss_* alias is superseded by the canonical market_data_*/alpaca_* name for the same command. Alias removal is a follow-up slice.",
  },
  {
    id: "agentdb-read-mcp-commands",
    name: "AgentDB read MCP commands",
    source: "src/mcp/agentDbReadCommands.ts",
    status: "live",
    commands: [
      "agentdb.chain.status",
      "agentdb.jobs.history",
      "agentdb.audit.history",
      "agentdb.reports.list",
    ],
    commandSources: [{ file: "src/mcp/agentDbReadCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "mesh-door-mcp-commands",
    name: "Mesh door MCP commands (G1)",
    source: "src/mcp/meshDoorCommands.ts",
    status: "live",
    commands: [
      "list_scheduled_goals",
      "trigger_scheduled_goal",
      "check_payment_budget",
      "get_payments_overview",
      "propose_stock_trade",
      "propose_options_trade",
      "get_trading_accounts",
      "get_trading_positions",
      "get_trading_quote",
      "list_report_assets",
      "get_report_asset",
    ],
    commandSources: [{ file: "src/mcp/meshDoorCommands.ts", kind: "readonly-name" }],
    notes:
      "G1 outbound doors, batch A (#2341) + batch B (#2349): the chat turn reaches ScheduledAgent, PaymentsAgent, TradingAgent, and ReportAssetAgent through the typed doors in src/agents/orchestrator/meshDoors.ts. The commands require the turn's acting identity (the context actingLogin carrier) and fail closed without one, so they serve the chat door; external MCP callers use the A2A doors for these agents. The TradingAgent door exposes proposals (preview only) and reads — never the approval door; later G1 batches extend this family.",
  },
  {
    id: "mas-tools",
    name: "MAS tools",
    source: "src/agents/mas.ts (createMAS)",
    status: "live",
    commands: [],
    toolNames: [
      "searchKnowledge",
      "draftPayment",
      "createTaskDraft",
      "confirmDraft",
      "rememberFact",
      "recallFacts",
    ],
    notes:
      "AI-SDK tool set, not McpToolFactory-registered. The production route caller is POST /search/mas (src/agents/routes/searchHub.ts), which invokes searchKnowledge; the same set serves the orchestrator turn.",
  },
  {
    id: "remote-mcp-servers",
    name: "Remotely consumed MCP servers",
    source: "src/services/mcpClient.ts (RemoteMcpClient)",
    status: "live",
    commands: [],
    notes:
      "Outbound MCP consumption: AiSearchAgent's instance-MCP path (src/agents/aiSearchPaths.ts) and the payment strategies call remote MCP servers through RemoteMcpClient.",
  },
  {
    id: "sandbox-tools",
    name: "Sandbox execution",
    source: "src/agents/sandbox-agent.ts + ETradeSandboxService",
    status: "degraded",
    commands: [],
    notes:
      "No container backend is configured: runs return executed:false (honest degradation). The run_sandbox_command MCP command lives in the cloudflare-agent-mcp-commands family.",
  },
  {
    id: "browser-tools",
    name: "Browser tools",
    source: "src/agents/browserAgent.ts + Browser Rendering binding BROWSER",
    status: "live",
    commands: [],
    notes:
      "The BROWSER binding is declared in wrangler.jsonc (#2253); the survey-era finding 'no Browser Rendering binding in deployed config' is superseded on current main. The browser_* MCP commands live in the cloudflare-agent-mcp-commands family.",
  },
  {
    id: "ai-search-service",
    name: "AI Search service (REST path)",
    source: "src/services/aiSearch.ts (ETradeAISearchService)",
    status: "live",
    commands: [],
    notes:
      "Direct REST search over the AI Search instance; backs the ai_search_financial_docs MCP command and AiSearchAgent's fallback path.",
  },
  {
    id: "payments-tools",
    name: "Payments tools and services",
    source: "src/services/payments.ts + src/agents/payments-agent.ts",
    status: "live",
    commands: [],
    notes:
      "Draft/confirm/gateway/transaction MCP commands live in the core-mcp-commands family; paid legs live in the agentic-payment-mcp-commands family.",
  },
  {
    id: "screening-research-services",
    name: "Screening and research services",
    source: "src/agents/screener-agent.ts + src/agents/research-agent.ts + src/trading/",
    status: "live",
    commands: [],
    notes: "The deterministic screening/research engines the agents and workflows execute; not a command surface of their own.",
  },
  {
    id: "durable-fibers",
    name: "Durable fibers",
    source: "src/services/durableFibers.ts",
    status: "degraded",
    commands: [],
    notes:
      "Home-grown fiber helper: in-memory registry, checkpoints written but never read — NOT durable across eviction (survey §3). Moved from src/agents/durableFibers.ts since the survey base. The execute_durable_twap command lives in the cloudflare-agent-mcp-commands family.",
  },
  {
    id: "web-search",
    name: "Web search (reference-set family)",
    source: "no defining module on main",
    status: "absent",
    commands: [],
    notes:
      "Named by the #2225 reference-set update as a G11 inventory family. No web_search tool exists in src/ on current main (verified by source scan for #2322); recorded as an honest gap for a later slice.",
  },
  {
    id: "web-fetch",
    name: "Web fetch (reference-set family)",
    source: "no defining module on main",
    status: "absent",
    commands: [],
    notes:
      "No standalone web_fetch tool exists on current main; BrowserAgent (browser-tools family) is the current fetch surface. Recorded as an inventory gap.",
  },
  {
    id: "ai-search-platform",
    name: "AI Search platform (namespace binding path)",
    source: "src/agents/aiSearchAgent.ts + src/agents/aiSearchPaths.ts",
    status: "degraded",
    commands: [],
    notes:
      "Cloudflare AI Search through the ai_search_namespaces binding: the binding is not declared in wrangler.jsonc (dashboard-issued namespace value), so the primary path is config-gated off and AiSearchAgent degrades to its MCP and REST paths.",
  },
];

// ---------------------------------------------------------------------------
// Doors — the five invocation surfaces (doors-and-layers §2), each
// with its own enforcement point. Channel ingresses are separate
// (MESH_CHANNELS); schedules are triggers, not doors.
// ---------------------------------------------------------------------------

export const MESH_DOORS: MeshDoorEntry[] = [
  {
    id: "chat-turn",
    name: "Chat turn",
    entryPoint:
      "src/server.ts routeAgentRequest -> OrchestratorAgent turn; turn tools assembled by src/agents/mcpAdapter.ts (createAgentMcpTools over the MCP command registry)",
    gate: "Session auth at connect; MCP permission scopes (#1744) enforced at the agent-turn adapter.",
  },
  {
    id: "http-routes",
    name: "HTTP routes",
    entryPoint: "src/server.ts routeRequest + src/agents/routes/*",
    gate: "Per-route session/API authentication.",
  },
  {
    id: "mcp",
    name: "MCP (external protocol surface)",
    entryPoint: "src/mcp/index.ts MCP server over the McpToolFactory catalog (src/mcp/commands.ts)",
    gate: "MCP permission scopes (#1744) at the MCP factory/adapter — a separate enforcement point from the chat turn's in-process tool calls over the same registry.",
  },
  {
    id: "a2a",
    name: "A2A",
    entryPoint: "src/a2a/index.ts handleA2A (cards: src/a2a/agent-cards.ts; resolution: src/a2a/resolution.ts)",
    gate: "A2A_API_TOKEN bearer at the edge, fail-closed (503 when unconfigured); per-agent dispatch modules under src/agents/.",
  },
  {
    id: "agent-as-a-tool",
    name: "Agent-as-a-tool",
    entryPoint:
      "Agents SDK runAgentTool (src/agents/orchestrator.ts; e.g. ResearchAgent via src/agents/orchestrator/researchPublish.ts)",
    gate: "Runs inside the parent turn's identity and instance boundary.",
  },
];

// ---------------------------------------------------------------------------
// Workflows — the three ThinkWorkflow classes and their starters.
// ---------------------------------------------------------------------------

export const MESH_WORKFLOWS: MeshWorkflowEntry[] = [
  {
    className: "ScreenerScreenWorkflow",
    binding: "SCREENER_WORKFLOW",
    sourceFile: "src/workflows/screenerWorkflow.ts",
    starters: [
      "OrchestratorAgent submission paths (chat/HTTP) via src/services/goalScreenWorkflowSubmission.ts",
      "ScheduledAgent scheduled runs via src/services/scheduledTasks.ts",
    ],
    role: "Durable staged screen execution: feed -> gather -> analysis -> store -> deliver, with qualified partials.",
  },
  {
    className: "TradingTradeWorkflow",
    binding: "TRADE_WORKFLOW",
    sourceFile: "src/agents/trading-trade-workflow.ts",
    starters: ["TradingAgent (SDK runWorkflow, after the approval door)"],
    role: "Approved trade execution with durable approval waits.",
  },
  {
    className: "PaymentWorkflow",
    binding: "PAYMENT_WORKFLOW",
    sourceFile: "src/workflows/paymentWorkflow.ts",
    starters: [
      "src/services/paymentWorkflowSubmission.ts seam (paid screen submissions from routes; scheduled runs via src/services/scheduledTasks.ts)",
    ],
    role: "Per-run-request payment gate for paid screens: testnet, feature-flagged, default OFF; one charge per run-request, failure compensates with a replacement-run credit, never a cash refund.",
  },
];

// ---------------------------------------------------------------------------
// Recorded non-renames (survey §5) — collisions that are documented,
// not resolved by renaming.
// ---------------------------------------------------------------------------

export const MESH_NON_RENAMES: MeshNonRenameEntry[] = [
  {
    names: ["SearchAgent", "SearchHub", "SearchAgentTab"],
    decision:
      "Recorded non-rename: SearchHub and SearchAgentTab (src/client/search/) are UI names for the /search/agent REST surface — a different thing from the SearchAgent Durable Object class (the orchestrator's export alias). Neither side is renamed for the other.",
    source: "mesh survey §5",
  },
  {
    names: ["SearchAgent", "OrchestratorAgent"],
    decision:
      "Retained in this slice: SearchAgent remains the export alias of OrchestratorAgent in src/server.ts (the SEARCH_AGENT binding's class_name). The G0 class rename is slice S2, gated on the preview-deploy proof for the rename collision (OrchestratorAgent is already a registered class, migration v9).",
    source: "mesh survey §5",
  },
];

// ---------------------------------------------------------------------------
// Typed accessors — the queryable shape later slices consume.
// ---------------------------------------------------------------------------

export const MESH_REGISTRY = {
  agents: MESH_AGENTS,
  surfaces: MESH_SURFACES,
  channels: MESH_CHANNELS,
  toolFamilies: MESH_TOOL_FAMILIES,
  doors: MESH_DOORS,
  workflows: MESH_WORKFLOWS,
  nonRenames: MESH_NON_RENAMES,
} as const;

export function getAgentByClass(className: string): MeshAgentEntry | undefined {
  return MESH_AGENTS.find((a) => a.className === className);
}

export function getAgentByBinding(binding: string): MeshAgentEntry | undefined {
  return MESH_AGENTS.find((a) => a.bindings.includes(binding));
}

export function getSurface(name: string): MeshSurfaceEntry | undefined {
  return MESH_SURFACES.find((s) => s.name === name);
}

export function surfacesForClass(className: string): MeshSurfaceEntry[] {
  return MESH_SURFACES.filter((s) => s.ownerClass === className);
}

export function getChannel(id: MeshChannelEntry["id"]): MeshChannelEntry | undefined {
  return MESH_CHANNELS.find((c) => c.id === id);
}

export function getToolFamily(id: string): MeshToolFamilyEntry | undefined {
  return MESH_TOOL_FAMILIES.find((f) => f.id === id);
}

/** Map of every McpToolFactory command name to the family that owns it. */
export function mcpCommandOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const family of MESH_TOOL_FAMILIES) {
    for (const command of family.commands) owners.set(command, family.id);
  }
  return owners;
}

export function getDoor(id: MeshDoorEntry["id"]): MeshDoorEntry | undefined {
  return MESH_DOORS.find((d) => d.id === id);
}

export function getWorkflowByBinding(binding: string): MeshWorkflowEntry | undefined {
  return MESH_WORKFLOWS.find((w) => w.binding === binding);
}
