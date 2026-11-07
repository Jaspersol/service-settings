import { invoke } from '@tauri-apps/api/core'

// 与 src-tauri/src/lib.rs 的 #[tauri::command] service_command 对应。
// 参数名 action / name 必须与 Rust 侧一致：invoke 按名字映射到命令参数。
export const serviceCommand = (action, name) => invoke('service_command', { action, name })

/** 当前进程是否已提权（未提权时前端显示「以管理员重启」入口） */
export const elevationStatus = () => invoke('elevation_status')

/** 以管理员权限重启自身；成功时 Rust 侧会退出当前进程 */
export const elevate = () => invoke('elevate')
