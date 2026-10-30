// Issue #2348 (#1976 step-0 residual) — DEDICATED vitest config
// for the workerd transaction-primitive proof suite.
//
// This config is used ONLY by `npm run test:workers`. The default
// suite (`npm test`, vite.config.ts) is untouched and does not
// pick up the workers suite: its files live under tests/workers/
// and carry a .workers.ts suffix, which the default include
// pattern does not match. The workers suite runs inside workerd
// (via @cloudflare/vitest-plugin + Miniflare) against a test-only
// worker (tests/workers/proof-worker.ts) declaring one proof
// Durable Object and one local D1 database
// (tests/workers/wrangler.test.jsonc).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workers/wrangler.test.jsonc" },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.workers.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
