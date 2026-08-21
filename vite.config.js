import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  appType: "mpa", // disable SPA fallback — missing assets should 404
                   // cleanly instead of re-serving index.html, which
                   // inside an <iframe> caused the infinite recursion
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
