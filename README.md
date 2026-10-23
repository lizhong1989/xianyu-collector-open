# Xianyu Collector

[简体中文](README.zh-CN.md) | English

A Chrome Manifest V3 extension for organising publicly visible listings on Xianyu (Goofish). This repository is the open-source edition of the extension. It does not include the commercial licence server, activation keys, administrative tools, customer data, purchase links or marketing material. The extension UI is currently in Simplified Chinese.

Users pick one of three entry points from the popup:

- Item collection reads a product detail page and exports the complete description, fields and product images.
- Shop collection reads the visible listing cards of the current shop and exports a screening workbook.
- Search collection reads one to ten loaded result batches and exports the same screening workbook.

Shop and search collection deliberately stop at list-level fields. To collect detail data, mark rows in the `是否导出详细数据` (export detail data) column of the screening workbook, then import that workbook from the local task list. Only the matching item IDs already stored in the local task are opened. Images and descriptions are fetched one item at a time with a random delay.

## Output

Screening produces `闲鱼快速筛选_<shop-or-search>_<timestamp>.xlsx`. Detail collection produces ZIP parts of at most 100 items:

```text
闲鱼深度采集_<type>_<timestamp>_part001-of003.zip
├─ 商品数据.xlsx
├─ <item-id>_<short-title>/
│  ├─ <item-id>_商品文案.md
│  └─ <item-id>_001.jpg
└─ ...
```

Single-item collection writes the `闲鱼单商品采集_` prefix instead of `闲鱼深度采集_`. `商品数据.xlsx` always has three sheets: `商品数据` (product data), `失败清单` (failure list) and `任务说明` (task notes). Images are downloaded with at most two concurrent requests and re-encoded as standard JPEG at quality 0.92.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the `extension/` directory.
3. Open a signed-in Xianyu page, then use the popup entry that matches the page.

Version 3 starts with a fresh IndexedDB store and does not migrate data from version 2.

## Privacy

Collected data stays in the browser. The extension has no analytics, account system or remote licence check. It requests `storage`, `activeTab`, `tabs` and `downloads`, plus host access to Goofish and the CDN domains used for product images.

## Responsible use

The extension reads information already rendered on public pages. It does not bypass login, captchas, access controls or rate limits. A 403, 429, slider or security prompt pauses the task and brings the product tab forward; the user must complete verification manually before resuming. Tasks stop after 60 continuous minutes, keep at most the 20 most recent tasks for 90 days, and never send requests while no task is running.

Respect the target platform's terms and applicable law. Listing view counts are observations, not sales figures, and this tool is not affiliated with Xianyu or Goofish.

## Development

```powershell
npm ci
npm test
```

Node.js 20 or newer is required for the test suite. There is no build step; the `extension/` directory is the loadable extension.

## Third-party notices

The extension bundles two libraries in `extension/vendor/`:

- `xlsx.full.min.js`: SheetJS Community Edition, Apache License 2.0. Full text: `extension/vendor/xlsx.LICENSE.txt`.
- `jszip.min.js`: JSZip, dual-licensed MIT/GPLv3. Full notice: `extension/vendor/jszip.LICENSE.md`.

Project source is licensed under the MIT License; see `LICENSE`.

