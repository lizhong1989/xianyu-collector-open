"use strict";

const $ = (id) => document.getElementById(id);
let page = null;

function pageName(type) {
  return ({ item: "单商品详情页", shop: "店铺页面", search: "搜索结果页" })[type] || "不支持的页面";
}

async function init() {
  page = await chrome.runtime.sendMessage({ action: "GET_ACTIVE_PAGE" }).catch((error) => ({ ok: false, error: error.message }));
  if (!page?.ok || !["item", "shop", "search"].includes(page.type)) {
    $("pageState").textContent = "当前不是可采集页面，请选择下方入口前往闲鱼。";
    return;
  }
  $("pageState").textContent = `已识别：${pageName(page.type)}\n${page.title || page.url}`;
}

document.querySelectorAll(".entry").forEach((button) => button.addEventListener("click", async () => {
  const type = button.dataset.type;
  if (page?.ok && page.type === type) {
    const response = await chrome.runtime.sendMessage({ action: "OPEN_TASK_PAGE", sourceTabId: page.tabId, type }).catch((error) => ({ ok: false, error: error.message }));
    if (response?.ok) window.close();
    else $("pageState").textContent = response?.error || "无法打开任务页";
    return;
  }
  const prompts = {
    item: "当前不是商品详情页。是否打开闲鱼首页？请进入具体商品后再次点击扩展。",
    shop: "当前不是店铺页。是否打开闲鱼首页？请进入目标店铺后再次点击扩展。",
    search: "当前不是搜索结果页。是否打开闲鱼搜索页？"
  };
  if (!confirm(prompts[type])) return;
  try {
    await chrome.tabs.create({ url: type === "search" ? "https://www.goofish.com/search" : "https://www.goofish.com/" });
    window.close();
  } catch (error) {
    $("pageState").textContent = error.message;
  }
}));
$("recentTasks").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ action: "OPEN_TASK_PAGE", type: "recent" }).catch(() => null);
  if (response?.ok) window.close();
  else $("pageState").textContent = response?.error || "无法打开任务页";
});
init().catch((error) => { $("pageState").textContent = error.message; });
