/**
 * What the window makes of two host events that carry no state of their own: a `host_health` report of something
 * that failed, and a `permission` the host answered for the first mate without asking the captain. Worked out here,
 * apart from the hook, so `pnpm test` reads it without a window.
 *
 * Pure functions only: no React, no host.
 */

export type HealthPayload = { kind?: unknown; warning?: unknown; error?: unknown; [key: string]: unknown };

/**
 * The `host_health` kinds that are the host's own diagnostics: kept in the event stream for whoever reads it, and
 * deliberately never drawn. `lock_unclaimed` is firstmate not having recorded a session owner yet, `session_start_turn`
 * what the session's start turn came back with (a usage limit there arrives as its own `session_limit`),
 * `adapter_stderr` a line the adapter printed, and `kill_group` a stop that left nothing running.
 */
export const DIAGNOSTIC_KINDS: readonly string[] = ["lock_unclaimed", "session_start_turn", "adapter_stderr", "kill_group"];

/**
 * A failure the host reports with an `error`, as the warning the captain sees, or null when the event names no error
 * or is a diagnostic. Every such failure is drawn, so one the window has no words for is still never dropped.
 */
export function errorWarning(payload: HealthPayload): string | null {
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  if (!error || DIAGNOSTIC_KINDS.includes(kind)) return null;
  if (kind === "outbox_write_failed") {
    return `A message you sent could not be saved on this Mac, so it may not survive a restart of the first mate: ${error}`;
  }
  if (kind === "session_pick_unsaved") {
    const category = typeof payload.category === "string" && payload.category ? payload.category : "session";
    return `Your ${category} choice is in effect now, but it could not be saved, so the first mate will not start with it next time: ${error}`;
  }
  return `The first mate's host reported a problem${kind ? ` (${kind})` : ""}: ${error}`;
}

/**
 * The chat's line for a permission the host answered without asking the captain, in a home whose permission mode
 * skips prompts, so what the first mate was let do is never invisible. Null for an event naming nothing.
 */
export function permissionLine(payload: { title?: unknown; chose?: unknown }): string | null {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const chose = typeof payload.chose === "string" ? payload.chose : "";
  if (!title && !chose) return null;
  const verb = chose.startsWith("reject") ? "Refused" : "Allowed";
  return `${verb} without asking you, as this home's permission mode says: ${title || "an action the first mate asked for"}`;
}
