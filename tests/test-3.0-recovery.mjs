import fs from "node:fs";
import vm from "node:vm";

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, textContent: "", innerHTML: "", hidden: false, disabled: false, checked: false, value: "", files: [],
      dataset: {}, style: {}, classList: { add() {}, remove() {} }, addEventListener() {}
    });
  }
  return elements.get(id);
}

const tasks = new Map();
let discoveryError = null;
let discoveryCalls = 0;
let downloadError = null;
let discoveryProducts = [];
const stopStates = [];
const resumeHandlers = new Map();
// 按 taskRows 当前渲染结果构造可点击的任务按钮，用于验证“继续任务”入口的真实行为。
function taskButtons(selector) {
  const pattern = selector === ".resume"
    ? /<button class="secondary task-action resume" data-id="([^"]+)"/g
    : null;
  if (!pattern) return [];
  const html = element("taskRows").innerHTML;
  const result = [];
  for (const match of html.matchAll(pattern)) {
    result.push({ dataset: { id: match[1] }, disabled: false, addEventListener(type, handler) { if (type === "click") resumeHandlers.set(match[1], handler); } });
  }
  return result;
}
const context = vm.createContext({
  console, URL, URLSearchParams, Date, Math, Promise, setImmediate, setTimeout: () => 0, clearTimeout: () => {}, Blob, globalThis: null,
  location: { search: "?sourceTabId=&type=recent" },
  document: { getElementById: element, querySelectorAll: taskButtons },
  chrome: {
    runtime: {
      sendMessage: async (payload) => {
        if (payload.action === "DISCOVER_FROM_TAB") {
          discoveryCalls += 1;
          if (discoveryError) throw new Error(discoveryError);
          return { ok: true, products: discoveryProducts, actualBatches: 1 };
        }
        if (payload.action === "DOWNLOAD_BLOB" && downloadError) return { ok: false, error: downloadError };
        return { ok: true };
      }
    },
    tabs: { get: async () => ({}), update: async () => ({}) }
  },
  XianyuDB: {
    pruneTasks: async () => [],
    listTasks: async () => [...tasks.values()],
    getTask: async (id) => tasks.get(id),
    saveTask: async (task) => { stopStates.push({ text: task.progressText, stopDisabled: element("stopTask").disabled }); tasks.set(task.taskId, { ...task }); return task; },
    getScreenings: async () => [{ itemId: "1", url: "https://www.goofish.com/item?id=1", title: "商品", price: 9.9, status: "on_sale" }],
    getFailures: async () => [],
    saveScreening: async () => {},
    addFailure: async () => {},
    getItems: async () => [],
    saveItem: async () => {},
    getAssets: async () => [],
    saveAsset: async () => {},
    clearPartAssets: async () => {}
  },
  XianyuExport: {
    screeningWorkbookBytes: () => new Uint8Array(), screeningName: () => "x.xlsx", downloadProductImages: async () => ({ results: [] }),
    directoryFor: () => "d", packageName: () => "p.zip", buildPart: async () => new Blob([]), parseScreeningSelection: () => ({})
  },
  XianyuV3: null
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL("../extension/model.js", import.meta.url), "utf8"), context);
vm.runInContext(fs.readFileSync(new URL("../extension/dashboard.js", import.meta.url), "utf8"), context);
await new Promise((resolve) => setImmediate(resolve));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function screeningTask(id, status) {
  return { taskId: id, type: "shop", mode: "screening", sourceUrl: "https://www.goofish.com/personal?userId=1", sourceTabId: 7, status, createdAt: "2026-08-03T00:00:00Z", refs: [], parts: [], discoveredCount: 0, successCount: 0, partialCount: 0, failedCount: 0, partCount: 0 };
}

tasks.set("s1", screeningTask("s1", "paused_verification"));
discoveryError = "网络请求失败";
let rejected = false;
try { await context.startScreening(tasks.get("s1")); } catch (error) { rejected = error.message === "网络请求失败"; }
assert(rejected, "筛选失败必须向上抛出原始错误");
assert(tasks.get("s1").status === "failed", `重新筛选失败后任务状态未落到可重试状态: ${tasks.get("s1").status}`);
assert(tasks.get("s1").error === "网络请求失败" && tasks.get("s1").progressText === "网络请求失败", "筛选失败原因未保存");
await context.renderTasks();
assert(element("taskRows").innerHTML.includes("重新筛选") && element("taskRows").innerHTML.includes("resume-screen"), "失败的筛选任务缺少重试入口");

tasks.set("s2", screeningTask("s2", "discovering"));
discoveryError = "HTTP 429";
try { await context.startScreening(tasks.get("s2")); } catch (_) {}
assert(tasks.get("s2").status === "paused_verification", "安全响应必须暂停并要求人工验证");
await context.renderTasks();
assert(element("taskRows").innerHTML.includes("验证后重试筛选"), "暂停任务缺少验证后重试入口");

tasks.set("s3", screeningTask("s3", "completed"));
discoveryError = null;
await context.renderTasks();
assert(!element("taskRows").innerHTML.includes('class="secondary task-action resume-screen" data-id="s3"'), "已完成的筛选任务不应出现重试入口");
assert(discoveryCalls === 2, "重试期间不应产生额外的发现请求");

tasks.set("s4", screeningTask("s4", "discovering"));
await context.renderTasks();
assert(element("taskRows").innerHTML.includes('data-id="s4">继续筛选</button>'), "中断的筛选任务缺少继续入口");
assert(element("taskRows").innerHTML.includes("发现/选中 0"), "中断任务仍应展示发现数量");

discoveryError = null;
await context.startScreening(tasks.get("s1"));
assert(tasks.get("s1").status === "completed" && tasks.get("s1").error === "", "失败任务重试成功后状态未恢复");
await context.renderTasks();
assert(!element("taskRows").innerHTML.includes('data-id="s1">重新筛选</button>'), "重试成功后不应保留重试入口");

downloadError = "下载被浏览器拦截";
discoveryProducts = [{ itemId: "1", url: "https://www.goofish.com/item?id=1", title: "商品", price: 9.9, status: "on_sale" }];
const s5 = screeningTask("s5", "failed");
tasks.set("s5", s5);
await context.startScreening(s5);
await context.renderTasks();
assert(tasks.get("s5").status === "completed" && tasks.get("s5").successCount === 1, "筛选数据已落库时下载失败不应把任务标记为失败");
assert(tasks.get("s5").progressText.includes("下载被浏览器拦截"), "下载失败原因必须写入任务进度");
assert(element("taskRows").innerHTML.includes('class="secondary task-action export-screen" data-id="s5"'), "下载失败后必须保留下载筛选表入口");
assert(element("taskRows").innerHTML.includes('class="secondary task-action import-deep" data-id="s5"'), "下载失败后必须保留导入深度采集入口");
downloadError = null;

const deepRefs = [
  { itemId: "1", url: "https://www.goofish.com/item?id=1", title: "商品一", price: 9.9, status: "sold" },
  { itemId: "2", url: "https://www.goofish.com/item?id=2", title: "商品二", price: 19.9, status: "sold" }
];
const deepTask = context.XianyuV3.makeTask({
  taskId: "d1", type: "shop", mode: "deep", sourceUrl: "https://www.goofish.com/personal?userId=1",
  discoveredCount: deepRefs.length, partCount: 1, refs: deepRefs, parts: [["1", "2"]]
});
tasks.set("d1", deepTask);
stopStates.length = 0;
element("stopTask").disabled = true;
await context.renderTasks();
assert(resumeHandlers.has("d1"), "深度采集任务缺少继续任务入口");
await resumeHandlers.get("d1")();
const runningStates = stopStates.filter((entry) => entry.text.includes("跳过已售出商品详情页"));
assert(runningStates.length > 0 && runningStates.every((entry) => entry.stopDisabled === false), "继续任务开始后必须启用停止按钮");
assert(tasks.get("d1").status === "completed" && element("stopTask").disabled === true, "继续任务结束后必须禁用停止按钮");
console.log("3.0 筛选失败状态落库、重试入口与安全暂停恢复通过。");
