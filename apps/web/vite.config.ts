import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite SPA for the CompanyOS web app. The Node BFF (src/server/serve.ts) serves
// the built assets in `dist/` and handles /api/* in production; in dev, Vite
// proxies /api to the BFF running on :3001.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3001" }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
