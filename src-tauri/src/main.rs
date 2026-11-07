// release 构建下隐藏额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    service_settings_lib::run()
}
