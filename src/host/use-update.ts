import { useCallback, useEffect, useState } from "react";

import type { AppUpdate, HostAdapter } from "./types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The app's own update: read when the window opens, then kept by the backend's events. The backend decides when to
 * look, download and install; the window only shows it and passes on what the captain asks.
 */
export function useUpdate(adapter: HostAdapter) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const stop = adapter.onUpdate((next) => live && setUpdate(next));
    adapter.updateStatus().then((next) => live && setUpdate(next)).catch(() => {});
    return () => {
      live = false;
      stop();
    };
  }, [adapter]);

  const act = useCallback(async (ask: () => Promise<AppUpdate>) => {
    setProblem(null);
    try {
      setUpdate(await ask());
    } catch (error) {
      setProblem(errorText(error));
    }
  }, []);

  return {
    update,
    problem,
    restart: useCallback(() => act(() => adapter.updateRestart()), [act, adapter]),
    cancel: useCallback(() => act(() => adapter.updateCancel()), [act, adapter]),
    seen: useCallback(() => act(() => adapter.updateSeen()), [act, adapter]),
  };
}
