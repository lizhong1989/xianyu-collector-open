"use strict";

const params = new URLSearchParams(location.search);
const sourceTabId = Number(params.get("sourceTabId"));
let sourceType = params.get("type") || "recent";
let sourceUrl = "";
let runningTask = null;
let pendingSourceTaskId = "";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomMs = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const isSecurityError = (value) => /403|429|验证码|安全验证|滑块|滑动验证|访问过于频繁/.test(String(value || ""));

function toast(value) {
  $("toast").textContent = value;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 3000);
}

function message(value, percent) {
  $("taskMessage").textContent = value;
  if (Number.isFinite(percent)) $("progressBar").style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

async function runtime(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || "操作失败");
  return response;
}

function taskTypeName(type) {
  return ({ item: "单商品", shop: "店铺", search: "搜索" })[type] || "未知";
}

function taskModeName(task) {
  return task.mode === "screening" ? "快速筛选" : (task.mode === "deep" ? "深度采集" : "单商品采集");
}

async function inspectSource() {
  if (sourceType === "recent" || !sourceTabId) {
    $("newTaskTitle").textContent = "最近任务";
    $("sourceInfo").textContent = "请从下方任务导入筛选 Excel、继续暂停任务或下载已有结果。";
    $("startTask").hidden = true;
    $("stopTask").hidden = true;
    return;
  }
  const tab = await chrome.tabs.get(sourceTabId);
  sourceUrl = tab.url || "";
  const state = await chrome.tabs.sendMessage(sourceTabId, { action: "PAGE_STATE" }).catch(() => null);
  if (!state?.ok || state.type !== sourceType) throw new Error(`当前标签页不是${taskTypeName(sourceType)}页面，请返回正确页面后重试`);
  $("sourceInfo").textContent = `${taskTypeName(sourceType)}：${sourceUrl}`;
  $("soldOption").hidden = sourceType !== "shop";
  $("batchOption").hidden = sourceType !== "search";
  $("startTask").textContent = sourceType === "item" ? "开始完整采集" : "开始快速筛选";
  $("startTask").disabled = false;
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try { await runtime({ action: "DOWNLOAD_BLOB", url, filename }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

async function exportScreening(taskId) {
  const task = await XianyuDB.getTask(taskId);
  if (!task || task.mode !== "screening") throw new Error("快速筛选任务不存在");
  const records = await XianyuDB.getScreenings(taskId);
  const failures = await XianyuDB.getFailures(taskId);
  const bytes = XianyuExport.screeningWorkbookBytes(task, records, failures);
  await downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), XianyuExport.screeningName(task));
}

async function startScreening(existingTask = null) {
  const type = existingTask?.type || sourceType;
  const tabId = existingTask?.sourceTabId || sourceTabId;
  const task = existingTask || XianyuV3.makeTask({
    type, mode: "screening", sourceUrl, sourceTabId: tabId,
    includeSold: $("includeSold").checked, requestedBatches: Number($("requestedBatches").value || 1),
    startedAt: new Date().toISOString(), status: XianyuV3.TASK_STATUS.DISCOVERING, progressText: "正在读取列表基础数据"
  });
  runningTask = task;
  task.status = XianyuV3.TASK_STATUS.DISCOVERING;
  task.pauseReason = "";
  task.error = "";
  await XianyuDB.saveTask(task);
  message("正在读取列表，不会打开商品详情或下载图片…", 10);
  const discovery = await runtime({
    action: "DISCOVER_FROM_TAB", tabId,
    options: { type: task.type, includeSold: task.includeSold, requestedBatches: task.requestedBatches }
  });
  const unique = new Map();
  discovery.products.forEach((value) => {
    const record = XianyuV3.normalizeScreening(value);
    const key = record.itemId || `invalid-${unique.size}`;
    if (!unique.has(key)) unique.set(key, record);
  });
  const records = [...unique.values()];
  const valid = records.filter((record) => record.resultStatus === "success");
  const invalid = records.filter((record) => record.resultStatus !== "success");
  const allowed = valid;
  for (const record of allowed) await XianyuDB.saveScreening(task.taskId, record);
  for (const record of invalid) await XianyuDB.addFailure(task.taskId, { itemId: record.itemId, url: record.url, stage: "screening", reason: record.failureReason });
  task.actualBatches = discovery.actualBatches;
  task.discoveredCount = records.length;
  task.successCount = allowed.length;
  task.failedCount = invalid.length;
  task.status = invalid.length ? XianyuV3.TASK_STATUS.PARTIAL : XianyuV3.TASK_STATUS.COMPLETED;
  task.completedAt = new Date().toISOString();
  task.progressText = `快速筛选完成，导出 ${allowed.length} 条`;
  await XianyuDB.saveTask(task);
  await exportScreening(task.taskId);
  message(task.progressText, 100);
}

async function collectWithRetry(ref, task) {
  if (ref.product) return ref.product;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await chrome.runtime.sendMessage({ action: "COLLECT_DETAIL", url: ref.url, source: { sourceType: task.type, sourceUrl: task.sourceUrl } });
    if (response?.ok) return response.product;
    lastError = new Error(response?.error || "商品详情读取失败");
    lastError.security = isSecurityError(lastError.message);
    lastError.workerTabId = response?.tabId;
    if (lastError.security || attempt === 1) throw lastError;
    await sleep(3000);
  }
  throw lastError;
}

function shouldSkipDetail(ref, task) {
  return task.mode === "deep" && ref.status === "sold";
}

async function processProduct(ref, task, itemIndex) {
  const partIndex = Math.floor(itemIndex / XianyuV3.PART_SIZE) + 1;
  const resumeProduct = task._resumeProduct?.itemId === ref.itemId ? task._resumeProduct : null;
  delete task._resumeProduct;
  try {
    const skipDetail = shouldSkipDetail(ref, task);
    task.status = XianyuV3.TASK_STATUS.COLLECTING;
    task.currentItem = ref.itemId;
    task.progressText = skipDetail
      ? `跳过已售出商品详情页 ${itemIndex + 1}/${task.refs.length}`
      : `读取商品 ${itemIndex + 1}/${task.refs.length}`;
    await XianyuDB.saveTask(task);
    message(task.progressText, 5 + (itemIndex / Math.max(1, task.refs.length)) * 80);
    if (skipDetail) {
      const finalized = XianyuV3.finalizeProduct({
        ...ref,
        description: "",
        imageUrls: ref.previewImageUrl ? [ref.previewImageUrl] : [],
        sourceType: task.type,
        sourceUrl: task.sourceUrl
      }, { imagePaths: [] });
      await XianyuDB.saveItem(task.taskId, finalized.product);
      task.partialCount += 1;
      return;
    }
    const raw = resumeProduct || await collectWithRetry(ref, task);
    if (!raw?.itemId || raw.unavailableReason) throw new Error(raw?.unavailableReason || "商品详情不存在或无法读取");
    task.status = XianyuV3.TASK_STATUS.DOWNLOADING_IMAGES;
    await XianyuDB.saveTask(task);
    const imageResult = await XianyuExport.downloadProductImages(raw);
    if (imageResult.fatalError) {
      imageResult.fatalError.security = true;
      throw imageResult.fatalError;
    }
    const directory = XianyuExport.directoryFor(raw);
    const imagePaths = [];
    const imageAssets = [];
    for (const entry of imageResult.results) {
      if (!entry.jpeg) continue;
      const path = `${directory}/${raw.itemId}_${String(imagePaths.length + 1).padStart(3, "0")}.jpg`;
      imagePaths.push(path);
      imageAssets.push({ path, blob: entry.jpeg });
    }
    const finalized = XianyuV3.finalizeProduct(raw, {
      imagePaths,
      failures: imageResult.results.filter((entry) => entry.error).map((entry) => ({ url: entry.url, reason: entry.error }))
    });
    if (task.mode === "item" && finalized.chargeable && !task.chargedItemIds.includes(raw.itemId)) task.chargedItemIds.push(raw.itemId);
    for (const asset of imageAssets) await XianyuDB.saveAsset(task.taskId, partIndex, asset.path, asset.blob);
    await XianyuDB.saveItem(task.taskId, finalized.product);
    finalized.product.resultStatus === "success" ? task.successCount += 1 : task.partialCount += 1;
  } catch (error) {
    if (error.security || isSecurityError(error.message)) throw error;
    task.failedCount += 1;
    await XianyuDB.addFailure(task.taskId, { itemId: ref.itemId, url: ref.url, stage: task.status, reason: error.message, partIndex });
  }
}

async function packagePart(task, partIndex) {
  const ids = task.parts?.[partIndex - 1] || [];
  const idSet = new Set(ids);
  const products = (await XianyuDB.getItems(task.taskId)).filter((row) => idSet.has(row.itemId));
  const failures = (await XianyuDB.getFailures(task.taskId)).filter((row) => Number(row.partIndex || 1) === partIndex);
  const assets = await XianyuDB.getAssets(task.taskId, partIndex);
  const blob = await XianyuExport.buildPart(task, products, failures, assets, partIndex, task.partCount);
  await downloadBlob(blob, XianyuExport.packageName(task, partIndex, task.partCount));
  await XianyuDB.clearPartAssets(task.taskId, partIndex);
}

async function packageTask(taskId) {
  const task = await XianyuDB.getTask(taskId);
  const downloaded = new Set(task.downloadedParts || []);
  for (let partIndex = 1; partIndex <= task.partCount; partIndex += 1) {
    if (downloaded.has(partIndex)) continue;
    await packagePart(task, partIndex);
    downloaded.add(partIndex);
    task.downloadedParts = [...downloaded];
    await XianyuDB.saveTask(task);
  }
}

async function pauseTask(task, status, reason) {
  task.status = status;
  task.pauseReason = reason;
  task.progressText = reason;
  task.lastSafeAt = new Date().toISOString();
  await XianyuDB.saveTask(task);
  if (status === XianyuV3.TASK_STATUS.PAUSED_VERIFICATION) {
    await chrome.runtime.sendMessage({ action: "ACTIVATE_WORKER_TAB" });
    message(`任务已暂停：${reason}。请在商品页手工完成验证，再点击“继续任务”。`);
  } else message(reason);
}

async function runDetailTask(task) {
  runningTask = task;
  const resumeProduct = task._resumeProduct;
  delete task._resumeProduct;
  task.stopRequested = false;
  task.pauseReason = "";
  task.runStartedAt = new Date().toISOString();
  await XianyuDB.saveTask(task);
  if (resumeProduct) task._resumeProduct = resumeProduct;
  const runDeadline = Date.now() + 60 * 60 * 1000;
  const completed = new Set((await XianyuDB.getItems(task.taskId)).map((row) => row.itemId));
  let processedThisRun = 0;
  for (let index = task.nextItemIndex; index < task.refs.length; index += 1) {
    if (task.stopRequested) break;
    if (Date.now() >= runDeadline) {
      await pauseTask(task, XianyuV3.TASK_STATUS.PAUSED_LIMIT, "已达到单次连续运行 60 分钟限制，请手动继续");
      return;
    }
    const ref = task.refs[index];
    const skipDetail = shouldSkipDetail(ref, task);
    if (completed.has(ref.itemId)) {
      task.nextItemIndex = index + 1;
      continue;
    }
    if (!skipDetail && processedThisRun && processedThisRun % 10 === 0) {
      const rest = randomMs(60000, 120000);
      message(`已完成 10 件，休息 ${Math.ceil(rest / 1000)} 秒…`);
      await sleep(rest);
    }
    if (!skipDetail && processedThisRun) await sleep(randomMs(10000, 20000));
    try {
      await processProduct(ref, task, index);
    } catch (error) {
      await pauseTask(task, XianyuV3.TASK_STATUS.PAUSED_VERIFICATION, error.message);
      return;
    }
    if (!skipDetail) processedThisRun += 1;
    task.nextItemIndex = index + 1;
    task.lastSafeAt = new Date().toISOString();
    await XianyuDB.saveTask(task);
  }
  task.status = XianyuV3.TASK_STATUS.PACKAGING;
  task.progressText = "正在生成结果分卷";
  await XianyuDB.saveTask(task);
  message("正在生成结果分卷…", 90);
  await packageTask(task.taskId);
  task.status = task.stopRequested || task.failedCount ? XianyuV3.TASK_STATUS.PARTIAL : XianyuV3.TASK_STATUS.COMPLETED;
  task.completedAt = new Date().toISOString();
  task.progressText = task.stopRequested ? "已安全停止并交付已有结果" : "采集完成";
  await XianyuDB.saveTask(task);
  await chrome.runtime.sendMessage({ action: "CLOSE_WORKER_TAB" });
  message(`${task.progressText}：成功 ${task.successCount}，部分 ${task.partialCount}，失败 ${task.failedCount}`, 100);
}

async function startItem() {
  const response = await runtime({ action: "READ_FROM_TAB", tabId: sourceTabId, source: { sourceType: "item", sourceUrl } });
  const task = XianyuV3.makeTask({
    type: "item", mode: "item", sourceUrl, startedAt: new Date().toISOString(), discoveredCount: 1,
    partCount: 1, refs: [{ itemId: response.product.itemId, url: response.product.url, product: response.product }],
    parts: [[response.product.itemId]]
  });
  await XianyuDB.saveTask(task);
  task._resumeProduct = response.product;
  await runDetailTask(task);
}

async function importSelection(file, expectedTaskId) {
  const parsed = XianyuExport.parseScreeningSelection(await file.arrayBuffer());
  if (parsed.taskId !== expectedTaskId) throw new Error("Excel 来源任务与所选本地任务不匹配");
  const sourceTask = await XianyuDB.getTask(parsed.taskId);
  const recent = await XianyuDB.listTasks(20);
  const expired = !sourceTask || sourceTask.mode !== "screening" || !recent.some((task) => task.taskId === parsed.taskId)
    || Date.now() - new Date(sourceTask.createdAt || 0).getTime() > 90 * 24 * 60 * 60 * 1000;
  if (expired) throw new Error("本地快速筛选任务不存在或已超过 90 天/最近 20 个任务保留范围");
  const localRecords = await XianyuDB.getScreenings(sourceTask.taskId);
  const localMap = new Map(localRecords.map((record) => [record.itemId, record]));
  const missing = parsed.selectedItemIds.filter((itemId) => !localMap.has(itemId));
  if (missing.length) throw new Error(`Excel 包含不属于本地任务的商品ID：${missing.slice(0, 3).join("、")}`);
  const refs = parsed.selectedItemIds.map((itemId) => localMap.get(itemId));
  const task = XianyuV3.makeTask({
    type: sourceTask.type, mode: "deep", sourceTaskId: sourceTask.taskId, sourceUrl: sourceTask.sourceUrl,
    startedAt: new Date().toISOString(), discoveredCount: refs.length, selectedItemIds: refs.map((ref) => ref.itemId),
    refs, partCount: Math.ceil(refs.length / XianyuV3.PART_SIZE), parts: XianyuV3.splitParts(refs).map((part) => part.map((ref) => ref.itemId))
  });
  await XianyuDB.saveTask(task);
  await runDetailTask(task);
}

async function startTask() {
  $("startTask").disabled = true;
  $("stopTask").disabled = false;
  try {
    if (sourceType === "item") await startItem();
    else await startScreening();
  } catch (error) {
    if (runningTask) {
      runningTask.status = isSecurityError(error.message) ? XianyuV3.TASK_STATUS.PAUSED_VERIFICATION : XianyuV3.TASK_STATUS.FAILED;
      runningTask.error = error.message;
      runningTask.progressText = error.message;
      await XianyuDB.saveTask(runningTask);
      if (runningTask.status === XianyuV3.TASK_STATUS.PAUSED_VERIFICATION && (runningTask.sourceTabId || sourceTabId)) {
        await chrome.tabs.update(runningTask.sourceTabId || sourceTabId, { active: true }).catch(() => {});
      }
    }
    message(error.message);
  } finally {
    runningTask = null;
    $("startTask").disabled = false;
    $("stopTask").disabled = true;
    await XianyuDB.pruneTasks();
    await renderTasks();
  }
}

async function renderTasks() {
  const tasks = await XianyuDB.listTasks(20);
  $("taskRows").innerHTML = tasks.map((task) => {
    const actions = [];
    if (task.mode === "screening" && ["completed", "partial"].includes(task.status)) {
      actions.push(`<button class="secondary task-action export-screen" data-id="${escapeHtml(task.taskId)}">下载筛选表</button>`);
      actions.push(`<button class="secondary task-action import-deep" data-id="${escapeHtml(task.taskId)}">导入并深度采集</button>`);
    }
    if (["pending", "collecting", "downloading_images", "packaging", "paused_verification", "paused_limit"].includes(task.status) && ["deep", "item"].includes(task.mode)) actions.push(`<button class="secondary task-action resume" data-id="${escapeHtml(task.taskId)}">继续任务</button>`);
    if (task.status === "paused_verification" && task.mode === "screening") actions.push(`<button class="secondary task-action resume-screen" data-id="${escapeHtml(task.taskId)}">验证后重试筛选</button>`);
    if (task.mode !== "screening" && task.partCount && (task.downloadedParts || []).length < task.partCount && (task.successCount || task.partialCount || task.failedCount)) actions.push(`<button class="secondary task-action package" data-id="${escapeHtml(task.taskId)}">下载已有结果</button>`);
    const taskSource = escapeHtml(task.sourceUrl || "-");
    return `<tr><td><strong>${escapeHtml(taskTypeName(task.type))} · ${escapeHtml(taskModeName(task))}</strong><div class="task-source" title="${taskSource}">${taskSource}</div></td><td><span class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><br><small>${escapeHtml(task.progressText || task.pauseReason || "")}</small></td><td>${Number(task.successCount)}/${Number(task.partialCount)}/${Number(task.failedCount)}<br><small>发现/选中 ${Number(task.discoveredCount)}</small></td><td>${task.startedAt ? new Date(task.startedAt).toLocaleString() : "-"}</td><td><div class="task-actions">${actions.join("") || "-"}</div></td></tr>`;
  }).join("") || '<tr><td colspan="5">暂无任务</td></tr>';
  document.querySelectorAll(".export-screen").forEach((button) => button.addEventListener("click", () => exportScreening(button.dataset.id).catch((error) => toast(error.message))));
  document.querySelectorAll(".import-deep").forEach((button) => button.addEventListener("click", () => { pendingSourceTaskId = button.dataset.id; $("screeningFile").value = ""; $("screeningFile").click(); }));
  document.querySelectorAll(".resume").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const task = await XianyuDB.getTask(button.dataset.id);
      if (task.status === XianyuV3.TASK_STATUS.PAUSED_VERIFICATION) {
        const checked = await chrome.runtime.sendMessage({ action: "READ_WORKER_PRODUCT", source: { sourceType: task.type, sourceUrl: task.sourceUrl } });
        if (checked?.product?.securityReason || isSecurityError(checked?.error)) {
          await chrome.runtime.sendMessage({ action: "ACTIVATE_WORKER_TAB" });
          throw new Error(checked?.error || checked.product?.securityReason || "安全验证仍未完成");
        }
        if (checked?.ok && checked.product?.itemId === task.refs[task.nextItemIndex]?.itemId) task._resumeProduct = checked.product;
      }
      await runDetailTask(task);
    }
    catch (error) { toast(error.message); }
    finally { runningTask = null; button.disabled = false; await renderTasks(); }
  }));
  document.querySelectorAll(".resume-screen").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const task = await XianyuDB.getTask(button.dataset.id);
      await chrome.tabs.get(task.sourceTabId);
      await startScreening(task);
    } catch (error) { toast(`${error.message}。若来源页已关闭，请从正确店铺/搜索页新建筛选任务。`); }
    finally { runningTask = null; button.disabled = false; await renderTasks(); }
  }));
  document.querySelectorAll(".package").forEach((button) => button.addEventListener("click", () => packageTask(button.dataset.id).then(() => renderTasks()).catch((error) => toast(error.message))));
}

$("screeningFile").addEventListener("change", async () => {
  const file = $("screeningFile").files[0];
  if (!file || !pendingSourceTaskId) return;
  try { await importSelection(file, pendingSourceTaskId); }
  catch (error) { toast(error.message); }
  finally { runningTask = null; pendingSourceTaskId = ""; await renderTasks(); }
});
$("startTask").addEventListener("click", startTask);
$("stopTask").addEventListener("click", async () => {
  if (!runningTask) return;
  runningTask.stopRequested = true;
  runningTask.progressText = "正在完成当前安全写入并停止";
  await XianyuDB.saveTask(runningTask);
  message(runningTask.progressText);
});
$("refreshTasks").addEventListener("click", renderTasks);

(async () => {
  await XianyuDB.pruneTasks();
  await Promise.all([inspectSource(), renderTasks()]);
})().catch((error) => message(error.message));
