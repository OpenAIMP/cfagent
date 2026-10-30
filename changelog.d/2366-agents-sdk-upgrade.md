### Changed

- Cloudflare Agents SDK upgraded from 0.24.0 to 0.32.0 (OpenAIMP/cfagent#2366), with `@modelcontextprotocol/sdk` co-upgraded from 1.30.0 to 1.32.2 to satisfy the new SDK's peer requirement. The framework scheduler statements and `cf_agents_jobs` table shape are unchanged in 0.32.0, so the slice-1 queue seek indexes still apply; the SDK still ships no index on `cf_agents_jobs`.
