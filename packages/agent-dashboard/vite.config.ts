import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": "http://localhost:3100",
      "/conversations": "http://localhost:3100",
      "/messages": "http://localhost:3100",
    },
  },
});
