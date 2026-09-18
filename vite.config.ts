import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The browser mock's review pages (`?artifacts`) are served as-is by the dev server and never bundled
 * into the app. The app's own scheme appends src-tauri/src/review-frame.js to every page it serves, so
 * the dev server appends the same file rather than a copy of it, and commenting behaves the same here.
 */
const PAGES = fileURLToPath(new URL("./src/fixtures/review-pages", import.meta.url));

function reviewPages(): Plugin {
  return {
    name: "quarterdeck-review-pages",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        if (!path.startsWith("/artifacts/") || !path.endsWith(".html")) return next();
        let page: string;
        try {
          // Only the fixtures: an encoded ".." must not walk out to any other page on disk.
          const file = resolve(PAGES, `.${decodeURIComponent(path)}`);
          if (!file.startsWith(PAGES + sep)) return next();
          page = readFileSync(file, "utf8");
        } catch {
          return next();
        }
        const script = readFileSync(new URL("./src-tauri/src/review-frame.js", import.meta.url), "utf8");
        const at = page.lastIndexOf("</body>");
        const injected = `\n<script data-quarterdeck-review>\n${script}\n</script>\n`;
        const body = at === -1 ? page + injected : page.slice(0, at) + injected + page.slice(at);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(body);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), reviewPages()],
  publicDir: command === "serve" ? "src/fixtures/review-pages" : false,
}));
