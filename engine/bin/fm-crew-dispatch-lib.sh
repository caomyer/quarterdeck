# shellcheck shell=bash
# Single owner of config/crew-dispatch.json validation.
# Usage: . bin/fm-crew-dispatch-lib.sh
#
# bin/fm-bootstrap.sh turns a reason into its
# "CREW_DISPATCH: invalid config/crew-dispatch.json - <reason>" diagnostic, and
# bin/fm-crew-dispatch.sh reports and refuses by the same reason, so a file one
# accepts the other accepts. docs/configuration.md "Crew dispatch profiles" owns
# the schema this checks. Needs jq; callers report a missing jq themselves.

FM_CREW_DISPATCH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-control-lib.sh disable=SC1091
. "$FM_CREW_DISPATCH_LIB_DIR/fm-control-lib.sh"
# shellcheck source=bin/fm-quota-axi-lib.sh disable=SC1091
. "$FM_CREW_DISPATCH_LIB_DIR/fm-quota-axi-lib.sh"

# The efforts each harness accepts in a profile, as a JSON object keyed by
# harness. An entry "<effort>@<model>" is accepted only with exactly that model,
# and "<effort>@<prefix>*" only with a model that starts with <prefix> and names
# something after it. A harness with an empty list takes no effort; a verified
# harness absent from the table takes any effort but ultra.
FM_CREW_DISPATCH_EFFORTS='{
  "claude": ["low","medium","high","xhigh","max"],
  "codex": ["low","medium","high","xhigh","max@gpt-5.6-luna"],
  "grok": ["low","medium","high"],
  "agy": ["low","medium","high"],
  "pi": ["low","medium","high","xhigh","max","ultra@codex-native/*"],
  "pi-signed": ["low","medium","high","xhigh","max","ultra@codex-native/*"],
  "omp": ["low","medium","high","xhigh","max"],
  "muse": ["low","medium","high","xhigh","max"],
  "rovo": ["low","medium","high","max"],
  "opencode": [],
  "kimi": [],
  "cursor": []
}'

# The effort vocabulary offered for a verified harness the table above leaves
# open.
FM_CREW_DISPATCH_OPEN_EFFORTS='["low","medium","high","xhigh","max"]'

# fm_crew_dispatch_harnesses <typed:true|false>
# Print the harnesses a profile may name, one per line. Typed dispatch
# resolution additionally accepts gemini, from bin/fm-control-lib.sh's verified
# list.
fm_crew_dispatch_harnesses() {
  if [ "$1" = true ]; then
    fm_control_harnesses
  else
    printf '%s\n' claude codex opencode pi pi-signed grok kimi cursor agy muse rovo omp
  fi
}

# fm_crew_dispatch_efforts <harness>
# Print the efforts a profile on <harness> may name, space-separated, in the
# "<effort>[@<model>]" form of FM_CREW_DISPATCH_EFFORTS.
fm_crew_dispatch_efforts() {
  jq -r --arg h "$1" --argjson open "$FM_CREW_DISPATCH_OPEN_EFFORTS" '(.[$h] // $open) | join(" ")' <<< "$FM_CREW_DISPATCH_EFFORTS"
}

# fm_crew_dispatch_invalid_reason <file> <typed:true|false>
# Print why <file> is not a valid dispatch profile file, or nothing when it is.
# <typed> is true while typed dispatch resolution is active (a TYPESAFE_API_KEY
# is set): only then are the resolver-only approval, floor, and provider
# declarations checked, and gemini accepted.
fm_crew_dispatch_invalid_reason() {
  local file=$1 typed_active=$2 verified_harnesses
  if ! jq -e . "$file" >/dev/null 2>&1; then
    echo "malformed JSON"
    return 0
  fi
  [ "$typed_active" = true ] || typed_active=false
  verified_harnesses=$(fm_crew_dispatch_harnesses "$typed_active" | jq -Rsc 'split("\n") | map(select(length > 0))')
  jq -r --argjson typed "$typed_active" --argjson verified_harnesses "$verified_harnesses" --argjson efforts "$FM_CREW_DISPATCH_EFFORTS" --arg provider_re "$FM_QUOTA_PROVIDER_ID_RE" '
    def verified($h): $verified_harnesses | index($h);
    def provider_id($p): ($p | type) == "string" and ($p | test($provider_re));
    # One entry of the efforts table, against a profile model: "<effort>" alone,
    # "<effort>@<model>" exactly, or "<effort>@<prefix>*" with more after it.
    def model_fits($m; $want):
      if ($want | endswith("*")) then
        ($want | rtrimstr("*")) as $prefix
        | ($m | type) == "string" and ($m | startswith($prefix)) and ($m | length) > ($prefix | length)
      else $m == $want
      end;
    def entry_ok($entry; $m; $e):
      ($entry | split("@")) as $parts
      | $parts[0] == $e and (($parts | length) == 1 or model_fits($m; $parts[1:] | join("@")));
    def effort_ok($h; $m; $e):
      if $e == null then true
      elif ($e | type) != "string" then false
      elif ($efforts | has($h)) then any($efforts[$h][]; entry_ok(.; $m; $e))
      else $e != "ultra"
      end;
    def profiles($value):
      if ($value | type) == "array" then $value
      elif ($value | type) == "object" then [$value]
      else []
      end;
    def configured_profiles:
      ([(.rules // [])[]? | profiles(.use?)[]?]
        + (if has("default") then [profiles(.default)[]?] else [] end));
    def malformed_optional_fields($items):
      ($items | any(has("model") and (((.model | type) != "string") or (.model | length) == 0)))
      or ($items | any(has("effort") and (((.effort | type) != "string") or (.effort | length) == 0)))
      or ($typed and ($items | any(has("provider") and (provider_id(.provider) | not))));
    # A quota floor, on a rule or a profile: bin/fm-dispatch-resolve.sh applies
    # it in code against one quota-axi row, so scope and min_percent must be
    # concrete; a rule floor also names the provider whose row it reads.
    def floor_bad($f; $need_provider):
      ($f | type) != "object"
      or (($f.scope | type) != "string") or (($f.scope | length) == 0)
      or (($f.min_percent | type) != "number") or ($f.min_percent < 0) or ($f.min_percent > 100)
      or (if $need_provider
          then (provider_id($f.provider) | not)
          else ($f | has("provider"))
          end);
    def malformed_profile_floors($items):
      ($items | any(has("floor") and floor_bad(.floor; false)));
    def bad_efforts:
      configured_profiles
      | map({h: .harness, m: .model, e: .effort})
      | map(select(.e != null))
      | map(select((.h | type) == "string" and verified(.h)))
      | map(select(. as $p | effort_ok($p.h; $p.m; $p.e) | not))
      | map("\(.h):\(.e)")
      | unique;
    if type != "object" then "top-level value must be an object"
    elif has("rules") and (.rules | type) != "array" then "rules must be an array"
    elif [(.rules // [])[]? | select(type != "object")] | length > 0 then "each rule must be an object"
    elif [(.rules // [])[]? | select((.when? | type) != "string" or (.when | length) == 0)] | length > 0 then "each rule needs non-empty when"
    elif [(.rules // [])[]? | select((.use? | type) != "object" and (.use? | type) != "array")] | length > 0 then "each rule needs use"
    elif [(.rules // [])[]? | select((.use? | type) == "array" and (.use | length) == 0)] | length > 0 then "each rule needs at least one use profile"
    elif [(.rules // [])[]? | profiles(.use?)[]? | select(type != "object")] | length > 0 then "each use profile must be an object"
    elif [(.rules // [])[]? | profiles(.use?)[]? | select((.harness? | type) != "string" or (.harness | length) == 0)] | length > 0 then "each use profile needs harness"
    elif malformed_optional_fields([(.rules // [])[]? | profiles(.use?)[]?]) then
      if $typed then "use profile model and effort must be non-empty strings, and provider must match ^[a-z0-9]+(-[a-z0-9]+)*\\z when present"
      else "use profile model and effort must be non-empty strings when present"
      end
    elif $typed and malformed_profile_floors([(.rules // [])[]? | profiles(.use?)[]?]) then "use profile floor needs scope and min_percent 0..100"
    elif $typed and ([(.rules // [])[]? | select(has("approval") and .approval != "captain")] | length > 0) then "approval must be \"captain\" when present"
    elif $typed and ([(.rules // [])[]? | select(has("floor") and floor_bad(.floor; true))] | length > 0) then "rule floor needs scope, min_percent 0..100, and provider matching ^[a-z0-9]+(-[a-z0-9]+)*\\z"
    elif [(.rules // [])[]? | select(has("select") and ((.select? | type) != "string" or (.select | length) == 0))] | length > 0 then "select must be a non-empty string"
    elif [(.rules // [])[]? | .select? // empty | select(. != "quota-balanced")] | length > 0 then
      "unknown select: " + ([ (.rules // [])[]? | .select? // empty | select(. != "quota-balanced") ] | unique | join(", "))
    elif has("default") and ((.default | type) != "object" and (.default | type) != "array") then "default must be a profile object or non-empty profile array"
    elif has("default") and ((.default | type) == "array" and (.default | length) == 0) then "default needs at least one profile"
    elif has("default") and ([profiles(.default)[]? | select(type != "object")] | length) > 0 then "each default profile must be an object"
    elif has("default") and ([profiles(.default)[]? | select((.harness? | type) != "string" or (.harness | length) == 0)] | length) > 0 then "each default profile needs harness"
    elif has("default") and malformed_optional_fields([profiles(.default)[]?]) then
      if $typed then "default profile model and effort must be non-empty strings, and provider must match ^[a-z0-9]+(-[a-z0-9]+)*\\z when present"
      else "default profile model and effort must be non-empty strings when present"
      end
    elif $typed and has("default") and malformed_profile_floors([profiles(.default)[]?]) then "default profile floor needs scope and min_percent 0..100"
    else
      (configured_profiles
        | map(.harness)
        | map(select(. != null))
        | map(select(. as $h | verified($h) | not))
        | unique) as $bad_harnesses
      | if ($bad_harnesses | length) > 0 then "unverified harness: " + ($bad_harnesses | join(", "))
        elif (bad_efforts | length) > 0 then "invalid effort: " + (bad_efforts | join(", "))
        else empty
        end
    end
  ' "$file" 2>/dev/null || true
}
