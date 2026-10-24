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
const context = vm.createContext({
  console, URL, URLSearchParams, Date, Math, Promise, setImmediate, setTimeout: () => 0, clearTimeout: () => {}, Blob, globalThis: null,
  location: { search: "?sourceTabId=&type=recent" },
  document: { getElementById: element, querySelectorAll: () => [] },
  chrome: {
    runtime: {
      sendMessage: async (payload) => {
        if (payload.action === "DISCOVER_FROM_TAB") {
          discoveryCalls += 1;
          if (discoveryError) throw new Error(discoveryError);
          return { ok: true, products: [], actualBatches: 1 };
        }
        return { ok: true };
      }
    },
    tabs: { get: async () => ({}), update: async () => ({}) }
  },
  XianyuDB: {
    pruneTasks: async () => [],
    listTasks: async () => [...tasks.values()],
    getTask: async (id) => tasks.get(id),
    saveTask: async (task) => { tasks.set(task.taskId, { ...task }); return task; },
    getScreenings: async () => [],
    getFailures: async () => [],
    saveScreening: async () => {},
    addFailure: async () => {}
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
console.log("3.0 筛选失败状态落库、重试入口与安全暂停恢复通过。");
