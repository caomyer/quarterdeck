import { useEffect, useState } from "react";

/** Resets and ages count down on screen: a panel reads the clock on every render, and renders at least this often. */
export function useNow(every = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return Date.now();
}
