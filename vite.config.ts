import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
});
