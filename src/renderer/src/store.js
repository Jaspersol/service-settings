// TestDB 数据库里只有一个对象库 config，以 id 为主键存放多条记录。
//
// 约定：服务列表存在 id 为 1 的单例记录里，loadData / updateData 都按 id 1 读写。
// 例外：saveData 写入的是 id 3，与 id 1 不是同一条记录；这是既有实现，
// 改动它会波及已安装用户的数据，故保持原样，仅在此记录约定以免后人误判为可随意调整。

/**
 * 打开 TestDB 数据库；首次打开时创建 config 对象库并以 id 为主键
 * @returns {Promise<IDBDatabase>} 已连接的数据库实例
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('TestDB', 1)
    request.onupgradeneeded = (e) => {
      const db = e.target.result
      // 创建对象存储（表）
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'id' })
      }
    }
    request.onsuccess = (e) => resolve(e.target.result)
    request.onerror = (e) => reject(e.target.error)
  })
}

/**
 * 写入 id 为 3 的记录。注意这不是 loadData 读取的 id 1 单例记录，
 * 详见文件头注释中的约定说明
 * @param {Array} list 服务列表
 * @returns {Promise<void>} 事务提交后 resolve
 */
export async function saveData(list) {
  const db = await openDB()
  const tx = db.transaction('config', 'readwrite')
  const store = tx.objectStore('config')
  store.add({ id: 3, data: list })
  return new Promise((resolve) => (tx.oncomplete = resolve))
}

/**
 * 读取 id 为 1 的单例记录。记录不存在时返回 undefined，
 * 默认值由调用方决定（见 switch.js 的首次运行兜底数据）
 * @returns {Promise<{id: number, data: Array}|undefined>} 设置记录
 */
export async function loadData() {
  const db = await openDB()
  const tx = db.transaction('config', 'readonly')
  const store = tx.objectStore('config')
  const request = store.get(1)
  return new Promise((resolve) => {
    request.onsuccess = (e) => resolve(e.target.result)
  })
}

/**
 * 按主键 put：id 为 1 的记录存在则整条覆盖，不存在则插入。
 * 传入对象必须自带 id，否则 put 会抛错
 * @param {{id: number, data: Array}} data 完整设置记录
 * @returns {Promise<IDBValidKey>} 写入记录的主键
 */
export async function updateData(data) {
  const db = await openDB()
  const tx = db.transaction('config', 'readwrite')
  const store = tx.objectStore('config')
  const request = store.put(data)
  return new Promise((resolve) => {
    request.onsuccess = (e) => {
      resolve(e.target.result)
    }
  })
}
