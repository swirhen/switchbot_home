// リリース版ではコンソール窓を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! SwitchBot Home をタスクトレイから開くアプリ。
//! 窓は本番の Web アプリ（コンパクト表示）を直接開くだけで、画面や処理は持たない。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_positioner::{Position, WindowExt};

// 環境変数 SWITCHBOT_HOME_URL で開く先を変えられる（手元の開発用サーバーで試すとき）
const DEFAULT_BASE_URL: &str = "https://swirhen.tv/switchbot_home/";
const WINDOW_LABEL: &str = "main";
// 窓の外（トレイアイコンを含む）をクリックして隠れた直後のクリックは、開き直さない
const REOPEN_GUARD: Duration = Duration::from_millis(300);
// フォーカスが外れた後、他のウインドウが前面に来たかを調べる間隔
const FOREGROUND_POLL: Duration = Duration::from_millis(50);

#[derive(Default)]
struct TrayState {
    hidden_at: Mutex<Option<Instant>>,
    // トレイアイコンの位置が分かってから、トレイ基準で窓を置く
    tray_known: AtomicBool,
    // フォーカスが変わるたびに増やし、古い監視を止める
    focus_generation: AtomicU64,
}

fn base_url() -> String {
    std::env::var("SWITCHBOT_HOME_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn hide(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
        *app.state::<TrayState>().hidden_at.lock().unwrap() = Some(Instant::now());
    }
}

/// 窓が前面（アクティブ）か。WebView のフォーカスとは別に、窓そのものを見る
#[cfg(windows)]
fn is_foreground(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let Ok(hwnd) = window.hwnd() else { return false };
    unsafe { GetForegroundWindow() as isize == hwnd.0 as isize }
}

#[cfg(not(windows))]
fn is_foreground(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

/// フォーカスが外れたら、他のウインドウが前面に来た時点で隠す。
/// 枠なしの窓は縁の子ウインドウでリサイズを受けるため、縁をつかむだけで WebView のフォーカスが外れる。
/// そのときも窓は前面のままなので、前面でなくなるまで待てばリサイズ中に隠れない
fn watch_focus_lost(app: &AppHandle) {
    let state = app.state::<TrayState>();
    let generation = state.focus_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(FOREGROUND_POLL);
        // フォーカスが戻った（または新しい監視が始まった）
        if app.state::<TrayState>().focus_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        let Some(window) = main_window(&app) else { return };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        if !is_foreground(&window) {
            hide(&app);
            return;
        }
    });
}

/// 窓をトレイの上に出す。hash を渡すとそのページ（#/layout など）に移る
fn show(app: &AppHandle, hash: Option<&str>) {
    let Some(window) = main_window(app) else { return };
    if let Some(hash) = hash {
        let _ = window.eval(&format!("location.hash = {hash:?}"));
    }
    let position = if app.state::<TrayState>().tray_known.load(Ordering::Relaxed) {
        Position::TrayCenter
    } else {
        Position::BottomRight
    };
    let _ = window.move_window(position);
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    if window.is_visible().unwrap_or(false) {
        hide(app);
        return;
    }
    let just_hidden = app
        .state::<TrayState>()
        .hidden_at
        .lock()
        .unwrap()
        .is_some_and(|at| at.elapsed() < REOPEN_GUARD);
    if !just_hidden {
        show(app, None);
    }
}

fn main() {
    tauri::Builder::default()
        // 2つ目を起動しようとしたら、動いている方の窓を出す
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app, None)))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .manage(TrayState::default())
        .setup(|app| {
            let url = format!("{}?compact#/layout", base_url());
            let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url.parse()?))
                .title("SwitchBot Home")
                .inner_size(420.0, 640.0)
                .min_inner_size(300.0, 300.0)
                .decorations(false)
                .resizable(true)
                .skip_taskbar(true)
                .always_on_top(true)
                .visible(false)
                .build()?;

            let handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                // 他の場所をクリックしたら隠す（リサイズで外れたときは隠さない）
                WindowEvent::Focused(false) => watch_focus_lost(&handle),
                WindowEvent::Focused(true) => {
                    handle.state::<TrayState>().focus_generation.fetch_add(1, Ordering::Relaxed);
                }
                // Alt+F4 などで閉じてもアプリは終わらせず、隠すだけにする
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide(&handle);
                }
                _ => {}
            });

            let open = MenuItem::with_id(app, "open", "開く", true, None::<&str>)?;
            let layout = MenuItem::with_id(app, "layout", "レイアウト", true, None::<&str>)?;
            let schedule = MenuItem::with_id(app, "schedule", "スケジュール", true, None::<&str>)?;
            let dashboard = MenuItem::with_id(app, "dashboard", "一覧", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "ブラウザで開く", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Windows 起動時に開始",
                true,
                app.autolaunch().is_enabled().unwrap_or(false),
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &layout,
                    &schedule,
                    &dashboard,
                    &PredefinedMenuItem::separator(app)?,
                    &browser,
                    &autostart,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            let autostart_item = autostart.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("アイコンがありません")?)
                .tooltip("SwitchBot Home")
                .menu(&menu)
                // 左クリックは窓の開閉、右クリックでメニュー
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show(app, None),
                    "layout" => show(app, Some("#/layout")),
                    "schedule" => show(app, Some("#/schedule")),
                    "dashboard" => show(app, Some("#/")),
                    "browser" => {
                        let _ = app.opener().open_url(format!("{}#/layout", base_url()), None::<&str>);
                    }
                    "autostart" => {
                        // チェックはクリックで切り替わるので、その状態に合わせて登録・解除する
                        let manager = app.autolaunch();
                        let enabled = autostart_item.is_checked().unwrap_or(false);
                        let result = if enabled { manager.enable() } else { manager.disable() };
                        if result.is_err() {
                            let _ = autostart_item.set_checked(manager.is_enabled().unwrap_or(false));
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    tauri_plugin_positioner::on_tray_event(app, &event);
                    app.state::<TrayState>().tray_known.store(true, Ordering::Relaxed);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle(app);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("SwitchBot Home Tray を起動できませんでした");
}
