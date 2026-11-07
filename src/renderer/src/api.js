import { invoke } from '@tauri-apps/api/core'

// 与 src-tauri/src/lib.rs 的 #[tauri::command] service_command 对应。
// 参数名 action / name 必须与 Rust 侧一致：invoke 按名字映射到命令参数。
export const serviceCommand = (action, name) => invoke('service_command', { action, name })
