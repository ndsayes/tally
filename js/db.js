// Tiny IndexedDB wrapper. Everything the app knows lives in this on-device database.
//   entries  – diary entries, indexed by date (YYYY-MM-DD)
//   foods    – "My Foods": scanned, label-read or saved foods, indexed by barcode
//   settings – key/value (goals, API key, model)

const DB_NAME = 'tally';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const entries = db.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('date', 'date');
      const foods = db.createObjectStore('foods', { keyPath: 'id' });
      foods.createIndex('barcode', 'barcode');
      db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const writeListeners = new Set();

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => {
      if (mode === 'readwrite') writeListeners.forEach((l) => l(storeName));
      resolve(req?.result);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  byIndex: (store, index, value) => run(store, 'readonly', (s) => s.index(index).getAll(value)),
  put: (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key)),
  putMany: (store, values) =>
    run(store, 'readwrite', (s) => {
      for (const v of values) s.put(v);
    }),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
  // Called with the store name after every successful write (used for automatic backup).
  onWrite: (listener) => writeListeners.add(listener),
};
