#!/usr/bin/env bash
# Repair a GitHub pull request body whose HTML blocks swallow the markdown after them.
#
# GitHub-flavored Markdown runs a `<details>` HTML block until the next blank
# line and renders nothing inside it as markdown, so an image on the line
# directly after `</details>` shows as literal `![alt](url)` text. The same
# happens to a line glued above a `<details>` line.
# The rule this enforces, outside fenced code blocks and nowhere else:
#   - no non-blank line directly follows a line whose entire content is `</details>`;
#   - no `<details...>` line directly follows a non-blank line.
# The repair inserts one blank line at each violation, and nothing else.
#
# This repairs output; the defect is not in this repository. The glued lines
# are written by no-mistakes' own `pr` step, not by an agent: its Testing-section
# renderer (internal/pipeline/steps/prsummary.go, as of v1.79.0) puts an uploaded
# screenshot's `![label](url)` directly after an embedded-log `</details>`
# artifact, and its needsArtifactBlockSeparator separates a `<details>` block
# only from a `- Evidence:` bullet. If that renderer starts separating every
# artifact block, this repair finds nothing to do and can be retired.
#
# Usage:
#   fm-pr-body-fix.sh <github-pr-url>   repair the pull request's body in place
#   fm-pr-body-fix.sh --filter          repair stdin to stdout, touching nothing else
#
# With a URL it reads the body, repairs a copy, and proves the copy equals the
# original once blank lines are ignored before writing anything; a failed proof
# refuses and writes nothing. The write is a compare-and-swap as close as the
# forge allows: the body is re-read immediately before the edit and the edit is
# skipped when it changed since the repair was computed (another writer, such as
# a pipeline step still updating the body, owns it; retried up to three times),
# and the body is read back afterwards to confirm the repair landed.
# A body that already satisfies the rule is never written, so a second run
# changes nothing. The caller runs it only once the no-mistakes `pr` step has
# finished (bin/fm-pr-check.sh, at PR-ready registration and again before a
# merge); a later pipeline rewrite of the body is repaired again at the next
# registration.
#
# Output (stdout): `pr-body: ok`, `pr-body: repaired <n> line(s): ...`, or
# `pr-body: skipped: ...` for a non-GitHub URL, exit 0; `pr-body: refused: ...`
# with the offending lines and the two-line fix, exit 1. --filter writes the
# repaired body to stdout and one `line <n>: ...` note per inserted blank line
# to stderr.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# pr_body_fix_filter: stdin -> stdout. Notes on stderr name each line (in the
# input's numbering) that gets a blank line inserted before it, and why.
pr_body_fix_filter() {
  awk '
    function bare(s) { sub(/\r$/, "", s); return s }
    function trim(s) { s = bare(s); sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    # A fence opens with 3+ backticks or tildes and closes with the same
    # character, at least as many, and nothing else on the line.
    function fence_run(s,   c, n) {
      c = substr(s, 1, 1)
      if (c != "`" && c != "~") return ""
      n = 0
      while (substr(s, n + 1, 1) == c) n++
      return n >= 3 ? substr(s, 1, n) : ""
    }
    {
      line = $0
      t = trim(line)
      blank = (t == "")
      if (fence == "") {
        why = ""
        if (NR > 1 && !blank && prev_close) {
          why = "follows </details>"
        } else if (NR > 1 && !prev_blank && t ~ /^<details([ \t>]|$)/) {
          why = "is a <details> line glued to the line above"
        }
        if (why != "") {
          # Keep the body'"'"'s own line ending on the inserted blank line.
          print (line ~ /\r$/ ? "\r" : "")
          printf "line %d: %s: %s\n", NR, why, substr(t, 1, 100) > "/dev/stderr"
        }
      }
      print line
      was_close = 0
      run = fence_run(t)
      if (fence == "") {
        if (run != "") fence = run
        else was_close = (t == "</details>")
      } else if (run != "" && index(run, fence) == 1 && t == run) {
        fence = ""
      }
      prev_close = was_close
      prev_blank = blank
    }
  '
}

# pr_body_fix_nonblank <file>: the file with every blank line removed, the
# comparison the proof rests on.
pr_body_fix_nonblank() {
  grep -v '^[[:space:]]*$' "$1" || true
}

pr_body_fix_refuse() {
  printf 'pr-body: refused: %s\n' "$1"
  exit 1
}

if [ "$#" -eq 1 ] && [ "$1" = --filter ]; then
  pr_body_fix_filter
  exit 0
fi

if [ "$#" -ne 1 ]; then
  echo "usage: fm-pr-body-fix.sh <github-pr-url> | --filter" >&2
  exit 2
fi

# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"
fm_pr_url_parse "$1" || { echo "error: not a pull request URL" >&2; exit 2; }
URL=$FM_PR_URL
if [ "$FM_PR_PROVIDER" != github ]; then
  printf 'pr-body: skipped: %s is not a GitHub pull request\n' "$URL"
  exit 0
fi
command -v gh >/dev/null 2>&1 || pr_body_fix_refuse "gh is not on PATH, so $URL was not checked"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-pr-body-fix.XXXXXX")
trap 'rm -rf -- "$TMP"' EXIT

# read_body <file>: the body as the forge holds it, without trailing newlines,
# so every comparison below is between bodies read and written the same way.
read_body() {
  local body
  body=$(gh pr view "$URL" --json body -q .body) || return 1
  printf '%s' "$body" > "$1"
}

attempt=1
while :; do
  read_body "$TMP/before" || pr_body_fix_refuse "could not read the body of $URL"
  pr_body_fix_filter < "$TMP/before" > "$TMP/after-raw" 2> "$TMP/notes"
  if [ ! -s "$TMP/notes" ]; then
    printf 'pr-body: ok\n'
    exit 0
  fi
  body=$(cat "$TMP/after-raw")
  printf '%s' "$body" > "$TMP/after"

  # The proof: identical once blank lines are ignored, and every added line blank.
  inserted=$(wc -l < "$TMP/notes" | tr -d ' ')
  before_lines=$(awk 'END { print NR }' "$TMP/before")
  after_lines=$(awk 'END { print NR }' "$TMP/after")
  if ! cmp -s <(pr_body_fix_nonblank "$TMP/before") <(pr_body_fix_nonblank "$TMP/after") \
    || [ "$after_lines" -ne $((before_lines + inserted)) ]; then
    pr_body_fix_refuse "the repaired body of $URL would differ from the original by more than blank lines, so nothing was written; fix it by hand, inserting one blank line between each pair below:
$(sed 's/^/  /' "$TMP/notes")"
  fi

  read_body "$TMP/latest" || pr_body_fix_refuse "could not re-read the body of $URL before writing"
  if cmp -s "$TMP/before" "$TMP/latest"; then
    break
  fi
  [ "$attempt" -lt 3 ] || pr_body_fix_refuse "the body of $URL kept changing while it was being repaired, so nothing was written; rerun once its writer has finished"
  attempt=$((attempt + 1))
done

gh pr edit "$URL" --body-file "$TMP/after" >/dev/null \
  || pr_body_fix_refuse "gh pr edit failed for $URL; the body still needs a blank line inserted at:
$(sed 's/^/  /' "$TMP/notes")"
read_body "$TMP/landed" || pr_body_fix_refuse "could not read back the body of $URL after the repair"
cmp -s "$TMP/after" "$TMP/landed" \
  || pr_body_fix_refuse "the body of $URL changed again right after the repair was written; another writer is active, so rerun once it has finished"
printf 'pr-body: repaired %s line(s) in %s by inserting a blank line:\n' "$inserted" "$URL"
sed 's/^/  /' "$TMP/notes"
