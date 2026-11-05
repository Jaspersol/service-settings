// TestDB 数据库里只有一个对象库 config，以 id 为主键存放多条记录。
//
// 约定：服务列表统一存在 id 为 1 的单例记录里，saveData / loadData / updateData 都按 id 1 读写。

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
 * 整体写入 id 为 1 的单例记录（不存在则插入，存在则整条覆盖）。
 * @param {Array} list 服务列表
 * @returns {Promise<void>} 事务提交后 resolve
 */
export async function saveData(list) {
  const db = await openDB()
  const tx = db.transaction('config', 'readwrite')
  const store = tx.objectStore('config')
  // 用 put 而非 add：id 1 的记录第二次保存时已存在，add 会抛 ConstraintError
  store.put({ id: 1, data: list })
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
