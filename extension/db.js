(function (root) {
  "use strict";

  const DB_NAME = "xianyuCollectorV3";
  const DB_VERSION = 2;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("数据库事务已中止"));
    });
  }

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("tasks")) {
          const tasks = database.createObjectStore("tasks", { keyPath: "taskId" });
          tasks.createIndex("createdAt", "createdAt");
        }
        if (!database.objectStoreNames.contains("items")) {
          const items = database.createObjectStore("items", { keyPath: ["taskId", "itemId"] });
          items.createIndex("taskId", "taskId");
        }
        if (!database.objectStoreNames.contains("screenings")) {
          const screenings = database.createObjectStore("screenings", { keyPath: ["taskId", "itemId"] });
          screenings.createIndex("taskId", "taskId");
        }
        if (!database.objectStoreNames.contains("failures")) {
          const failures = database.createObjectStore("failures", { keyPath: "id", autoIncrement: true });
          failures.createIndex("taskId", "taskId");
        }
        if (!database.objectStoreNames.contains("assets")) {
          const assets = database.createObjectStore("assets", { keyPath: ["taskId", "partIndex", "path"] });
          assets.createIndex("taskPart", ["taskId", "partIndex"]);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(names, mode, callback) {
    const database = await open();
    try {
      const transaction = database.transaction(names, mode);
      const done = transactionDone(transaction);
      const result = await callback(transaction);
      await done;
      return result;
    } finally {
      database.close();
    }
  }

  function rangeForTask(taskId) {
    return IDBKeyRange.only(String(taskId));
  }

  const api = {
    DB_NAME,
    async saveTask(task) {
      const value = { ...task, updatedAt: new Date().toISOString() };
      await withStore(["tasks"], "readwrite", (tx) => requestResult(tx.objectStore("tasks").put(value)));
      return value;
    },
    async getTask(taskId) {
      return withStore(["tasks"], "readonly", (tx) => requestResult(tx.objectStore("tasks").get(taskId)));
    },
    async listTasks(limit = 8) {
      const rows = await withStore(["tasks"], "readonly", (tx) => requestResult(tx.objectStore("tasks").getAll()));
      return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
    },
    async pruneTasks(now = Date.now()) {
      const rows = await api.listTasks(Number.MAX_SAFE_INTEGER);
      const cutoff = now - 90 * 24 * 60 * 60 * 1000;
      const keep = new Set(rows.filter((task, index) => index < 20 && new Date(task.createdAt || 0).getTime() >= cutoff).map((task) => task.taskId));
      const remove = rows.filter((task) => !keep.has(task.taskId)).map((task) => task.taskId);
      for (const taskId of remove) await api.deleteTask(taskId);
      return remove;
    },
    async deleteTask(taskId) {
      return withStore(["tasks", "items", "screenings", "failures", "assets"], "readwrite", async (tx) => {
        tx.objectStore("tasks").delete(taskId);
        for (const name of ["items", "screenings", "failures"]) {
          const store = tx.objectStore(name);
          const keys = await requestResult(store.index("taskId").getAllKeys(rangeForTask(taskId)));
          keys.forEach((key) => store.delete(key));
        }
        const assets = tx.objectStore("assets");
        const assetKeys = await requestResult(assets.getAllKeys());
        assetKeys.filter((key) => key[0] === taskId).forEach((key) => assets.delete(key));
      });
    },
    async saveItem(taskId, product) {
      const value = { ...product, taskId };
      await withStore(["items"], "readwrite", (tx) => requestResult(tx.objectStore("items").put(value)));
      return value;
    },
    async getItems(taskId) {
      return withStore(["items"], "readonly", (tx) => requestResult(tx.objectStore("items").index("taskId").getAll(rangeForTask(taskId))));
    },
    async saveScreening(taskId, record) {
      const value = { ...record, taskId };
      await withStore(["screenings"], "readwrite", (tx) => requestResult(tx.objectStore("screenings").put(value)));
      return value;
    },
    async getScreenings(taskId) {
      return withStore(["screenings"], "readonly", (tx) => requestResult(tx.objectStore("screenings").index("taskId").getAll(rangeForTask(taskId))));
    },
    async addFailure(taskId, failure) {
      const value = { taskId, createdAt: new Date().toISOString(), ...failure };
      await withStore(["failures"], "readwrite", (tx) => requestResult(tx.objectStore("failures").add(value)));
      return value;
    },
    async getFailures(taskId) {
      return withStore(["failures"], "readonly", (tx) => requestResult(tx.objectStore("failures").index("taskId").getAll(rangeForTask(taskId))));
    },
    async saveAsset(taskId, partIndex, path, blob) {
      return withStore(["assets"], "readwrite", (tx) => requestResult(tx.objectStore("assets").put({ taskId, partIndex, path, blob })));
    },
    async getAssets(taskId, partIndex) {
      return withStore(["assets"], "readonly", (tx) => requestResult(tx.objectStore("assets").index("taskPart").getAll(IDBKeyRange.only([taskId, partIndex]))));
    },
    async clearPartAssets(taskId, partIndex) {
      return withStore(["assets"], "readwrite", async (tx) => {
        const store = tx.objectStore("assets");
        const keys = await requestResult(store.index("taskPart").getAllKeys(IDBKeyRange.only([taskId, partIndex])));
        keys.forEach((key) => store.delete(key));
      });
    }
  };

  root.XianyuDB = api;
})(globalThis);
