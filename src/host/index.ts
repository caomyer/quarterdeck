import { MockHostAdapter } from "./mock";
import { TauriHostAdapter } from "./tauri";
import type { HostAdapter } from "@quarterdeck/core/types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function createHostAdapter(): HostAdapter {
  return window.__TAURI_INTERNALS__ ? new TauriHostAdapter() : new MockHostAdapter();
}

export type * from "@quarterdeck/core/types";
export { artifactPath } from "@quarterdeck/core/types";
