import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"

/**
 * The bundle is served by the gateway itself under `/admin/`, so every asset URL
 * is emitted with that prefix. Routing is hash-based, so the prefix can change
 * without touching the client.
 */
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  // shadcn writes `@/…` imports; tsconfig declares the alias for the type checker,
  // but Vite needs its own resolution map or Rollup cannot find the modules.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
})
