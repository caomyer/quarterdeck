import { useCallback, useEffect, useRef, useState } from "react";

import type { HostAdapter, QuotaRead } from "./types";

/** Plan limits move over hours and days, so a read every few minutes keeps them honest without hammering quota-axi. */
export const QUOTA_EVERY_MS = 5 * 60_000;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every provider's plan limits, from quota-axi: read when the window opens, every few minutes while it shows, again
 * when it comes back into view after that, and whenever the captain asks. Only the newest read may answer, so a slow
 * one cannot overwrite a newer one.
 */
export function useQuota(adapter: HostAdapter) {
  const [read, setRead] = useState<QuotaRead | null>(null);
  const [reading, setReading] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const asked = useRef(0);
  const lastRead = useRef(0);

  const answer = useCallback(async (ask: () => Promise<QuotaRead>) => {
    const mine = ++asked.current;
    setReading(true);
    try {
      const next = await ask();
      if (mine === asked.current) setRead(next);
    } catch (error) {
      // The backend answers failures itself; this is the call not reaching it at all.
      if (mine === asked.current) setRead((current) => ({ providers: current?.providers ?? null, read_at_ms: current?.read_at_ms ?? null, error: errorText(error), missing: false }));
    } finally {
      lastRead.current = Date.now();
      if (mine === asked.current) setReading(false);
    }
  }, []);

  const refresh = useCallback(() => answer(() => adapter.readQuota()), [adapter, answer]);

  /** Only ever because the captain pressed the button: macOS then asks them to allow it. */
  const allowKeychain = useCallback(async () => {
    setAllowing(true);
    try {
      await answer(() => adapter.allowQuotaKeychain());
    } finally {
      setAllowing(false);
    }
  }, [adapter, answer]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, QUOTA_EVERY_MS);
    const onShow = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRead.current >= QUOTA_EVERY_MS) void refresh();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refresh]);

  return { read, reading, allowing, refresh, allowKeychain };
}
