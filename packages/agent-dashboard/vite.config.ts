import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": "http://localhost:3000",
      "/agents": "http://localhost:3000",
      "/conversations": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
