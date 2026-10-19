import { useCallback, useEffect, useRef, useState } from "react";

import type { HomeStatus, HostAdapter, HostEvent, Needed, PickedCategory, SnapshotEvent } from "@quarterdeck/core/types";
import {
  COMPACT_COMMAND,
  type Conversation,
  emptyConversation,
  type FoldContext,
  foldCompactionAsked,
  foldCompactionDismissed,
  foldControls,
  foldEvent,
  foldHostState,
  foldNewHome,
  foldNoteSent,
  foldPermission,
  foldPermissionGone,
  foldResent,
  foldSend,
  foldSnapshot,
  foldStartError,
  NOT_STARTED_HERE,
  type PermissionView,
} from "@quarterdeck/core/conversation";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useHost(adapter: HostAdapter) {
  const [home, setHome] = useState<string | null>(null);
  const [homeChecked, setHomeChecked] = useState(false);
  const [homeProblem, setHomeProblem] = useState<string | null>(null);
  const [choosingHome, setChoosingHome] = useState(false);
  /** False while the app's own home is in use, so the app can offer it back. */
  const [homeChosen, setHomeChosen] = useState(false);
  /** What the first mate says this machine still needs, and whether it is being asked. */
  const [needs, setNeeds] = useState<Needed[]>([]);
  const [needsProblem, setNeedsProblem] = useState<string | null>(null);
  const [checkingTools, setCheckingTools] = useState(false);
  /** The conversation and what the host says around it, folded by the core's rules. */
  const [conversation, setConversation] = useState<Conversation>(emptyConversation);
  /** The same, as of the last event: the next fold can't wait for a render. */
  const folded = useRef(conversation);
  const homeRef = useRef<string | null>(null);
  /** The captain pressed Stop, so a Start it cuts short isn't an error. */
  const stopRequested = useRef(false);
  /** The first mate was left running in the saved home when the app last closed, and hasn't been started again yet. */
  const startOnLaunch = useRef(false);

  const foldContext = useCallback((): FoldContext => ({ now: Date.now(), newId: () => crypto.randomUUID(), home: homeRef.current }), []);

  const fold = useCallback((step: (current: Conversation) => Conversation) => {
    const next = step(folded.current);
    if (next === folded.current) return;
    folded.current = next;
    setConversation(next);
  }, []);

  const applySnapshot = useCallback((payload: SnapshotEvent) => {
    fold((current) => foldSnapshot(current, payload, foldContext()));
  }, [fold, foldContext]);

  const receive = useCallback((event: HostEvent) => {
    fold((current) => foldEvent(current, event, foldContext()));
  }, [fold, foldContext]);

  useEffect(() => {
    let active = true;
    const unsubscribe = adapter.subscribe(receive);
    void adapter.getHome().then((status) => {
      if (!active) return;
      homeRef.current = status.home;
      startOnLaunch.current = status.home !== null && status.startOnLaunch === true;
      setHome(status.home);
      setHomeProblem(status.problem);
      setHomeChosen(status.chosen === true);
      setHomeChecked(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setHomeProblem(`Couldn't read the saved firstmate folder: ${errorText(error)}`);
      setHomeChecked(true);
    });
    void adapter.getState().then((initial) => {
      if (!active) return;
      fold((current) => foldHostState(current, initial, foldContext()));
    }).catch(() => { /* state events still arrive */ });
    // Separate from the host state: this waits for a read in progress, which can take a while.
    void adapter.latestSnapshot().then((latest) => {
      if (active && latest) applySnapshot(latest);
    }).catch(() => { /* snapshot events still arrive */ });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [adapter, receive, applySnapshot, fold, foldContext]);

  const send = useCallback(async (text: string) => {
    let sent: { id: string } | { error: string };
    try {
      if (!homeRef.current || folded.current.hostHome !== homeRef.current) throw new Error(NOT_STARTED_HERE);
      sent = { id: await adapter.send(text) };
    } catch (error) {
      sent = { error: errorText(error) };
    }
    const { conversation: next, id } = foldSend(folded.current, text, sent, foldContext());
    fold(() => next);
    return id;
  }, [adapter, fold, foldContext]);

  /**
   * Records a message the app sent through another path, such as a review, so the conversation shows it.
   * Idempotent: the host's own outbox event for the same id adds nothing twice.
   */
  const noteSent = useCallback((id: string, text: string) => {
    fold((current) => foldNoteSent(current, id, text, foldContext()));
  }, [fold, foldContext]);

  /** Sends a message that didn't go through again, as a new message, once: the old one stops offering it. */
  const resend = useCallback(async (id: string, text: string) => {
    fold((current) => foldResent(current, id));
    return send(text);
  }, [fold, send]);

  /**
   * Compacts the first mate's conversation, only ever because the captain confirmed it. It goes the way a message
   * does, so it waits for a turn that is running, and it survives a restart the way a message does.
   */
  const compactNow = useCallback(async () => {
    const id = await send(COMPACT_COMMAND);
    fold((current) => foldCompactionAsked(current, id));
  }, [fold, send]);
  const dismissCompaction = useCallback(() => fold(foldCompactionDismissed), [fold]);

  const start = useCallback(async () => {
    // The ref, not state: Start can follow a folder choice before a render.
    const target = homeRef.current;
    if (!target) return;
    fold((current) => foldStartError(current, null));
    stopRequested.current = false;
    try {
      await adapter.hostStart(target);
    } catch (error) {
      if (!stopRequested.current) fold((current) => foldStartError(current, errorText(error)));
    }
  }, [adapter, fold]);
  // A first mate the captain left running comes back with the app. Only once the window is listening, so the
  // earlier conversation the start sends reaches it, and only if nothing started it meanwhile, such as a window
  // reloaded while the app kept running.
  useEffect(() => {
    if (!homeChecked || !startOnLaunch.current) return;
    startOnLaunch.current = false;
    void adapter.getState().then((current) => {
      if (current.state.state === "stopped" && folded.current.runtime.state === "stopped") void start();
    }, () => { /* the captain can still press Start */ });
  }, [homeChecked, adapter, start]);

  const stop = useCallback(async () => {
    stopRequested.current = true;
    try { await adapter.hostStop(); } catch { /* host state remains authoritative */ }
  }, [adapter]);
  const restart = useCallback(async () => {
    // A restart resumes the host's last home; after choosing a different folder, start there instead.
    if (folded.current.hostHome !== homeRef.current) return start();
    try { await adapter.hostRestart(); } catch { /* host state remains authoritative */ }
  }, [adapter, start]);
  const cancel = useCallback(async () => { try { await adapter.cancelTurn(); } catch { /* not exposed until the backend enables it */ } }, [adapter]);
  const paneCapture = useCallback((taskId: string) => adapter.paneCapture(taskId), [adapter]);
  const refreshSnapshot = useCallback(async () => { try { await adapter.refreshSnapshot(); } catch { /* the next snapshot event reports failures */ } }, [adapter]);

  /** Takes up a home the backend reported, clearing what belonged to the last one. */
  const adoptHome = useCallback((status: HomeStatus): string | null => {
    setHomeProblem(status.problem);
    setHomeChosen(status.chosen === true);
    if (!status.home || status.home === homeRef.current) return status.home;
    homeRef.current = status.home;
    setHome(status.home);
    fold(foldNewHome);
    return status.home;
  }, [fold]);

  /** Resolves to the chosen home when the captain picked a valid folder, `null` otherwise. */
  const chooseHome = useCallback(async (): Promise<string | null> => {
    setChoosingHome(true);
    let status;
    try {
      status = await adapter.chooseHome();
    } catch (error) {
      setHomeProblem(errorText(error));
      return null;
    } finally {
      setChoosingHome(false);
    }
    if (!status) return null;
    return adoptHome(status);
  }, [adapter, adoptHome]);

  /** Asks the first mate what this machine is missing. Reads only.
   *
   * The answer that arrives last is not the answer to the question asked last:
   * a home changed twice, or a retry over a slow check, and an older answer
   * would overwrite a newer one and unlock the button while it was still
   * waiting. Only the newest question is allowed to answer. */
  const asked = useRef(0);
  const checkTools = useCallback(async () => {
    const mine = ++asked.current;
    setCheckingTools(true);
    try {
      const answer = await adapter.toolsMissing();
      if (mine !== asked.current) return;
      setNeeds(answer.missing);
      setNeedsProblem(answer.problem);
    } catch (error) {
      if (mine !== asked.current) return;
      setNeeds([]);
      setNeedsProblem(errorText(error));
    } finally {
      if (mine === asked.current) setCheckingTools(false);
    }
  }, [adapter]);

  // Once the home is known, and again whenever it changes: a different home can
  // want different tools, and the answer is about this machine, not this window.
  useEffect(() => {
    if (!home) return;
    void checkTools();
  }, [home, checkTools]);

  /** Gives the app's own home back, forgetting a folder the captain chose. */
  const useAppHome = useCallback(async (): Promise<string | null> => {
    setChoosingHome(true);
    try {
      return adoptHome(await adapter.useAppHome());
    } catch (error) {
      setHomeProblem(errorText(error));
      return null;
    } finally {
      setChoosingHome(false);
    }
  }, [adapter, adoptHome]);

  /**
   * Changes the session's model or effort. The pill shows the new value only once the adapter confirms it: the answer
   * carries the session's controls, and a refusal rejects with the adapter's reason for the pill to show.
   */
  const setOption = useCallback(async (category: PickedCategory, value: string) => {
    const confirmed = await adapter.setSessionOption(category, value);
    fold((current) => foldControls(current, confirmed));
    return confirmed;
  }, [adapter, fold]);

  const answerPermission = useCallback(async (id: string, optionId: string) => {
    const patch = (change: Partial<PermissionView>) => fold((current) => foldPermission(current, id, change));
    patch({ answering: true, error: undefined });
    try {
      await adapter.answerPermission(id, optionId);
    } catch (error) {
      // The request may be gone already, for example after the host restarted the adapter; only keep the card if it still waits.
      const waiting = await adapter.getState().then((state) => state.permissionRequests?.some((request) => request.id === id), () => true);
      if (waiting) patch({ answering: false, error: errorText(error) });
      else fold((current) => foldPermissionGone(current, id));
    }
  }, [adapter, fold]);

  return {
    runtime: conversation.runtime,
    home,
    homeChecked,
    homeProblem,
    choosingHome,
    /** Messages go to the chosen home only once the first mate has started there. */
    sendReady: home !== null && conversation.hostHome === home,
    bearings: conversation.bearings,
    fleet: conversation.fleet,
    projects: conversation.projects,
    snapshotHealth: conversation.snapshotHealth,
    refreshing: conversation.refreshing,
    messages: conversation.messages,
    outbox: conversation.outbox,
    healthWarning: conversation.healthWarning,
    rewakeStorm: conversation.rewakeStorm,
    startError: conversation.startError,
    permissionRequests: conversation.permissionRequests,
    answerPermission,
    context: conversation.context,
    rateLimit: conversation.rateLimit,
    compaction: conversation.compaction,
    compactNow,
    controls: conversation.controls,
    setOption,
    turnSince: conversation.turnSince,
    dismissCompaction,
    send,
    noteSent,
    resend,
    start,
    stop,
    restart,
    cancel,
    paneCapture,
    chooseHome,
    useAppHome,
    homeChosen,
    needs,
    needsProblem,
    checkingTools,
    checkTools,
    refreshSnapshot,
  };
}
