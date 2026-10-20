import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // mppx/server is node-only (imports node:util) and is only ever loaded
      // lazily inside server-side MPP payment flows (see
      // src/services/agenticPayments.ts). Keep it out of the browser bundle;
      // the worker build (wrangler/esbuild) ignores this config and bundles
      // it normally. (Issue #290: the trading boundary index is imported by
      // client code, which would otherwise drag mppx into the client graph.)
      // The mppx root is external for the same reason: Credential.fromRequest
      // is loaded lazily from it in the same flows (issue #700).
      external: ["mppx/server", "mppx"],
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  // @ts-expect-error vitest configuration options
  test: {
    testTimeout: 25000,
    hookTimeout: 25000,
    // `src/server.ts` exports Durable Object classes, so importing the Worker
    // under Node resolves `cloudflare:workers` — a scheme the ESM loader cannot
    // load. The stub only provides the base class; tests never instantiate one.
    alias: {
      "cloudflare:workers": new URL("./tests/stubs/cloudflareWorkers.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@cloudflare/think": new URL("./tests/stubs/cloudflareThink.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    },
  },
});
