// Unit tests for packages/core/src/health.ts, what the window makes of the host's failure reports and the permissions it
// answered for the first mate.
//
//   pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { DIAGNOSTIC_KINDS, errorWarning, permissionLine } from "@quarterdeck/core/health";

test("a message whose durable copy could not be written is a warning, never silence", () => {
  const warning = errorWarning({ kind: "outbox_write_failed", id: "m42", error: "No space left on device (os error 28)" });
  assert.equal(warning, "A message you sent could not be saved on this Mac, so it may not survive a restart of the first mate: No space left on device (os error 28)");
});

test("a session pick that could not be kept says it is in effect now but not at the next start", () => {
  assert.equal(
    errorWarning({ kind: "session_pick_unsaved", category: "model", error: "Permission denied (os error 13)" }),
    "Your model choice is in effect now, but it could not be saved, so the first mate will not start with it next time: Permission denied (os error 13)",
  );
});

test("any other failure the host reports with an error is drawn too, in the host's words", () => {
  assert.equal(errorWarning({ kind: "something_new", error: " it broke " }), "The first mate's host reported a problem (something_new): it broke");
});

test("the host's diagnostics, and events with no error, stay undrawn", () => {
  for (const kind of DIAGNOSTIC_KINDS) assert.equal(errorWarning({ kind, error: "a failed start turn" }), null, kind);
  assert.deepEqual([...DIAGNOSTIC_KINDS].sort(), ["adapter_stderr", "kill_group", "lock_unclaimed", "session_start_turn"]);
  assert.equal(errorWarning({ kind: "outbox_write_failed" }), null);
  assert.equal(errorWarning({ kind: "outbox_write_failed", error: "  " }), null);
  assert.equal(errorWarning({ kind: "session_start_turn", error: null }), null);
});

test("a permission the host answered without asking is a line in the chat", () => {
  assert.equal(permissionLine({ title: "Run git push", chose: "opt-1", kind: "allow_once" }), "Allowed without asking you, as this home's permission mode says: Run git push");
  assert.equal(permissionLine({ title: "Delete the build folder", chose: "deny", kind: "reject_once" }), "Refused without asking you, as this home's permission mode says: Delete the build folder");
  assert.equal(permissionLine({ title: "", chose: "allow", kind: "allow_always" }), "Allowed without asking you, as this home's permission mode says: an action the first mate asked for");
  assert.equal(permissionLine({}), null);
});

test("a permission answered with an option of no known kind claims neither allowed nor refused", () => {
  for (const payload of [{ title: "Run git push", chose: "reject_once" }, { title: "Run git push", chose: "allow", kind: null }, { title: "Run git push", chose: "allow", kind: "custom" }]) {
    const line = permissionLine(payload);
    assert.equal(line, `Answered without asking you with option ${payload.chose}, as this home's permission mode says: Run git push`);
  }
});
