// 打开数据库
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

// 写入数据
export async function saveData(list) {
  const db = await openDB()
  const tx = db.transaction('config', 'readwrite')
  const store = tx.objectStore('config')
  store.add({ id: 3, data: list })
  return new Promise((resolve) => (tx.oncomplete = resolve))
}

// 读取数据
export async function loadData() {
  const db = await openDB()
  const tx = db.transaction('config', 'readonly')
  const store = tx.objectStore('config')
  const request = store.get(1)
  return new Promise((resolve) => {
    request.onsuccess = (e) => resolve(e.target.result)
  })
}

// 更新数据
export async function upData(data) {
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
