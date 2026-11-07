import { invoke } from '@tauri-apps/api/core'

// 服务列表存于 Rust 侧的 app_data_dir()/services.json，
// 不再依赖 WebView2 的 IndexedDB（见 src-tauri/src/lib.rs）。

/**
 * 整体写入服务列表（Rust 侧先写临时文件再原子替换）
 * @param {Array} list 服务列表
 * @returns {Promise<void>}
 */
export function saveData(list) {
  return invoke('save_services', { list })
}

/** v0.2.x 把列表存在 IndexedDB 的 TestDB / config / id=1 */
async function readLegacyList() {
  // 先确认数据库存在，避免 indexedDB.open 反过来创建一个空库
  if (typeof indexedDB.databases !== 'function') return null
  const databases = await indexedDB.databases().catch(() => [])
  if (!databases.some((db) => db.name === 'TestDB')) return null

  return new Promise((resolve) => {
    const request = indexedDB.open('TestDB', 1)
    request.onerror = () => resolve(null)
    request.onsuccess = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('config')) {
        db.close()
        resolve(null)
        return
      }
      const get = db.transaction('config', 'readonly').objectStore('config').get(1)
      get.onsuccess = () => {
        const record = get.result
        db.close()
        resolve(record && Array.isArray(record.data) ? record.data : null)
      }
      get.onerror = () => {
        db.close()
        resolve(null)
      }
    }
  })
}

/** 迁移成功后删掉旧库，避免以后清空列表时又被「复活」 */
function dropLegacyDatabase() {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('TestDB')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

/**
 * 读取服务列表；配置文件不存在时返回空数组，由调用方给出首跑占位数据。
 * 若 Rust 侧还没有配置文件、但存在 v0.2.x 的 IndexedDB 列表，则一次性迁移。
 * @returns {Promise<Array<{domName: string, serviceName: string, status: boolean}>>}
 */
export async function loadData() {
  const list = await invoke('load_services')
  if (list.length > 0) return list

  const legacy = await readLegacyList()
  if (!legacy || legacy.length === 0) return list
  await saveData(legacy)
  await dropLegacyDatabase()
  return legacy
}
