(function (root) {
  "use strict";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safeCell(value) {
    if (typeof value !== "string") return value ?? "";
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
  }

  function markdownFor(product) {
    const title = String(product.title || "未命名商品").replace(/[\r\n]+/g, " ").trim();
    const description = String(product.description || "");
    return `# ${title}\n\n${description}${description.endsWith("\n") ? "" : "\n"}`;
  }

  function directoryFor(product) {
    return `${root.XianyuV3.safeName(product.itemId, "unknown", 32)}_${root.XianyuV3.safeName(product.title, "闲鱼商品", 40)}`;
  }

  function productRow(product) {
    const dir = directoryFor(product);
    const md = `${dir}/${product.itemId}_商品文案.md`;
    return {
      商品ID: safeCell(product.itemId), 商品URL: safeCell(product.url), 标题: safeCell(product.title),
      描述: safeCell(product.description), 价格: product.price ?? "", 原价: product.originalPrice ?? "",
      状态: safeCell(product.status), 想要数: product.wantCount ?? "", 卖家名称: safeCell(product.sellerName),
      卖家ID: safeCell(product.sellerId), 店铺URL: safeCell(product.shopUrl || ""), 地区: safeCell(product.location),
      发布时间: safeCell(product.publishTime), 分类: safeCell(product.category), 成色: safeCell(product.condition),
      运费: product.shippingFee ?? "", 图片数量: product.imageCount || 0,
      图片原始地址: safeCell((product.imageUrls || []).join("\n")), 来源类型: product.sourceType,
      来源URL: safeCell(product.sourceUrl), 采集时间: product.collectedAt, 结果状态: product.resultStatus,
      失败原因: safeCell(product.failureReason), 商品目录: dir, Markdown路径: md,
      图片路径: (product.imagePaths || []).join("\n")
    };
  }

  function failureRow(value) {
    return {
      商品ID: safeCell(value.itemId), 商品URL: safeCell(value.url || ""), 阶段: safeCell(value.stage),
      原因: safeCell(value.reason || value.failureReason), 时间: value.createdAt || new Date().toISOString()
    };
  }

  function screeningRow(record, taskId) {
    return {
      商品ID: safeCell(record.itemId), 标题: safeCell(record.title), 价格: record.price ?? "",
      列表状态: safeCell(record.status), 想要数: record.wantCount ?? "", 卖家名称: safeCell(record.sellerName),
      商品URL: safeCell(record.url || ""), 列表预览图地址: safeCell(record.previewImageUrl || ""),
      是否导出详细数据: "", 来源任务ID: taskId
    };
  }

  function configureScreeningSheet(sheet, rowCount) {
    sheet["!cols"] = [16, 48, 12, 12, 10, 18, 36, 36, 18, 42].map((wch) => ({ wch }));
    sheet["!rows"] = [{ hpt: 22 }];
    sheet["!autofilter"] = { ref: `A1:J${Math.max(1, rowCount + 1)}` };
    for (let row = 2; row <= rowCount + 1; row += 1) {
      const cell = sheet[`A${row}`];
      if (cell) {
        cell.t = "s";
        cell.z = "@";
      }
    }
  }

  function screeningWorkbookBytes(task, records, failures) {
    const rows = records.map((record) => screeningRow(record, task.taskId));
    const failedRows = failures.map(failureRow);
    const infoRows = [
      ["任务ID", task.taskId], ["任务模式", "快速筛选"], ["来源类型", task.type], ["来源URL", task.sourceUrl],
      ["发现商品数", task.discoveredCount], ["导出商品数", records.length], ["截断原因", task.truncatedReason || ""],
      ["选中说明", "在商品数据工作表的“是否导出详细数据”列填写 是/Y/YES/1/TRUE/√；筛选或隐藏行不代表选中"]
    ].map(([项目, 内容]) => ({ 项目, 内容: safeCell(内容) }));
    const workbook = root.XLSX.utils.book_new();
    const dataSheet = rows.length
      ? root.XLSX.utils.json_to_sheet(rows)
      : root.XLSX.utils.aoa_to_sheet([Object.keys(screeningRow({}, task.taskId))]);
    const failureSheet = root.XLSX.utils.json_to_sheet(failedRows.length ? failedRows : [{ 说明: "没有失败记录" }]);
    const infoSheet = root.XLSX.utils.json_to_sheet(infoRows);
    configureScreeningSheet(dataSheet, rows.length);
    if (rows.length) setUrlLinks(dataSheet, rows);
    root.XLSX.utils.book_append_sheet(workbook, dataSheet, "商品数据");
    root.XLSX.utils.book_append_sheet(workbook, failureSheet, "失败清单");
    root.XLSX.utils.book_append_sheet(workbook, infoSheet, "任务说明");
    return root.XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  }

  function parseScreeningSelection(bytes) {
    const workbook = root.XLSX.read(bytes, { type: "array" });
    if (!workbook.Sheets["商品数据"] || !workbook.Sheets["任务说明"]) throw new Error("不是闲鱼采集器快速筛选 Excel");
    const dataSheet = workbook.Sheets["商品数据"];
    const headers = root.XLSX.utils.sheet_to_json(dataSheet, { header: 1, defval: "" })[0] || [];
    if (!headers.includes("是否导出详细数据")) throw new Error("Excel 缺少“是否导出详细数据”列，请使用新版快速筛选表");
    const rows = root.XLSX.utils.sheet_to_json(dataSheet, { defval: "" });
    const info = root.XLSX.utils.sheet_to_json(workbook.Sheets["任务说明"], { defval: "" });
    const taskId = String(info.find((row) => String(row.项目).trim() === "任务ID")?.内容 || rows[0]?.来源任务ID || "").trim();
    if (!taskId) throw new Error("Excel 缺少来源任务ID");
    const selectedItemIds = root.XianyuV3.uniqueStrings(rows.filter((row) => root.XianyuV3.isSelectedMarker(row.是否导出详细数据)).map((row) => row.商品ID));
    if (!selectedItemIds.length) throw new Error("没有商品被标记为导出详细数据");
    return { taskId, selectedItemIds };
  }

  function taskRows(task, partIndex, partCount, partItemIds) {
    return [
      ["任务ID", task.taskId], ["任务类型", task.type], ["任务模式", task.mode || "item"],
      ["来源快速筛选任务ID", task.sourceTaskId || ""], ["来源URL", task.sourceUrl],
      ["包含已卖出", task.includeSold ? "是" : "否"], ["请求批次数", task.requestedBatches],
      ["实际批次数", task.actualBatches], ["发现商品数", task.discoveredCount],
      ["成功数", task.successCount], ["部分成功数", task.partialCount], ["失败数", task.failedCount],
      ["开始时间", task.startedAt], ["完成时间", task.completedAt], ["分卷", `${partIndex}/${partCount}`],
      ["本卷商品ID", partItemIds.join(",")]
    ].map(([项目, 内容]) => ({ 项目, 内容: safeCell(内容) }));
  }

  function setUrlLinks(sheet, rows) {
    ["商品URL", "店铺URL", "来源URL"].forEach((column) => {
      const index = Object.keys(rows[0] || {}).indexOf(column);
      if (index < 0) return;
      rows.forEach((row, rowIndex) => {
        const value = row[column];
        const address = root.XLSX.utils.encode_cell({ r: rowIndex + 1, c: index });
        if (value && sheet[address]) sheet[address].l = { Target: value };
      });
    });
  }

  function workbookBytes(task, products, failures, partIndex, partCount) {
    const rows = products.map(productRow);
    const failedRows = failures.map(failureRow);
    const infoRows = taskRows(task, partIndex, partCount, products.map((value) => value.itemId));
    const workbook = root.XLSX.utils.book_new();
    const dataSheet = root.XLSX.utils.json_to_sheet(rows.length ? rows : [{ 说明: "本卷没有成功或部分成功商品" }]);
    const failureSheet = root.XLSX.utils.json_to_sheet(failedRows.length ? failedRows : [{ 说明: "本卷没有失败记录" }]);
    const infoSheet = root.XLSX.utils.json_to_sheet(infoRows);
    if (rows.length) setUrlLinks(dataSheet, rows);
    if (failedRows.length) setUrlLinks(failureSheet, failedRows);
    root.XLSX.utils.book_append_sheet(workbook, dataSheet, "商品数据");
    root.XLSX.utils.book_append_sheet(workbook, failureSheet, "失败清单");
    root.XLSX.utils.book_append_sheet(workbook, infoSheet, "任务说明");
    return root.XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  }

  function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { credentials: "include", signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  async function fetchImage(url, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, options.timeoutMs || 20000);
        if (response.status === 403 || response.status === 429) {
          const error = new Error(`图片请求返回 HTTP ${response.status}`);
          error.fatal = true;
          throw error;
        }
        if (!response.ok) throw new Error(`图片请求返回 HTTP ${response.status}`);
        return await response.blob();
      } catch (error) {
        lastError = error;
        if (error.fatal || attempt === 1) throw error;
        await sleep(options.retryDelayMs || 2000);
      }
    }
    throw lastError;
  }

  async function toJpeg(blob, quality = 0.92) {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
      const jpeg = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("JPEG 编码失败")), "image/jpeg", quality));
      const header = new Uint8Array(await jpeg.slice(0, 3).arrayBuffer());
      if (header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) throw new Error("JPEG 解码验证失败");
      const validation = await createImageBitmap(jpeg);
      try {
        if (validation.width !== bitmap.width || validation.height !== bitmap.height) throw new Error("JPEG 解码尺寸不一致");
      } finally {
        validation.close();
      }
      return jpeg;
    } finally {
      bitmap.close();
    }
  }

  async function mapLimit(values, limit, worker) {
    const result = new Array(values.length);
    let cursor = 0;
    async function run() {
      while (cursor < values.length) {
        const index = cursor++;
        result[index] = await worker(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
    return result;
  }

  async function downloadProductImages(product) {
    let fatalError = null;
    const values = product.imageUrls || [];
    const results = [];
    for (let offset = 0; offset < values.length; offset += 2) {
      const batch = values.slice(offset, offset + 2);
      const entries = await Promise.all(batch.map(async (url, innerIndex) => {
        const index = offset + innerIndex;
        if (fatalError) return { url, error: "任务已因安全响应暂停" };
        try {
          const jpeg = await toJpeg(await fetchImage(url));
          return { url, index, jpeg };
        } catch (error) {
          if (error.fatal) fatalError = error;
          return { url, index, error: error.message, fatal: Boolean(error.fatal) };
        }
      }));
      results.push(...entries);
      if (fatalError) break;
      if (offset + 2 < values.length) await sleep(1000 + Math.floor(Math.random() * 2001));
    }
    return { results, fatalError };
  }

  async function buildPart(task, products, failures, assets, partIndex, partCount) {
    const zip = new root.JSZip();
    zip.file("商品数据.xlsx", workbookBytes(task, products, failures, partIndex, partCount));
    products.forEach((product) => {
      const dir = directoryFor(product);
      zip.file(`${dir}/${product.itemId}_商品文案.md`, markdownFor(product));
    });
    assets.forEach((asset) => zip.file(asset.path, asset.blob));
    return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }

  function packageName(task, partIndex, partCount) {
    const typeNames = { item: "单商品", shop: "店铺", search: "搜索" };
    const stamp = String(task.startedAt || new Date().toISOString()).replace(/[-:TZ.]/g, "").slice(0, 14);
    const prefix = task.mode === "item" ? "闲鱼单商品采集" : "闲鱼深度采集";
    return `${prefix}_${typeNames[task.type] || task.type}_${stamp}_part${String(partIndex).padStart(3, "0")}-of${String(partCount).padStart(3, "0")}.zip`;
  }

  function screeningName(task) {
    const typeNames = { shop: "店铺", search: "搜索" };
    const stamp = String(task.startedAt || new Date().toISOString()).replace(/[-:TZ.]/g, "").slice(0, 14);
    return `闲鱼快速筛选_${typeNames[task.type] || task.type}_${stamp}.xlsx`;
  }

  root.XianyuExport = {
    buildPart, directoryFor, downloadProductImages, failureRow, markdownFor, packageName,
    parseScreeningSelection, productRow, safeCell, screeningName, screeningRow, screeningWorkbookBytes,
    taskRows, toJpeg, workbookBytes
  };
})(globalThis);
