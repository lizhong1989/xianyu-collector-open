import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../extension/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(manifest.manifest_version === 3 && manifest.version === "3.0.0" && manifest.name === "闲鱼采集器", "清单名称/版本错误");
assert(manifest.permissions.includes("downloads"), "缺少 downloads 权限");
for (const file of ["background.js", "popup.html", "dashboard.html", "dashboard.js", "model.js", "db.js", "content.js", "export.js", "config.js", "vendor/xlsx.full.min.js", "vendor/jszip.min.js"]) assert(fs.existsSync(path.join(root, file)), `运行文件缺失: ${file}`);
const ui = fs.readFileSync(path.join(root, "dashboard.html"), "utf8") + fs.readFileSync(path.join(root, "popup.html"), "utf8");
for (const removed of ["历史快照", "筛选分析", "批量店铺", "CSV", "兼容 XLS", "收藏", "备注", "本地备份"]) assert(!ui.includes(removed), `界面仍包含已移除功能: ${removed}`);
const dashboard = fs.readFileSync(path.join(root, "dashboard.js"), "utf8");
for (const marker of ["DISCOVER_FROM_TAB", "COLLECT_DETAIL", "PART_SIZE", "packageTask"]) assert(dashboard.includes(marker), `任务链路缺失: ${marker}`);
assert(!/<script[^>]+src=["']https?:/i.test(ui), "不允许远程 UI 脚本");
for (const entry of ["商品采集", "店铺采集", "搜索商品采集"]) assert(ui.includes(entry), `缺少菜单入口: ${entry}`);
assert(ui.includes("screeningFile") && dashboard.includes("导入并深度采集"), "缺少筛选 Excel 深度采集入口");
const config = fs.readFileSync(path.join(root, "config.js"), "utf8");
assert(!/BUY_KEY_URL|LICENSE_API_URL/i.test(config) && !config.includes("gfauth"), "公开版残留私有服务配置: config.js");
for (const file of ["background.js", "content.js", "dashboard.js", "db.js", "export.js", "model.js", "popup.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert(!/(?:gfauth|gfupdate)\.|ADMIN_|BUY_KEY_URL/i.test(source), `公开版残留私有服务引用: ${file}`);
}
const dashboardCss = fs.readFileSync(path.join(root, "dashboard.css"), "utf8");
for (const marker of ["table-layout:fixed", "-webkit-line-clamp:3", ".task-action", "white-space:nowrap"]) assert(dashboardCss.includes(marker), `最近任务固定布局缺失: ${marker}`);
console.log("3.0 清单、权限、运行文件、简化 UI 和统一任务链路通过。");
