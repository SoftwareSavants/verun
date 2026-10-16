//! Attribute Claude output by message identity, never by text equality.
use dashmap::DashMap;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    Stream,
    Transcript,
}
#[derive(Default, Debug)]
pub struct Claims {
    owners: HashMap<String, Source>,
    order: VecDeque<String>,
}
pub type SharedClaims = Arc<Mutex<Claims>>;
#[derive(Default)]
pub struct SourceRegistry(DashMap<String, SharedClaims>);
pub fn for_session(app: &tauri::AppHandle, session: &str) -> Option<SharedClaims> {
    let registry = app.try_state::<SourceRegistry>()?;
    let claims = registry.0.entry(session.into()).or_default().clone();
    Some(claims)
}
pub fn claim_input(app: &tauri::AppHandle, session: &str, bytes: &[u8]) {
    if let (Some(claims), Ok(value)) = (
        for_session(app, session),
        serde_json::from_slice::<Value>(bytes),
    ) {
        claims.lock().unwrap().input(&value);
    }
}
impl Claims {
    pub fn input(&mut self, value: &Value) {
        self.claim("user", value["uuid"].as_str(), Source::Stream);
    }

    fn claim(&mut self, prefix: &str, id: Option<&str>, source: Source) -> bool {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return true;
        };
        let key = format!("{prefix}:{id}");
        if let Some(owner) = self.owners.get(&key) {
            return *owner == source;
        }
        // IDs only; no prompt or response content is retained. Bound long sessions.
        if self.order.len() >= 50_000 {
            if let Some(old) = self.order.pop_front() {
                self.owners.remove(&old);
            }
        }
        self.owners.insert(key.clone(), source);
        self.order.push_back(key);
        true
    }
    fn blocks(&mut self, value: &mut Value, source: Source) {
        if let Some(blocks) = value
            .pointer_mut("/message/content")
            .and_then(Value::as_array_mut)
        {
            blocks.retain(|block| match block["type"].as_str() {
                Some("tool_use") => self.claim("tool", block["id"].as_str(), source),
                Some("tool_result") => self.claim("result", block["tool_use_id"].as_str(), source),
                _ => true,
            });
        }
    }
    /// False suppresses only display items; callers still handle lifecycle/control frames.
    pub fn stream(&mut self, value: &mut Value, current: &mut Option<String>) -> bool {
        match value["type"].as_str() {
            Some("stream_event") => {
                let event = &value["event"];
                if event["type"] == "message_start" {
                    *current = event["message"]["id"].as_str().map(str::to_owned);
                }
                if !self.claim("message", current.as_deref(), Source::Stream) {
                    return false;
                }
                if event["type"] == "content_block_start"
                    && event["content_block"]["type"] == "tool_use"
                {
                    return self.claim(
                        "tool",
                        event["content_block"]["id"].as_str(),
                        Source::Stream,
                    );
                }
                true
            }
            Some("assistant") => {
                if !self.claim("message", value["message"]["id"].as_str(), Source::Stream) {
                    return false;
                }
                self.blocks(value, Source::Stream);
                true
            }
            Some("user") => {
                // SDK user text echoes are not rendered. Only sent inputs are
                // claimed explicitly; tool results arbitrate independently.
                self.blocks(value, Source::Stream);
                true
            }
            _ => true,
        }
    }
    pub fn transcript(&mut self, mut value: Value) -> Option<Value> {
        let source = Source::Transcript;
        match value["type"].as_str() {
            Some("assistant")
                if !self.claim("message", value["message"]["id"].as_str(), source) =>
            {
                return None
            }
            Some("user") if !self.claim("user", value["uuid"].as_str(), source) => return None,
            _ => {}
        }
        self.blocks(&mut value, source);
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sdk_user_echo_is_hidden_but_repeated_terminal_prompt_is_kept() {
        let mut claims = Claims::default();
        let input = json!({"type":"user","uuid":"sdk-user","message":{"content":"same text"}});
        claims.input(&input);
        assert!(claims.transcript(input).is_none());
        assert!(claims
            .transcript(
                json!({"type":"user","uuid":"terminal-user","message":{"content":"same text"}})
            )
            .is_some());
    }

    #[test]
    fn assistant_message_has_one_owner_in_either_arrival_order() {
        for terminal_first in [false, true] {
            let mut claims = Claims::default();
            let snapshot = json!({"type":"assistant","uuid":"a","message":{"id":"msg-a","content":[{"type":"text","text":"hello"}]}});
            if terminal_first {
                assert!(claims.transcript(snapshot.clone()).is_some());
            }
            let mut current = None;
            let mut start = json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-a"}}});
            claims.stream(&mut start, &mut current);
            let mut delta = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}});
            assert_eq!(claims.stream(&mut delta, &mut current), !terminal_first);
            if !terminal_first {
                assert!(claims.transcript(snapshot).is_none());
            }
        }
    }

    #[test]
    fn result_can_arrive_from_stream_after_transcript_owned_tool_start() {
        let mut claims = Claims::default();
        claims.transcript(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"tool","name":"Bash"}]}}));
        let mut result = json!({"type":"user","uuid":"result","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"OK"}]}});
        assert!(claims.stream(&mut result, &mut None));
        assert_eq!(result["message"]["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn tool_result_echo_is_filtered_by_tool_id_not_result_text() {
        let mut claims = Claims::default();
        let mut current = None;
        let mut start = json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"sdk-tool"}}});
        claims.stream(&mut start, &mut current);
        let mut streamed_result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"sdk-tool","content":"OK"}]}});
        claims.stream(&mut streamed_result, &mut current);
        let result = json!({"type":"user","uuid":"results","message":{"content":[
            {"type":"tool_result","tool_use_id":"sdk-tool","content":"OK"},
            {"type":"tool_result","tool_use_id":"terminal-tool","content":"OK"}
        ]}});
        let kept = claims.transcript(result).unwrap();
        assert_eq!(kept["message"]["content"].as_array().unwrap().len(), 1);
        assert_eq!(
            kept["message"]["content"][0]["tool_use_id"],
            "terminal-tool"
        );
    }
}
