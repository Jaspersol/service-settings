import { loadData, saveData } from './store'
import { SERVICE_NAME_PATTERN, isDuplicateEntry } from '../../shared/services.js'

/** 导出为 JSON 文件（纯前端 Blob + download，不需要额外权限） */
async function exportConfig() {
  const list = await loadData()
  const payload = JSON.stringify({ version: 1, services: list }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'service-settings.json'
  link.click()
  URL.revokeObjectURL(url)
}

/** 校验导入数据：结构、服务名合法、节点名/服务名不重复 */
function validateImport(list) {
  if (!Array.isArray(list)) throw new Error('文件内容不是服务列表')
  const seen = []
  for (const item of list) {
    if (!item || typeof item.domName !== 'string' || typeof item.serviceName !== 'string') {
      throw new Error('配置条目缺少节点名称或服务名称')
    }
    if (!SERVICE_NAME_PATTERN.test(item.serviceName)) {
      throw new Error(`服务名称不合法：${item.serviceName}`)
    }
    if (isDuplicateEntry(seen, item.domName, item.serviceName)) {
      throw new Error(`节点名称或服务名称重复：${item.serviceName}`)
    }
    seen.push({
      domName: item.domName,
      serviceName: item.serviceName,
      status: item.status === true,
      isChanging: false
    })
  }
  return seen
}

/** 为工具栏的两个按钮绑定事件 */
export function initConfigTools() {
  const exportBtn = document.getElementById('exportBtn')
  const importBtn = document.getElementById('importBtn')
  const fileInput = document.getElementById('importFile')

  exportBtn.addEventListener('click', async () => {
    try {
      await exportConfig()
    } catch (err) {
      alert(`导出失败：${err.message}`)
    }
  })

  importBtn.addEventListener('click', () => fileInput.click())

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      const list = validateImport(Array.isArray(parsed) ? parsed : parsed.services)
      await saveData(list)
      // 重新加载页面，复用启动时的读盘 / 渲染 / 状态查询流程
      location.reload()
    } catch (err) {
      alert(`导入失败：${err.message}`)
    } finally {
      fileInput.value = ''
    }
  })
}
