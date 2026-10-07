import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1000,
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
  },
});
