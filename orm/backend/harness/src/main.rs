//! The plugin inside a mock Tauri app, reached as the app reaches it: through the IPC and
//! its capability. A request is one JSON line `{id, command, args}` on stdin; an answer is
//! `{id, ok}` or `{id, err}` on stdout.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde_json::{Value as JsonValue, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_7otion_sqlite::migrate::{Migration, Schema};
use tauri_plugin_7otion_sqlite::migrations;

/// The one set a test may open a file under, as `notes`.
struct CreateNotes;

impl Migration for CreateNotes {
    const NAME: &'static str = "create_notes";

    fn up(schema: &mut Schema) {
        schema.create("notes", |table| {
            table.id();
            table.text("body");
        });
    }
}

fn main() {
    let app = mock_builder()
        .plugin(
            tauri_plugin_7otion_sqlite::Builder::new()
                .migrations("notes", migrations![CreateNotes])
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("the mock app builds");

    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("the mock webview builds");

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let mut answering = Vec::new();

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let webview = webview.clone();
        let out = out.clone();

        // A call blocks until its command answers, and one may wait for the writer
        // while others run, so each has a thread of its own.
        answering.push(std::thread::spawn(move || {
            let answer = answer(&webview, &line);
            let mut out = out.lock().expect("nothing is written while panicking");
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
        }));
    }

    // Stdin has ended; whatever is still running answers before the process goes.
    for task in answering {
        let _ = task.join();
    }
}

fn answer(webview: &WebviewWindow<MockRuntime>, line: &str) -> JsonValue {
    let request: JsonValue = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return json!({
                "id": JsonValue::Null,
                "err": { "code": "protocol", "message": error.to_string(), "transactionEnded": false },
            });
        }
    };

    let id = request["id"].clone();
    let command = request["command"].as_str().unwrap_or_default();
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));

    match tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: format!("plugin:7otion-sqlite|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("a local URL"),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    ) {
        Ok(body) => json!({
            "id": id,
            "ok": body.deserialize::<JsonValue>().unwrap_or(JsonValue::Null),
        }),
        Err(error) => json!({ "id": id, "err": error }),
    }
}
