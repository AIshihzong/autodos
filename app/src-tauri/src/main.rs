// Tauri shell for Autodos: shows the board in a native window. It reuses a Autodos server
// that is already running on port 4747, otherwise starts one with the Node.js on this machine.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_PORT: u16 = 4747;
const BRIDGE: &str = include_str!("bridge.js");
const SMOKE: &str = "window.autodos.notify('autodos-smoke', JSON.stringify({ url: location.href, body: document.body.className, rail: !!document.querySelector('.rail'), todos: document.querySelectorAll('.card').length, bridge: Object.keys(window.autodos) }))";

#[derive(Default)]
struct Shell {
    child: Mutex<Option<Child>>,
    url: Mutex<Option<String>>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// True when a Autodos server answers on this port.
fn is_autodos(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /api/state HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16384];
    while buf.len() < 8 << 20 {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        let text = String::from_utf8_lossy(&buf);
        if text.contains("\"todos\"") {
            return text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
        }
    }
    false
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(0)
}

/// Apps opened from Finder get a bare PATH. Ask the login shell for the user's real one, so the
/// server finds node, git, gh, claude and codex the same way it does in a terminal.
fn login_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let fallback = format!(
        "{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        home().display()
    );
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", "printf '__CB__%s__CB__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return fallback;
    };
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if let Ok(Some(_)) = child.try_wait() {
            let mut out = String::new();
            let _ = child.stdout.take().map(|mut o| o.read_to_string(&mut out));
            if let Some(p) = out.split("__CB__").nth(1).filter(|p| !p.is_empty()) {
                return format!("{p}:{fallback}");
            }
            return fallback;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    fallback
}

fn find_node(path: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("AUTODOS_NODE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    path.split(':').map(|d| Path::new(d).join("node")).find(|p| p.is_file())
}

/// The board's folder: ~/.autodos, or ~/.crewboard for a board from before the rename.
fn data_dir() -> PathBuf {
    let cur = home().join(".autodos");
    let old = home().join(".crewboard");
    if !cur.join("db.json").exists() && old.join("db.json").exists() {
        old
    } else {
        cur
    }
}

/// Folder holding server/, dist/ and package.json.
fn app_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    } else {
        app.path().resource_dir().map(|d| d.join("app")).unwrap_or_default()
    }
}

/// Returns the board's address, or a message to show when it cannot start.
fn ensure_server(app: &AppHandle) -> Result<String, (String, String)> {
    let wanted = std::env::var("AUTODOS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    if is_autodos(wanted) {
        return Ok(format!("http://127.0.0.1:{wanted}/"));
    }
    let path = login_path();
    let Some(node) = find_node(&path) else {
        return Err((
            "Node.js not found".into(),
            "Autodos runs its server with Node.js 20 or newer. Install it from <code>nodejs.org</code> or with <code>brew install node</code>, then open Autodos again.".into(),
        ));
    };
    let port = if TcpListener::bind(("127.0.0.1", wanted)).is_ok() { wanted } else { free_port() };
    let dir = app_dir(app);
    let data = data_dir();
    let _ = std::fs::create_dir_all(&data);
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data.join("desktop.log"));
    let (out, err) = match log {
        Ok(f) => (Stdio::from(f.try_clone().unwrap()), Stdio::from(f)),
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let mut child = Command::new(&node)
        .arg(dir.join("server").join("index.js"))
        .current_dir(home())
        .env("PATH", &path)
        .env("PORT", port.to_string())
        .env("AUTODOS_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| ("Could not start the server".to_string(), e.to_string()))?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        if let Ok(Some(status)) = child.try_wait() {
            return Err((
                "The server stopped".into(),
                format!("It exited with {status}. Details are in <code>~/.autodos/desktop.log</code>."),
            ));
        }
        if is_autodos(port) {
            *app.state::<Shell>().child.lock().unwrap() = Some(child);
            return Ok(format!("http://127.0.0.1:{port}/"));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let _ = child.kill();
    Err(("The server did not start".into(), "Details are in <code>~/.autodos/desktop.log</code>.".into()))
}

/// Ask our own server to shut down cleanly (it saves the board on SIGTERM).
fn stop_server(app: &AppHandle) {
    let Some(mut child) = app.state::<Shell>().child.lock().unwrap().take() else { return };
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

fn open_outside(app: &AppHandle, url: &str) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Option<String> {
    window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    // Self-check (`npm run check:desktop`): the page reports through this command, then we quit.
    if let Ok(out) = std::env::var("AUTODOS_SMOKE") {
        if title == "autodos-smoke" {
            let _ = std::fs::write(out, body);
            app.exit(0);
            return;
        }
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn set_badge(window: WebviewWindow, count: i64) {
    let _ = window.set_badge_count(if count > 0 { Some(count) } else { None });
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    open_outside(&app, &url);
}

#[tauri::command]
fn start_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) {
    let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let folder = MenuItem::with_id(app, "data-folder", "Open Data Folder", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let help = menu
        .items()?
        .into_iter()
        .filter_map(|i| i.as_submenu().cloned())
        .find(|s| s.text().map(|t| t == "Help").unwrap_or(false));
    match help {
        Some(h) => {
            h.append(&folder)?;
            h.append(&browser)?;
        }
        None => menu.append(&Submenu::with_items(app, "Help", true, &[&folder, &browser])?)?,
    }
    Ok(menu)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![pick_folder, notify, set_badge, open_external, start_drag, toggle_maximize])
        .menu(build_menu)
        .on_window_event(|window, event| {
            // On macOS closing the window keeps Autodos running, like other Mac apps.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .on_menu_event(|app, e| match e.id().as_ref() {
            "data-folder" => {
                let _ = app.opener().open_path(data_dir().to_string_lossy(), None::<&str>);
            }
            "browser" => {
                if let Some(url) = app.state::<Shell>().url.lock().unwrap().clone() {
                    open_outside(app, &url);
                }
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let nav = handle.clone();
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Autodos")
                .inner_size(1360.0, 860.0)
                .min_inner_size(760.0, 520.0)
                .initialization_script(BRIDGE)
                // Only the board itself loads in the window; anything else opens in the browser.
                .on_navigation(move |url| {
                    let ours = match url.scheme() {
                        "tauri" => true,
                        "http" | "https" => {
                            url.host_str() == Some("tauri.localhost")
                                || nav.state::<Shell>().url.lock().unwrap().as_deref().is_some_and(|u| url.as_str().starts_with(u))
                        }
                        _ => false,
                    };
                    if !ours {
                        open_outside(&nav, url.as_str());
                    }
                    ours
                });
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));
            }
            let window = builder.build()?;
            std::thread::spawn(move || match ensure_server(&handle) {
                Ok(url) => {
                    *handle.state::<Shell>().url.lock().unwrap() = Some(url.clone());
                    if let Ok(u) = url.parse() {
                        let _ = window.navigate(u);
                    }
                    if std::env::var("AUTODOS_SMOKE").is_ok() {
                        std::thread::sleep(Duration::from_secs(4));
                        let _ = window.eval(SMOKE);
                    }
                }
                Err((title, body)) => {
                    let msg = format!("{{\"title\":{:?},\"body\":{:?}}}", title, body);
                    let _ = window.eval(format!("window.autodosFail({msg})"));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Autodos");

    app.run(|app, event| match event {
        RunEvent::Exit => stop_server(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
