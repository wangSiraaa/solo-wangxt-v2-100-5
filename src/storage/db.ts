// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
// v1：formulas（自由笔记公式）
// v2：tasks（教师任务包）、attempts（学生尝试/证据），attempts 以 slotKey 建索引
import type { Formula } from "../engine/types";
import type { Attempt, TaskPackage } from "../engine/types";
import type { PackageEntry } from "./taskPackage";

const DB_NAME = "dimension-notebook";
const VERSION = 2;

export const STORE_FORMULAS = "formulas";
export const STORE_TASKS = "tasks";
export const STORE_ATTEMPTS = "attempts";

function openDB(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version ?? VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FORMULAS)) {
        db.createObjectStore(STORE_FORMULAS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: "packageId" });
      }
      if (!db.objectStoreNames.contains(STORE_ATTEMPTS)) {
        const store = db.createObjectStore(STORE_ATTEMPTS, { keyPath: "attemptId" });
        // 幂等槽位 + 包版本查询
        store.createIndex("slotKey", "slotKey", { unique: false });
        store.createIndex("packageVersion", ["packageId", "version"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const t = database.transaction(storeName, mode);
        const req = run(t.objectStore(storeName));
        req.onsuccess = () => { resolve(req.result); database.close(); };
        req.onerror = () => { reject(req.error); database.close(); };
      }),
  );
}

/** 多对象库事务（导入任务包需要原子写入） */
function multiStore(
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (stores: Map<string, IDBObjectStore>) => void,
): Promise<void> {
  return openDB().then(
    (database) =>
      void new Promise<void>((resolve, reject) => {
        const t = database.transaction(storeNames, mode);
        const map = new Map(storeNames.map((n) => [n, t.objectStore(n)]));
        run(map);
        t.oncomplete = () => { resolve(); database.close(); };
        t.onerror = () => { reject(t.error); database.close(); };
        t.onabort = () => { reject(t.error ?? new Error("transaction aborted")); database.close(); };
      }),
  );
}

// ---------------- 自由笔记公式（v1 接口保持不变） ----------------

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await tx<Formula[]>(STORE_FORMULAS, "readonly", (s) => s.getAll() as IDBRequest<Formula[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(formula: Formula): Promise<void> {
    await tx<IDBValidKey>(STORE_FORMULAS, "readwrite", (s) => s.put(formula));
  },
  async bulkPut(formulas: Formula[]): Promise<void> {
    await multiStore([STORE_FORMULAS], "readwrite", (stores) => {
      const store = stores.get(STORE_FORMULAS)!;
      for (const f of formulas) store.put(f);
    });
  },
  async delete(id: string): Promise<void> {
    await tx<undefined>(STORE_FORMULAS, "readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(): Promise<void> {
    await tx<undefined>(STORE_FORMULAS, "readwrite", (s) => s.clear() as IDBRequest<undefined>);
  },
};

// ---------------- 任务包 ----------------

async function getAll<T>(storeName: string): Promise<T[]> {
  return tx<T[]>(storeName, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export const taskStore = {
  allPackages: () => getAll<TaskPackage>(STORE_TASKS),

  async putPackage(pkg: TaskPackage): Promise<void> {
    await tx<IDBValidKey>(STORE_TASKS, "readwrite", (s) => s.put(pkg));
  },

  async deletePackage(packageId: string): Promise<void> {
    await tx<undefined>(STORE_TASKS, "readwrite", (s) => s.delete(packageId) as IDBRequest<undefined>);
  },

  /** 幂等导入：在同一事务内检查版本是否已存在，再写入任务包 */
  async importEntries(decisions: { entry: PackageEntry }[]): Promise<void> {
    const adds = decisions.map((d) => d.entry);
    if (adds.length === 0) return;
    await multiStore([STORE_TASKS], "readwrite", (stores) => {
      const store = stores.get(STORE_TASKS)!;
      const getReq = store.getAll() as IDBRequest<TaskPackage[]>;
      getReq.onsuccess = () => {
        const byId = new Map(getReq.result.map((p) => [p.packageId, p]));
        for (const entry of adds) {
          const pkg = byId.get(entry.packageId);
          if (pkg) {
            // 事务内二次校验（防并发重复导入）
            if (pkg.versions.some((v) => v.version === entry.version.version)) continue;
            pkg.versions.push(entry.version);
            pkg.versions.sort((a, b) => a.version - b.version);
            pkg.updatedAt = Date.now();
            store.put(pkg);
          } else {
            const fresh: TaskPackage = {
              packageId: entry.packageId,
              code: entry.code,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              draft: null,
              versions: [entry.version],
            };
            store.put(fresh);
          }
        }
      };
    });
  },
};

// ---------------- 学生尝试 ----------------

export const attemptStore = {
  all: () => getAll<Attempt>(STORE_ATTEMPTS),

  async put(attempt: Attempt): Promise<void> {
    await tx<IDBValidKey>(STORE_ATTEMPTS, "readwrite", (s) => s.put(attempt));
  },

  async get(attemptId: string): Promise<Attempt | undefined> {
    return tx<Attempt | undefined>(STORE_ATTEMPTS, "readonly", (s) => s.get(attemptId) as IDBRequest<Attempt | undefined>);
  },

  async bySlot(slotKey: string): Promise<Attempt[]> {
    const database = await openDB();
    try {
      return await new Promise<Attempt[]>((resolve, reject) => {
        const t = database.transaction(STORE_ATTEMPTS, "readonly");
        const req = t.objectStore(STORE_ATTEMPTS).index("slotKey").getAll(slotKey) as IDBRequest<Attempt[]>;
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      database.close();
    }
  },

  async byPackage(packageId: string): Promise<Attempt[]> {
    const database = await openDB();
    try {
      return await new Promise<Attempt[]>((resolve, reject) => {
        const t = database.transaction(STORE_ATTEMPTS, "readonly");
        const idx = t.objectStore(STORE_ATTEMPTS).index("packageVersion");
        // 主键范围只按 packageId 前缀（IDBKeyRange bound 复合键）
        const range = IDBKeyRange.bound([packageId, -Infinity], [packageId, Infinity]);
        const req = idx.getAll(range) as IDBRequest<Attempt[]>;
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      database.close();
    }
  },

  /** 在同一事务内按 slotKey 取/建进行中尝试，保证刷新与重复提交不制造重复记录 */
  async getOrCreateInProgress(
    slotKey: string,
    make: () => Attempt,
  ): Promise<{ attempt: Attempt; created: boolean }> {
    const database = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const t = database.transaction(STORE_ATTEMPTS, "readwrite");
        const store = t.objectStore(STORE_ATTEMPTS);
        const req = store.index("slotKey").getAll(slotKey) as IDBRequest<Attempt[]>;
        req.onsuccess = () => {
          const existing = req.result.find((a) => a.status === "in_progress");
          if (existing) {
            resolve({ attempt: existing, created: false });
            return;
          }
          // 同一事务内写入：事务提交前不会有其他调用插入同槽位记录
          const attempt = make();
          store.put(attempt);
          t.oncomplete = () => resolve({ attempt, created: true });
        };
        req.onerror = () => reject(req.error);
        t.onerror = () => reject(t.error);
      });
    } finally {
      database.close();
    }
  },
};

export function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
