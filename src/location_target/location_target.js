// 獨立的「定位目標元素」模組，跟移動滑鼠/點擊/畫愛心等實際動作完全分開。
//
// 用法（在有 chrome.* API 權限的地方呼叫，例如 background.js）：
//   const point = await locateTargetElement(tabId, selector, options);
//   if (point) { ... point.x, point.y 就是螢幕絕對座標（元素中心點） ... }
//
//   const points = await locateAllTargetElements(tabId, selector, options);
//   // 回傳陣列，同一頁上有多個符合條件的元素（例如同時鋪了 reCAPTCHA + hCaptcha
//   // 當備援）時可以逐一拿到每一個的座標，用來輪流提醒。locateTargetElement
//   // 內部就是取這個陣列的第一筆，兩者共用同一套偵測/換算邏輯。
//
// selector 可以是逗號分隔的多個 CSS selector（跟 document.querySelectorAll 一樣）。
// locateTargetElement 取「第一個通過 options 篩選條件」的元素；
// locateAllTargetElements 回傳「全部」通過篩選的元素。都找不到就回傳
// null（locateTargetElement）或空陣列（locateAllTargetElements）。
//
// options：
//   minWidth / minHeight：元素 boundingClientRect 至少要多大才算數（濾掉隱形的
//     0x0 佔位元素，或像 grecaptcha 角落徽章那種很小的裝飾元件）。
//   excludeSelector：符合這個 selector（用 el.closest 判斷）的元素直接跳過。
//
// 這支檔案是 classic script（沒有用 ES module 的 import/export），
// background.js 用 importScripts("location_target/location_target.js") 載入，
// 載入後就能直接使用全域函式 locateTargetElement / locateAllTargetElements。
//
// chrome.scripting.executeScript 沒辦法注入 chrome-extension:// 頁面（Chrome 的
// 硬性限制，不管 host_permissions 怎麼寫都一樣，包括對自己的擴充功能頁面）。這種
// 頁面（例如 element_test.html）改成自己主動把元件座標推送過來：頁面載入時呼叫
// chrome.runtime.sendMessage({action: "ELEMENT_TEST_WIDGETS", widgets: [...]})，
// 下面這個監聽器收著存進 ELEMENT_TEST_REPORTS，executeScript 失敗時查表即可，
// 不用再往頁面問一次（這個方向 —— 擴充功能頁面呼叫 sendMessage 給背景 —— 才是
// 一定能送到的方向，popup.js 全程都是這樣跟 background.js 溝通的）。
const ELEMENT_TEST_REPORTS = new Map(); // tabId → {innerWidth, innerHeight, widgets, ts}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.action === "ELEMENT_TEST_WIDGETS" && sender.tab) {
    ELEMENT_TEST_REPORTS.set(sender.tab.id, {
      innerWidth: msg.innerWidth,
      innerHeight: msg.innerHeight,
      widgets: msg.widgets || [],
      ts: Date.now()
    });
  }
});

// 把 executeScript 抓回來的 viewport-relative rect（含 innerWidth/innerHeight）
// 換算成螢幕絕對座標。locateTargetElement / locateAllTargetElements 共用同一套
// 換算公式，只是前者只轉一個 rect、後者轉整個陣列。
function rectToScreenPoint(rect, windowInfo) {
  // 近似值：chrome.windows.get 給的是視窗外框（含標題列/分頁列/工具列）。
  // 假設左右留白對稱、上方留白全部是瀏覽器 UI 佔用的高度。
  //
  // 單位：實測證實 chrome.windows.get() 的 left/top/width/height 其實是 CSS／
  // 邏輯像素（devicePixelRatio=1.25 時，windowInfo.width=1552 卻小於同一個視窗
  // 量到的 rect.innerWidth*1.25=1920——視窗不可能比自己的 viewport 還窄，可見
  // windowInfo 本來就沒有被實體像素放大過）。getBoundingClientRect()／
  // innerWidth／innerHeight 也是 CSS 像素（網頁標準規定）。所以這裡全程都用
  // CSS 像素計算，跟原本（100% 縮放年代）的公式一致；native host 那邊操作的是
  // 實體像素螢幕座標，只有在算完、要交出去之前，才在最後一次性乘上
  // devicePixelRatio 轉成實體像素——不是提早在 rect 這一層就乘（那樣會把
  // windowInfo／rect 兩套本來一致的 CSS 像素數字，混成不同單位再加在一起）。
  const viewportScreenX = windowInfo.left + Math.max(0, windowInfo.width - rect.innerWidth) / 2;
  const viewportScreenY = windowInfo.top + Math.max(0, windowInfo.height - rect.innerHeight);

  const elementScreenLeft = viewportScreenX + rect.left;
  const elementScreenTop = viewportScreenY + rect.top;

  const dpr = rect.dpr || 1;
  return {
    x: (elementScreenLeft + rect.width / 2) * dpr,
    y: (elementScreenTop + rect.height / 2) * dpr,
    left: elementScreenLeft * dpr,
    top: elementScreenTop * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr,
    matched: rect.matched,
    // 除錯用：定位準確後這幾個欄位可以拿掉。
    _debugDpr: dpr,
    _debugRawRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    _debugRawInner: { innerWidth: rect.innerWidth, innerHeight: rect.innerHeight },
    _debugWindowInfo: { left: windowInfo.left, top: windowInfo.top, width: windowInfo.width, height: windowInfo.height }
  };
}

// 跟 locateTargetElement 同樣的 selector/options，但回傳「全部」符合條件的元素
// （陣列，可能是 0 個、1 個或多個），不是只回第一個。用於一頁上可能同時有多個
// 驗證挑戰元件（例如同時鋪了 reCAPTCHA + hCaptcha 當備援）時，要輪流逐一提醒。
async function locateAllTargetElements(tabId, selector, options) {
  if (!selector) throw new Error("locateAllTargetElements: selector is required");
  options = options || {};
  const minWidth = options.minWidth || 0;
  const minHeight = options.minHeight || 0;
  const excludeSelector = options.excludeSelector || null;

  let rects = [];
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, minW, minH, excludeSel) => {
        const isUsable = (el) => {
          if (!el) return false;
          if (excludeSel && el.closest(excludeSel)) return false;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > minW && rect.height > minH;
        };
        // document.querySelectorAll 不會穿透 shadow root，但 Cloudflare Turnstile
        // 等挑戰元件常把實際渲染出的 iframe/容器包在（open）shadow root 裡再插進
        // DOM，只查 document 這一層常常直接漏掉。這裡改成遞迴：先查目前這層，再
        // 對每個有 shadowRoot 的節點往下查同一組 selector，結果合併去重。
        const deepQuerySelectorAll = (root, selector) => {
          const found = new Set(Array.from(root.querySelectorAll(selector)));
          const all = root.querySelectorAll("*");
          for (const el of all) {
            if (el.shadowRoot) {
              for (const nested of deepQuerySelectorAll(el.shadowRoot, selector)) {
                found.add(nested);
              }
            }
          }
          return Array.from(found);
        };
        // getBoundingClientRect()／innerWidth／innerHeight 永遠是 CSS 像素（網頁
        // 標準規定，不受 Windows 顯示縮放影響），這裡直接原樣回傳、不要提早換算
        // ——chrome.windows.get() 拿到的 windowInfo 實測也是 CSS 像素，兩者單位
        // 本來就一致，混合計算沒問題；只有最後真的要交給 native host（它操作的
        // 是實體螢幕座標）時，才在 rectToScreenPoint() 裡一次性乘上
        // devicePixelRatio。dpr 隨 rect 一起帶出去，讓那裡拿得到這個縮放比例。
        const dpr = window.devicePixelRatio || 1;
        return deepQuerySelectorAll(document, sel).filter(isUsable).map((el) => {
          const rect = el.getBoundingClientRect();
          const firstClass = el.className && typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
          const matched = el.id ? ("#" + el.id) : (firstClass ? ("." + firstClass) : el.tagName.toLowerCase());
          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            matched,
            dpr,
          };
        });
      },
      args: [selector, minWidth, minHeight, excludeSelector]
    });
    rects = (injection && injection.result) || [];
  } catch (scriptingError) {
    // 一般 http/https 頁面不會走到這裡，上面的 executeScript 就能處理；這裡是
    // chrome-extension:// 頁面（例如 element_test.html）專用的查表 fallback。
    const report = ELEMENT_TEST_REPORTS.get(tabId);
    if (report) {
      const requestedTokens = selector.split(",").map(s => s.trim()).filter(Boolean);
      rects = report.widgets
        .filter(w => w.width > minWidth && w.height > minHeight && requestedTokens.includes(w.selector))
        .map(w => ({
          left: w.left,
          top: w.top,
          width: w.width,
          height: w.height,
          innerWidth: report.innerWidth,
          innerHeight: report.innerHeight,
          matched: w.selector
        }));
    }
  }

  if (!rects.length) return [];

  const tab = await chrome.tabs.get(tabId);
  const windowInfo = await chrome.windows.get(tab.windowId);
  return rects.map(rect => rectToScreenPoint(rect, windowInfo));
}

// 回傳「第一個」符合條件的元素（跟舊版行為一致），內部就是
// locateAllTargetElements 取第一筆，兩者共用同一套偵測/換算邏輯。
async function locateTargetElement(tabId, selector, options) {
  const all = await locateAllTargetElements(tabId, selector, options);
  return all.length ? all[0] : null;
}
