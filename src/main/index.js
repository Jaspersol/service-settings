import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { exec, execSync } from 'child_process'
import { platform } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// 检查是否为管理员权限
function isAdmin() {
  try {
    if (platform() === 'win32') {
      execSync('fltmc', { stdio: 'ignore' }) // Windows 管理员权限检测命令
      return true
    } else if (platform() === 'darwin' || platform() === 'linux') {
      return process.getuid() === 0 // macOS/Linux root 用户检测
    }
    return false
  } catch {
    // 当前平台不支持检测或无权限执行检测命令时，按非管理员处理
    return false
  }
}

// 以管理员权限重启应用（仅 Windows 有效）
function restartAsAdmin() {
  if (platform() !== 'win32') {
    dialog.showErrorBox('权限不足', '请以管理员权限重启应用（macOS: sudo 命令 / Linux: sudo）')
    return
  }

  const appPath = app.getPath('exe')
  const command = `Start-Process "${appPath}" -Verb RunAs` // PowerShell 管理员启动
  exec(`powershell -Command "${command}"`, (err) => {
    if (!err) app.quit() // 重启成功后退出当前进程
  })
}

// 以管理员权限执行 CMD 命令
function runCmdAsAdmin(command) {
  return new Promise((resolve, reject) => {
    // Windows 下通过 cmd.exe 执行命令（继承管理员权限）
    const cmd = `cmd.exe /c "${command}"`
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`执行失败：${error.message}`))
        return
      }
      if (stderr) {
        reject(new Error(`命令错误：${stderr}`))
        return
      }
      resolve(`命令输出：\n${stdout}`)
    })
  })
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    icon: join(__dirname, '../../resources/icon.png'), // Windows 路径
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 监听渲染进程的 CMD 执行请求
  ipcMain.handle('run-cmd-as-admin', async (_, command) => {
    if (!isAdmin()) {
      restartAsAdmin()
      return { success: false, message: '请授予管理员权限后重试' }
    }

    try {
      const result = await runCmdAsAdmin(command)
      return { success: true, result }
    } catch (err) {
      return { success: false, message: err.message }
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
