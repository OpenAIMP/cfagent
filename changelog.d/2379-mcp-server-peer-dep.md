### Fixed

- Add `@modelcontextprotocol/server` 2.4.0 as a direct dependency: agents 0.32.0 peer-depends on it, and its absence broke the production deploy (Deploy #1459: wrangler could not resolve the import).
- Upgrade `@cloudflare/think` 0.19.0 to 0.23.0: think 0.19.0 imports the removed `SkillRegistry` from `agents/skills`, which agents 0.32.0 replaced with the Workspace-skills API; the local wrangler bundle failed on it after the server peer was added. Think 0.23.0 uses the new API. Fixes #2379.
