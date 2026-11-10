// Native side of Omni.
// Phase 4 adds a tiny local web listener used once during "Sign in with Spotify":
// Spotify redirects the browser to http://127.0.0.1:43821/callback?code=…,
// we catch that single request, show a "you can close this tab" page, and hand
// the code back to the app. Nothing else listens on the network.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

static CANCEL_OAUTH: AtomicBool = AtomicBool::new(false);

const DONE_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Omni</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#15161c;color:#e8e9f0;display:grid;place-items:center;height:100vh;margin:0}
div{text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#9a9db0}</style></head>
<body><div><h1>&#10003; Connected to Spotify</h1><p>You can close this tab and go back to Omni.</p></div></body></html>"#;

fn listen_once(port: u16, timeout_secs: u64) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Couldn't open the sign-in listener on port {port}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        if CANCEL_OAUTH.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("").to_string();

                if !path.starts_with("/callback") {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    continue;
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    DONE_PAGE.len(),
                    DONE_PAGE
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                return Ok(path);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("Timed out waiting for Spotify sign-in.".into());
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Wait for Spotify to redirect back to us. Returns the callback path incl. query string.
#[tauri::command]
async fn wait_for_oauth(app: tauri::AppHandle, port: u16, timeout_secs: u64) -> Result<String, String> {
    CANCEL_OAUTH.store(false, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || listen_once(port, timeout_secs))
        .await
        .map_err(|e| e.to_string())?;
    if result.is_ok() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    result
}

#[tauri::command]
fn cancel_oauth() {
    CANCEL_OAUTH.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![wait_for_oauth, cancel_oauth])
        .run(tauri::generate_context!())
        .expect("error while running Omni");
}
