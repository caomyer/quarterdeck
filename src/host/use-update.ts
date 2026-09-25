import { useCallback, useEffect, useState } from "react";

import { updateFeed } from "../update";
import type { AppUpdate, HostAdapter } from "./types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The app's own update: read when the window opens, then kept by the backend's events. The backend decides when to
 * look, download and install; the window only shows it and passes on what the captain asks, looking now among them.
 */
export function useUpdate(adapter: HostAdapter) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [feed] = useState(() => updateFeed(setUpdate));

  useEffect(() => {
    let live = true;
    const stop = adapter.onUpdate((next) => live && feed.event(next));
    feed.reply(() => adapter.updateStatus()).catch(() => {});
    return () => {
      live = false;
      stop();
    };
  }, [adapter, feed]);

  const act = useCallback(async (ask: () => Promise<AppUpdate>) => {
    setProblem(null);
    try {
      await feed.reply(ask);
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [feed]);

  return {
    update,
    problem,
    check: useCallback(() => act(() => adapter.updateCheck()), [act, adapter]),
    restart: useCallback(() => act(() => adapter.updateRestart()), [act, adapter]),
    cancel: useCallback(() => act(() => adapter.updateCancel()), [act, adapter]),
    seen: useCallback(() => act(() => adapter.updateSeen()), [act, adapter]),
  };
}
