"use strict";

const WORKER_KEY = "v3WorkerTabId";
const TASK_PAGE_KEY = "v3TaskPageTabId";

function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(Number(tabId), message);
  } catch (error) {
    return { ok: false, error: error.message || "页面脚本未就绪" };
  }
}

function waitForTab(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("商品页面就绪超时")), timeoutMs);
    function listener(changedId, changeInfo) {
      if (changedId === tabId && changeInfo.status === "complete") finish();
    }
    function finish(error) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getWorkerTab() {
  const stored = await chrome.storage.session.get(WORKER_KEY);
  const tabId = Number(stored[WORKER_KEY]);
  if (tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.storage.session.set({ [WORKER_KEY]: tab.id });
  return tab;
}

async function collectDetail(url, source) {
  const tab = await getWorkerTab();
  const ready = waitForTab(tab.id, 20000);
  await chrome.tabs.update(tab.id, { url, active: false });
  await ready;
  const response = await sendToTab(tab.id, { action: "READ_PRODUCT", source });
  return { ...response, tabId: tab.id };
}

async function workerPageState() {
  const tab = await getWorkerTab();
  const response = await sendToTab(tab.id, { action: "PAGE_STATE" });
  return { ...response, tabId: tab.id, url: tab.url };
}

async function readWorkerProduct(source) {
  const tab = await getWorkerTab();
  const response = await sendToTab(tab.id, { action: "READ_PRODUCT", source });
  return { ...response, tabId: tab.id, url: tab.url };
}

async function activateWorkerTab() {
  const tab = await getWorkerTab();
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true, tabId: tab.id };
}

async function closeWorkerTab() {
  const stored = await chrome.storage.session.get(WORKER_KEY);
  const tabId = Number(stored[WORKER_KEY]);
  await chrome.storage.session.remove(WORKER_KEY);
  if (!tabId) return;
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("分卷下载等待超时")), 10 * 60 * 1000);
    function listener(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") finish();
      if (delta.state.current === "interrupted") finish(new Error("分卷下载被中断"));
    }
    function finish(error) {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === "complete") finish();
      if (item?.state === "interrupted") finish(new Error("分卷下载被中断"));
    }).catch(() => {});
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await chrome.storage.session.get(WORKER_KEY);
  if (Number(stored[WORKER_KEY]) === tabId) await chrome.storage.session.remove(WORKER_KEY);
  const taskPage = await chrome.storage.session.get(TASK_PAGE_KEY);
  if (Number(taskPage[TASK_PAGE_KEY]) === tabId) {
    await chrome.storage.session.remove(TASK_PAGE_KEY);
    await closeWorkerTab();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.action) {
      case "GET_ACTIVE_PAGE": {
        const tab = await activeTab();
        if (!tab?.id) return { ok: false, error: "找不到当前标签页" };
        const state = await sendToTab(tab.id, { action: "PAGE_STATE" });
        return { ...state, tabId: tab.id, title: tab.title, url: tab.url };
      }
      case "OPEN_TASK_PAGE": {
        const params = new URLSearchParams({ sourceTabId: String(message.sourceTabId || ""), type: message.type || "unknown" });
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?${params}`) });
        await chrome.storage.session.set({ [TASK_PAGE_KEY]: tab.id });
        return { ok: true, tabId: tab.id };
      }
      case "DISCOVER_FROM_TAB":
        return sendToTab(message.tabId, { action: "DISCOVER_PRODUCTS", options: message.options });
      case "READ_FROM_TAB":
        return sendToTab(message.tabId, { action: "READ_PRODUCT", source: message.source });
      case "COLLECT_DETAIL":
        return collectDetail(message.url, message.source);
      case "CHECK_WORKER_PAGE":
        return workerPageState();
      case "READ_WORKER_PRODUCT":
        return readWorkerProduct(message.source);
      case "ACTIVATE_WORKER_TAB":
        return activateWorkerTab();
      case "CLOSE_WORKER_TAB":
        await closeWorkerTab();
        return { ok: true };
      case "DOWNLOAD_BLOB": {
        const downloadId = await chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: false });
        await waitForDownload(downloadId);
        return { ok: true, downloadId };
      }
      default:
        return { ok: false, error: "未知操作" };
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
