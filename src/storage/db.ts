// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
import type { Formula, TaskAttempt, TaskPackage } from "../engine/types";

const DB_NAME = "dimension-notebook";
export const STORES = {
  formulas: "formulas",
  tasks: "taskPackages",
  attempts: "taskAttempts",
} as const;
const VERSION = 2;

function openDB(version: number = VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.formulas)) {
        db.createObjectStore(STORES.formulas, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.tasks)) {
        db.createObjectStore(STORES.tasks, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.attempts)) {
        db.createObjectStore(STORES.attempts, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = run(t.objectStore(storeName));
        req.onsuccess = () => { resolve(req.result); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      }),
  );
}

async function allInStore<T>(storeName: string): Promise<T[]> {
  return tx<T[]>(storeName, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await allInStore<Formula>(STORES.formulas);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(formula: Formula): Promise<void> {
    await tx<IDBValidKey>(STORES.formulas, "readwrite", (s) => s.put(formula));
  },
  async bulkPut(formulas: Formula[]): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORES.formulas, "readwrite");
      const store = t.objectStore(STORES.formulas);
      for (const f of formulas) store.put(f);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },
  async delete(id: string): Promise<void> {
    await tx<undefined>(STORES.formulas, "readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(): Promise<void> {
    await tx<undefined>(STORES.formulas, "readwrite", (s) => s.clear() as IDBRequest<undefined>);
  },

  async allTasks(): Promise<TaskPackage[]> {
    const rows = await allInStore<TaskPackage>(STORES.tasks);
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.version - b.version);
  },
  async putTask(task: TaskPackage): Promise<void> {
    await tx<IDBValidKey>(STORES.tasks, "readwrite", (s) => s.put(task));
  },
  async deleteTask(id: string): Promise<void> {
    await tx<undefined>(STORES.tasks, "readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  },

  async allAttempts(): Promise<TaskAttempt[]> {
    const rows = await allInStore<TaskAttempt>(STORES.attempts);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async putAttempt(attempt: TaskAttempt): Promise<void> {
    await tx<IDBValidKey>(STORES.attempts, "readwrite", (s) => s.put(attempt));
  },
};

export function newId(prefix = "f"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
