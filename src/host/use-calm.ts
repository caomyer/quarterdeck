import { useCallback, useEffect, useRef, useState } from "react";

import type { CalmRead, HostAdapter, HostRuntimeState } from "./types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * This home's Calm choice, read and set only through firstmate's own command (`src-tauri/src/calm.rs`), so one switch
 * governs every surface of the home. It is read again when the first mate starts and when the window regains focus,
 * so a `/calm` in a terminal on the same home shows up without a restart. Only the newest read answers.
 */
export function useCalm(adapter: HostAdapter, home: string | null, runtime: HostRuntimeState) {
  const [calm, setCalm] = useState<CalmRead | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  const read = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const answer = await adapter.calmGet();
      if (mine === asked.current) setCalm(answer);
    } catch (problem) {
      if (mine === asked.current) setCalm({ available: false, on: false, problem: errorText(problem) });
    }
  }, [adapter]);

  useEffect(() => {
    if (!home) return;
    void read();
  }, [home, read]);

  useEffect(() => {
    if (runtime === "starting") void read();
  }, [runtime, read]);

  useEffect(() => {
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [read]);

  /** Sets Calm. The chat changes only once the command kept the choice; a refusal leaves it as it was, with why. */
  const setOn = useCallback(async (on: boolean) => {
    const mine = ++asked.current;
    setSaving(true);
    setError(null);
    try {
      const answer = await adapter.calmSet(on);
      if (mine === asked.current) setCalm(answer);
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setSaving(false);
    }
  }, [adapter]);

  return { calm, saving, error, setOn, dismissError: useCallback(() => setError(null), []) };
}
