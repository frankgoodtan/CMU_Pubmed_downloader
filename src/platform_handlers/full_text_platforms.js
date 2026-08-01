/**
 * 出版商平台判斷與 PDF 抓取（platform_handlers/full_text_platforms.js）
 *
 * 這個檔案取代原本散在 background.js 三個地方、各自為政的平台判斷邏輯：
 *   1. pollForFullTextLink：在 PubMed 頁面上找 Full Text 連結時，用一串寫死的
 *      CSS selector 猜連結屬於哪家平台。
 *   2. getPdfFromFullTextOption：真正要下載前，又重新判斷一次「這是哪個平台」，
 *      而且每家平台檢查的欄位不一致（有的只看網址、有的也看標籤文字）。
 *   3. 各家 getPdfFromXxx handler 內部，各自再做一次平台相關的猜測。
 *
 * 這種不一致正是先前 Oxford Academic（Silverchair 平台）誤判成 Atypon 平台的根因：
 * PubMed 明明在標籤文字寫著「See full text options at Silverchair Information
 * Systems」，但 JAMA/Silverchair 那條判斷式只檢查網址字串，沒去看標籤文字，於是
 * 漏接、掉進萬用兜底，兜底又對網址套用不適用的猜測規則，三個候選全部 404。
 *
 * 現在改成單一表格 FULL_TEXT_PLATFORMS：每個平台一個項目，包含：
 *   - id：平台代碼（也是 pollForFullTextLink 挑連結時的 source 標籤）
 *   - pickSelectors：在 PubMed 頁面上找這個平台專屬連結用的 CSS selector（選填；
 *     沒填代表這個平台原本就沒有專屬 picker，例如 Wiley——它一直是被下面的萬用
 *     兜底 picker 抓到，只是在 match() 階段才被重新歸類成 Wiley）
 *   - pickLabel：picker 抓到連結時要顯示的標籤文字
 *   - match(ft)：判斷一個已經抓到的 Full Text 連結（{source, label, url}）是否
 *     屬於這個平台。**務必同時檢查 source / label / url 三者**，不要只看網址——
 *     這正是修掉先前那個 bug 的地方。
 *   - getPdf(tabId, ft)：真的走進這個平台的文章頁、找出下載用 PDF 網址的邏輯。
 *
 * ── 新增一個出版商平台的步驟 ──
 * 在 FULL_TEXT_PLATFORMS 陣列裡（放在 generic 兜底之前）加一個項目，match() 判斷
 * 依據 source/label/url 決定，getPdf() 寫抓取邏輯即可；pollForFullTextLink 和
 * getPdfFromFullTextOption 都會自動吃到，不必再去改別的地方。
 *
 * 這個檔案只給 background.js（service worker）用，透過 importScripts 載入，
 * 共用 background.js 裡的全域工具函式（sleep、navigateTab、navigateAndWaitStable、
 * addThreadLog、recoverPdfFromRedirectLoop、requestCookieCleanup、isCmuProxyUrl、
 * normalizePdfUrlValue、全域狀態 G 等）——這些函式在檔案載入當下還沒執行到也沒關係，
 * 因為它們只在下面這些函式「被呼叫時」才會用到，那時 background.js 早就跑完初始化了。
 */

// ── 平台判斷表 ──
// 順序即 match() 的檢查順序：越前面越先比對到。generic 一定要放最後
// （match 永遠回傳 true，是所有其他平台都判斷不到時的最終兜底）。
const FULL_TEXT_PLATFORMS = [
  {
    id: "jama",
    pickLabel: "JAMA / Silverchair",
    pickSelectors: [
      "a.link-item[href*='jamanetwork-com']",
      "a.link-item[href*='jamanetwork.com']",
      "a.link-item[href*='silverchair']"
    ],
    // JAMA Network 和 Oxford Academic 都是 Silverchair 平台，PubMed 常直接把
    // "Silverchair Information Systems" 寫進標籤文字——這裡同時檢查 label，
    // 之前的 bug 就是漏了這一半。
    match: ft => ft.source === "jama" ||
      /silverchair/i.test(ft.label || "") ||
      /jamanetwork|silverchair/i.test(ft.url || ""),
    getPdf: getPdfFromJama,
  },
  {
    id: "elsevier",
    pickLabel: "Elsevier / ScienceDirect",
    pickSelectors: [
      "a.link-item[href*='linkinghub-elsevier-com']",
      "a.link-item[href*='sciencedirect-com']"
    ],
    match: ft => ft.source === "elsevier" ||
      /linkinghub-elsevier|sciencedirect/i.test(ft.url || ""),
    getPdf: getPdfFromElsevier,
  },
  {
    id: "pmc",
    pickLabel: "PMC",
    pickSelectors: [
      "a.link-item[href*='pmc.ncbi.nlm.nih.gov']",
      "a.link-item[href*='pmc-ncbi-nlm-nih-gov']"
    ],
    match: ft => ft.source === "pmc" ||
      /pmc\.ncbi\.nlm|pmc-ncbi-nlm/i.test(ft.url || ""),
    getPdf: getPdfFromPmc,
  },
  {
    id: "scielo",
    pickLabel: "SciELO",
    pickSelectors: [
      "a.link-item[href*='scielo.br']",
      "a.link-item[href*='scielo-br']",
      "a.link-item[title*='Scientific Electronic Library Online']",
      "a.link-item[data-ga-action*='Scientific Electronic Library Online']"
    ],
    match: ft => ft.source === "scielo" ||
      /scielo\.br|scielo-br/i.test(ft.url || ""),
    getPdf: getPdfFromSciELORobust,
  },
  {
    id: "wiley",
    // Wiley 一直沒有專屬 picker：連結是被下面「萬用兜底」的 picker 抓到、
    // source 標成 generic，要靠這裡的 match() 才重新認出是 Wiley。
    pickSelectors: [],
    match: ft => ft.source === "wiley" ||
      /wiley/i.test(ft.label || "") ||
      /onlinelibrary[-.]wiley\.com/i.test(ft.url || ""),
    getPdf: getPdfFromWiley,
  },
  {
    id: "serialssolutions",
    // CMU Library / SerialsSolutions resolver：不是真正的出版社全文連結，
    // 一律視為不可用、不嘗試下載。isCmuLibFullTextLink() 就是查這個項目的 match()。
    pickLabel: "CMU Library / SerialsSolutions",
    pickSelectors: [
      "a.link-item[href*='serialssolutions']",
      "a.link-item[href*='SS_UIDType=pmid']"
    ],
    match: ft => ft.source === "serialssolutions" ||
      /serialssolutions|ss_uidtype/i.test(ft.url || "") ||
      /cmulib|china medical university library/i.test(ft.label || ""),
    getPdf: async () => null,
  },
  {
    id: "generic",
    // 兜底：以上都判斷不到時最後才用。match 永遠 true，必須放在陣列最後一個。
    pickSelectors: [],
    match: () => true,
    getPdf: getPdfFromGenericPage,
  },
];

// PubMed 頁面上「萬用兜底」picker 專用的 selector：抓 full-text-links-list 裡
// 第一個非 CMU Lib 的連結，標成 source="generic"，交給上面的 match() 表重新歸類。
// 這是撿連結時的兜底，跟 FULL_TEXT_PLATFORMS 裡 id==="generic" 那個「下載時的
// 最終兜底」是兩件事——後者是任何連結都可能落入的最後一招，前者只在 PubMed
// 頁面上實際挑連結、且沒有平台專屬 picker 命中時才會用到。
const GENERIC_PICK_LABEL = "First full text link";
const GENERIC_PICK_SELECTOR =
  "div.full-text-links-list a.link-item:not([href*='serialssolutions']):not([href*='SS_UIDType=pmid'])";

// 是否為 CMU Library / SerialsSolutions resolver 連結（視為不可用，略過不嘗試）
function isCmuLibFullTextLink(ft) {
  const platform = FULL_TEXT_PLATFORMS.find(p => p.id === "serialssolutions");
  return !!platform?.match(ft);
}

function isAtyponContext(entry) {
  const text = [
    entry?.source || "",
    entry?.label || "",
    entry?.sourceUrl || "",
    entry?.url || "",
    entry?.href || "",
    entry?.pdfUrl || "",
    typeof entry === "string" ? entry : ""
  ].join(" ").toLowerCase();
  return text.includes("atypon") ||
         text.includes("journals-sagepub") ||
         text.includes("sagepub") ||
         text.includes("liebertpub") ||
         text.includes("journals.lww");
}

function hasAtyponContext(pdfCandidates = [], fullTextLinks = [], linkAttempts = []) {
  return [...(pdfCandidates || []), ...(fullTextLinks || []), ...(linkAttempts || [])].some(isAtyponContext);
}

// 在 PubMed 文章頁上找 Full Text 連結：依序用每個平台的 pickSelectors 找，
// 找不到專屬 picker 命中的（含 Wiley）就退回萬用兜底，最後才找 CMU Lib 連結。
// 保留原本的挑選順序（jama → pmc → elsevier → scielo → 萬用兜底 → serialssolutions），
// 因為同一個連結可能同時被多個 picker 抓到，順序決定去重後最終標成哪個 source。
async function pollForFullTextLink(tabId, maxMs) {
  const pickOrder = [
    FULL_TEXT_PLATFORMS.find(p => p.id === "jama"),
    FULL_TEXT_PLATFORMS.find(p => p.id === "pmc"),
    FULL_TEXT_PLATFORMS.find(p => p.id === "elsevier"),
    FULL_TEXT_PLATFORMS.find(p => p.id === "scielo"),
    { id: "generic", pickLabel: GENERIC_PICK_LABEL, pickSelectors: [GENERIC_PICK_SELECTOR] },
    FULL_TEXT_PLATFORMS.find(p => p.id === "serialssolutions"),
  ].filter(Boolean);
  const pickDefs = pickOrder.map(p => ({ id: p.id, pickLabel: p.pickLabel, selectors: p.pickSelectors || [] }));

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(500);
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: defs => {
          const pick = (source, label, selectors) => {
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              if (el?.href) {
                const text = (el.innerText || el.getAttribute("title") || label).replace(/\s+/g, " ").trim();
                return { source, label: text || label, url: el.href };
              }
            }
            return null;
          };
          const candidates = defs
            .map(d => d.selectors.length ? pick(d.id, d.pickLabel || d.id, d.selectors) : null)
            .filter(Boolean);
          const seen = new Set();
          return candidates.filter(item => {
            if (!item?.url || seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
          });
        },
        args: [pickDefs]
      });
      if (r?.[0]?.result?.length) return r[0].result;
    } catch(e) {}
  }
  return [];
}

// 真正要下載前的平台分派：在表格裡找第一個 match() 為 true 的平台，交給它的
// getPdf() 處理。generic 一定會 match，所以這個函式永遠會找到一個平台可用。
async function getPdfFromFullTextOption(tabId, ft) {
  const platform = FULL_TEXT_PLATFORMS.find(p => p.match(ft));
  return await platform.getPdf(tabId, ft.url, ft);
}

async function getPdfFromSciELORobust(tabId, url) {
  await navigateTab(tabId, url, 4000);
  // SciELO 伺服器很慢（舊網址 redirect + SPA 載入可能超過一分鐘），輪詢時間要夠長
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    const currentUrl = tab.url || url;
    const base = currentUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || "";

    // 不等 DOM：只要已 redirect 到新版文章網址（/j/期刊/a/文章ID），
    // 網址直接加 format=pdf 就是 PDF 檔案本體，不必等慢吞吞的頁面載入完
    try {
      const u = new URL(currentUrl);
      if (u.hostname.includes("scielo") && /\/j\/[^/]+\/a\/[^/]+\/?$/i.test(u.pathname)) {
        u.searchParams.set("format", "pdf");
        if (!u.searchParams.has("lang") && u.searchParams.get("lng")) {
          u.searchParams.set("lang", u.searchParams.get("lng"));
        }
        return u.href;
      }
    } catch {}

    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const meta = document.querySelector("meta[name='citation_pdf_url']")?.content;
          if (meta) return meta;

          const selectors = [
            "a[href*='format=pdf'][href*='lang=']",
            "#btnGroupDropPDF + .dropdown-menu a[href*='format=pdf']",
            "#ModalDownloads a[href*='format=pdf']",
            "a.dropdown-item[href*='format=pdf']",
            "a[href*='format=pdf']",
            "a[href$='.pdf']"
          ];

          for (const selector of selectors) {
            const a = document.querySelector(selector);
            if (a?.href) return a.getAttribute("href");
          }

          const articleUrl = document.querySelector("meta[property='og:url']")?.content || location.href;
          try {
            const u = new URL(articleUrl, location.href);
            if (u.hostname.includes("scielo") && /\/j\/[^/]+\/a\/[^/]+\/?$/i.test(u.pathname)) {
              u.searchParams.set("format", "pdf");
              if (!u.searchParams.has("lang")) {
                const lang = document.documentElement.lang || document.querySelector("meta[name='citation_language']")?.content;
                if (lang) u.searchParams.set("lang", lang);
              }
              return u.href;
            }
          } catch {}

          return null;
        }
      });

      const rel = r?.[0]?.result;
      if (rel) {
        let pdfUrl;
        try {
          pdfUrl = new URL(rel, currentUrl).href;
        } catch {
          pdfUrl = rel;
        }

        if (pdfUrl.includes("scielo.br/") && base.includes("autorpa.cmu.edu.tw")) {
          pdfUrl = pdfUrl.replace(/^https:\/\/www\.scielo\.br/i, base);
        }

        return pdfUrl || null;
      }
    } catch {}
  }

  return null;
}

async function getPdfFromJama(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const tab = await chrome.tabs.get(tabId);
  // 慢渲染：EZproxy 下頁面常要 1-2 分鐘才渲染出 PDF 按鈕；輪詢一抓到就返回，
  // 拉長上限只會讓「真的沒有 PDF」的頁多等，不影響成功頁的速度。
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const metaPdf = document.querySelector("meta[name='citation_pdf_url']")?.content;

          const isSupplementPdf = el => {
            const href = (el?.getAttribute("href") || el?.href || "").toLowerCase();
            const context = [
              el?.textContent || "",
              el?.getAttribute("aria-label") || "",
              el?.getAttribute("title") || "",
              el?.className || "",
              el?.id || "",
              el?.closest(".supplement, [class*='supplement'], #supplemental-tab")?.textContent || "",
              el?.closest(".supplement, [class*='supplement'], #supplemental-tab")?.className || "",
              el?.closest(".supplement, [class*='supplement'], #supplemental-tab")?.id || ""
            ].join(" ").toLowerCase();
            return /(?:^|[._/-])supp(?:lement)?\d*|supplement|appendix|protocol|trial protocol|eappendix|coi\d*.*supp/i.test(href) ||
                   context.includes("supplement") ||
                   context.includes("trial protocol") ||
                   context.includes("appendix");
          };
          const toAbsolute = value => {
            try { return new URL(value, location.href).href; } catch { return value; }
          };

          if (metaPdf && !/supp(?:lement)?|appendix|protocol|eappendix|coi\d*.*supp/i.test(metaPdf.toLowerCase())) {
            return metaPdf;
          }

          const primaryPdf = document.querySelector(
            "#pdf-link[data-article-url], " +
            "a.js-pdfaccess[data-article-url], " +
            "a[aria-label='Download PDF'][data-article-url]"
          );
          const primaryUrl = primaryPdf?.getAttribute("data-article-url");
          if (primaryUrl && !isSupplementPdf(primaryPdf)) return toAbsolute(primaryUrl);

          const selectors = [
            "a[href*='/articlepdf/']",
            "a[href*='fullarticlepdf']",
            "a[href*='downloadpdf']",
            "a[aria-label*='PDF']",
            "a[title*='PDF']",
            "a[class*='pdf']",
            "a[href*='.pdf']"
          ];
          for (const selector of selectors) {
            const links = Array.from(document.querySelectorAll(selector));
            const el = links.find(a => a?.href && !isSupplementPdf(a));
            if (el?.href) return el.getAttribute("href");
          }
          return null;
        }
      });
      const rel = r?.[0]?.result;
      if (rel) {
        if (rel.startsWith("/")) {
          const base = (tab.url || "").match(/^(https?:\/\/[^/]+)/)?.[1] || "";
          return base + rel;
        }
        return rel;
      }
    } catch(e) {}
  }
  return null;
}

// ScienceDirect「View PDF / Download PDF」連結的選擇器
const SD_PDF_LINK_SELECTOR =
  "li.ViewPDF a[href*='/pdfft'], " +
  "a[aria-label*='View PDF'][href*='/pdfft'], " +
  "a[aria-label*='Download PDF'][href*='/pdfft'], " +
  "a[href*='/science/article/pii/'][href*='/pdfft'], " +
  "a[href*='/pdfft']";

async function getPdfFromElsevier(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const tab = await chrome.tabs.get(tabId);
  // 慢渲染：ScienceDirect 經 EZproxy 可能 1-2 分鐘才出 View/Download PDF 按鈕；
  // 輪詢一抓到就返回，拉長上限只影響「真的沒 PDF」的頁。
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const b = document.querySelector(
            "a[href*='/science/article/pii/'][href*='pdfft'], " +
            "a[aria-label*='View PDF'], a[aria-label*='Download PDF']"
          );
          if (b) return b.getAttribute("href");
          const a = document.querySelector("a[href*='pdfft']");
          return a ? a.getAttribute("href") : null;
        }
      });
      const rel = r?.[0]?.result;
      if (rel) {
        let pdfUrl = rel;
        if (rel.startsWith("/")) {
          const base = (tab.url || "").match(/^(https?:\/\/[^/]+)/)?.[1] || "";
          pdfUrl = base + rel;
        }
        const clickedPdfUrl = await resolveScienceDirectPdfByClick(tabId, pdfUrl);
        return clickedPdfUrl || pdfUrl;
      }
    } catch(e) {}
  }
  return null;
}

async function resolveScienceDirectPdfByClick(tabId, fallbackPdfUrl) {
  try {
    const beforeTab = await chrome.tabs.get(tabId).catch(() => null);
    const beforeUrl = beforeTab?.url || "";
    const clicked = await chrome.scripting.executeScript({
      target: { tabId },
      func: sel => {
        const link = document.querySelector(sel);
        if (!link) return { ok: false, href: "" };
        const href = new URL(link.getAttribute("href") || link.href, location.href).href;
        link.setAttribute("target", "_self");
        link.click();
        return { ok: true, href };
      },
      args: [SD_PDF_LINK_SELECTOR]
    });
    const clickedHref = clicked?.[0]?.result?.href || fallbackPdfUrl || "";
    addThreadLog("ScienceDirect View PDF clicked", { href: clickedHref });

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(700);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return clickedHref || fallbackPdfUrl;
      const currentUrl = tab.url || "";
      if (/pdf\.sciencedirectassets\.com/i.test(currentUrl) ||
          (/\/main\.pdf(?:$|[?#])/i.test(currentUrl) && /X-Amz-|pii=|science/i.test(currentUrl))) {
        addThreadLog("ScienceDirect signed PDF URL resolved", { url: currentUrl });
        return currentUrl;
      }

      try {
        const viewer = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            try {
              const url = window.PDFViewerApplication?.url || "";
              return url && !url.startsWith("blob:") ? new URL(url, location.href).href : "";
            } catch {
              return "";
            }
          }
        });
        const viewerUrl = viewer?.[0]?.result || "";
        if (/pdf\.sciencedirectassets\.com|\/main\.pdf(?:$|[?#])/i.test(viewerUrl)) {
          addThreadLog("ScienceDirect PDF viewer URL resolved", { url: viewerUrl });
          return viewerUrl;
        }
      } catch {}

      if (currentUrl !== beforeUrl &&
          /\/science\/article\/pii\/[^/?#]+\/pdfft/i.test(currentUrl) &&
          !/\/science\/article\/pii\/[^/?#]+(?:$|[?#])/i.test(currentUrl)) {
        fallbackPdfUrl = currentUrl;
      }
    }
    addThreadLog("ScienceDirect View PDF did not resolve signed URL in time", {
      fallbackPdfUrl,
      beforeUrl
    });
    return fallbackPdfUrl || clickedHref || null;
  } catch(e) {
    addThreadLog("ScienceDirect View PDF click fallback failed", {
      message: e?.message || String(e),
      fallbackPdfUrl
    });
    return fallbackPdfUrl || null;
  }
}

async function getPdfFromPmc(tabId, url) {
  const finalUrl = await navigateAndWaitStable(tabId, url, 2000, 20000);
  const base = finalUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || "";
  // 慢渲染：輪詢一抓到正式 PDF 連結就返回；找不到才走 PMC 頁面列印 fallback。
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          let sawSupplementPdf = false;
          const metaPdf = document.querySelector("meta[name='citation_pdf_url']")?.content;
          const isSupplementUrl = value => {
            const lower = String(value || "").toLowerCase();
            return /(?:^|[._/-])supp(?:lement)?\d*(?:[._/-]|$)|supplement|appendix|protocol|trial protocol|eappendix|coi\d*.*supp|\/articles\/instance\/[^/]+\/bin\/|-[se]\d{2,4}\.pdf(?:$|[?#])/.test(lower);
          };
          if (metaPdf && !isSupplementUrl(metaPdf)) return metaPdf;
          const isSupplementPdf = el => {
            const href = (el?.getAttribute("href") || el?.href || el?.content || "").toLowerCase();
            const block = el?.closest?.(
              ".supplementary-materials, [class*='supplementary'], [class*='supplement'], .sm, section[id*='supplementary']"
            );
            const context = [
              el?.textContent || "",
              el?.getAttribute?.("aria-label") || "",
              el?.getAttribute?.("title") || "",
              el?.className || "",
              el?.id || "",
              el?.getAttribute?.("data-ga-action") || "",
              block?.textContent || "",
              block?.className || "",
              block?.id || ""
            ].join(" ").toLowerCase();
            const isSupplement =
              isSupplementUrl(href) ||
              context.includes("supplement") ||
              context.includes("supplementary materials") ||
              context.includes("trial protocol") ||
              context.includes("appendix") ||
              context.includes("additional data file") ||
              context.includes("click_feat_suppl");
            if (isSupplement && /\.pdf(?:$|[?#])/.test(href)) sawSupplementPdf = true;
            return isSupplement;
          };
          for (const s of [
            "a[aria-label*='Download PDF']",
            "a[data-ga-label*='pdf_download']",
            "a[href^='pdf/'][href*='.pdf']",
            "a[href*='/pdf/'][href*='.pdf']",
            "a[href*='.pdf']",
            "a[href*='download=1'][href*='pdf']",
            "a.int-view[href*='.pdf']",
            "a.pdf-link", "li.pdf a"
          ]) {
            const el = document.querySelector(s);
            if (el?.content && !isSupplementPdf(el)) return el.content;
            if (el?.href && !isSupplementPdf(el)) return el.href;
          }
          return sawSupplementPdf ? "__PMC_ONLY_SUPPLEMENT_PDF__" : null;
        }
      });
      const href = r?.[0]?.result;
      if (href === "__PMC_ONLY_SUPPLEMENT_PDF__") break;
      if (href) {
        if (/^https?:\/\//i.test(href)) return href;
        return base + (href.startsWith("/") ? href : "/" + href);
      }
    } catch {}
    await sleep(500);
  }
  if (await isPrintablePmcArticle(tabId)) {
    return {
      printPmc: true,
      pdfUrl: "pmc-print:" + finalUrl,
      printUrl: finalUrl || url,
      sourceUrl: finalUrl || url,
      label: "PMC 頁面列印成 PDF"
    };
  }
  return null;
}

async function isPrintablePmcArticle(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const href = location.href;
        const host = location.hostname.toLowerCase();
        const isPmcHost =
          host.includes("pmc.ncbi.nlm.nih.gov") ||
          host.includes("pmc-ncbi-nlm-nih-gov");
        const isPmcPath = /\/articles\/(?:pmid\/)?[^/?#]+\/?/i.test(location.pathname);
        const isPmc = isPmcHost && isPmcPath;
        const hasArticle = !!document.querySelector("article, main, .jig-ncbiinpagenav, #maincontent, .pmc-wm, .usa-prose");
        const hasTitle = !!document.querySelector("h1, .content-title, .heading-title, .pmc-article-title");
        const bodyText = (document.body?.innerText || "").slice(0, 5000).toLowerCase();
        const blocked = bodyText.includes("request verification") || bodyText.includes("access denied") || bodyText.includes("captcha");
        return isPmc && hasArticle && hasTitle && !blocked;
      }
    });
    return !!r?.[0]?.result;
  } catch {
    return false;
  }
}

async function getPdfFromWiley(tabId, url) {
  const finalUrl = await navigateAndWaitStable(tabId, url, 3500, 22000);

  // Proxy redirect loop？cookie 清理後重試，不繼續刮 16 秒
  const recoveredFromLoop = await recoverPdfFromRedirectLoop(tabId);
  if (recoveredFromLoop) return recoveredFromLoop;
  if (G.cookieCleanupRequested) return null;

  const deadline = Date.now() + 90000;
  // 從「原始 full-text 連結」和導航後網址都建候選。Wiley 經 EZproxy 常要 1-2 分鐘才把
  // PDF 按鈕渲染出來，等 JS 會逾時；而導航逾時（22 秒）那刻 finalUrl 可能還停在中途跳轉
  // 網址、抓不到乾淨 DOI。但原始連結（.../doi/{DOI}）本來就帶 DOI，/doi/pdfdirect/{DOI}
  // 是可直接推導的，不必等頁面 → 用它當首選候選，讓下載立即可進行。
  const candidates = [];
  const addUniqueCandidate = c => {
    if (c && !candidates.includes(c)) candidates.push(c);
  };
  for (const c of buildWileyDirectCandidatesFromUrl(url)) {
    addUniqueCandidate(c);
  }
  for (const c of buildWileyDirectCandidatesFromUrl(finalUrl)) {
    addUniqueCandidate(c);
  }
  for (const c of buildPdfCandidatesFromUrl(url)) {
    addUniqueCandidate(c);
  }
  for (const c of buildPdfCandidatesFromUrl(finalUrl)) {
    addUniqueCandidate(c);
  }
  const addCandidate = (href, baseUrl = finalUrl) => {
    if (!href) return;
    try {
      const absolute = new URL(href, baseUrl).href;
      for (const candidate of buildWileyDirectCandidatesFromUrl(absolute)) {
        addUniqueCandidate(candidate);
      }
      for (const candidate of buildPdfCandidatesFromUrl(absolute)) {
        addUniqueCandidate(candidate);
      }
      addUniqueCandidate(absolute);
    } catch {}
  };

  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const currentUrl = tab?.url || finalUrl || url;
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const found = [];
          const add = href => {
            if (href && !found.includes(href)) found.push(href);
          };
          add(document.querySelector("meta[name='citation_pdf_url']")?.content);
          for (const sel of [
            "a.navbar-download[href*='/doi/pdfdirect/']",
            "a[data-single-download='true'][href*='/doi/pdfdirect/']",
            "a[href*='/doi/pdfdirect/'][href*='download=true']",
            "a[href*='/doi/pdfdirect/']",
            "a[href*='/doi/pdf/']",
            "a[href*='/doi/epdf/']",
            "a.coolBar__ctrl.pdf-download[href*='/doi/epdf/']",
            "a[data-item-name='download-PDF']",
            "a[aria-label*='Download PDF']",
            "a[aria-label*='PDF'][href*='pdf']",
            "a[title*='PDF'][href*='pdf']",
            "a[href*='downloadpdf']",
            ".article__access-options a[href*='pdf']",
          ]) {
            const el = document.querySelector(sel);
            add(el?.getAttribute("href") || el?.href);
          }
          for (const a of document.querySelectorAll("a[href]")) {
            const href = a.getAttribute("href") || "";
            const label = ((a.textContent || "") + " " + (a.getAttribute("aria-label") || "") + " " + (a.getAttribute("title") || "")).toLowerCase();
            if (/\/doi\/(?:pdfdirect|pdf|epdf)\//i.test(href) ||
                (label.includes("download pdf") && href.toLowerCase().includes("pdf"))) {
              add(href);
            }
          }
          return found;
        }
      });
      const hrefs = Array.isArray(r?.[0]?.result) ? r[0].result : [];
      hrefs.forEach(href => addCandidate(href, currentUrl));
      if (candidates.length) return candidates[0];
    } catch {}
  }
  return candidates[0] || null;
}

function buildWileyDirectCandidatesFromUrl(url) {
  try {
    const u = new URL(url);
    const doiMatch = u.pathname.match(/\/doi\/(?:full\/|abs\/|epdf\/|pdf\/|pdfdirect\/)?(.+)$/i);
    const resolverDoiMatch = /(?:^|\.)doi-org(?:\.|$)|(?:^|\.)doi\.org$/i.test(u.hostname)
      ? u.pathname.match(/^\/(10\.\d{4,9}\/.+)$/i)
      : null;
    const doi = (doiMatch?.[1] || resolverDoiMatch?.[1] || "").replace(/[?#].*$/, "");
    if (!doi) return [];
    const currentOrigin = u.hostname.endsWith(".onlinelibrary.wiley.com")
      ? u.origin
      : "";
    const acsFirst = u.hostname.includes("acsjournals") || /^10\.1002\/cncr\./i.test(doi);
    const hosts = acsFirst
      ? ["https://acsjournals.onlinelibrary.wiley.com", "https://onlinelibrary.wiley.com"]
      : ["https://onlinelibrary.wiley.com", "https://acsjournals.onlinelibrary.wiley.com"];
    if (currentOrigin && !hosts.includes(currentOrigin)) hosts.unshift(currentOrigin);
    const candidates = [];
    for (const origin of hosts) {
      candidates.push(origin + "/doi/epdf/" + doi);
      candidates.push(origin + "/doi/pdfdirect/" + doi + "?download=true");
      candidates.push(origin + "/doi/pdfdirect/" + doi);
      candidates.push(origin + "/doi/pdf/" + doi);
    }
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

// Atypon 家族平台（Wiley 非 onlinelibrary 站台、SAGE、ASCO 等）常見的 /doi/ 端點猜測。
// 注意：這組規則只憑「網址路徑含 /doi/」就套用，對 Silverchair 平台（Oxford Academic、
// JAMA 等）容易誤判——它們的文章網址路徑也常帶 /doi/（如 academic.oup.com 的
// article-lookup/doi/{doi}），但猜出來的 /doi/pdfdirect 等端點其實不存在。
// getPdfFromGenericPage 已經把「檢查 citation_pdf_url meta 標籤」放在套用這組規則
// 之前，降低誤判機會；但這裡本身不會、也不該去驗證網址是不是真的 Atypon 平台。
function buildPdfCandidatesFromUrl(url) {
  try {
    const u = new URL(url);
    const candidates = [];
    // 必須用 u.host（含 :8443 port）而不是 u.hostname：
    // EZproxy 網址掉了 port 會連到錯的伺服器，下載直接中斷
    const origin = "https://" + u.host;

    const doiMatch = u.pathname.match(/\/doi\/(?:full\/|abs\/|epdf\/|pdf\/|pdfdirect\/)?(.+)$/i);
    if (doiMatch?.[1]) {
      const doi = doiMatch[1].replace(/[?#].*$/, "");
      if (u.hostname.includes("wiley")) {
        candidates.push(origin + "/doi/pdfdirect/" + doi + "?download=true");
      }
      // Atypon 平台（ascopubs、sagepub 等）的 /doi/pdf/ 是內嵌 viewer 頁面，
      // /doi/pdfdirect/ 才是真正的 PDF 檔案，優先嘗試
      candidates.push(origin + "/doi/pdfdirect/" + doi);
      candidates.push(origin + "/doi/pdf/" + doi);
      candidates.push(origin + "/doi/epdf/" + doi);
    }

    if (/\.pdf(?:$|[?#])/i.test(url) || /\/(?:pdf|epdf|pdfdirect)\//i.test(u.pathname)) {
      candidates.push(url);
    }

    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

// 目前分頁是否停在一個 403 Forbidden / Access denied 錯誤頁（沿用
// getCurrentPageFailureReason 既有的偵測文字，跟下載失敗 txt 裡顯示的原因一致）。
async function isForbiddenPage(tabId) {
  const reason = await getCurrentPageFailureReason(tabId).catch(() => "");
  return /403|forbidden|access denied/i.test(reason || "");
}

// 防盜連重試：先導到 url 同網域的首頁，再用頁面內真正的 <a> 超連結點擊（不是
// chrome.tabs.update 那種位址列導航）導去 url，讓瀏覽器自然帶上正確的 Referer。
// 連首頁都連不上、或重試後仍是 403，就回傳 null，呼叫端維持原本的 finalUrl 不受影響。
async function retryWithRefererFromOrigin(tabId, url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  await navigateAndWaitStable(tabId, origin, 1000, 8000);
  if (await isForbiddenPage(tabId)) return null;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: targetUrl => {
        const a = document.createElement("a");
        a.href = targetUrl;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
      args: [url]
    });
  } catch {
    return null;
  }

  const start = Date.now();
  let lastUrl = "";
  while (Date.now() - start < 15000) {
    await sleep(400);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) break;
    lastUrl = tab.url || lastUrl;
    if (tab.status !== "loading" && lastUrl) break;
  }

  if (await isForbiddenPage(tabId)) return null;
  return lastUrl || null;
}

// ── 萬用兜底：以上都判斷不到平台時使用 ──
async function getPdfFromGenericPage(tabId, url) {
  try {
    const u = new URL(url);
    // attachType=PDF（journaltcm.cn 這類「下載檔案」端點的常見寫法）：query string
    // 已經明講這是個直接吐檔案的下載端點，不是文章頁，沒有頁面內容/連結可找。
    // 這種端點常見有防盜連（見下面 retryWithRefererFromOrigin 的說明），但那招是
    // 「先開首頁、再點頁面內真超連結」，對這種端點沒用——它回的是
    // Content-Disposition: attachment，真的點下去會觸發瀏覽器原生下載、被
    // chrome.downloads 接走，不是我們這裡能攔截處理的頁面導航，反而會讓真正的
    // 下載內容在背景不受控地存到 Chrome 預設資料夾。這裡直接把網址本身當成
    // pdfUrl 候選回傳，交給後面 preflightPdfCheck／實際下載那段用 fetch()
    // 帶正確 Referer 去抓（見 sameOriginReferrer()），不要先浪費時間導航分頁。
    if (/\.pdf(?:$|[?#])/i.test(url) || /\/(?:pdf|epdf)\//i.test(u.pathname) ||
        /(?:^|[?&])attachType=PDF(?:&|$)/i.test(u.search)) {
      return url;
    }
  } catch {}

  let finalUrl = await navigateAndWaitStable(tabId, url, 2000, 20000);

  // 有些小型出版商的下載端點會做防盜連（Referer 檢查）：要求請求是「從自己站
  // 內文章頁點下載按鈕過去的」，不接受沒有 Referer 的直接連結（例如
  // journaltcm.cn 的 downloadArticleFile.do，直接連過去會回 403 Forbidden，
  // 即使不透過任何 proxy、直接用 curl 測試也一樣，證實是站方自己的防護，跟
  // CMU 網路/授權無關）。navigateAndWaitStable 用的 chrome.tabs.update()
  // 就是「位址列貼網址」那種導航，天生不帶 Referer，正好踩到這類防護。
  // 偵測到 403 時重試一次：先導到同網域首頁建立正常瀏覽情境，再用頁面內真正
  // 的 <a> 超連結點擊（而不是位址列導航）導去原本網址，讓瀏覽器自動帶上正確
  // 的 Referer——這招對「真的沒有這篇/沒授權」的 403 沒有幫助，但對純粹的
  // Referer 檢查型防盜連應該有效，且失敗也不影響原本流程（retryWithRefererFromOrigin
  // 拿不到更好的結果就回傳 null，維持原本的 finalUrl）。
  if (await isForbiddenPage(tabId)) {
    const retried = await retryWithRefererFromOrigin(tabId, url);
    if (retried) finalUrl = retried;
  }

  const currentUrl = finalUrl || url;
  if (/zhenciyanjiu\.cn/i.test(currentUrl) || /zhenciyanjiu\.cn/i.test(url)) {
    const zcyPdf = await getPdfFromZhenciYanjiu(tabId, currentUrl);
    if (zcyPdf) return zcyPdf;
  }

  // 頁面自己在 <meta name="citation_pdf_url"> 宣告的 PDF 網址是伺服器端直接渲染好的、
  // 最可靠的訊號（不必等 JS/DOM），優先於下面「硬猜 /doi/pdf 等 Atypon 端點」的規則。
  // 這規則對 Silverchair 平台（如 Oxford Academic、JAMA）常誤判：這類站的文章網址
  // 路徑裡也常帶「/doi/」（例如 academic.oup.com/.../article-lookup/doi/{doi}），
  // 會被誤認成 Atypon 平台，猜出來的 /doi/pdfdirect、/doi/pdf、/doi/epdf 其實不存在，
  // 三個都 404，且因為猜測規則會直接搶先 return，連檢查這個 meta 標籤的機會都沒有。
  try {
    const metaResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const meta = document.querySelector("meta[name='citation_pdf_url']")?.content || "";
        if (!meta || /supp(?:lement)?|appendix|protocol|eappendix/i.test(meta.toLowerCase())) return null;
        return meta;
      }
    });
    const metaPdf = metaResult?.[0]?.result;
    if (metaPdf) {
      try { return new URL(metaPdf, currentUrl).href; } catch { return metaPdf; }
    }
  } catch {}

  // 從原始連結和導航後網址都建候選：帶 DOI 的站（Atypon 家族）可直接推導 PDF，
  // 不必等 1-2 分鐘的慢渲染；導航逾時那刻 finalUrl 可能還在中途跳轉，故也用原始 url。
  const currentCandidates = buildPdfCandidatesFromUrl(currentUrl);
  for (const c of buildPdfCandidatesFromUrl(url)) {
    if (!currentCandidates.includes(c)) currentCandidates.push(c);
  }
  if (currentCandidates.length) return currentCandidates[0];

  const recoveredPdf = await recoverPdfFromRedirectLoop(tabId);
  if (recoveredPdf) return recoveredPdf;

  // 慢渲染：輪詢一抓到 PDF 連結就返回；拉長上限只影響「真的沒 PDF」的頁。
  const deadline = Date.now() + 90000;
  let navigationErrorHandled = false;
  while (Date.now() < deadline) {
    // pdf.js 檢視頁（如 zhenciyanjiu 的 previewFile）：頁面上沒有指向 PDF 的 <a>，
    // 真正的檔案 URL 要從 MAIN world 的 PDFViewerApplication 讀出來
    try {
      const isViewer = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!document.getElementById("download") &&
                    !!(document.getElementById("viewerContainer") || document.querySelector(".pdfViewer"))
      });
      if (isViewer?.[0]?.result) {
        const viewerPdf = await readPdfJsViewerUrl(tabId);
        if (viewerPdf) return viewerPdf;
      }
    } catch {}
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const metaPdf = document.querySelector("meta[name='citation_pdf_url']")?.content
                       || document.querySelector("meta[name='dc.identifier'][content$='.pdf']")?.content;
          if (metaPdf) return metaPdf;

          // Wolters Kluwer / LWW（journals.lww.com）：PDF 連結不是 <a>，而是掛在
          // 文章工具列容器的 data-pdf-url 屬性（Download → PDF 按鈕觸發的網址，
          // 指向 _layouts/15/oaks.journals/downloadpdf.aspx）。掃 <a> 永遠找不到。
          const lwwToolsEl = document.querySelector("[data-pdf-url]");
          if (lwwToolsEl) {
            const lwwPdfUrl = lwwToolsEl.getAttribute("data-pdf-url") || "";
            const lwwPdfEnabled = (lwwToolsEl.getAttribute("data-pdf-enabled") || "true").toLowerCase() !== "false";
            if (lwwPdfUrl && lwwPdfEnabled) {
              try { return new URL(lwwPdfUrl, location.href).href; } catch {}
            }
          }

          if (location.hostname.includes("scielo")) {
            const scieloPdfLink = document.querySelector("a[href*='format=pdf']")?.getAttribute("href");
            if (scieloPdfLink) return new URL(scieloPdfLink, location.href).href;

            const articleUrl = document.querySelector("meta[property='og:url']")?.content || location.href;
            try {
              const u = new URL(articleUrl, location.href);
              if (/\/j\/[^/]+\/a\/[^/]+\/?$/i.test(u.pathname)) {
                u.searchParams.set("format", "pdf");
                if (!u.searchParams.has("lang")) {
                  const lang = document.documentElement.lang || document.querySelector("meta[name='citation_language']")?.content;
                  if (lang) u.searchParams.set("lang", lang);
                }
                return u.href;
              }
            } catch {}
          }

          const toAbsoluteUrl = value => {
            try {
              return new URL(value, location.href).href;
            } catch {
              return value;
            }
          };

          const scoreCandidate = (href, rawHref, text, label) => {
            const cleanHref = href.split(/[?#]/)[0].toLowerCase();
            const cleanCurrent = location.href.split(/[?#]/)[0].toLowerCase();
            const lowerHref = href.toLowerCase();
            const lowerRawHref = rawHref.toLowerCase();
            const lowerText = String(text || "").toLowerCase();
            const lowerLabel = String(label || "").toLowerCase();
            const isSupplement =
              /(?:^|[._/-])supp(?:lement)?\d*|supplement|appendix|protocol|trial protocol|eappendix|coi\d*.*supp/i.test(lowerHref) ||
              /supplement|appendix|trial protocol|eappendix/.test(lowerText + " " + lowerLabel);
            const blockedHosts = [
              "miit.gov.cn",
              "doaj.org",
              "google.com",
              "scholar.google",
              "crossref.org",
              "orcid.org",
              "altmetric.com",
              "dimensions.ai",
              "plu.mx",
              "scite.ai",
              "addtoany.com",
              "facebook.com",
              "twitter.com",
              "x.com",
              "linkedin.com"
            ];
            const blocked = href.startsWith("javascript:") ||
                            href.startsWith("mailto:") ||
                            href.startsWith("tel:") ||
                            cleanHref === cleanCurrent ||
                            isSupplement ||
                            blockedHosts.some(host => lowerHref.includes(host));
            let score = 0;
            if (cleanHref.endsWith(".pdf")) score += 100;
            if (cleanHref.includes("/pdf/") || cleanHref.includes("pdfft") || cleanHref.includes("downloadpdf")) score += 60;
            if (lowerHref.includes("/download") && lowerHref.includes("attachtype=")) score += 80;
            if (lowerHref.includes("lowqualitypdf") || lowerHref.includes("highqualitypdf") || lowerHref.includes("fulltextpdf")) score += 100;
            if (lowerRawHref.includes(".pdf")) score += 40;

            if (lowerHref.includes("format=pdf") || lowerRawHref.includes("format=pdf")) score += 80;
            if (lowerHref.includes("previewfile") || lowerHref.includes("type=pdf")) score += 80;
            if (/\bpdf\b/.test(label)) score += 30;
            if (label.includes("file-pdf") || label.includes("pdf_link") || label.includes("dropdown-item")) score += 10;
            if (text === "pdf" || text.toLowerCase().includes("download pdf")) score += 20;
            if (cleanHref.endsWith(".xml") || text === "xml" || label.includes("file-code") || lowerHref.includes("attachtype=metaxml")) score -= 100;
            return { href, score, blocked };
          };

          const candidates = [];

          for (const a of Array.from(document.querySelectorAll("a[href]"))) {
            const rawHref = a.getAttribute("href") || "";
            const href = toAbsoluteUrl(rawHref);
            const text = (a.textContent || "").trim().toLowerCase();
            const label = [
              text,
              a.getAttribute("aria-label") || "",
              a.getAttribute("title") || "",
              a.className || "",
              a.querySelector("i")?.className || ""
            ].join(" ").toLowerCase();
            candidates.push(scoreCandidate(href, rawHref, text, label));
          }

          // 有些站台（如 alternative-therapies.com）不給下載連結，直接把 PDF
          // 塞進 <iframe src="xxx.pdf#toolbar=0&..."> 當內嵌閱讀器用——
          // 上面的 a[href] 掃描完全看不到這個，這裡另外掃 iframe/embed 的 src
          for (const el of Array.from(document.querySelectorAll("iframe[src], embed[src]"))) {
            const rawHref = el.getAttribute("src") || "";
            if (!rawHref) continue;
            const href = toAbsoluteUrl(rawHref);
            const label = [
              el.getAttribute("title") || "",
              el.getAttribute("aria-label") || "",
              el.className || ""
            ].join(" ").toLowerCase();
            candidates.push(scoreCandidate(href, rawHref, "", label));
          }

          for (const el of Array.from(document.querySelectorAll("[data-matomoclick]"))) {
            const rawData = el.getAttribute("data-matomoclick") || "";
            const matches = rawData.match(/https?:\/\/[^'"\],\s]+/g) || [];
            for (const rawHref of matches) {
              const href = toAbsoluteUrl(rawHref.replace(/&amp;/g, "&"));
              const text = (el.textContent || "").trim().toLowerCase();
              const label = [
                text,
                el.getAttribute("aria-label") || "",
                el.getAttribute("title") || "",
                el.className || "",
                rawData
              ].join(" ").toLowerCase();
              candidates.push(scoreCandidate(href, rawHref, text, label));
            }
          }

          const usableCandidates = candidates.filter(item => !item.blocked);
          usableCandidates.sort((a, b) => b.score - a.score);

          // 絕不退回 score 0 的任意連結——之前會抓到頁尾的備案/社群連結
          // 之類完全無關的網址拿去當 PDF 下載
          const best = usableCandidates.find(item => item.score > 0);
          if (best) return best.href;

          // SPA 頁面的 PDF 按鈕可能不是 <a>（如 zhenciyanjiu 的 <p class="citeBtn">PDF</p>），
          // 點一下讓頁面切到 PDF 檢視頁，外層輪詢會重掃新頁面
          if (!window.__pdfBtnClicked) {
            const clickable = Array.from(document.querySelectorAll("p, button, span, div, a"))
              .find(el => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "pdf" &&
                          el.offsetParent !== null && el.children.length <= 2);
            if (clickable) {
              window.__pdfBtnClicked = true;
              clickable.click();
            }
          }
          return null;
        }
      });
      const pdfUrl = normalizePdfUrlValue(r?.[0]?.result);
      if (pdfUrl) return pdfUrl;
    } catch(e) {
      const message = e?.message || String(e);
      if (!navigationErrorHandled && /showing error page|chrome-error|cannot access/i.test(message)) {
        navigationErrorHandled = true;
        const candidates = buildPdfCandidatesFromUrl(url);
        addThreadLog("Generic PDF parser hit browser error page", {
          url,
          message,
          fallbackCandidate: candidates[0] || ""
        });
        if (isCmuProxyUrl(url)) {
          requestCookieCleanup("proxy 連線錯誤，需要清理後重試");
        }
        if (candidates.length) return candidates[0];
        return null;
      }
    }
    await sleep(500);
  }
  return null;
}

async function readPdfJsViewerUrl(tabId) {
  try {
    const rv = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const frameSrc = Array.from(document.querySelectorAll("iframe[src], embed[src]"))
            .map(el => el.getAttribute("src") || "")
            .find(src => /\/PDFJS\/web\/viewer\.html/i.test(src) && /[?&]file=/i.test(src));
          if (frameSrc) {
            const rawFile = (frameSrc.match(/[?&]file=([\s\S]+)$/i)?.[1] || "").replace(/&amp;/g, "&");
            const file = rawFile
              ? (/^https?%3A/i.test(rawFile) ? decodeURIComponent(rawFile) : rawFile)
              : new URL(frameSrc, location.href).searchParams.get("file");
            if (file && !file.startsWith("blob:")) return new URL(file, location.href).href;
          }

          const u = window.PDFViewerApplication?.url || null;
          if (!u || u.startsWith("blob:")) return null;
          return new URL(u, location.href).href;
        } catch { return null; }
      }
    });
    return rv?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function getPdfFromZhenciYanjiu(tabId, url) {
  const deadline = Date.now() + 60000;
  let clicked = false;
  while (Date.now() < deadline) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = tab?.url || url;
    if (/\/previewFile\b/i.test(currentUrl) && /(?:[?&])type=pdf\b/i.test(currentUrl)) {
      const viewerPdf = await readPdfJsViewerUrl(tabId);
      if (viewerPdf && viewerPdf !== currentUrl) return viewerPdf;
    }
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: shouldClick => {
          const current = location.href;
          if (/\/previewFile\b/i.test(current) && /(?:[?&])type=pdf\b/i.test(current)) return "__VIEWER__";

          const direct = Array.from(document.querySelectorAll("a[href], iframe[src], embed[src]"))
            .map(el => el.getAttribute("href") || el.getAttribute("src") || "")
            .find(v => /previewFile/i.test(v) && /(?:[?&])type=pdf\b/i.test(v));
          if (direct) return new URL(direct, location.href).href;

          if (!shouldClick) return null;
          const citeBtn = Array.from(document.querySelectorAll(".citeBtn, p, button, span, div, a"))
            .find(el =>
              (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "pdf" &&
              (el.className || "").toString().toLowerCase().includes("citebtn")
            );
          const genericPdfBtn = Array.from(document.querySelectorAll("p, button, span, div, a"))
            .find(el =>
              (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "pdf" &&
              el.offsetParent !== null &&
              el.children.length <= 2
            );
          const pdfBtn = citeBtn || genericPdfBtn;
          if (pdfBtn) {
            pdfBtn.click();
            return "__CLICKED__";
          }
          return null;
        },
        args: [!clicked]
      });
      const result = r?.[0]?.result;
      if (result && result !== "__CLICKED__" && result !== "__VIEWER__") return result;
      if (result === "__CLICKED__") clicked = true;
    } catch {}
  }
  return null;
}
