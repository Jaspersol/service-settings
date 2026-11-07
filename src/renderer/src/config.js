import { loadData, saveData } from './store'
import { SERVICE_NAME_PATTERN, isDuplicateEntry } from '../../shared/services.js'
import { notify } from './notify'

const MAX_DOM_NAME_LENGTH = 64
const MAX_SERVICE_NAME_LENGTH = 255
const MAX_ENTRIES = 200
const MAX_IMPORT_BYTES = 1_000_000

/** 导出为 JSON 文件（纯前端 Blob + download，不需要额外权限） */
async function exportConfig() {
  const list = await loadData()
  const payload = JSON.stringify({ version: 1, services: list }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'service-settings.json'
  link.click()
  // 立即 revoke 可能让下载还没开始读 Blob 就失效，延后回收
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 校验导入数据：结构、字段、长度、服务名合法、节点名/服务名不重复。
 * 返回的是内存列表（带运行时字段 status / isChanging），落盘时 Rust 只取 domName / serviceName。
 */
function validateImport(list) {
  if (!Array.isArray(list)) throw new Error('文件内容不是服务列表')
  if (list.length > MAX_ENTRIES) throw new Error(`条目过多（上限 ${MAX_ENTRIES} 条）`)
  const seen = []
  for (const item of list) {
    if (!item || typeof item.domName !== 'string' || typeof item.serviceName !== 'string') {
      throw new Error('配置条目缺少节点名称或服务名称')
    }
    const domName = item.domName.trim()
    const serviceName = item.serviceName.trim()
    if (!domName) throw new Error('节点名称不能为空')
    if (domName.length > MAX_DOM_NAME_LENGTH) throw new Error(`节点名称过长：${domName}`)
    if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
      throw new Error(`服务名称过长：${serviceName}`)
    }
    if (!SERVICE_NAME_PATTERN.test(serviceName)) {
      throw new Error(`服务名称不合法：${serviceName}`)
    }
    if (isDuplicateEntry(seen, domName, serviceName)) {
      throw new Error(`节点名称或服务名称重复：${serviceName}`)
    }
    seen.push({
      domName,
      serviceName,
      status: false, // 真实状态由启动时逐张查询 SCM 决定，不落盘
      isChanging: false
    })
  }
  return seen
}

/** 为标题栏的两个按钮绑定事件 */
export function initConfigTools() {
  const exportBtn = document.getElementById('exportBtn')
  const importBtn = document.getElementById('importBtn')
  const fileInput = document.getElementById('importFile')

  exportBtn.addEventListener('click', async () => {
    try {
      await exportConfig()
    } catch (err) {
      notify(`导出失败：${err.message}`, 'error')
    }
  })

  importBtn.addEventListener('click', () => fileInput.click())

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        throw new Error('文件过大，请检查是否为正确的配置文件')
      }
      const parsed = JSON.parse(await file.text())
      const list = validateImport(Array.isArray(parsed) ? parsed : parsed.services)
      await saveData(list)
      // 重新加载页面，复用启动时的读盘 / 渲染 / 状态查询流程
      location.reload()
    } catch (err) {
      notify(`导入失败：${err.message}`, 'error')
    } finally {
      fileInput.value = ''
    }
  })
}
