(function (root) {
  "use strict";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomMs = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const text = (value) => String(value ?? "").trim();
  const cleanText = (value) => text(value).replace(/\u00a0/g, " ");

  function itemIdFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      return text(url.searchParams.get("id") || url.searchParams.get("itemId") || url.pathname.match(/item\/(\d+)/)?.[1]);
    } catch (_) {
      return "";
    }
  }

  function pageType(url = location.href) {
    if (itemIdFromUrl(url) || /\/item(?:[/?]|$)/i.test(url)) return "item";
    if (/personal|shop|userId=/i.test(url)) return "shop";
    if (/search|q=|keyword=/i.test(url)) return "search";
    return "unknown";
  }

  function parseNumber(value) {
    const match = cleanText(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function parseCount(value) {
    const raw = cleanText(value).replace(/,/g, "");
    const match = raw.match(/(\d+(?:\.\d+)?)\s*(万|w)?\s*(?:人)?想要/i);
    if (!match) return parseNumber(raw);
    const multiplier = match[2] ? 10000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  }

  function parseCardPrice(value, wantCount, hasWantContext = false) {
    const raw = cleanText(value).replace(/,/g, "");
    const token = (raw.match(/[¥￥]\s*(\d+(?:\.\d+)?)/)?.[1] || raw.match(/\d+(?:\.\d+)?/)?.[0] || "");
    if (!token) return null;
    let cleaned = token;
    const suffix = Number.isInteger(wantCount) && wantCount > 0 ? String(wantCount) : "";
    const decimalLength = token.includes(".") ? token.split(".")[1].length : 0;
    if (hasWantContext && suffix && token.endsWith(suffix) && (decimalLength > 2 || !token.includes("."))) {
      const candidate = token.slice(0, -suffix.length).replace(/\.$/, "");
      if (candidate && Number.isFinite(Number(candidate))) cleaned = candidate;
    }
    const result = Number(cleaned);
    return Number.isFinite(result) ? result : null;
  }

  function cleanSellerName(value) {
    const locations = /^(?:北京|上海|天津|重庆|河北|河南|云南|辽宁|黑龙江|湖南|安徽|山东|新疆|江苏|浙江|江西|湖北|广西|甘肃|山西|内蒙古|陕西|吉林|福建|贵州|广东|青海|西藏|四川|宁夏|海南|香港|澳门|台湾)$/;
    const lines = String(value ?? "").split(/[\r\n]+/).map(cleanText).filter(Boolean);
    for (const line of lines) {
      const candidate = line
        .replace(/(?:\d+\s*(?:分钟|小时|天)内发货|回复超快|百?分百好评|信用(?:极好|优秀))$/g, "")
        .trim();
      if (!candidate || candidate.length > 40 || locations.test(candidate)) continue;
      if (/[¥￥]|\d+(?:\.\d+)?\s*(?:万|w)?\s*(?:人)?想要/i.test(candidate)) continue;
      return candidate;
    }
    return "";
  }

  function cardSellerName(card) {
    const selectors = [
      '[class*="seller-name"]', '[class*="sellerName"]',
      '[class*="user-name"]', '[class*="userName"]',
      'a[href*="personal"]', 'a[href*="userId"]'
    ];
    for (const selector of selectors) {
      const name = cleanSellerName(card.querySelector?.(selector)?.textContent);
      if (name) return name;
    }
    return "";
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const value = cleanText(document.querySelector(selector)?.textContent);
      if (value) return value;
    }
    return "";
  }

  function meta(name) {
    return text(document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content);
  }

  function structuredObjects() {
    const result = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
      try {
        const value = JSON.parse(node.textContent || "null");
        Array.isArray(value) ? result.push(...value) : result.push(value);
      } catch (_) {}
    });
    return result.filter(Boolean);
  }

  function structuredProduct() {
    return structuredObjects().find((value) => /product/i.test(Array.isArray(value?.["@type"]) ? value["@type"].join(" ") : value?.["@type"] || "")) || {};
  }

  function normalizeImageUrl(value) {
    const raw = text(value).replace(/^\/\//, `${location.protocol}//`);
    if (!raw) return "";
    try {
      const url = new URL(raw, location.href);
      ["x-oss-process", "imageMogr2", "imageView2", "watermark"].forEach((key) => url.searchParams.delete(key));
      url.hash = "";
      url.pathname = url.pathname.replace(/_(?:\d+x\d+|q\d+|\.webp).*$/i, "");
      return url.href;
    } catch (_) {
      return raw;
    }
  }

  function productImages(data) {
    const values = [];
    const structured = data.image;
    if (Array.isArray(structured)) values.push(...structured);
    else if (structured) values.push(structured);
    const structuredValues = values.map(normalizeImageUrl).filter((url) => /alicdn|goofish|tbcdn|taobaocdn/i.test(url));
    if (structuredValues.length) return [...new Set(structuredValues)];
    document.querySelectorAll('[class*="carousel"] img,[class*="swiper"] img,[class*="gallery"] img').forEach((image) => {
      values.push(image.currentSrc, image.src, image.dataset.src, image.dataset.originSrc);
      const srcset = text(image.srcset).split(",").map((entry) => entry.trim().split(/\s+/)[0]);
      values.push(...srcset);
    });
    if (!values.length) values.push(meta("og:image"));
    return [...new Set(values.map(normalizeImageUrl).filter((url) => /alicdn|goofish|tbcdn|taobaocdn/i.test(url)))];
  }

  function fullDescription(data) {
    const selectors = [
      '[class*="desc"]', '[class*="description"]', '[data-testid*="desc"]',
      '[class*="detail-content"]', '[class*="item-content"]'
    ];
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .map((node) => cleanText(node.innerText))
      .filter((value) => value.length > 1 && !/卖家|推荐|猜你喜欢/.test(value.slice(0, 12)));
    const structured = String(data.description ?? "");
    return structured || candidates.sort((a, b) => b.length - a.length)[0] || meta("description");
  }

  function securityReason() {
    const body = cleanText(document.body?.innerText).slice(0, 2000);
    if (/验证码|安全验证|访问过于频繁|滑动验证|账号存在风险/.test(body)) return "检测到验证码或安全验证";
    return "";
  }

  function unavailableReason() {
    const body = cleanText(document.body?.innerText).slice(0, 3000);
    if (/商品不存在|商品已删除|宝贝不存在|页面不存在|已被删除/.test(body)) return "商品已删除或不存在";
    return "";
  }

  function readCurrentProduct(source = {}) {
    const data = structuredProduct();
    const offer = Array.isArray(data.offers) ? data.offers[0] || {} : data.offers || {};
    const itemId = itemIdFromUrl(location.href) || text(data.sku || data.productID || data.identifier);
    const description = fullDescription(data);
    const fallbackTitle = text(data.name) || meta("og:title") || firstText(["h1", '[class*="title"]']);
    const title = description.split(/[\r\n]+/).map(cleanText).find(Boolean) || fallbackTitle;
    const priceText = offer.price ?? (meta("product:price:amount") || firstText(['[class*="price"]']));
    const statusText = `${offer.availability || ""} ${firstText(['[class*="status"]'])}`;
    const status = /sold|已卖|下架|outofstock/i.test(statusText)
      ? "sold"
      : (/instock|在售|发布中|立即购买|我想要/i.test(`${statusText} ${document.body?.innerText || ""}`) ? "on_sale" : "unknown");
    const sellerLink = document.querySelector('a[href*="personal"],a[href*="userId"]');
    const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
    return {
      itemId,
      url: canonical,
      title,
      description,
      price: parseNumber(priceText),
      originalPrice: parseNumber(firstText(['[class*="original-price"]', '[class*="originalPrice"]'])),
      wantCount: parseCount(firstText(['[class*="want"]', '[class*="collect"]'])),
      status,
      sellerName: text(data.brand?.name || firstText(['[class*="seller-name"]', '[class*="user-name"]'])),
      sellerId: itemIdFromUrl(sellerLink?.href || "") || text(new URL(sellerLink?.href || location.href).searchParams.get("userId")),
      shopUrl: sellerLink?.href || "",
      location: firstText(['[class*="location"]', '[class*="area"]']),
      publishTime: firstText(['[class*="publish"]', '[class*="time"]']),
      category: text(data.category || firstText(['[class*="category"]'])),
      condition: firstText(['[class*="condition"]', '[class*="degree"]']),
      shippingFee: parseNumber(firstText(['[class*="shipping"]', '[class*="freight"]'])),
      imageUrls: productImages(data),
      sourceType: source.sourceType || "item",
      sourceUrl: source.sourceUrl || location.href,
      collectedAt: new Date().toISOString(),
      securityReason: securityReason(),
      unavailableReason: unavailableReason()
    };
  }

  function discoverCards(type, includeSold) {
    const map = new Map();
    document.querySelectorAll('a[href*="/item"],a[href*="item?id="],a[href*="itemId="]').forEach((link) => {
      const itemId = itemIdFromUrl(link.href);
      if (!itemId) return;
      const card = link.closest('article,[class*="card"],li') || link;
      const cardText = cleanText(card.innerText || link.innerText);
      if (type === "shop" && !includeSold && /已卖出|已售|下架/.test(cardText)) return;
      if (map.has(itemId)) return;
      const image = card.querySelector?.("img") || link.querySelector?.("img");
      const titleNode = card.querySelector?.('[class*="title"]');
      const title = cleanText(titleNode?.textContent || link.getAttribute?.("title") || link.innerText).split("\n")[0];
      const wantCount = /想要/.test(cardText) ? parseCount(cardText) : null;
      const priceNode = card.querySelector?.('[data-price],[aria-label*="价格"],[class*="price"]');
      const dataPrice = priceNode?.dataset?.price;
      const ariaPrice = priceNode?.getAttribute?.("aria-label");
      const priceText = dataPrice || ariaPrice || priceNode?.textContent || cardText.match(/[¥￥]\s*\d+(?:\.\d+)?/)?.[0];
      const status = /已卖出|已售/.test(cardText) ? "sold" : (/下架/.test(cardText) ? "off_shelf" : "on_sale");
      map.set(itemId, {
        itemId,
        url: link.href.split("#")[0],
        title,
        price: parseCardPrice(priceText, wantCount, !dataPrice && !ariaPrice && /想要/.test(cardText)),
        status,
        wantCount,
        sellerName: cardSellerName(card),
        previewImageUrl: normalizeImageUrl(image?.currentSrc || image?.src || image?.dataset?.src),
        sourceType: type,
        sourceUrl: location.href,
        collectedAt: new Date().toISOString()
      });
    });
    return map;
  }

  async function discoverProducts(options = {}) {
    const type = options.type || pageType();
    const requested = type === "search" ? Math.min(10, Math.max(1, Number(options.requestedBatches || 1))) : Number.POSITIVE_INFINITY;
    const deadline = type === "shop" ? Date.now() + Math.max(1000, Number(options.remainingMs || 30 * 60 * 1000)) : Number.POSITIVE_INFINITY;
    const found = new Map();
    let stable = 0;
    let actualBatches = 0;
    let lastSize = -1;
    while (stable < 3 && actualBatches < requested && Date.now() < deadline) {
      discoverCards(type, Boolean(options.includeSold)).forEach((value, key) => found.set(key, value));
      if (found.size > lastSize) {
        actualBatches += 1;
        stable = 0;
        lastSize = found.size;
      } else {
        stable += 1;
      }
      if (actualBatches >= requested) break;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(options.waitMs == null ? randomMs(2000, 5000) : Math.max(0, Number(options.waitMs)));
    }
    return { products: [...found.values()], actualBatches, timedOut: Date.now() >= deadline, securityReason: securityReason() };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "PAGE_STATE") {
      sendResponse({ ok: true, type: pageType(), url: location.href, securityReason: securityReason() });
      return;
    }
    if (message?.action === "READ_PRODUCT") {
      const product = readCurrentProduct(message.source || {});
      sendResponse({ ok: !product.securityReason, product, error: product.securityReason });
      return;
    }
    if (message?.action === "DISCOVER_PRODUCTS") {
      discoverProducts(message.options).then((result) => sendResponse({ ok: !result.securityReason, ...result, error: result.securityReason })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });

  root.XianyuContent = { cardSellerName, cleanSellerName, discoverCards, discoverProducts, itemIdFromUrl, normalizeImageUrl, pageType, parseCardPrice, parseCount, readCurrentProduct, securityReason };
})(globalThis);
