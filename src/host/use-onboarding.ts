import { useCallback, useEffect, useState } from "react";

import { foldInstall, type InstallView } from "../agents";
import type { AgentId, HostAdapter, OnboardingStatus } from "./types";

/**
 * The agents on this Mac, and the captain's ways through what is missing: install, sign in, choose which one runs the
 * first mate. Read again whenever the home changes and after anything that could change the answer; never polled.
 */
export function useOnboarding(adapter: HostAdapter, home: string | null) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [checking, setChecking] = useState(false);
  /** Why reading the agents, or something the captain asked for, did not work. */
  const [problem, setProblem] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Partial<Record<AgentId, InstallView>>>({});
  /** Agents whose sign-in is open in Terminal, waiting for the captain to come back. */
  const [signingIn, setSigningIn] = useState<Partial<Record<AgentId, boolean | "still-out">>>({});
  /** A first mate said its first words in this home while the window was open. */
  const [greetedNow, setGreetedNow] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await adapter.onboardingStatus();
      setStatus(next);
      setProblem(null);
      return next;
    } catch (error) {
      setProblem(String(error));
      return null;
    } finally {
      setChecking(false);
    }
  }, [adapter]);

  /** Whether this home has met its first mate, known at once; the agents are read only when it has not. */
  const [greetedAtOpen, setGreetedAtOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let current = true;
    setStatus(null);
    setGreetedNow(false);
    setGreetedAtOpen(null);
    if (!home) return;
    adapter.onboardingGreeted().then((greeted) => {
      if (!current) return;
      setGreetedAtOpen(greeted);
      if (!greeted) void check();
    }, (error) => {
      // Unreadable is not new: nobody is held on a welcome the app cannot justify.
      if (current) { setGreetedAtOpen(true); setProblem(String(error)); }
    });
    return () => { current = false; };
  }, [adapter, home, check]);

  useEffect(() => adapter.onInstall((event) => {
    setInstalls((current) => ({ ...current, [event.harness]: foldInstall(current[event.harness] ?? null, event) }));
  }), [adapter]);

  useEffect(() => adapter.subscribe((event) => {
    if (event.type === "greeted") setGreetedNow(true);
  }), [adapter]);

  const install = useCallback(async (agent: AgentId) => {
    setInstalls((current) => ({ ...current, [agent]: undefined }));
    try {
      await adapter.agentInstall(agent);
      // Done: the agent's row says so from the fresh reading below.
      setInstalls((current) => ({ ...current, [agent]: undefined }));
    } catch (error) {
      // The failed step already says why; a refusal before any step started is said here.
      setInstalls((current) => current[agent] ? current : { ...current, [agent]: { step: 0, steps: 0, title: "", command: "", line: null, lines: [], state: "failed", error: String(error) } });
    }
    await check();
  }, [adapter, check]);

  const signIn = useCallback(async (agent: AgentId) => {
    try {
      await adapter.agentSignIn(agent);
      setSigningIn((current) => ({ ...current, [agent]: true }));
    } catch (error) {
      setProblem(`Terminal could not be opened for the sign-in: ${String(error)}`);
    }
  }, [adapter]);

  /** "I've signed in": read the agent's own status again. Still signed out, the row says so. */
  const confirmSignIn = useCallback(async (agent: AgentId) => {
    const next = await check();
    const now = next?.agents.find((candidate) => candidate.id === agent);
    setSigningIn((current) => ({ ...current, [agent]: now?.signedIn === "signed-out" ? "still-out" : false }));
  }, [check]);

  const chooseFirstMate = useCallback(async (agent: AgentId) => {
    setChoosing(true);
    try {
      await adapter.firstMateSet(agent);
    } catch (error) {
      setProblem(String(error));
    } finally {
      setChoosing(false);
    }
    await check();
  }, [adapter, check]);

  return {
    status,
    checking,
    problem,
    installs,
    signingIn,
    choosing,
    /** `null` until the home has been read. */
    greeted: greetedNow ? true : greetedAtOpen,
    check,
    install,
    signIn,
    confirmSignIn,
    chooseFirstMate,
  };
}
