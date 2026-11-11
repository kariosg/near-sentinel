import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8080", "/health": "http://127.0.0.1:8080", "/ready": "http://127.0.0.1:8080", "/docs": "http://127.0.0.1:8080" } },
  build: { outDir: "dist", sourcemap: false },
});
