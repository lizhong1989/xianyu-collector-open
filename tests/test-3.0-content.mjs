import fs from "node:fs";
import vm from "node:vm";

let listener;
let sellerHref = null;
const image = { currentSrc: "https://img.alicdn.com/item.jpg_800x800.jpg", src: "", dataset: {}, srcset: "" };
function makeCard({ text, title, price, seller }) {
  return {
    innerText: text,
    querySelector(selector) {
      if (selector.includes("title")) return title ? { textContent: title } : null;
      if (selector.includes("price") || selector.includes("data-price") || selector.includes("aria-label")) return price ? { textContent: price, dataset: {}, getAttribute() { return ""; } } : null;
      if (selector.includes("seller-name")) return seller ? { textContent: seller } : null;
      if (selector === "img") return image;
      return null;
    }
  };
}
const activeCard = makeCard({ text: "测试标题 ¥1.78412 412人想要", title: "测试标题", price: "¥1.78412人想要", seller: "安徽4分钟内发货" });
const soldCard = makeCard({ text: "已卖出 ¥9.9 1.2万人想要", title: "已售商品", price: "¥9.9", seller: "真实卖家\n回复超快" });
const cards = [
  { href: "https://www.goofish.com/item?id=1", innerText: "在售", closest: () => activeCard },
  { href: "https://www.goofish.com/item?id=2", innerText: "已卖出", closest: () => soldCard },
  { href: "https://www.goofish.com/item?id=1", innerText: "重复", closest: () => ({ innerText: "重复" }) }
];
const descriptionNode = { innerText: "第一行\n第二行" };
const context = vm.createContext({
  console, URL, Date, Promise, globalThis: null,
  location: { href: "https://www.goofish.com/item?id=123", protocol: "https:" },
  document: {
    body: { innerText: "正常商品页面" }, documentElement: { scrollHeight: 1000 },
    querySelector(selector) {
      if (selector.includes('link[rel="canonical"]')) return { href: "https://www.goofish.com/item?id=123" };
      if (selector.includes('meta[property="og:title"]')) return { content: "结构化商品" };
      if (selector.includes('meta[property="og:image"]')) return { content: image.currentSrc };
      if (selector.includes('a[href*="personal"]')) return sellerHref ? { href: sellerHref } : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') return [{ textContent: JSON.stringify({ "@type": "Product", name: "为你推荐", description: "正确文案标题\n正文第二段", image: [image.currentSrc], offers: { price: "99", availability: "InStock" } }) }];
      if (selector.includes("carousel") || selector.includes("swiper")) return [image];
      if (selector.includes('a[href*="/item"]')) return cards;
      if (selector.includes("desc")) return [descriptionNode];
      return [];
    }
  },
  window: { scrollTo() {} },
  setTimeout(callback) { callback(); return 1; }, clearTimeout() {},
  chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(context.XianyuContent.pageType() === "item", "单商品页面识别失败");
const product = context.XianyuContent.readCurrentProduct({ sourceType: "item", sourceUrl: context.location.href });
assert(product.itemId === "123" && product.title === "正确文案标题" && product.description === "正确文案标题\n正文第二段" && product.price === 99, "详情字段读取失败或文案标题未取详情第一段");
assert(product.sellerId === "" && product.shopUrl === "", "缺少卖家链接时不应把商品ID回填为卖家ID");
sellerHref = "https://www.goofish.com/personal?userId=seller-9";
const productWithSeller = context.XianyuContent.readCurrentProduct({});
assert(productWithSeller.sellerId === "seller-9" && productWithSeller.shopUrl === sellerHref, "有卖家链接时应读取卖家ID与店铺URL");
assert(product.imageUrls.length === 1 && product.imageUrls[0].endsWith("item.jpg"), "原图 URL 去重/规格清理失败");
assert(context.XianyuContent.parseCardPrice("¥1.78412人想要", 412, true) === 1.78, "小数价格与想要数粘连修正失败");
assert(context.XianyuContent.parseCardPrice("12352人想要", 2352, true) === 1, "整数价格与想要数粘连修正失败");
assert(context.XianyuContent.parseCardPrice("12", 2, true) === 1, "单个想要数与整数价格粘连修正失败");
assert(context.XianyuContent.parseCount("1.2万人想要") === 12000, "万单位想要数解析失败");
assert(context.XianyuContent.cleanSellerName("安徽4分钟内发货") === "", "发货地区不应识别为卖家名称");
assert(context.XianyuContent.cleanSellerName("真实卖家\n回复超快") === "真实卖家", "卖家名称清理失败");
context.location.href = "https://www.goofish.com/personal?userId=seller";
assert(context.XianyuContent.pageType() === "shop", "店铺页面识别失败");
const activeRecords = context.XianyuContent.discoverCards("shop", false);
assert(activeRecords.size === 1, "店铺在售过滤或去重失败");
assert(activeRecords.get("1").price === 1.78 && activeRecords.get("1").wantCount === 412 && activeRecords.get("1").sellerName === "", "在售卡片字段解析失败");
const allRecords = context.XianyuContent.discoverCards("shop", true);
assert(allRecords.size === 2 && allRecords.get("2").price === 9.9 && allRecords.get("2").wantCount === 12000 && allRecords.get("2").sellerName === "真实卖家", "包含已卖出卡片字段解析失败");
context.location.href = "https://www.goofish.com/search?q=camera&sort=price";
assert(context.XianyuContent.pageType() === "search", "搜索页面识别失败");
const response = await new Promise((resolve) => listener({ action: "DISCOVER_PRODUCTS", options: { type: "search", requestedBatches: 10, waitMs: 1 } }, {}, resolve));
assert(response.ok && response.products.length === 2 && response.actualBatches === 1, "搜索批次/去重/提前结束失败");
console.log("3.0 页面识别、详情、列表价格/想要数/卖家、店铺过滤和搜索批次通过。");
