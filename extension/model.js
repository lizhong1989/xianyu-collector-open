(function (root) {
  "use strict";

  const CORE_FIELDS = ["itemId", "url", "title", "description", "price", "status"];
  const TASK_STATUS = Object.freeze({
    PENDING: "pending",
    DISCOVERING: "discovering",
    COLLECTING: "collecting",
    DOWNLOADING_IMAGES: "downloading_images",
    PACKAGING: "packaging",
    COMPLETED: "completed",
    PARTIAL: "partial",
    FAILED: "failed",
    PAUSED_VERIFICATION: "paused_verification",
    PAUSED_LIMIT: "paused_limit"
  });
  const PART_SIZE = 100;
  const TASK_RETENTION_DAYS = 90;
  const TASK_RETENTION_COUNT = 20;

  function text(value) {
    return String(value ?? "").trim();
  }

  function numberOrNull(value) {
    if (value === "" || value == null) return null;
    const valueNumber = Number(value);
    return Number.isFinite(valueNumber) ? valueNumber : null;
  }

  function uniqueStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
  }

  function normalizeProduct(value = {}) {
    const collectedAt = text(value.collectedAt) || new Date().toISOString();
    return {
      itemId: text(value.itemId),
      url: text(value.url),
      title: text(value.title),
      description: String(value.description ?? ""),
      price: numberOrNull(value.price),
      originalPrice: numberOrNull(value.originalPrice),
      wantCount: numberOrNull(value.wantCount),
      status: text(value.status) || "unknown",
      sellerName: text(value.sellerName),
      sellerId: text(value.sellerId),
      shopUrl: text(value.shopUrl),
      location: text(value.location),
      publishTime: text(value.publishTime),
      category: text(value.category),
      condition: text(value.condition),
      shippingFee: numberOrNull(value.shippingFee),
      imageUrls: uniqueStrings(value.imageUrls),
      imagePaths: uniqueStrings(value.imagePaths),
      imageCount: Math.max(0, Number(value.imageCount || 0)),
      sourceType: text(value.sourceType),
      sourceUrl: text(value.sourceUrl),
      collectedAt,
      resultStatus: text(value.resultStatus) || "partial",
      failureReason: text(value.failureReason)
    };
  }

  function normalizeScreening(value = {}) {
    const record = {
      itemId: text(value.itemId),
      url: text(value.url),
      title: text(value.title),
      price: numberOrNull(value.price),
      status: text(value.status) || "unknown",
      wantCount: numberOrNull(value.wantCount),
      sellerName: text(value.sellerName),
      previewImageUrl: text(value.previewImageUrl),
      sourceType: text(value.sourceType),
      sourceUrl: text(value.sourceUrl),
      collectedAt: text(value.collectedAt) || new Date().toISOString(),
      resultStatus: text(value.resultStatus) || "pending",
      failureReason: text(value.failureReason),
      quotaConsumed: Boolean(value.quotaConsumed)
    };
    const missing = ["itemId", "url", "title"].filter((field) => !record[field]);
    if (!Number.isFinite(record.price) || record.price < 0) missing.push("price");
    record.resultStatus = missing.length ? "failed" : "success";
    record.failureReason = missing.length ? `缺少快速筛选必填字段：${missing.join("、")}` : "";
    return record;
  }

  function normalizeTaskRef(value = {}) {
    return {
      itemId: text(value.itemId),
      url: text(value.url),
      title: text(value.title),
      price: numberOrNull(value.price),
      status: text(value.status) || "unknown",
      wantCount: numberOrNull(value.wantCount),
      sellerName: text(value.sellerName),
      previewImageUrl: text(value.previewImageUrl),
      sourceType: text(value.sourceType),
      sourceUrl: text(value.sourceUrl),
      collectedAt: text(value.collectedAt)
    };
  }

  function isSelectedMarker(value) {
    return new Set(["是", "Y", "YES", "1", "TRUE", "√"]).has(text(value).toUpperCase());
  }

  function missingCoreFields(product) {
    return CORE_FIELDS.filter((field) => {
      const value = product?.[field];
      return value == null || value === "" || (field === "status" && value === "unknown") || (field === "price" && !Number.isFinite(Number(value)));
    });
  }

  function finalizeProduct(value = {}, imageResult = {}) {
    const product = normalizeProduct({
      ...value,
      imagePaths: imageResult.imagePaths || value.imagePaths,
      imageCount: (imageResult.imagePaths || value.imagePaths || []).length
    });
    const missing = missingCoreFields(product);
    const imageFailures = Array.isArray(imageResult.failures) ? imageResult.failures : [];
    const reasons = [];
    if (missing.length) reasons.push(`缺少核心字段：${missing.join("、")}`);
    if (!product.imageCount) reasons.push("没有成功图片");
    if (imageFailures.length) reasons.push(`${imageFailures.length} 张图片失败`);
    product.resultStatus = reasons.length ? "partial" : "success";
    product.failureReason = reasons.join("；");
    return {
      product,
      chargeable: missing.length === 0 && product.imageCount > 0,
      failures: imageFailures
    };
  }

  function makeTask(values = {}) {
    const now = new Date().toISOString();
    const randomId = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
      taskId: text(values.taskId) || `task-${randomId}`,
      type: text(values.type) || "item",
      mode: text(values.mode) || (text(values.type) === "item" ? "item" : "screening"),
      sourceTaskId: text(values.sourceTaskId),
      sourceUrl: text(values.sourceUrl),
      sourceTabId: Math.max(0, Number(values.sourceTabId || 0)),
      includeSold: Boolean(values.includeSold),
      requestedBatches: Math.min(10, Math.max(1, Number(values.requestedBatches || 1))),
      status: text(values.status) || TASK_STATUS.PENDING,
      discoveredCount: Math.max(0, Number(values.discoveredCount || 0)),
      successCount: Math.max(0, Number(values.successCount || 0)),
      partialCount: Math.max(0, Number(values.partialCount || 0)),
      failedCount: Math.max(0, Number(values.failedCount || 0)),
      startedAt: text(values.startedAt),
      deadlineAt: text(values.deadlineAt),
      completedAt: text(values.completedAt),
      createdAt: text(values.createdAt) || now,
      updatedAt: now,
      currentItem: text(values.currentItem),
      progressText: text(values.progressText) || "等待开始",
      partIndex: Math.max(0, Number(values.partIndex || 0)),
      partCount: Math.max(0, Number(values.partCount || 0)),
      partItemIds: uniqueStrings(values.partItemIds),
      actualBatches: Math.max(0, Number(values.actualBatches || 0)),
      stopRequested: Boolean(values.stopRequested),
      error: text(values.error),
      nextItemIndex: Math.max(0, Number(values.nextItemIndex || 0)),
      chargedItemIds: uniqueStrings(values.chargedItemIds),
      selectedItemIds: uniqueStrings(values.selectedItemIds),
      pauseReason: text(values.pauseReason),
      lastSafeAt: text(values.lastSafeAt),
      downloadedParts: [...new Set((Array.isArray(values.downloadedParts) ? values.downloadedParts : []).map(Number).filter((value) => value > 0))],
      refs: Array.isArray(values.refs) ? values.refs.map(normalizeTaskRef).filter((ref) => ref.itemId && ref.url) : [],
      parts: Array.isArray(values.parts) ? values.parts.map(uniqueStrings) : [],
      runStartedAt: text(values.runStartedAt),
      truncatedReason: text(values.truncatedReason)
    };
  }

  function splitParts(values, size = PART_SIZE) {
    const rows = Array.isArray(values) ? values : [];
    const result = [];
    for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
    return result;
  }

  function safeName(value, fallback = "闲鱼商品", max = 40) {
    const cleaned = text(value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .slice(0, max);
    return cleaned || fallback;
  }

  root.XianyuV3 = {
    CORE_FIELDS,
    PART_SIZE,
    TASK_RETENTION_COUNT,
    TASK_RETENTION_DAYS,
    TASK_STATUS,
    finalizeProduct,
    makeTask,
    missingCoreFields,
    isSelectedMarker,
    normalizeProduct,
    normalizeScreening,
    safeName,
    splitParts,
    uniqueStrings
  };
})(globalThis);
