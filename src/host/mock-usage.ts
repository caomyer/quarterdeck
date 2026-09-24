// The usage panel's states for the browser review, chosen with `?usage=<state>`. With no `?usage` the mock
// reports what quota-axi 0.1.49 read on a real Mac on 2026-09-23, after its Keychain access was allowed.
//
//   fresh      a Mac that has not allowed the Keychain: Claude has no numbers, only what the session says
//   warn       Claude's 5h window at 86% and the context at 81%
//   over       Claude refusing the first mate until its window resets
//   stale      quota-axi stopped answering; the numbers are 42 minutes old
//   start      nothing read yet: no context reading, and the first plan read still running
//   compacted  the conversation was compacted 12 minutes ago
//   resumed    a relaunch resumed the session, earlier conversation and all
//   missing    quota-axi is not installed
//   compact-fails  Compact now runs and Claude Code says it could not compact

import type { ContextReading, QuotaProvider, QuotaRead, RateLimit } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Words quota-axi printed for providers nobody set up on that Mac, verbatim. */
const NOT_SET_UP: [string, string, string][] = [
  ["copilot", "GitHub Copilot", "GitHub Copilot sign-in required"],
  ["grok", "Grok", "Grok sign-in required"],
  ["kimi", "Kimi", "kimi_credential_unavailable"],
  ["zai", "Z.AI", "zai_credential_unavailable"],
  ["agy", "Antigravity", "Antigravity/agy is not running"],
  ["alibaba", "Alibaba Coding Plan", "bl_cli_unavailable"],
  ["opencode-go", "OpenCode Go", "opencode_go_credential_unavailable"],
  ["commandcode", "Command Code", "commandcode_sign_in_required"],
  ["minimax", "MiniMax", "minimax_credential_unavailable"],
  ["mimo", "MiMo", "mimo_credential_unavailable"],
  ["deepseek", "DeepSeek", "deepseek_credential_unavailable"],
  ["openrouter", "OpenRouter", "openrouter_credential_unavailable"],
  ["elevenlabs", "ElevenLabs", "elevenlabs_credential_unavailable"],
];

function provider(id: string, label: string, fields: Partial<QuotaProvider>): QuotaProvider {
  return { id, label, plan: null, status: "fresh", stale: false, refreshed_at: null, error: null, reason: null, remedy: null, confidence: "established", windows: [], ...fields };
}

function window(id: string, label: string, kind: string, used: number, resetsIn: number, now: number) {
  return { id, label, kind, used, resets_at: new Date(now + resetsIn).toISOString() };
}

function providers(scenario: string, now: number, readAt: number): QuotaProvider[] {
  const fresh = new Date(readAt).toISOString();
  const [fiveHour, week, fable] = scenario === "warn" ? [86, 61, 4] : scenario === "over" ? [100, 71, 9] : scenario === "compacted" ? [41, 33, 0] : scenario === "stale" ? [31, 18, 0] : [20, 17, 0];
  const claude = scenario === "fresh" || scenario === "resumed"
    ? provider("claude", "Claude", { status: "auth_required", error: "keychain_prompt_required", reason: "keychain_access_required", remedy: "quota-axi --allow-keychain-prompt", confidence: null })
    : provider("claude", "Claude", {
      plan: "max",
      refreshed_at: fresh,
      windows: [
        window("five_hour", "session", "session", fiveHour, scenario === "warn" ? 38 * MIN : scenario === "over" ? 52 * MIN : 95 * MIN, now),
        window("seven_day", "week", "weekly", week, 2 * DAY + 23 * HOUR, now),
        window("model:fable", "Fable week", "model", fable, 2 * DAY + 23 * HOUR, now),
      ],
    });
  const codexUsed = scenario === "warn" || scenario === "over" ? [22, 9] : [0, 0];
  const codex = provider("codex", "Codex", {
    plan: "plus",
    confidence: "early",
    refreshed_at: fresh,
    windows: [window("five_hour", "session", "session", codexUsed[0], 4 * HOUR + 59 * MIN, now), window("weekly", "week", "weekly", codexUsed[1], 4 * DAY + 12 * HOUR, now)],
  });
  const cursor = provider("cursor", "Cursor", {
    plan: "Free",
    refreshed_at: fresh,
    windows: [window("included_usage", "included usage", "monthly", 0, 3 * DAY + 15 * HOUR, now)],
  });
  const others = NOT_SET_UP.map(([id, label, error]) => provider(id, label, {
    status: id === "agy" || id === "alibaba" ? "unavailable" : "auth_required",
    error,
    confidence: null,
  }));
  return [claude, codex, cursor, ...others].map((entry) => scenario === "stale" && entry.windows.length ? { ...entry, status: "stale", stale: true } : entry);
}

export type MockUsage = {
  /** The context reading the host reports after the first mate's first turn; `null` until then. */
  context: ContextReading | null;
  rateLimit: RateLimit | null;
  quota: (now: number) => QuotaRead;
  /** How long the first plan read takes. */
  quotaDelay: number;
  /** What allowing the Keychain reads. */
  allowed: (now: number) => QuotaRead;
  /** Claude Code's words when compacting fails, or `null` when it compacts. */
  compactFailure: string | null;
};

export function mockUsage(scenario: string | null): MockUsage {
  const name = scenario ?? "today";
  const now = Date.now();
  const size = 1_000_000;
  const used = name === "warn" ? 812_400 : name === "over" ? 402_000 : name === "stale" ? 118_250 : name === "compacted" ? 61_200 : name === "resumed" ? 69_163 : 70_979;
  const context: ContextReading | null = name === "start" ? null : {
    used,
    size,
    at_ms: now - (name === "over" ? 14 * MIN : 3 * MIN),
    resumed: name === "resumed",
    compacted: name === "compacted" ? { from: 812_400, to: 61_200, at_ms: now - 12 * MIN } : null,
  };
  const sessionLimit = (status: string, resetsIn: number): RateLimit => ({ status, rateLimitType: "five_hour", resetsAt: Math.round((now + resetsIn) / 1000), at_ms: now - 3 * MIN });
  const rateLimit = name === "over" ? sessionLimit("rejected", 52 * MIN)
    : name === "warn" ? sessionLimit("allowed_warning", 38 * MIN)
    : name === "start" ? null
    : sessionLimit("allowed", 95 * MIN);
  const read = (at: number, readAt: number, kind = name): QuotaRead => ({ providers: providers(kind, at, readAt), read_at_ms: readAt, error: null, missing: false });
  return {
    context,
    rateLimit,
    quota: (at) => {
      if (name === "missing") return { providers: null, read_at_ms: null, error: "quota-axi is not installed", missing: true };
      if (name === "stale") return { ...read(at, at - 42 * MIN), error: "quota-axi did not answer within 45s" };
      return read(at, at);
    },
    quotaDelay: name === "start" ? 20_000 : 300,
    allowed: (at) => read(at, at, "today"),
    compactFailure: name === "compact-fails" ? "Compacting failed: Not enough messages to compact." : null,
  };
}
