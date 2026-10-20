import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": "http://127.0.0.1:3400", "/ws": { target: "ws://127.0.0.1:3400", ws: true } },
  },
});
