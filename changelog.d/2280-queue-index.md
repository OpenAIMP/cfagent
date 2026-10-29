### Fixed

- Durable Objects rows-read exhaustion (#2280): create seek indexes for the framework alarm queue (`cf_agents_jobs`) from `OrchestratorAgent.onStart` so each alarm seeks instead of scanning the queue.
