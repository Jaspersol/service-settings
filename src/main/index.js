import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { execFile, execSync } from 'child_process'
import { platform } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
// 服务名校验与状态判定与渲染进程共用同一份实现；
// 名字只作为 execFile 的参数数组元素传入，渲染进程无法借此拼接命令
import { SERVICE_ACTIONS, RUNNING_PATTERN, isValidServiceName } from '../shared/services.js'

const ALLOWED_ACTIONS = new Set(SERVICE_ACTIONS)

// 提权检测结果缓存：启动时检测一次，之后所有 IPC 直接复用
let cachedIsAdmin = null
// 是否已经发起过提权重启，保证 UAC 最多只弹一次
let elevationRequested = false

// 检查是否为管理员权限
function detectAdmin() {
  try {
    if (platform() === 'win32') {
      execSync('fltmc', { stdio: 'ignore', windowsHide: true }) // Windows 管理员权限检测命令
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

// 读取缓存的提权状态，没有缓存时先检测一次
function isAdmin() {
  if (cachedIsAdmin === null) cachedIsAdmin = detectAdmin()
  return cachedIsAdmin
}

// 以管理员权限重启应用（只会在 Windows 下被调用），整个进程生命周期内只发起一次
function restartAsAdmin() {
  if (elevationRequested) return
  elevationRequested = true

  // 路径用 PowerShell 单引号字面量包裹，路径内的单引号按规则写成两个；
  // 这样 Program Files 这类含空格的路径也能正确启动
  const exePath = app.getPath('exe').replace(/'/g, "''")
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${exePath}' -Verb RunAs`
    ],
    { windowsHide: true },
    (error) => {
      if (!error) app.quit() // 重启成功后退出当前进程
    }
  )
}

/**
 * 解码控制台输出：Windows 下 sc / net 按 OEM 代码页（中文系统为 GBK）输出，
 * 直接按 UTF-8 解码会得到乱码
 * @param {Buffer|string|null} output 子进程输出
 * @returns {string} 解码后的文本
 */
function decodeConsoleOutput(output) {
  if (!output) return ''
  if (!Buffer.isBuffer(output)) return String(output)
  try {
    return new TextDecoder(platform() === 'win32' ? 'gbk' : 'utf-8').decode(output)
  } catch {
    return output.toString('utf8')
  }
}

/**
 * 以固定的可执行文件 + 参数数组执行命令，不经过 shell
 * @param {string} file 可执行文件名
 * @param {string[]} args 参数数组
 * @returns {Promise<string>} 标准输出
 */
function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 20000, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(decodeConsoleOutput(stderr).trim() || error.message))
          return
        }
        resolve(decodeConsoleOutput(stdout))
      }
    )
  })
}

/**
 * 执行服务操作
 * @param {'status'|'start'|'stop'} action 操作类型
 * @param {string} name 已校验的服务名
 * @returns {Promise<string>} 标准输出
 */
function runServiceAction(action, name) {
  if (action === 'status') return execFileAsync('sc', ['query', name])
  return execFileAsync('net', [action, name])
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

  // 只在启动时检测一次权限；Windows 下未提权则最多发起一次自我重启
  if (platform() === 'win32' && !isAdmin()) restartAsAdmin()

  // 渲染进程的服务操作请求：只接受 { action, name }
  ipcMain.handle('service-command', async (_, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, message: '请求参数不合法' }
    }
    const { action, name } = payload
    if (!ALLOWED_ACTIONS.has(action)) {
      return { success: false, message: '未知操作' }
    }
    if (!isValidServiceName(name)) {
      return { success: false, message: '服务名称不合法' }
    }
    // sc query 只读，不需要提权；启停才需要管理员权限
    if (action !== 'status' && !isAdmin()) {
      return { success: false, message: '权限不足，请以管理员身份重新启动本程序' }
    }

    try {
      const stdout = await runServiceAction(action, name)
      return {
        success: true,
        running: action === 'status' ? RUNNING_PATTERN.test(stdout) : undefined
      }
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
