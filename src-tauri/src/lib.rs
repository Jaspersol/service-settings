use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::LazyLock;
#[cfg(windows)]
use windows::core::{w, PCWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
#[cfg(windows)]
use windows::Win32::System::Services::{
    CloseServiceHandle, ControlService, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx,
    StartServiceW, SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_CONTROL_STOP,
    SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START, SERVICE_STATUS, SERVICE_STATUS_PROCESS,
    SERVICE_STOP,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
#[cfg(windows)]
use windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const INVALID_PAYLOAD_MESSAGE: &str = "请求参数不合法";
const UNKNOWN_ACTION_MESSAGE: &str = "未知操作";
const INVALID_NAME_MESSAGE: &str = "服务名称不合法";
#[cfg(not(windows))]
const UNSUPPORTED_PLATFORM_MESSAGE: &str = "不支持此平台：服务控制仅在 Windows 上可用";
#[cfg(windows)]
const NOT_ELEVATED_MESSAGE: &str = "权限不足，请点击标题栏的「以管理员重启」按钮重新启动程序";

#[cfg(windows)]
static ELEVATION_REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static IS_ELEVATED: LazyLock<bool> = LazyLock::new(detect_elevation);

// 每次写盘用唯一临时文件名，避免多个并发保存共用同一个 tmp 互相踩
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

const CONFIG_FILE: &str = "services.json";

/// 统一返回结构：前端 switch.js 在 .catch 之外还会读 res.message，
/// 所以服务命令绝不能用 Result::Err 把失败变成 invoke 的 reject。
#[derive(Serialize)]
struct CommandResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl CommandResult {
    fn fail(message: impl Into<String>) -> Self {
        Self {
            success: false,
            running: None,
            message: Some(message.into()),
        }
    }

    #[cfg(windows)]
    fn ok(running: Option<bool>) -> Self {
        Self {
            success: true,
            running,
            message: None,
        }
    }
}

/// 服务清单里的一条记录。开关状态不落盘：它是运行时缓存，
/// 启动时与每 5 秒刷新都从 SCM 读回，写进文件只会让它与真实状态漂移。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceEntry {
    dom_name: String,
    service_name: String,
}

/// 与 src/shared/services.js 的 SERVICE_NAME_PATTERN 保持一致。
/// JS 的 \w 在无 u flag 时只匹配 ASCII，因此这里显式限定 ASCII，
/// 避免中文服务名在两侧判定不一致；同时限制在 Win32 服务名上限 255 字符内。
fn valid_service_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'$' | b'-'))
}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// 读取服务列表；配置文件不存在时返回空数组。
/// 解析失败时先把损坏文件改名备份，绝不让调用方用占位数据覆盖它。
#[tauri::command]
fn load_services(app: tauri::AppHandle) -> Result<Vec<ServiceEntry>, String> {
    load_services_from_path(&config_dir(&app)?.join(CONFIG_FILE))
}

/// 与 AppHandle 解耦，便于测试损坏文件的备份行为。
fn load_services_from_path(path: &Path) -> Result<Vec<ServiceEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    // 旧版 / 手工编辑的文件可能带 status / isChanging 等额外字段，serde 默认忽略
    match serde_json::from_str::<Vec<ServiceEntry>>(&text) {
        Ok(list) => Ok(list),
        Err(err) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_file_name(format!(
                "{}.bad-{}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                ts
            ));
            // 备份失败也要把解析错误报出去，不能静默吞掉
            let _ = std::fs::rename(path, &backup);
            Err(format!(
                "配置损坏：{}；原文件已备份为 {}",
                err,
                backup.file_name().unwrap_or_default().to_string_lossy()
            ))
        }
    }
}

/// 整体写入服务列表：唯一临时文件 + fsync + 原子替换。
#[tauri::command]
fn save_services(app: tauri::AppHandle, list: Vec<ServiceEntry>) -> Result<(), String> {
    save_services_to_dir(&config_dir(&app)?, &list)
}

/// 与 AppHandle 解耦；并发调用各自用不同的临时文件，不会互相覆盖。
fn save_services_to_dir(dir: &Path, list: &[ServiceEntry]) -> Result<(), String> {
    use std::io::Write;

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(CONFIG_FILE);
    let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{CONFIG_FILE}.{}.{}.tmp", std::process::id(), seq));
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;

    let result = std::fs::File::create(&tmp)
        .map_err(|e| e.to_string())
        .and_then(|mut f| {
            f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())
        })
        .and_then(|_| std::fs::rename(&tmp, &path).map_err(|e| e.to_string()));
    if result.is_err() {
        // 写盘或 rename 失败时清掉临时文件，避免残留
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 把 Win32 错误码映射成可读中文；其余交给系统本地化消息
/// （FormatMessageW，中文系统下本身就是中文，不再需要 GBK 解码）。
#[cfg(windows)]
fn scm_message(err: windows::core::Error) -> String {
    let code = (err.code().0 as u32) & 0xFFFF;
    match code {
        5 => "拒绝访问：请以管理员身份重试".to_string(),
        1060 => "服务不存在：请确认填写的是服务名称（不是显示名称）".to_string(),
        1056 => "服务已在运行中".to_string(),
        1062 => "服务当前未运行".to_string(),
        1053 => "服务未及时响应启动或停止请求".to_string(),
        _ => err.message(),
    }
}

/// 用 SERVICE_STATUS_PROCESS 直接读状态码，不再解析 sc query 的文本。
#[cfg(windows)]
fn query_running(service: windows::Win32::System::Services::SC_HANDLE) -> Result<bool, windows::core::Error> {
    let mut buf = [0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
    let mut needed = 0u32;
    unsafe {
        QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, Some(&mut buf[..]), &mut needed)?;
        let status: SERVICE_STATUS_PROCESS =
            std::ptr::read_unaligned(buf.as_ptr() as *const SERVICE_STATUS_PROCESS);
        Ok(status.dwCurrentState == SERVICE_RUNNING)
    }
}

/// 固定 Win32 SCM 调用，按 action 申请最小权限，绝不拼 shell 命令。
/// 返回 status 查询的运行状态；start / stop 返回 false（调用方不使用）。
#[cfg(windows)]
fn scm_action(action: &str, name: &str) -> Result<bool, String> {
    use windows::Win32::System::Services::SC_HANDLE;

    unsafe {
        let name_wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT)
            .map_err(scm_message)?;

        let desired = match action {
            "status" => SERVICE_QUERY_STATUS,
            "start" => SERVICE_START,
            _ => SERVICE_STOP,
        };
        let service: SC_HANDLE = match OpenServiceW(scm, PCWSTR(name_wide.as_ptr()), desired) {
            Ok(handle) => handle,
            Err(err) => {
                let _ = CloseServiceHandle(scm);
                return Err(scm_message(err));
            }
        };

        let result = match action {
            "status" => query_running(service),
            "start" => StartServiceW(service, None).map(|_| false),
            _ => {
                let mut status = SERVICE_STATUS::default();
                ControlService(service, SERVICE_CONTROL_STOP, &mut status).map(|_| false)
            }
        };

        let _ = CloseServiceHandle(service);
        let _ = CloseServiceHandle(scm);
        result.map_err(scm_message)
    }
}

/// 提权检测结果缓存：整个进程生命周期只检测一次。
#[cfg(windows)]
fn is_elevated() -> bool {
    *IS_ELEVATED
}

#[cfg(windows)]
fn detect_elevation() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

/// 以 runas 重启自身。返回 true 表示已成功发起，调用方应立即退出；
/// 用户拒绝 UAC 时 ShellExecuteW 返回 <= 32，此时标志不置位，允许再次重试。
#[cfg(windows)]
fn restart_as_admin() -> bool {
    use std::os::windows::ffi::OsStrExt;

    // 只有真正成功发起过提权才锁住，避免拒绝 UAC 后再也弹不出来
    if ELEVATION_REQUESTED.load(Ordering::SeqCst) {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let wide: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("runas"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let launched = result.0 as usize > 32;
    if launched {
        ELEVATION_REQUESTED.store(true, Ordering::SeqCst);
    }
    launched
}

/// 前端据此决定标题栏是否显示「以管理员重启」。
#[cfg(windows)]
#[tauri::command]
fn elevation_status() -> bool {
    is_elevated()
}

#[cfg(not(windows))]
#[tauri::command]
fn elevation_status() -> bool {
    false
}

/// 用户主动重试提权；成功时结束当前进程，由 runas 启动的新进程接管。
#[cfg(windows)]
#[tauri::command]
fn elevate(app: tauri::AppHandle) -> bool {
    if restart_as_admin() {
        app.exit(0);
        return true;
    }
    false
}

#[cfg(not(windows))]
#[tauri::command]
fn elevate(_app: tauri::AppHandle) -> bool {
    false
}

#[tauri::command]
fn service_command(action: Option<String>, name: Option<String>) -> CommandResult {
    let (Some(action), Some(name)) = (action, name) else {
        return CommandResult::fail(INVALID_PAYLOAD_MESSAGE);
    };
    if !matches!(action.as_str(), "status" | "start" | "stop") {
        return CommandResult::fail(UNKNOWN_ACTION_MESSAGE);
    }
    if !valid_service_name(&name) {
        return CommandResult::fail(INVALID_NAME_MESSAGE);
    }

    #[cfg(not(windows))]
    {
        let _ = (&action, &name);
        return CommandResult::fail(UNSUPPORTED_PLATFORM_MESSAGE);
    }

    #[cfg(windows)]
    {
        // status 只读、免提权；start / stop 才需要管理员权限
        if action != "status" && !is_elevated() {
            return CommandResult::fail(NOT_ELEVATED_MESSAGE);
        }
        match scm_action(&action, &name) {
            Err(message) => CommandResult::fail(message),
            Ok(running) => CommandResult::ok(if action == "status" {
                Some(running)
            } else {
                None
            }),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            {
                // 启动时检测一次；未提权最多发起一次自我重启。
                // 用户拒绝 UAC 时不退出，窗口照常打开，标题栏保留重试入口。
                if !is_elevated() && restart_as_admin() {
                    std::process::exit(0);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            service_command,
            load_services,
            save_services,
            elevation_status,
            elevate
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "service-settings-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_injection_attempts() {
        assert!(valid_service_name("MySQL84"));
        assert!(valid_service_name("My.Service_1-$"));
        assert!(!valid_service_name("MySQL84; echo x"));
        assert!(!valid_service_name("has space"));
        assert!(!valid_service_name(""));
        assert!(!valid_service_name("中文"));
    }

    #[test]
    fn rejects_overlong_service_name() {
        assert!(valid_service_name(&"a".repeat(255)));
        assert!(!valid_service_name(&"a".repeat(256)));
    }

    #[test]
    fn service_entry_does_not_persist_status() {
        let entry = ServiceEntry {
            dom_name: "mysql".into(),
            service_name: "MySQL84".into(),
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({ "domName": "mysql", "serviceName": "MySQL84" })
        );
    }

    #[test]
    fn legacy_entries_with_extra_fields_are_accepted() {
        let parsed: Vec<ServiceEntry> = serde_json::from_str(
            r#"[{"domName":"mysql","serviceName":"MySQL84","status":true,"isChanging":false}]"#,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].service_name, "MySQL84");
    }

    #[test]
    fn corrupted_config_is_backed_up() {
        let dir = temp_test_dir("corrupt");
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, "{ not json").unwrap();

        let err = load_services_from_path(&path).expect_err("must fail");
        assert!(err.starts_with("配置损坏"), "unexpected: {err}");
        assert!(!path.exists(), "corrupt file should be moved away");

        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("services.json.bad-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_saves_keep_config_valid() {
        let dir = temp_test_dir("concurrent");
        let a = vec![ServiceEntry {
            dom_name: "a".into(),
            service_name: "SvcA".into(),
        }];
        let b = vec![ServiceEntry {
            dom_name: "b".into(),
            service_name: "SvcB".into(),
        }];
        std::thread::scope(|s| {
            s.spawn(|| save_services_to_dir(&dir, &a).unwrap());
            s.spawn(|| save_services_to_dir(&dir, &b).unwrap());
        });

        // 无论谁最后 rename，配置文件都必须是完整合法的 JSON
        let text = std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        let parsed: Vec<ServiceEntry> =
            serde_json::from_str(&text).expect("config must stay valid JSON");
        assert_eq!(parsed.len(), 1);

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn command_result_shape_matches_renderer_contract() {
        assert_eq!(
            serde_json::to_value(CommandResult::ok(Some(true))).unwrap(),
            serde_json::json!({ "success": true, "running": true })
        );
        assert_eq!(
            serde_json::to_value(CommandResult::fail("未知操作")).unwrap(),
            serde_json::json!({ "success": false, "message": "未知操作" })
        );
    }

    #[cfg(windows)]
    #[test]
    fn missing_service_returns_mapped_error() {
        // 走真实 SCM 链路（只读、免提权），并验证 1060 的中文映射
        let err = scm_action("status", "NoSuchService_ZZZZ").expect_err("must fail");
        assert!(err.contains("服务不存在"), "unexpected: {err}");
    }
}
