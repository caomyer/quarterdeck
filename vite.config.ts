import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // The browser mock's review pages (`?artifacts`) are served as-is by the dev server and never bundled into the app.
  publicDir: command === "serve" ? "src/fixtures/review-pages" : false,
}));
