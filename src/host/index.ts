import { MockHostAdapter } from "./mock";
import { TauriHostAdapter } from "./tauri";
import type { HostAdapter } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function createHostAdapter(): HostAdapter {
  return window.__TAURI_INTERNALS__ ? new TauriHostAdapter() : new MockHostAdapter();
}

export type * from "./types";
export { artifactPath } from "./types";
