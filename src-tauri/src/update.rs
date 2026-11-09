use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// 最近一次检查结果。安装只接受这里缓存的值，前端无法传入任意下载地址或校验值。
static LAST_CHECK: Mutex<Option<UpdateInfo>> = Mutex::new(None);

fn cache(info: &UpdateInfo) {
    if let Ok(mut slot) = LAST_CHECK.lock() {
        *slot = Some(info.clone());
    }
}

/// 读取最近一次检查结果，不触发网络请求。
pub fn last_result() -> Option<UpdateInfo> {
    LAST_CHECK.lock().ok().and_then(|slot| slot.clone())
}

/// 发布更新安装包的仓库。
const REPO: &str = "Jaspersol/service-settings";
const USER_AGENT: &str = "ServiceSettings";
/// 自动检查最多每 6 小时请求一次；手动检查不受限制。
const AUTO_CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const PROGRESS_STEP_BYTES: u64 = 128 * 1024;
/// 无 API 兜底路径优先读取的校验清单。
const CHECKSUMS_ASSET: &str = "SHA256SUMS.txt";
const STATE_FILE: &str = "update-state.json";
/// 下载与重定向只允许 GitHub 域名，避免更新包被转到任意主机。
const DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "githubusercontent.com",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_name: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub release_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size: Option<u64>,
    pub download_url: Option<String>,
    /// 同一安装包的备用入口（API 资产地址或 latest 直链）。
    pub mirror_url: Option<String>,
    pub sha256: Option<String>,
    pub checked_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    #[serde(default)]
    last_check_ms: u64,
    /// 上次成功检查的结果。重启后仍在节流期内时，用它恢复“发现新版本”红点。
    #[serde(default)]
    last_result: Option<UpdateInfo>,
}

#[derive(Debug, Clone, PartialEq)]
struct HtmlAsset {
    name: String,
    sha256: Option<String>,
}

#[derive(Debug, Clone)]
struct ReleaseAsset {
    name: String,
    size: u64,
    url: String,
    mirror: Option<String>,
    sha256: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE))
}

fn read_state(app: &AppHandle) -> UpdateState {
    let Some(path) = state_path(app) else {
        return UpdateState::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<UpdateState>(&text).ok())
        .unwrap_or_default()
}

fn record_check(app: &AppHandle, result: Option<&UpdateInfo>) {
    let Some(path) = state_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let previous = read_state(app);
    let state = UpdateState {
        last_check_ms: now_ms(),
        // 检查失败时保留上一次成功结果，避免重启后丢失“发现新版本”。
        last_result: result.cloned().or(previous.last_result),
    };
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, text);
    }
}

/// 缓存结果只有在仍然比当前版本新时才可用（例如用户已手动升级）。
fn usable_cached_update(app: &AppHandle, info: Option<UpdateInfo>) -> Option<UpdateInfo> {
    let info = info?;
    let current = app.package_info().version.to_string();
    if info.has_update && is_newer(&current, &info.latest_version) {
        Some(info)
    } else {
        None
    }
}

/// 手动检查：主路径失败时自动切换直链兜底路径。
pub async fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    match fetch_latest_with_fallback(app).await {
        Ok(info) => {
            record_check(app, Some(&info));
            cache(&info);
            Ok(info)
        }
        Err(error) => {
            // 网络失败时把磁盘里的上次结果放进内存，前端可以继续展示。
            if let Some(info) = usable_cached_update(app, read_state(app).last_result) {
                cache(&info);
            }
            Err(error)
        }
    }
}

/// 启动时自动检查：遵守 6 小时间隔，失败静默，不打断正常使用。
pub async fn auto_check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let state = read_state(app);
    if now_ms().saturating_sub(state.last_check_ms) < AUTO_CHECK_INTERVAL_MS {
        if let Some(info) = usable_cached_update(app, state.last_result) {
            cache(&info);
            return Ok(Some(info));
        }
        return Ok(None);
    }
    match fetch_latest_with_fallback(app).await {
        Ok(info) => {
            record_check(app, Some(&info));
            cache(&info);
            Ok(info.has_update.then_some(info))
        }
        Err(error) => {
            eprintln!("自动检查更新失败: {error}");
            record_check(app, None);
            Ok(None)
        }
    }
}

fn latest_release_api() -> String {
    format!("https://api.github.com/repos/{REPO}/releases/latest")
}

fn release_page_url() -> String {
    format!("https://github.com/{REPO}/releases/latest")
}

fn latest_asset_url() -> String {
    format!("https://github.com/{REPO}/releases/latest/download/")
}

/// 主路径：GitHub Releases REST API。响应里同时给出资产名、大小与 sha256 digest。
async fn fetch_latest(app: &AppHandle) -> Result<UpdateInfo, String> {
    let client = http_client()?;
    let response = client
        .get(latest_release_api())
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("连接 GitHub 失败: {}", describe_error(&error)))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("GitHub 仓库还没有发布任何版本".to_string());
    }
    if !status.is_success() {
        if status == reqwest::StatusCode::FORBIDDEN {
            let limited = response
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.trim() == "0")
                .unwrap_or(false);
            if limited {
                return Err("GitHub API 访问次数已用完，请稍后再试".to_string());
            }
        }
        return Err(format!("检查更新失败：HTTP {}", status.as_u16()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("解析发布信息失败: {error}"))?;
    let current = app.package_info().version.to_string();
    let mut info = parse_release(&current, &body);

    // 老版本 API 没有 asset.digest 时，再读同目录的 <installer>.exe.sha256。
    if info.sha256.is_none() {
        if let Some(name) = info.asset_name.clone() {
            if let Some(checksum_url) = checksum_asset_url(&body, &name) {
                if let Ok(Some(checksum)) = fetch_checksum(&client, &checksum_url).await {
                    info.sha256 = Some(checksum);
                }
            }
        }
    }
    Ok(info)
}

/// 主路径失败后改用普通 github.com 页面：
/// 1. `releases/latest` 的重定向地址给出 tag；
/// 2. `releases/expanded_assets/<tag>` 的 HTML 内含资产名与 `sha256:` digest；
/// 3. 直链 `releases/download/<tag>/<asset>` 下载，不需要 api.github.com 配额。
async fn fetch_latest_with_fallback(app: &AppHandle) -> Result<UpdateInfo, String> {
    match fetch_latest(app).await {
        Ok(info) => Ok(info),
        Err(primary) => {
            eprintln!("检查更新主路径失败，切换直链兜底: {primary}");
            match fetch_latest_fallback(app).await {
                Ok(info) => {
                    eprintln!("已通过直链兜底完成检查更新");
                    Ok(info)
                }
                Err(fallback) => {
                    eprintln!("直链兜底同样失败: {fallback}");
                    Err(format!("{fallback}；主路径：{primary}"))
                }
            }
        }
    }
}

async fn fetch_latest_fallback(app: &AppHandle) -> Result<UpdateInfo, String> {
    let client = http_client()?;
    let tag = fallback_latest_tag(&client).await?;
    let current = app.package_info().version.to_string();
    let latest = normalise_version(&tag);
    let has_update = is_newer(&current, &latest);
    let release_url = format!("https://github.com/{REPO}/releases/tag/{tag}");

    let mut info = UpdateInfo {
        current_version: current,
        latest_version: if latest.is_empty() {
            tag.clone()
        } else {
            latest.clone()
        },
        has_update,
        release_name: Some(tag.clone()),
        notes: None,
        published_at: None,
        release_url: Some(release_url),
        asset_name: None,
        asset_size: None,
        download_url: None,
        mirror_url: None,
        sha256: None,
        checked_at: now_ms(),
    };

    if !has_update {
        return Ok(info);
    }

    let (name, sha256) = fallback_installer(&client, &tag, &latest).await?;
    info.download_url = tagged_download_url(&tag, &name);
    info.mirror_url = latest_download_url(&name);
    info.asset_name = Some(name);
    info.sha256 = sha256;
    Ok(info)
}

/// 无 API 时找出安装包文件名与校验值。优先解析 release 资产 HTML，其次读
/// SHA256SUMS.txt / <asset>.sha256；都拿不到文件名时按发布命名约定推导。
async fn fallback_installer(
    client: &reqwest::Client,
    tag: &str,
    latest: &str,
) -> Result<(String, Option<String>), String> {
    let mut selected: Option<(String, Option<String>)> = None;

    let expanded_url = format!("https://github.com/{REPO}/releases/expanded_assets/{tag}");
    if let Ok(response) = client.get(&expanded_url).send().await {
        if response.status().is_success() {
            if let Ok(html) = response.text().await {
                if let Some(asset) = pick_html_installer(&html) {
                    selected = Some((asset.name, asset.sha256));
                }
            }
        }
    }

    // 清单里同时有文件名和哈希；HTML 没给 digest 时用它补齐。
    if selected.as_ref().is_none_or(|(_, sha)| sha.is_none()) {
        let sums_url = format!("{}{CHECKSUMS_ASSET}", latest_asset_url());
        if let Ok(response) = client.get(&sums_url).send().await {
            if response.status().is_success() {
                if let Ok(text) = response.text().await {
                    if let Some((name, sha)) = installer_from_checksums(&text) {
                        match &mut selected {
                            Some((selected_name, selected_sha))
                                if selected_name.eq_ignore_ascii_case(&name) =>
                            {
                                *selected_sha = Some(sha);
                            }
                            Some(_) => {}
                            None => selected = Some((name, Some(sha))),
                        }
                    }
                }
            }
        }
    }

    if selected.is_none() && !latest.is_empty() {
        selected = Some((format!("ServiceSettings-{latest}-setup.exe"), None));
    }

    let Some((name, mut sha256)) = selected else {
        return Err("该版本没有提供安装包".to_string());
    };
    if sha256.is_none() {
        if let Some(url) = latest_asset_path_url(&format!("{name}.sha256")) {
            if let Ok(digest) = fetch_checksum(client, &url).await {
                sha256 = digest;
            }
        }
    }
    Ok((name, sha256))
}

/// `releases/latest` 会 302 到 `releases/tag/<tag>`；跟随重定向后从最终 URL 取 tag。
async fn fallback_latest_tag(client: &reqwest::Client) -> Result<String, String> {
    let response = client
        .get(release_page_url())
        .send()
        .await
        .map_err(|error| format!("连接 GitHub 失败: {}", describe_error(&error)))?;
    if let Some(tag) = tag_from_release_url(response.url().as_str()) {
        return Ok(tag);
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("GitHub 仓库还没有发布任何版本".to_string());
    }
    Err("最新发布没有可识别的版本号".to_string())
}

fn tag_from_release_url(url: &str) -> Option<String> {
    const MARKER: &str = "/releases/tag/";
    let path = url.split(['?', '#']).next()?;
    let marker = path.rfind(MARKER)?;
    let tag = path[marker + MARKER.len()..].trim_end_matches('/');
    if tag.is_empty() {
        return None;
    }
    Some(tag.to_string())
}

/// 从 release 资产 HTML 中按行提取 `.exe` 链接与紧随其后的 `sha256:` digest。
fn assets_from_release_html(html: &str) -> Vec<HtmlAsset> {
    const MARKER: &str = "/releases/download/";
    let mut assets: Vec<HtmlAsset> = Vec::new();
    for line in html.lines() {
        if let Some(position) = line.find(MARKER) {
            let rest = &line[position + MARKER.len()..];
            let path = rest
                .split(['"', '\'', '?', '#', '<', '>'])
                .next()
                .unwrap_or("");
            let name = path.rsplit('/').next().unwrap_or("").trim();
            if is_installer_name(name) {
                assets.push(HtmlAsset {
                    name: name.to_string(),
                    sha256: None,
                });
            }
        }
        if let Some(position) = line.find("sha256:") {
            let rest = &line[position + "sha256:".len()..];
            let digest: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
            if digest.len() == 64 {
                if let Some(asset) = assets.last_mut() {
                    if asset.sha256.is_none() {
                        asset.sha256 = Some(digest.to_ascii_lowercase());
                    }
                }
            }
        }
    }
    assets
}

fn pick_html_installer(html: &str) -> Option<HtmlAsset> {
    let assets = assets_from_release_html(html);
    assets
        .iter()
        .find(|asset| {
            is_installer_name(&asset.name) && asset.name.to_ascii_lowercase().contains("setup")
        })
        .or_else(|| assets.iter().find(|asset| is_installer_name(&asset.name)))
        .cloned()
}

fn is_installer_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".exe") && !lower.contains("uninstall") && !name.contains(['/', '\\'])
}

fn installer_from_checksums(text: &str) -> Option<(String, String)> {
    for line in text.lines() {
        let line = line.trim_end_matches('\r').trim();
        let Some(split) = line.find([' ', '\t']) else {
            continue;
        };
        if split == 0 {
            continue;
        }
        let hash = line[..split].trim();
        let name = line[split..].trim().trim_start_matches('*').trim();
        if hash.len() == 64
            && hash.chars().all(|c| c.is_ascii_hexdigit())
            && is_installer_name(name)
        {
            return Some((name.to_string(), hash.to_ascii_lowercase()));
        }
    }
    None
}

fn parse_release(current: &str, body: &serde_json::Value) -> UpdateInfo {
    let tag = text_field(body, "tag_name").unwrap_or_default();
    let latest = normalise_version(&tag);
    let asset = pick_installer(body);
    UpdateInfo {
        current_version: current.to_string(),
        latest_version: if latest.is_empty() {
            tag.clone()
        } else {
            latest.clone()
        },
        has_update: is_newer(current, &latest),
        release_name: text_field(body, "name")
            .or_else(|| Some(tag).filter(|value| !value.is_empty())),
        notes: text_field(body, "body"),
        published_at: text_field(body, "published_at"),
        release_url: text_field(body, "html_url"),
        asset_name: asset.as_ref().map(|item| item.name.clone()),
        asset_size: asset.as_ref().map(|item| item.size),
        download_url: asset.as_ref().map(|item| item.url.clone()),
        mirror_url: asset.as_ref().and_then(|item| item.mirror.clone()),
        sha256: asset.as_ref().and_then(|item| item.sha256.clone()),
        checked_at: now_ms(),
    }
}

fn pick_installer(body: &serde_json::Value) -> Option<ReleaseAsset> {
    let assets: Vec<ReleaseAsset> = body
        .get("assets")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ReleaseAsset {
                        name: text_field(item, "name")?,
                        size: item
                            .get("size")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0),
                        url: text_field(item, "browser_download_url")?,
                        mirror: text_field(item, "url"),
                        sha256: text_field(item, "digest").and_then(|digest| parse_digest(&digest)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    assets
        .iter()
        .find(|asset| {
            is_installer_name(&asset.name) && asset.name.to_ascii_lowercase().contains("setup")
        })
        .or_else(|| assets.iter().find(|asset| is_installer_name(&asset.name)))
        .cloned()
}

fn checksum_asset_url(body: &serde_json::Value, asset_name: &str) -> Option<String> {
    let wanted = format!("{asset_name}.sha256");
    body.get("assets")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                text_field(item, "name")
                    .map(|name| name.eq_ignore_ascii_case(&wanted))
                    .unwrap_or(false)
            })
        })
        .and_then(|item| text_field(item, "browser_download_url"))
}

async fn fetch_checksum(client: &reqwest::Client, url: &str) -> Result<Option<String>, String> {
    if validate_download_url(url).is_err() {
        return Ok(None);
    }
    let text = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    Ok(parse_digest(&text))
}

fn parse_digest(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '*')
        .map(|token| token.trim().strip_prefix("sha256:").unwrap_or(token).trim())
        .find(|token| token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|token| token.to_ascii_lowercase())
}

fn text_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn normalise_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).trim().to_string()
}

/// 接受 `1.2.3`、`v1.2`、`1.2.3-rc.1`；其它格式视为未知版本。
fn parse_version(raw: &str) -> Option<semver::Version> {
    let cleaned = normalise_version(raw);
    if let Ok(version) = semver::Version::parse(&cleaned) {
        return Some(version);
    }
    let split_at = cleaned.find(['-', '+']).unwrap_or(cleaned.len());
    let (core, suffix) = cleaned.split_at(split_at);
    let mut numbers: Vec<&str> = core.split('.').collect();
    if numbers.is_empty() || numbers.len() > 3 {
        return None;
    }
    while numbers.len() < 3 {
        numbers.push("0");
    }
    semver::Version::parse(&format!("{}{suffix}", numbers.join("."))).ok()
}

/// 未知版本不触发更新，避免异常 tag 让检查陷入循环。
fn is_newer(current: &str, latest: &str) -> bool {
    match (parse_version(current), parse_version(latest)) {
        (Some(current), Some(latest)) => latest > current,
        _ => false,
    }
}

fn describe_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(&format!("（{cause}）"));
        source = cause.source();
    }
    message
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(format!(
            "{USER_AGENT}/{} (+https://github.com/{REPO})",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(8))
        // 重定向逐跳校验：GitHub 不能把安装包交给白名单之外的域名。
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("重定向次数过多");
            }
            match validate_download_url(attempt.url().as_str()) {
                Ok(()) => attempt.follow(),
                Err(_) => attempt.error("更新重定向目标不在允许的 GitHub 域名内"),
            }
        }))
}

fn http_client() -> Result<reqwest::Client, String> {
    client_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("初始化网络客户端失败: {error}"))
}

fn download_client() -> Result<reqwest::Client, String> {
    client_builder()
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("初始化网络客户端失败: {error}"))
}

/// 只接受 HTTPS URL，返回小写主机名（忽略 userinfo 与端口）。
fn https_host(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    let host = authority.split(':').next()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn validate_download_url(url: &str) -> Result<(), String> {
    let host = https_host(url).ok_or_else(|| "更新地址必须是 HTTPS".to_string())?;
    let allowed = DOWNLOAD_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")));
    if !allowed {
        return Err("更新地址不在允许的 GitHub 域名内".to_string());
    }
    Ok(())
}

fn tagged_download_url(tag: &str, name: &str) -> Option<String> {
    if tag.is_empty()
        || matches!(tag, "." | "..")
        || tag.contains(['/', '\\'])
        || !is_installer_name(name)
    {
        return None;
    }
    Some(format!(
        "https://github.com/{REPO}/releases/download/{tag}/{name}"
    ))
}

/// `releases/latest/download/<name>`，用于安装包或它的 `.sha256` 附属文件。
fn latest_asset_path_url(name: &str) -> Option<String> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }
    Some(format!("{}{name}", latest_asset_url()))
}

fn latest_download_url(name: &str) -> Option<String> {
    if !is_installer_name(name) {
        return None;
    }
    latest_asset_path_url(name)
}

fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['\\', '/']).next().unwrap_or("update");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim().to_string();
    if cleaned.to_ascii_lowercase().ends_with(".exe") {
        cleaned
    } else {
        "ServiceSettings-setup.exe".to_string()
    }
}

fn update_dir() -> PathBuf {
    std::env::temp_dir().join("ServiceSettings-update")
}

/// 依次尝试每个候选地址，每个地址最多重试一次。
async fn open_stream(
    client: &reqwest::Client,
    candidates: &[String],
) -> Result<reqwest::Response, String> {
    let mut errors: Vec<String> = Vec::new();
    for url in candidates {
        if validate_download_url(url).is_err() {
            errors.push(format!("{url}（域名不在允许范围内）"));
            continue;
        }
        let is_asset_api =
            url.starts_with("https://api.github.com/") && url.contains("/releases/assets/");
        for attempt in 0..2 {
            let mut request = client.get(url);
            if is_asset_api {
                request = request.header(reqwest::header::ACCEPT, "application/octet-stream");
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    // 代理/门户偶尔用 200 + HTML 冒充下载地址，直接换下一个候选。
                    let content_type = response
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("");
                    if is_html_content_type(content_type) {
                        errors.push("返回了网页而不是安装包".to_string());
                        break;
                    }
                    return Ok(response);
                }
                Ok(response) => {
                    errors.push(format!("HTTP {}", response.status().as_u16()));
                    break;
                }
                Err(error) => {
                    errors.push(describe_error(&error));
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(700)).await;
                    }
                }
            }
        }
    }
    Err(format!("下载更新失败：{}", errors.join("；")))
}

async fn download_to_file(
    candidates: &[String],
    target: &Path,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(u64, String), String> {
    let client = download_client()?;
    let mut response = open_stream(&client, candidates).await?;
    let total = response.content_length().filter(|value| *value > 0);
    if total.unwrap_or(0) > MAX_INSTALLER_BYTES {
        return Err("更新包体积异常，已停止下载".to_string());
    }

    let mut file =
        std::fs::File::create(target).map_err(|error| format!("写入更新包失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let mut head: Vec<u8> = Vec::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                drop(file);
                let _ = std::fs::remove_file(target);
                return Err(format!("下载中断: {}", describe_error(&error)));
            }
        };
        if chunk.is_empty() {
            continue;
        }
        if head.len() < 2 {
            head.extend_from_slice(&chunk[..chunk.len().min(2 - head.len())]);
        }
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(target);
            return Err(format!("写入更新包失败: {error}"));
        }
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if downloaded > MAX_INSTALLER_BYTES {
            drop(file);
            let _ = std::fs::remove_file(target);
            return Err("更新包体积异常，已停止下载".to_string());
        }
        if downloaded - reported >= PROGRESS_STEP_BYTES || Some(downloaded) == total {
            reported = downloaded;
            on_progress(downloaded, total);
        }
    }
    file.flush()
        .map_err(|error| format!("写入更新包失败: {error}"))?;
    drop(file);

    if downloaded == 0 {
        let _ = std::fs::remove_file(target);
        return Err("下载的更新包为空".to_string());
    }
    if let Some(total) = total {
        if downloaded != total {
            let _ = std::fs::remove_file(target);
            return Err(format!("下载不完整：{downloaded}/{total} 字节"));
        }
    }
    if head.as_slice() != b"MZ" {
        let _ = std::fs::remove_file(target);
        return Err("下载的文件不是有效的 Windows 安装程序".to_string());
    }
    Ok((downloaded, hex_digest(&hasher.finalize())))
}

fn is_html_content_type(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("text/html")
}

fn required_checksum(info: &UpdateInfo) -> Result<String, String> {
    info.sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            "该版本没有可用的 SHA256 校验值，已取消安装（无法验证安装包完整性）".to_string()
        })
}

/// 下载最近一次检查公布的安装包，校验 SHA256 后交给 NSIS 静默安装。
pub async fn install_latest(app: AppHandle) -> Result<(), String> {
    let info = last_result().ok_or_else(|| "请先检查更新".to_string())?;
    if !info.has_update {
        return Err("当前已是最新版本".to_string());
    }
    let expected_sha256 = required_checksum(&info)?;
    let file_name = info
        .asset_name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "该版本没有提供安装包".to_string())?;

    // 浏览器直链 → API 资产地址 → tag 直链 → latest 直链，前者失败自动换下一个。
    let mut candidates: Vec<String> = Vec::new();
    if let Some(url) = info.download_url.as_deref() {
        candidates.push(url.to_string());
    }
    if let Some(url) = info.mirror_url.as_deref() {
        candidates.push(url.to_string());
    }
    if let Some(tag) = info.release_url.as_deref().and_then(tag_from_release_url) {
        if let Some(url) = tagged_download_url(&tag, &file_name) {
            if !candidates.contains(&url) {
                candidates.push(url);
            }
        }
    }
    if let Some(url) = latest_download_url(&file_name) {
        if !candidates.contains(&url) {
            candidates.push(url);
        }
    }
    if candidates.is_empty() {
        return Err("该版本没有提供安装包".to_string());
    }
    for candidate in &candidates {
        validate_download_url(candidate)?;
    }

    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建更新目录失败: {error}"))?;
    let target = dir.join(safe_file_name(&file_name));
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }

    let emitter = app.clone();
    let (downloaded, digest) = download_to_file(&candidates, &target, |downloaded, total| {
        let _ = emitter.emit("update-progress", ProgressPayload { downloaded, total });
    })
    .await?;

    if digest != expected_sha256 {
        let _ = std::fs::remove_file(&target);
        return Err("更新包校验失败：SHA256 不匹配".to_string());
    }
    if let Some(size) = info.asset_size {
        if size > 0 && downloaded != size {
            let _ = std::fs::remove_file(&target);
            return Err(format!("下载不完整：{downloaded}/{size} 字节"));
        }
    }
    eprintln!("更新包已通过 SHA256 校验 ({digest})");

    let _ = app.emit(
        "update-progress",
        ProgressPayload {
            downloaded,
            total: Some(downloaded),
        },
    );
    if let Err(error) = launch_installer(&target) {
        let _ = std::fs::remove_file(&target);
        return Err(error);
    }

    // 先让命令成功返回，前端才能提示“正在安装”，随后退出让安装程序替换文件。
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        handle.exit(0);
    });
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn launch_installer(path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file = wide(&path.as_os_str().to_string_lossy());
    let parameters = wide("/S /UPDATE /R");
    let result = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            PCWSTR(file.as_ptr()),
            PCWSTR(parameters.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err(format!("启动安装程序失败：错误码 {}", result.0 as isize));
    }
    Ok(())
}

#[cfg(not(windows))]
fn launch_installer(path: &Path) -> Result<(), String> {
    std::process::Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动安装程序失败: {error}"))
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file = wide(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err(format!("打开浏览器失败：错误码 {}", result.0 as isize));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开浏览器失败: {error}"))
}

/// 只允许打开 github.com 的链接，避免把任意 URL 交给系统默认浏览器。
pub fn open_release_page(url: &str) -> Result<(), String> {
    if https_host(url).as_deref() != Some("github.com") {
        return Err("只允许打开 GitHub 链接".to_string());
    }
    open_in_browser(url.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update_info(sha256: Option<&str>) -> UpdateInfo {
        UpdateInfo {
            current_version: "0.3.0".into(),
            latest_version: "0.4.0".into(),
            has_update: true,
            release_name: None,
            notes: None,
            published_at: None,
            release_url: None,
            asset_name: Some("ServiceSettings-0.4.0-setup.exe".into()),
            asset_size: Some(1024),
            download_url: Some(
                "https://github.com/Jaspersol/service-settings/releases/download/v0.4.0/a.exe"
                    .into(),
            ),
            mirror_url: None,
            sha256: sha256.map(str::to_string),
            checked_at: 0,
        }
    }

    #[test]
    fn rejects_html_download_responses() {
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("  TEXT/HTML  "));
        assert!(!is_html_content_type("application/octet-stream"));
        assert!(!is_html_content_type("application/x-msdownload"));
        assert!(!is_html_content_type(""));
    }

    #[test]
    fn install_requires_a_well_formed_checksum() {
        let digest = "A".repeat(64);
        assert_eq!(
            required_checksum(&update_info(Some(&digest))).unwrap(),
            "a".repeat(64)
        );
        assert!(required_checksum(&update_info(None)).is_err());
        assert!(required_checksum(&update_info(Some(""))).is_err());
        assert!(required_checksum(&update_info(Some("deadbeef"))).is_err());
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.3.0", "0.4.0"));
        assert!(is_newer("0.3.0", "0.3.1"));
        assert!(!is_newer("0.4.0", "0.4.0"));
        assert!(!is_newer("0.4.0", "0.3.9"));
        assert!(is_newer("v0.3.0", "v0.3.1"));
        assert!(!is_newer("0.4.0", "0.4"));
        assert!(is_newer("0.4", "0.4.1"));
        assert!(is_newer("0.4.0", "0.5.0-beta.1"));
    }

    #[test]
    fn unknown_versions_never_trigger_updates() {
        assert!(!is_newer("0.4.0", "nightly"));
        assert!(!is_newer("0.4.0", ""));
        assert_eq!(parse_version("1.2"), Some(semver::Version::new(1, 2, 0)));
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn strips_version_prefix() {
        assert_eq!(normalise_version("v1.2.3"), "1.2.3");
        assert_eq!(normalise_version(" 2.0.0 "), "2.0.0");
    }

    #[test]
    fn only_allows_github_download_hosts() {
        assert!(validate_download_url("https://github.com/a/b/releases/download/v1/x.exe").is_ok());
        assert!(validate_download_url("https://objects.githubusercontent.com/x").is_ok());
        assert!(validate_download_url("https://release-assets.githubusercontent.com/x").is_ok());
        assert!(validate_download_url("http://github.com/a/b").is_err());
        assert!(validate_download_url("https://evil.example.com/github.com/x.exe").is_err());
        assert!(validate_download_url("https://github.com.evil.example/x.exe").is_err());
    }

    #[test]
    fn sanitises_download_file_names() {
        assert_eq!(
            safe_file_name("ServiceSettings-0.4.0-setup.exe"),
            "ServiceSettings-0.4.0-setup.exe"
        );
        assert_eq!(
            safe_file_name("../../etc/passwd"),
            "ServiceSettings-setup.exe"
        );
        assert_eq!(safe_file_name("weird name.exe"), "weird_name.exe");
    }

    #[test]
    fn release_page_must_be_github() {
        assert_eq!(
            https_host("https://Github.com/a?x=1"),
            Some("github.com".to_string())
        );
        assert_eq!(
            https_host("https://user:pw@github.com:443/a"),
            Some("github.com".to_string())
        );
        assert_eq!(https_host("http://github.com/a"), None);
        assert_eq!(
            https_host("https://github.com.evil.dev/a"),
            Some("github.com.evil.dev".to_string())
        );
    }

    #[test]
    fn reads_checksum_files() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_digest(&format!("{digest}  ServiceSettings-setup.exe")),
            Some(digest.clone())
        );
        assert_eq!(
            parse_digest(&format!("sha256:{digest}")),
            Some(digest.clone())
        );
        assert_eq!(parse_digest("not a checksum"), None);
    }

    #[test]
    fn reads_the_tag_from_a_release_url() {
        assert_eq!(
            tag_from_release_url(
                "https://github.com/Jaspersol/service-settings/releases/tag/v0.4.0"
            ),
            Some("v0.4.0".to_string())
        );
        assert_eq!(
            tag_from_release_url(
                "https://github.com/Jaspersol/service-settings/releases/tag/v1.2.3?x=1"
            ),
            Some("v1.2.3".to_string())
        );
        assert_eq!(
            tag_from_release_url("https://github.com/Jaspersol/service-settings/releases/latest"),
            None
        );
    }

    #[test]
    fn parses_the_checksum_manifest() {
        let hash = "a".repeat(64);
        let names = [
            "THIRD-PARTY-NOTICES.md",
            "ServiceSettings-0.4.0-setup.exe.sha256",
            "ServiceSettings-0.4.0-setup.exe",
        ];
        let text = names
            .iter()
            .map(|name| format!("{hash}  {name}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            installer_from_checksums(&text),
            Some(("ServiceSettings-0.4.0-setup.exe".to_string(), hash.clone()))
        );
        assert_eq!(
            installer_from_checksums(&format!("{hash} *setup.exe\r\n")),
            Some(("setup.exe".to_string(), hash.clone()))
        );
        assert_eq!(installer_from_checksums("not a checksum"), None);
    }

    #[test]
    fn parses_release_asset_html() {
        let hash = "551c42e796b4b86a7dfa8ff104107ed788ef7e10c3f80e4d9f957c7c78b4904b";
        let html = format!(
            r#"
<div class="Box-row">
  <a href="/Jaspersol/service-settings/releases/download/v0.3.0/ServiceSettings-0.3.0-setup.exe" rel="nofollow">
    <span class="text-bold">ServiceSettings-0.3.0-setup.exe</span>
  </a>
  <span data-view-component="true" class="Truncate-text">sha256:{hash}</span>
  <clipboard-copy value="sha256:{hash}"></clipboard-copy>
</div>
<a href="/Jaspersol/service-settings/archive/refs/tags/v0.3.0.zip">Source code</a>
"#
        );
        let asset = pick_html_installer(&html).expect("installer");
        assert_eq!(asset.name, "ServiceSettings-0.3.0-setup.exe");
        assert_eq!(asset.sha256.as_deref(), Some(hash));
        assert_eq!(assets_from_release_html("<p>no assets</p>").len(), 0);
    }

    #[test]
    fn persists_the_last_result_for_throttled_startups() {
        let digest = "a".repeat(64);
        let state = UpdateState {
            last_check_ms: 123,
            last_result: Some(update_info(Some(&digest))),
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["lastCheckMs"], 123);
        assert_eq!(json["lastResult"]["latestVersion"], "0.4.0");
        assert_eq!(json["lastResult"]["hasUpdate"], true);

        let decoded: UpdateState = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.last_check_ms, 123);
        assert_eq!(
            decoded.last_result.and_then(|info| info.sha256),
            Some(digest)
        );

        // v0.3.0 之前的 state 只有时间戳，仍能读出并正常节流。
        let old: UpdateState = serde_json::from_str(r#"{"lastCheckMs":5}"#).unwrap();
        assert_eq!(old.last_check_ms, 5);
        assert!(old.last_result.is_none());
    }

    #[test]
    fn parses_api_release_and_keeps_camel_case_contract() {
        let digest = "551c42e796b4b86a7dfa8ff104107ed788ef7e10c3f80e4d9f957c7c78b4904b";
        let body = serde_json::json!({
            "tag_name": "v0.4.0",
            "name": "ServiceSettings v0.4.0",
            "body": "release notes",
            "published_at": "2026-11-09T02:24:28Z",
            "html_url": "https://github.com/Jaspersol/service-settings/releases/tag/v0.4.0",
            "assets": [
                {
                    "name": "helper.exe",
                    "size": 10,
                    "browser_download_url": "https://github.com/Jaspersol/service-settings/releases/download/v0.4.0/helper.exe",
                    "url": "https://api.github.com/repos/Jaspersol/service-settings/releases/assets/1",
                    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                },
                {
                    "name": "ServiceSettings-0.4.0-setup.exe",
                    "size": 1933619,
                    "browser_download_url": "https://github.com/Jaspersol/service-settings/releases/download/v0.4.0/ServiceSettings-0.4.0-setup.exe",
                    "url": "https://api.github.com/repos/Jaspersol/service-settings/releases/assets/2",
                    "digest": format!("sha256:{digest}")
                }
            ]
        });
        let info = parse_release("0.3.0", &body);
        assert!(info.has_update);
        assert_eq!(info.latest_version, "0.4.0");
        assert_eq!(
            info.asset_name.as_deref(),
            Some("ServiceSettings-0.4.0-setup.exe")
        );
        assert_eq!(info.asset_size, Some(1933619));
        assert_eq!(info.sha256.as_deref(), Some(digest));
        assert_eq!(
            info.download_url.as_deref(),
            Some("https://github.com/Jaspersol/service-settings/releases/download/v0.4.0/ServiceSettings-0.4.0-setup.exe")
        );
        assert!(info
            .mirror_url
            .as_deref()
            .unwrap_or("")
            .contains("/releases/assets/2"));

        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["currentVersion"], "0.3.0");
        assert_eq!(json["latestVersion"], "0.4.0");
        assert_eq!(json["hasUpdate"], true);
        assert_eq!(json["assetName"], "ServiceSettings-0.4.0-setup.exe");
        assert_eq!(json["sha256"], digest);
    }

    /// 真实网络冒烟：验证 API 主路径能拿到当前发布、安装包与 digest。
    /// 默认不跑（`cargo test --lib -- --ignored` 才会执行）。
    #[tokio::test]
    #[ignore]
    async fn live_api_reads_current_release() {
        let client = http_client().expect("client");
        let response = client
            .get(latest_release_api())
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .expect("request");
        assert!(response.status().is_success());
        let body: serde_json::Value = response.json().await.expect("json");
        let info = parse_release("0.2.0", &body);
        println!(
            "latest={} asset={:?} sha256={:?}",
            info.latest_version, info.asset_name, info.sha256
        );
        assert!(info.has_update);
        assert!(info.asset_name.is_some());
        assert!(info.sha256.is_some());
    }

    /// 真实网络冒烟：验证无 API 路径能从当前发布页拿到文件名与 digest。
    /// 默认不跑（`cargo test --lib -- --ignored` 才会执行）。
    #[tokio::test]
    #[ignore]
    async fn live_fallback_reads_current_release() {
        let client = http_client().expect("client");
        let tag = fallback_latest_tag(&client).await.expect("tag");
        let latest = normalise_version(&tag);
        let (name, sha256) = fallback_installer(&client, &tag, &latest)
            .await
            .expect("installer");
        println!("tag={tag} name={name} sha256={sha256:?}");
        assert!(is_installer_name(&name));
        assert!(
            sha256.is_some(),
            "release asset HTML should expose a sha256 digest"
        );
    }

    #[test]
    fn direct_download_urls_stay_on_github() {
        let tagged =
            tagged_download_url("v0.4.0", "ServiceSettings-0.4.0-setup.exe").expect("tagged url");
        assert!(validate_download_url(&tagged).is_ok());
        assert!(tagged.contains("/releases/download/v0.4.0/"));

        let latest = latest_download_url("ServiceSettings-0.4.0-setup.exe").expect("latest url");
        assert!(validate_download_url(&latest).is_ok());
        assert!(latest.contains("/releases/latest/download/"));

        let checksum =
            latest_asset_path_url("ServiceSettings-0.4.0-setup.exe.sha256").expect("checksum url");
        assert!(validate_download_url(&checksum).is_ok());

        assert!(tagged_download_url("../v1", "setup.exe").is_none());
        assert!(tagged_download_url("..", "setup.exe").is_none());
        assert!(latest_download_url("../../etc/passwd").is_none());
        assert!(latest_asset_path_url("../../etc/passwd").is_none());
        assert!(latest_download_url("").is_none());
    }
}
