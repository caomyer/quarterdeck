import { ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ContextReading, HostRuntimeState, QuotaRead, RateLimit } from "./host/types";
import type { Compaction } from "./host/use-host";
import { ago, contextEvent, contextLevel, contextPercent, type Level, percent, type ProviderView, providerViews, stripLine, stripProviders, tokens, tokensExact, until, type WindowView } from "./usage";

/** Resets and ages count down on screen: the panel reads the clock on every render, and renders at least this often. */
function useNow(every = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return Date.now();
}

const LIVE: HostRuntimeState[] = ["idle", "prompt_turn", "agent_turn"];

function Meter({ used, level = "", tone = "", className = "" }: { used: number | null; level?: Level; tone?: "" | "stale" | "early"; className?: string }) {
  if (used == null) return <span className={`usage-meter unknown ${className}`} aria-hidden="true" />;
  return <span className={`usage-meter ${level} ${tone} ${className}`} aria-hidden="true"><b style={{ width: `${Math.min(100, Math.max(used, used > 0 ? 3 : 0))}%` }} /></span>;
}

export type UsageProps = {
  context: ContextReading | null;
  rateLimit: RateLimit | null;
  quota: { read: QuotaRead | null; reading: boolean; allowing: boolean; refresh: () => void; allowKeychain: () => void };
  runtime: HostRuntimeState;
  /** Messages reach the first mate in this home: Compact now needs that too. */
  sendReady: boolean;
  compaction: Compaction | null;
  onCompact: () => void;
  onDismissCompaction: () => void;
};

/**
 * The usage strip at the top of the sidebar's footer, on every page: this conversation's context window, and the
 * plan limit the first mate runs under. Quiet until something matters. Clicking it opens the detail.
 */
export function Usage(props: UsageProps) {
  const [open, setOpen] = useState(false);
  const strip = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLElement>(null);
  const now = useNow();
  const running = LIVE.includes(props.runtime);
  const { shown, others } = providerViews(props.quota.read, props.rateLimit, now);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !strip.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        strip.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const contextShare = contextPercent(props.context);
  const plans = stripProviders(shown);
  return <>
    <button ref={strip} className="usage-strip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((current) => !current)} title="Usage: context and plan limits">
      {!running
        ? <StripRow label="Context" used={null} value="" detail={props.runtime === "starting" || props.runtime === "restarting" ? "starting…" : "not running"} />
        : contextShare == null
          ? <StripRow label="Context" used={null} value="" detail="after first reply" />
          : <StripRow label="Context" used={contextShare} level={contextLevel(contextShare)} value={percent(contextShare)} detail={`${tokens(props.context!.used!)} of ${tokens(props.context!.size!)}`} />}
      {plans.map((view) => {
        const line = stripLine(view, now);
        const level = view.state === "stale" ? "" : view.binding?.level ?? "";
        return <StripRow key={view.id} label={view.name} used={view.binding?.used ?? null} level={level} tone={view.state === "stale" ? "stale" : view.state === "early" ? "early" : ""} value={line.value} detail={line.detail} joined={line.joined} />;
      })}
      {!plans.length && (props.quota.read === null
        ? <StripRow label="Plans" used={null} value="" detail="checking…" />
        : props.quota.read.missing && <StripRow label="Plans" used={null} value="" detail="no quota-axi" />)}
    </button>
    {/* Outside the sidebar, which would lend it its own colours, and on a narrow window its transform. */}
    {open && createPortal(<section ref={popover} className="usage-popover" role="dialog" aria-label="Usage">
      <header>
        <strong>Usage</strong>
        <small>{props.quota.reading && !props.quota.read ? "checking…" : props.quota.read?.missing ? "plan limits unavailable" : props.quota.read?.read_at_ms ? `checked ${ago(props.quota.read.read_at_ms, now)}` : ""}</small>
        <button className={`icon-button ${props.quota.reading ? "spinning" : ""}`} onClick={props.quota.refresh} disabled={props.quota.reading} title="Check plan limits again" aria-label="Check plan limits again"><RefreshCw size={15} /></button>
      </header>
      <div className="usage-popover-body">
        <ContextSection {...props} running={running} now={now} />
        <PlanSection quota={props.quota} shown={shown} others={others} now={now} />
      </div>
    </section>, document.body)}
  </>;
}

function StripRow({ label, used, level = "", tone = "", value, detail, joined = false }: { label: string; used: number | null; level?: Level; tone?: "" | "stale" | "early"; value: string; detail: string; joined?: boolean }) {
  return <span className={`usage-strip-row ${level}`}>
    <span>{label}</span>
    <Meter used={used} level={level} tone={tone} />
    <span className="usage-value">{value}{value && detail ? " " : ""}{detail && <i>{value && !joined ? "· " : ""}{detail}</i>}</span>
  </span>;
}

function ContextSection({ context, runtime, running, sendReady, compaction, onCompact, onDismissCompaction, now }: UsageProps & { running: boolean; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const share = contextPercent(context);
  const known = running && share != null && context?.used != null && context.size != null;
  const busy = runtime === "prompt_turn" || runtime === "agent_turn";
  const waiting = compaction?.state === "waiting" || compaction?.state === "running";
  const event = running ? contextEvent(context, now) : null;
  // A reading from before the first mate stopped is not this conversation's any more.
  const canCompact = known && sendReady && !waiting;
  const why = !running ? "The first mate isn't running" : !known ? "Nothing to compact until the first reply" : !sendReady ? "The first mate hasn't started in this folder yet" : waiting ? "Already compacting" : "Summarise the older turns to free room";

  useEffect(() => {
    if (!canCompact) setConfirming(false);
  }, [canCompact]);

  return <div className="usage-section">
    <div className="usage-section-head"><span>This conversation</span><small>{known && context?.at_ms ? `first mate · as of ${ago(context.at_ms, now)}` : "first mate"}</small></div>
    {known
      ? <div className={`usage-context-line ${contextLevel(share)}`}><strong>{tokensExact(context!.used!)} <span>of {tokensExact(context!.size!)} tokens</span></strong><span>{percent(share!)}</span></div>
      : <div className="usage-context-line"><strong>— <span>of the context window</span></strong></div>}
    <Meter used={known ? share : null} level={contextLevel(share)} className="usage-meter-wide" />
    <p className="usage-note">{!running
      ? "The first mate isn't running. Its context is read again after its first reply."
      : !known
        ? "Known after the first mate's first reply. Its session reports it after every turn."
        : contextLevel(share)
          ? "Near the limit the first mate compacts on its own: Claude Code summarises the older turns to make room."
          : `${tokens(context!.size! - context!.used!)} tokens of room left. It grows with every turn and drops when the conversation is compacted.`}</p>
    {event && <div className="usage-event">{event}</div>}
    {compaction?.state === "failed" && <div className="usage-problem" role="alert"><p>Couldn't compact: {compaction.error}</p><button className="link-button" onClick={onDismissCompaction}>Dismiss</button></div>}
    {waiting
      ? <div className="usage-working" role="status"><RefreshCw size={13} />{compaction?.state === "waiting" && busy ? "Waiting for the current turn to end, then compacting." : "Compacting…"} The first mate says in chat when it's done.</div>
      : confirming
        ? <div className="usage-confirm">
          <p>Compact the first mate's conversation now? It holds {tokensExact(context!.used!)} tokens, {percent(share!)} of its {tokens(context!.size!)} context. Claude Code summarises the older turns to make room, and their word-for-word detail is gone for good. The backlog and the first mate's own notes stay as they are.</p>
          {busy && <p>The first mate is working now, so it compacts once that turn ends.</p>}
          <div><button className="btn-base" onClick={() => setConfirming(false)}>Cancel</button><button className="btn-base usage-go" onClick={() => { setConfirming(false); onCompact(); }}>Compact</button></div>
        </div>
        : <div className="usage-actions"><button className="btn-base usage-small" disabled={!canCompact} title={why} onClick={() => setConfirming(true)}>Compact now…</button></div>}
  </div>;
}

function PlanSection({ quota, shown, others, now }: { quota: UsageProps["quota"]; shown: ProviderView[]; others: { name: string; words: string }[]; now: number }) {
  const [othersOpen, setOthersOpen] = useState(false);
  const read = quota.read;
  return <div className="usage-section">
    <div className="usage-section-head"><span>Plan limits</span><small>account-wide, crew included</small></div>
    {read === null && <p className="usage-note">Reading plan limits…</p>}
    {read?.missing && <p className="usage-note">Plan limits come from <code>quota-axi</code>, which isn't installed on this Mac.</p>}
    {read?.error && !read.missing && <p className="usage-note usage-read-problem">{read.providers
      ? <>Can't refresh: {read.error}.{read.read_at_ms ? ` These are the numbers from ${ago(read.read_at_ms, now)}, and they update on the next good read.` : ""}</>
      : <>Can't read plan limits: {read.error}.</>}</p>}
    {read && !read.missing && !read.error && !shown.length && <p className="usage-note">quota-axi has no plan limits for any provider on this Mac.</p>}
    {shown.map((view) => <ProviderRow key={view.id} view={view} now={now} allowing={quota.allowing} onAllow={quota.allowKeychain} ageShown={Boolean(read?.error)} />)}
    {others.length > 0 && <div className="usage-others">
      <button className="usage-others-toggle" aria-expanded={othersOpen} onClick={() => setOthersOpen((current) => !current)}><ChevronRight size={13} />{others.length} more {others.length === 1 ? "provider" : "providers"} not set up</button>
      {othersOpen && <ul>{others.map((other) => <li key={other.name}><span>{other.name}</span><span title={other.words}>{other.words}</span></li>)}</ul>}
    </div>}
  </div>;
}

function windowTitle(window: WindowView, now: number, early: boolean) {
  const reset = window.resetsAt != null ? `resets in ${until(window.resetsAt, now)}` : "not reported";
  return `${window.label}: ${reset}${early ? " · an early reading: quota-axi has little history for it yet" : ""}`;
}

/** `ageShown`: the section already says how old every number is, after a read that failed. */
function ProviderRow({ view, now, allowing, onAllow, ageShown }: { view: ProviderView; now: number; allowing: boolean; onAllow: () => void; ageShown: boolean }) {
  const reset = view.binding?.resetsAt != null ? until(view.binding.resetsAt, now) : null;
  const headLevel = view.state === "stale" ? "" : view.binding?.level ?? "";
  const when = view.state === "refused"
    ? reset ? `Back in ${reset}` : "Refused"
    : [view.status, reset ? `Resets in ${reset}` : null].filter(Boolean).join(" · ") || (view.state === "needs_auth" ? "Needs sign-in" : "Unavailable");
  const early = view.state === "early";
  const tone = view.state === "stale" ? "stale" : early ? "early" : "";
  return <div className={`usage-provider ${view.state}`}>
    <div className="usage-provider-head">
      <span className="usage-glyph" aria-hidden="true">{view.glyph}</span>
      <strong>{view.name}{view.plan && <small>{view.plan}</small>}{early && <span className="usage-tag" title="quota-axi is not yet sure of this reading">early</span>}</strong>
      <span className={`usage-when ${headLevel}`} title={when}>{when}</span>
    </div>
    {view.windows.length > 0 && <div className="usage-windows">{view.windows.map((window) => <span key={window.key} className={`usage-window ${view.state === "stale" ? "stale" : window.level} ${tone}`} title={windowTitle(window, now, early)}>
      {window.label}<Meter used={window.used} level={view.state === "stale" ? "" : window.level} tone={tone} /><span>{window.used == null ? "—" : `${early ? "~" : ""}${percent(window.used)}`}</span>
    </span>)}</div>}
    {view.state === "stale" && view.readAt && !ageShown && <p className="usage-aside">These are the numbers from {ago(view.readAt, now)}. They update on the next good read.</p>}
    {(view.words || view.remedy) && <div className="usage-ask">
      <p>{view.keychain
        ? "Percentages need Keychain access, allowed once with Always Allow. Routing reads the same numbers."
        : view.state === "needs_auth" ? `${view.name} needs signing in before its limits can be read.` : `${view.name}'s limits can't be read right now.`}</p>
      {view.words && <p className="usage-words">quota-axi: <code>{view.words}</code></p>}
      {view.keychain
        ? <button className="btn-base usage-small" onClick={onAllow} disabled={allowing}>{allowing ? "Waiting for macOS…" : "Allow Keychain access…"}</button>
        : view.remedy && <p className="usage-words">Fix: <code>{view.remedy}</code></p>}
    </div>}
  </div>;
}
