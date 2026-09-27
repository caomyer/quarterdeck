//! What the first mate's session lets the captain change, and what it advertises.
//!
//! The adapter states its session config options whole, each time: in the
//! `session/new` or `session/load` result, in the response to every
//! `session/set_config_option`, and in every `config_option_update`. The latest
//! of those is the truth; nothing here keeps a list of models or efforts of its
//! own. The same goes for the slash commands it advertises in
//! `available_commands_update`, which the composer's palette lists as sent.
//!
//! The captain may change the options whose category is `model` or
//! `thought_level` (the adapter's Effort). The permission mode is the home's,
//! from `config/claude-permission-mode`, and is never offered here.
//!
//! A pick does not reliably survive a relaunch: a resumed session keeps a model
//! only because the CLI reads back the one it ran, a fresh session starts on
//! the default, and effort is re-seeded at every open. So each confirmed pick
//! is kept for the home, in the app's own per-home folder, and applied again
//! after every session opens. What the window shows is only ever what the
//! adapter last confirmed.
//!
//! A model that cannot run the home's permission mode makes the adapter drop
//! the mode to Manual. The host puts the model and the mode back and refuses
//! the pick with the reason, so a model change never quietly changes how much
//! the first mate may do without asking.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// Option categories the captain may change, in the order they are applied: a
/// model change rebuilds the efforts, so effort goes after it.
pub(crate) const PICKED: [&str; 2] = ["model", "thought_level"];

/// Where each home's picks are kept, in the host's per-home folder.
const PICKS_FILE: &str = "session-picks.json";

/// How long the adapter gets to answer a change.
pub(crate) const SET_WAIT: Duration = Duration::from_secs(30);

/// The session's options and commands, as the adapter last stated them.
#[derive(Default)]
pub(crate) struct Controls {
    /// Every config option, whole; `None` until a session has opened.
    pub options: Option<Vec<Value>>,
    /// The advertised slash commands; `None` until the session has sent them.
    pub commands: Option<Vec<Value>>,
    /// The session's permission mode, as the adapter last reported it.
    pub mode: Option<String>,
    /// A change on its way: its category and value.
    pub pending: Option<(String, String)>,
    /// Why a kept pick could not be applied when the session opened, by category.
    pub problems: Map<String, Value>,
    /// Values this session refused because they cannot run the home's permission mode, with why,
    /// keyed by `unfit_key`: model and effort share value ids such as `default`.
    pub unfit: HashMap<String, String>,
}

/// The key `Controls::unfit` keeps a refused value under.
pub(crate) fn unfit_key(category: &str, value: &str) -> String {
    format!("{category}:{value}")
}

impl Controls {
    /// A session just opened: its result carries its options and mode.
    pub fn opened(session: &Value) -> Self {
        Controls {
            options: Some(options_of(session)),
            mode: session.pointer("/modes/currentModeId").and_then(Value::as_str).map(str::to_string),
            ..Controls::default()
        }
    }

    /// Takes one of the adapter's meta updates. Returns whether anything the window shows changed.
    pub fn note(&mut self, update: &Value) -> bool {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("config_option_update") => {
                self.options = Some(options_of(update));
                true
            }
            Some("available_commands_update") => {
                self.commands = Some(commands_of(update));
                true
            }
            Some("current_mode_update") => {
                self.mode = update.get("currentModeId").and_then(Value::as_str).map(str::to_string);
                true
            }
            _ => false,
        }
    }

    /// What the window draws. `live` is whether a session is open to take a change.
    pub fn view(&self, live: bool, picks: &Map<String, Value>) -> Value {
        json!({
            "live": live,
            "options": self.options,
            "commands": self.commands,
            "mode": self.mode,
            "pending": self.pending.as_ref().map(|(category, value)| json!({"category": category, "value": value})),
            "problems": self.problems,
            "unfit": self.unfit,
            "picks": picks,
        })
    }
}

/// `configOptions` from a result or an update; an adapter that sends none offers none.
pub(crate) fn options_of(value: &Value) -> Vec<Value> {
    value.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The advertised commands as the palette reads them: a name, a description, and the argument hint when there is one.
pub(crate) fn commands_of(update: &Value) -> Vec<Value> {
    update
        .get("availableCommands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str).filter(|name| !name.is_empty())?;
                    Some(json!({
                        "name": name,
                        "description": command.get("description").and_then(Value::as_str).unwrap_or(""),
                        "hint": command.pointer("/input/hint").and_then(Value::as_str),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a meta update is one `Controls` keeps.
pub(crate) fn is_control_update(update: &Value) -> bool {
    matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("config_option_update" | "available_commands_update" | "current_mode_update")
    )
}

fn current(option: &Value) -> Option<&str> {
    option.get("currentValue").and_then(Value::as_str)
}

fn offers(option: &Value, value: &str) -> bool {
    option
        .get("options")
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|entry| entry.get("value").and_then(Value::as_str) == Some(value)))
}

/// A value's name as the session gives it, for the captain's words.
pub(crate) fn value_name(option: &Value, value: &str) -> String {
    option
        .get("options")
        .and_then(Value::as_array)
        .and_then(|values| values.iter().find(|entry| entry.get("value").and_then(Value::as_str) == Some(value)))
        .and_then(|entry| entry.get("name").and_then(Value::as_str))
        .map(|name| name.trim_end_matches(" (recommended)").to_string())
        .unwrap_or_else(|| value.to_string())
}

fn category_of(options: &[Value], category: &str) -> Option<Value> {
    options.iter().find(|option| option.get("category").and_then(Value::as_str) == Some(category)).cloned()
}

/// What the adapter said when it refused, in its own words: `data.details`, where it puts the reason, then `message`.
pub(crate) fn refusal(error: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(error) else {
        return error.to_string();
    };
    parsed
        .pointer("/data/details")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("message").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

/// The picks kept for a home, by category.
pub(crate) fn read_picks(host_dir: &Path) -> Map<String, Value> {
    std::fs::read_to_string(host_dir.join(PICKS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .map(|picks| picks.into_iter().filter(|(category, value)| PICKED.contains(&category.as_str()) && value.is_string()).collect())
        .unwrap_or_default()
}

/// Keeps a confirmed pick, written whole through a temporary file.
pub(crate) fn keep_pick(host_dir: &Path, category: &str, value: &str) -> Result<(), String> {
    let mut picks = read_picks(host_dir);
    picks.insert(category.to_string(), json!(value));
    let body = serde_json::to_string_pretty(&Value::Object(picks)).map_err(|e| e.to_string())?;
    let temporary = host_dir.join(format!("{PICKS_FILE}.tmp"));
    std::fs::write(&temporary, body).map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, host_dir.join(PICKS_FILE)).map_err(|e| format!("could not keep the pick: {e}"))
}

/// Something that sends one request to the adapter and waits a bounded time for its answer.
pub(crate) trait Requester {
    async fn ask(&self, method: &str, params: Value) -> Result<Value, String>;
}

/// Why a change did not take: the adapter's reason, and the options as they stand after it, when known.
#[derive(Debug)]
pub(crate) struct Refused {
    pub reason: String,
    pub options: Option<Vec<Value>>,
    /// The value cannot run the home's permission mode.
    pub unfit: bool,
}

/// Sets one option and returns the options the adapter answered with. A model that
/// makes the adapter drop the home's permission mode is put back, with the mode.
pub(crate) async fn set_option(
    rpc: &impl Requester,
    session_id: &str,
    options: &[Value],
    category: &str,
    value: &str,
    posture: &str,
) -> Result<Vec<Value>, Refused> {
    let refused = |reason: String| Refused { reason, options: None, unfit: false };
    let option = category_of(options, category).ok_or_else(|| refused(format!("this first mate's session offers no {category} setting")))?;
    let id = option.get("id").and_then(Value::as_str).unwrap_or(category).to_string();
    if !offers(&option, value) {
        return Err(refused(format!("{value} is not one of the values this session offers")));
    }
    let answered = rpc
        .ask("session/set_config_option", json!({"sessionId": session_id, "configId": id, "value": value}))
        .await
        .map_err(|error| refused(refusal(&error)))?;
    let after = options_of(&answered);
    let mode = category_of(&after, "mode");
    let dropped = category == "model" && mode.as_ref().and_then(current).is_some_and(|mode| mode != posture);
    if !dropped {
        return Ok(after);
    }
    // The adapter clamped the permission mode for this model: put the model back, then the mode.
    let name = value_name(&option, value);
    let previous = current(&option).unwrap_or("default").to_string();
    let mut reason = format!("{name} can't run this home's {posture} permissions, so the first mate stayed on {}", value_name(&option, &previous));
    let restored = rpc
        .ask("session/set_config_option", json!({"sessionId": session_id, "configId": id, "value": previous}))
        .await
        .map(|answered| options_of(&answered));
    let mode_back = rpc.ask("session/set_mode", json!({"sessionId": session_id, "modeId": posture})).await;
    if let Err(error) = &restored {
        reason = format!("{name} can't run this home's {posture} permissions, and putting the model back failed: {}", refusal(error));
    }
    if let Err(error) = &mode_back {
        reason = format!("{reason}. Putting the permission mode back failed too: {}", refusal(error));
    }
    let mut options = restored.ok();
    // `set_mode` answers with nothing: the mode it set is what the options must say.
    if mode_back.is_ok() {
        if let Some(options) = options.as_mut() {
            for option in options.iter_mut().filter(|option| option.get("category").and_then(Value::as_str) == Some("mode")) {
                option["currentValue"] = json!(posture);
            }
        }
    }
    Err(Refused { reason, options, unfit: true })
}

/// Applies each kept pick the session offers and is not already on, in order. Returns the
/// options as they stand after, and why each pick that could not be applied was not.
pub(crate) async fn apply_picks(
    rpc: &impl Requester,
    session_id: &str,
    mut options: Vec<Value>,
    picks: &Map<String, Value>,
    posture: &str,
    skip: Option<&str>,
) -> (Vec<Value>, Map<String, Value>, HashMap<String, String>) {
    let mut problems = Map::new();
    let mut unfit = HashMap::new();
    for category in PICKED {
        if Some(category) == skip {
            continue;
        }
        let Some(value) = picks.get(category).and_then(Value::as_str) else { continue };
        // A model without efforts offers no effort option; that is the model's, not a problem.
        let Some(option) = category_of(&options, category) else { continue };
        if current(&option) == Some(value) {
            continue;
        }
        if !offers(&option, value) {
            problems.insert(category.to_string(), json!({"value": value, "reason": format!("this session no longer offers {value}")}));
            continue;
        }
        match set_option(rpc, session_id, &options, category, value, posture).await {
            Ok(after) => options = after,
            Err(refused) => {
                if refused.unfit {
                    unfit.insert(unfit_key(category, value), refused.reason.clone());
                }
                if let Some(after) = refused.options {
                    options = after;
                }
                problems.insert(category.to_string(), json!({"value": value, "reason": refused.reason}));
            }
        }
    }
    (options, problems, unfit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The configOptions `claude-agent-acp` 0.69.0 returned from `session/new`, verbatim
    /// (scout qd-fmsettings-1, run1), trimmed to what these tests read.
    fn opus_options() -> Vec<Value> {
        serde_json::from_value(json!([
            {"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "auto", "options": [{"value": "auto", "name": "Auto"}, {"value": "default", "name": "Manual"}, {"value": "bypassPermissions", "name": "Bypass Permissions"}]},
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "default", "options": [{"value": "default", "name": "Default (recommended)", "description": "Opus (1M context)"}, {"value": "opus[1m]", "name": "Opus (1M context)"}, {"value": "sonnet", "name": "Sonnet"}, {"value": "haiku", "name": "Haiku"}]},
            {"id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": "default", "options": [{"value": "default", "name": "Default"}, {"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]}
        ]))
        .unwrap()
    }

    /// Answers like the adapter: a set rebuilds the list; Haiku drops effort and, in an auto home, clamps the mode.
    struct FakeAdapter {
        options: Mutex<Vec<Value>>,
        asked: Mutex<Vec<(String, Value)>>,
        refuse: Option<&'static str>,
    }

    impl FakeAdapter {
        fn new(options: Vec<Value>) -> Self {
            FakeAdapter { options: Mutex::new(options), asked: Mutex::new(Vec::new()), refuse: None }
        }
    }

    impl Requester for FakeAdapter {
        async fn ask(&self, method: &str, params: Value) -> Result<Value, String> {
            self.asked.lock().unwrap().push((method.to_string(), params.clone()));
            if method == "session/set_mode" {
                let mut options = self.options.lock().unwrap();
                for option in options.iter_mut().filter(|o| o["id"] == "mode") {
                    option["currentValue"] = params["modeId"].clone();
                }
                return Ok(json!({}));
            }
            if let Some(details) = self.refuse {
                return Err(json!({"code": -32603, "message": "Internal error", "data": {"details": details}}).to_string());
            }
            let mut options = self.options.lock().unwrap();
            let id = params["configId"].as_str().unwrap();
            let value = params["value"].clone();
            if id == "model" && value == "haiku" {
                options.retain(|o| o["id"] != "effort");
                for option in options.iter_mut().filter(|o| o["id"] == "mode") {
                    if option["currentValue"] == "auto" {
                        option["currentValue"] = json!("default");
                    }
                }
            } else if id == "model" && !options.iter().any(|o| o["id"] == "effort") {
                options.push(opus_options()[2].clone());
            }
            for option in options.iter_mut().filter(|o| o["id"] == id) {
                option["currentValue"] = value.clone();
            }
            Ok(json!({"configOptions": *options}))
        }
    }

    fn picks(entries: &[(&str, &str)]) -> Map<String, Value> {
        entries.iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
    }

    #[tokio::test]
    async fn a_change_is_sent_as_set_config_option_by_the_options_own_id() {
        let adapter = FakeAdapter::new(opus_options());
        let after = set_option(&adapter, "s1", &opus_options(), "thought_level", "high", "auto").await.unwrap();
        let asked = adapter.asked.lock().unwrap().clone();
        assert_eq!(asked, vec![("session/set_config_option".to_string(), json!({"sessionId": "s1", "configId": "effort", "value": "high"}))]);
        assert_eq!(category_of(&after, "thought_level").unwrap()["currentValue"], "high");
    }

    #[tokio::test]
    async fn a_value_the_session_does_not_offer_never_reaches_it() {
        let adapter = FakeAdapter::new(opus_options());
        let refused = set_option(&adapter, "s1", &opus_options(), "model", "gpt-9", "auto").await.unwrap_err();
        assert!(refused.reason.contains("not one of the values"), "{refused:?}");
        let refused = set_option(&adapter, "s1", &opus_options(), "fast", "on", "auto").await.unwrap_err();
        assert!(refused.reason.contains("offers no fast setting"), "{refused:?}");
        assert!(adapter.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refusal_is_the_adapters_own_details() {
        let mut adapter = FakeAdapter::new(opus_options());
        adapter.refuse = Some("Invalid value for config option model: sonnet");
        let refused = set_option(&adapter, "s1", &opus_options(), "model", "sonnet", "auto").await.unwrap_err();
        assert_eq!(refused.reason, "Invalid value for config option model: sonnet");
        assert!(!refused.unfit && refused.options.is_none());
    }

    #[tokio::test]
    async fn a_model_that_drops_the_homes_mode_is_put_back_with_the_mode() {
        let adapter = FakeAdapter::new(opus_options());
        let refused = set_option(&adapter, "s1", &opus_options(), "model", "haiku", "auto").await.unwrap_err();
        assert!(refused.unfit, "{refused:?}");
        assert_eq!(refused.reason, "Haiku can't run this home's auto permissions, so the first mate stayed on Default");
        let options = refused.options.unwrap();
        assert_eq!(category_of(&options, "model").unwrap()["currentValue"], "default");
        assert_eq!(category_of(&options, "mode").unwrap()["currentValue"], "auto");
        let methods: Vec<String> = adapter.asked.lock().unwrap().iter().map(|(m, p)| format!("{m} {}", p.get("value").or(p.get("modeId")).unwrap())).collect();
        assert_eq!(methods, ["session/set_config_option \"haiku\"", "session/set_config_option \"default\"", "session/set_mode \"auto\""]);
    }

    #[tokio::test]
    async fn a_bypass_home_keeps_its_mode_on_any_model() {
        let mut options = opus_options();
        options[0]["currentValue"] = json!("bypassPermissions");
        let adapter = FakeAdapter::new(options.clone());
        let after = set_option(&adapter, "s1", &options, "model", "haiku", "bypassPermissions").await.unwrap();
        assert_eq!(category_of(&after, "model").unwrap()["currentValue"], "haiku");
        assert!(category_of(&after, "thought_level").is_none(), "Haiku offers no effort");
    }

    #[tokio::test]
    async fn kept_picks_are_applied_model_first_and_only_where_needed() {
        let adapter = FakeAdapter::new(opus_options());
        let (after, problems, unfit) = apply_picks(&adapter, "s1", opus_options(), &picks(&[("thought_level", "high"), ("model", "sonnet")]), "auto", None).await;
        let asked: Vec<Value> = adapter.asked.lock().unwrap().iter().map(|(_, p)| p["configId"].clone()).collect();
        assert_eq!(asked, [json!("model"), json!("effort")], "model goes first: it rebuilds the efforts");
        assert_eq!(category_of(&after, "model").unwrap()["currentValue"], "sonnet");
        assert_eq!(category_of(&after, "thought_level").unwrap()["currentValue"], "high");
        assert!(problems.is_empty() && unfit.is_empty());

        // Already there: nothing is sent.
        let adapter = FakeAdapter::new(after.clone());
        apply_picks(&adapter, "s1", after, &picks(&[("thought_level", "high"), ("model", "sonnet")]), "auto", None).await;
        assert!(adapter.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_pick_that_cannot_be_applied_says_why_and_stops_nothing() {
        let mut adapter = FakeAdapter::new(opus_options());
        adapter.refuse = Some("Invalid value for config option effort: high");
        let (after, problems, _) = apply_picks(&adapter, "s1", opus_options(), &picks(&[("thought_level", "high"), ("model", "gone-model")]), "auto", None).await;
        assert_eq!(problems["model"]["reason"], "this session no longer offers gone-model");
        assert_eq!(problems["thought_level"]["reason"], "Invalid value for config option effort: high");
        assert_eq!(after, opus_options(), "nothing is shown that the adapter did not confirm");
    }

    #[tokio::test]
    async fn an_unfit_model_is_kept_under_its_category_not_its_bare_value() {
        let adapter = FakeAdapter::new(opus_options());
        let (_, problems, unfit) = apply_picks(&adapter, "s1", opus_options(), &picks(&[("model", "haiku")]), "auto", None).await;
        assert!(problems["model"]["reason"].as_str().unwrap().contains("can't run this home's auto permissions"));
        assert_eq!(unfit.keys().collect::<Vec<_>>(), [&unfit_key("model", "haiku")]);
        assert!(!unfit.contains_key(&unfit_key("thought_level", "haiku")) && !unfit.contains_key("haiku"));
    }

    #[tokio::test]
    async fn effort_on_a_model_without_efforts_is_not_a_problem() {
        let mut options = opus_options();
        options[0]["currentValue"] = json!("bypassPermissions");
        let adapter = FakeAdapter::new(options.clone());
        let haiku = set_option(&adapter, "s1", &options, "model", "haiku", "bypassPermissions").await.unwrap();
        let (_, problems, _) = apply_picks(&adapter, "s1", haiku, &picks(&[("thought_level", "high")]), "bypassPermissions", None).await;
        assert!(problems.is_empty(), "{problems:?}");
    }

    #[test]
    fn picks_are_kept_per_home_and_only_for_what_the_captain_may_change() {
        let dir = std::env::temp_dir().join(format!("qd-picks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_picks(&dir).is_empty());
        keep_pick(&dir, "model", "sonnet").unwrap();
        keep_pick(&dir, "thought_level", "high").unwrap();
        keep_pick(&dir, "model", "opus[1m]").unwrap();
        std::fs::write(dir.join("other.json"), "{}").unwrap();
        assert_eq!(Value::Object(read_picks(&dir)), json!({"model": "opus[1m]", "thought_level": "high"}));
        std::fs::write(dir.join(PICKS_FILE), r#"{"mode": "bypassPermissions", "model": "sonnet"}"#).unwrap();
        assert_eq!(Value::Object(read_picks(&dir)), json!({"model": "sonnet"}), "the permission mode is never a pick");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commands_keep_name_description_and_hint() {
        let update = json!({"sessionUpdate": "available_commands_update", "availableCommands": [
            {"name": "afk", "description": "Enter the away posture.", "input": null},
            {"name": "effort", "description": "Set effort level for model usage", "input": {"hint": "<low|medium|high|xhigh|max|ultracode|auto>"}},
            {"name": "", "description": "nameless"}
        ]});
        let mut controls = Controls::default();
        assert!(controls.note(&update));
        assert_eq!(controls.commands.unwrap(), vec![
            json!({"name": "afk", "description": "Enter the away posture.", "hint": null}),
            json!({"name": "effort", "description": "Set effort level for model usage", "hint": "<low|medium|high|xhigh|max|ultracode|auto>"}),
        ]);
    }
}
