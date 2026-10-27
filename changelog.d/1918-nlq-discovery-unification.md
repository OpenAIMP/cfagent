### NLQ discovery unification (#1918)

- Unified NLQ's two discovery actions into one: `options_discovery` is removed and its phrase family ("discover setups", "find setups") now routes to the surviving `options_fit_discovery` action's scope leg; fit phrasing keeps the kernel fit leg. One intent-schema action, one dispatch branch, no phrase family lost, no silent fallback.

#CDO-mha7
