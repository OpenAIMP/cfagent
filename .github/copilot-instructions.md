# cfagent instructions

AI Search Agent / E*TRADE trading app (Cloudflare Worker + Durable Objects + React client). Not `cfpay`, which is a separate repo.

## Commands
- PowerShell blocks `npm.ps1`; use `npm.cmd`.
- `npm.cmd run typecheck`, `npm.cmd test` (vitest), `npm.cmd run dev` (vite).
- `core.autocrlf` is on; keep CRLF in `wrangler.jsonc` to avoid spurious diffs.

## NLQ flow
`src/agents/nlq.ts` plans a query, then `nlqOptionsStrategy.ts` (and others) return `{ summary, rows }`. Rows are rendered by several views: `client/ETradeTradingHub.tsx`, `client/OptionsResearchPanel.tsx`, `client/Chat.tsx`. When adding or changing a row shape (especially nested arrays/objects), update every renderer that displays NLQ rows.

## Payments
x402 and MPP services live in `src/services/agenticPayments.ts` (legacy, Cloudflare `withX402`). Verified-payment logic lives in the separate `cfpay` repo.

## Delivery policy

All work in this repo follows `docs/agents/gitops.md` (issues may proceed in parallel on separate branches; each issue follows issue → PR → merge → post-merge verification). Put your agent hashtag in every issue and PR you create (the `## Agent` field in the gitops §5/§9 templates).
