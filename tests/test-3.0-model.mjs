import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ console, Date, Math, globalThis: null });
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL("../extension/model.js", import.meta.url), "utf8"), context);
const api = context.XianyuV3;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const complete = { itemId: "1", url: "https://www.goofish.com/item?id=1", title: "商品", description: "原文\n第二行", price: 99, status: "on_sale" };
let result = api.finalizeProduct(complete, { imagePaths: ["1/1_001.jpg"], failures: [] });
assert(result.product.resultStatus === "success" && result.chargeable, "完整商品成功语义错误");
result = api.finalizeProduct(complete, { imagePaths: ["1/1_001.jpg"], failures: [{ reason: "第二张失败" }] });
assert(result.product.resultStatus === "partial" && result.chargeable, "部分图片失败成功度语义错误");
result = api.finalizeProduct({ ...complete, description: "" }, { imagePaths: ["1/1_001.jpg"] });
assert(result.product.resultStatus === "partial" && !result.chargeable && result.product.failureReason.includes("description"), "缺核心字段语义错误");
result = api.finalizeProduct(complete, { imagePaths: [] });
assert(result.product.resultStatus === "partial" && !result.chargeable, "无图片语义错误");

for (const [count, expected] of [[0, 0], [1, 1], [99, 1], [100, 1], [101, 2], [200, 2], [201, 3]]) {
  assert(api.splitParts(Array.from({ length: count }, (_, index) => index)).length === expected, `分卷数量错误: ${count}`);
}
assert(!/[\\/:*?"<>|]/.test(api.safeName('a\\b:c*?"<>| ')), "文件名清理错误");
const task = api.makeTask({ type: "search", requestedBatches: 99 });
assert(task.requestedBatches === 10 && task.status === "pending" && task.mode === "screening", "任务契约错误");
const screening = api.normalizeScreening({ itemId: "1", url: complete.url, title: "标题", price: "9.9", status: "on_sale" });
assert(screening.resultStatus === "success" && screening.price === 9.9, "快速筛选成功契约错误");
assert(api.normalizeScreening({ itemId: "1", url: complete.url, title: "", price: 9 }).failureReason.includes("title"), "快速筛选缺字段规则错误");
for (const marker of ["是", " y ", "YES", 1, "true", "√"]) assert(api.isSelectedMarker(marker), `选中标记未识别: ${marker}`);
assert(!api.isSelectedMarker("否") && !api.isSelectedMarker(""), "未选中标记识别错误");
const deep = api.makeTask({ type: "shop", mode: "deep", sourceTaskId: "screen-1", nextItemIndex: 3, selectedItemIds: ["1", "1", "2"], status: api.TASK_STATUS.PAUSED_VERIFICATION, refs: [{ ...screening, status: "sold", previewImageUrl: "https://img.alicdn.com/preview.jpg" }] });
assert(deep.sourceTaskId === "screen-1" && deep.nextItemIndex === 3 && deep.selectedItemIds.length === 2, "深度任务断点契约错误");
assert(deep.refs[0].status === "sold" && deep.refs[0].title === "标题" && deep.refs[0].price === 9.9 && deep.refs[0].previewImageUrl.endsWith("preview.jpg"), "深度任务未保留列表状态和基础字段");
const soldResult = api.finalizeProduct({ ...deep.refs[0], description: "", imageUrls: [deep.refs[0].previewImageUrl] }, { imagePaths: [] });
assert(soldResult.product.status === "sold" && soldResult.product.resultStatus === "partial" && soldResult.product.imageUrls.length === 1 && !soldResult.chargeable, "已售出列表级结果语义错误");
console.log("3.0 数据契约、成功/完整度语义、文件名和分卷边界通过。");
