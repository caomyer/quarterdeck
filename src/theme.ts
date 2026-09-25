import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Keeps the window's own appearance on the app's theme, which is the `dark` class on the root
 * (set before first paint by index.html and by the theme toggle), not the Mac's setting.
 *
 * An artifact page is a separate document in a sandboxed frame, and pages style their dark
 * scheme with `prefers-color-scheme`, which no class or `color-scheme` on the frame can reach
 * in WebKit. The window's appearance does: WebKit answers that query in every frame from it,
 * and re-evaluates it live, so every revision already presented follows the app, unchanged.
 * The title bar follows too, so the window never shows one theme around another.
 */
export function followAppTheme() {
  if (!window.__TAURI_INTERNALS__) return;
  const root = document.documentElement;
  let applied: boolean | null = null;
  const apply = () => {
    const dark = root.classList.contains("dark");
    if (dark === applied) return;
    applied = dark;
    getCurrentWindow().setTheme(dark ? "dark" : "light").catch((error) => {
      // The app still draws its own theme; only framed pages and the title bar keep the Mac's.
      console.warn("could not set the window theme", error);
    });
  };
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["class"] });
}
