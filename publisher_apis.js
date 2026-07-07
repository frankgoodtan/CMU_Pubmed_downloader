/**
 * 出版商官方 API 註冊表（publisher_apis.js）
 *
 * 這個檔案同時被兩邊載入：
 * - popup.html（<script>）：api_settings.js 只用 PUBLISHER_APIS 的欄位定義產生設定介面
 * - background.js（importScripts）：實際執行 tryPublisherApiDownload()
 *
 * ── 新增一家出版商 API 的步驟 ──
 * 在 PUBLISHER_APIS 加一個物件即可，介面欄位與下載流程會自動接上：
 *   {
 *     id:    "wiley",                       // 唯一識別，也是憑證儲存的 key
 *     label: "Wiley",                       // 顯示名稱
 *     note:  "…",                           // 顯示在欄位下方的說明（選填）
 *     fields: [{ key, label, placeholder }],// 需要使用者填的憑證欄位
 *     isConfigured: creds => …,             // 判斷憑證是否已填到可以啟用
 *     tryDownload: async (item, creds, ctx) => …, // 回 true=已下載成功；false=回退瀏覽器流程
 *   }
 *
 * tryDownload 只會在 background（service worker）執行，可以用 fetch / chrome.downloads，
 * 也可直接呼叫 background.js 的全域工具（traceStamp / sanitizeDownloadFolder /
 * workerLog / addThreadLog）。ctx = { folder, workerIdx, trace }。
 */

const PUBLISHER_APIS = [
  {
    id: "elsevier",
    label: "Elsevier",
    note: "Article Retrieval API：校內 IP 只需 API Key；校外要另向 Elsevier 申請 Insttoken（EZproxy 幫不上 api.elsevier.com）。API Key 至 dev.elsevier.com 免費申請。",
    fields: [
      { key: "apiKey",    label: "Elsevier API Key",   placeholder: "至 dev.elsevier.com 免費申請（選填）" },
      { key: "insttoken", label: "Elsevier Insttoken", placeholder: "校外使用才需要，向 Elsevier 申請（選填）" },
    ],
    isConfigured: creds => !!String(creds?.apiKey || "").trim(),
    tryDownload: elsevierApiTryDownload,
  },
];

// 是否有任何一家出版商 API 已設定好憑證
function publisherApiConfigured(credsByPublisher) {
  return PUBLISHER_APIS.some(p => p.isConfigured(credsByPublisher?.[p.id]));
}

// 已設定憑證的出版商名稱清單（給 log / 介面摘要用）
function publisherApiConfiguredLabels(credsByPublisher) {
  return PUBLISHER_APIS
    .filter(p => p.isConfigured(credsByPublisher?.[p.id]))
    .map(p => p.label);
}

// 依序試每一家已設定憑證的出版商 API；任一家下載成功就回 true。
// 只在 background 呼叫。
async function tryPublisherApiDownload(item, folder, workerIdx, trace, credsByPublisher) {
  for (const pub of PUBLISHER_APIS) {
    const creds = credsByPublisher?.[pub.id];
    if (!pub.isConfigured(creds)) continue;
    try {
      if (await pub.tryDownload(item, creds, { folder, workerIdx, trace })) return true;
    } catch (e) {
      if (Array.isArray(trace)) {
        trace.push(traceStamp() + pub.label + " API：發生錯誤（" + (e?.message || e) + "），改走瀏覽器流程");
      }
    }
  }
  return false;
}

// 共用：把（已預檢過的）URL 交給 Chrome 下載並等待完成；逾時 5 分鐘取消
function publisherApiDownloadUrlToFile(url, filename) {
  // 有 onDeterminingFilename 監聽器活著時 filename 會被忽略，先登記讓監聽器補回
  registerPendingDownloadFilename(url, filename);
  return new Promise(resolve => {
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "overwrite",
    }, downloadId => {
      if (chrome.runtime.lastError || !downloadId) { resolve(false); return; }
      let timeoutId = null;
      const settle = v => {
        if (timeoutId) clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(listener);
        resolve(v);
      };
      const listener = delta => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete") settle(true);
        else if (delta.state?.current === "interrupted") settle(false);
      };
      chrome.downloads.onChanged.addListener(listener);
      timeoutId = setTimeout(() => {
        chrome.downloads.cancel(downloadId, () => { void chrome.runtime.lastError; });
        settle(false);
      }, 300000);
    });
  });
}

// ── Elsevier：Article Retrieval API（dev.elsevier.com）──
// 以 PMID 直接向 api.elsevier.com 要 PDF：純 HTTP 請求、完全不開出版社網頁，
// 因此不會觸發 ScienceDirect 的人機驗證。
// - 權限比對以「機構 IP」為準：校內只需 API Key；校外需 Insttoken
// - 404 = 這篇不是 Elsevier 刊物 → 靜默回退瀏覽器流程（每篇只多花一個請求）
// - 401/403 = 無權限（多半是校外未附 insttoken）→ 回退並提示
// - 429 = 配額用完（Article Retrieval 每週 5 萬次、每秒 10 次）→ 回退
async function elsevierApiTryDownload(item, creds, ctx) {
  const { folder, workerIdx, trace } = ctx;
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };
  const apiKey = String(creds?.apiKey || "").trim();
  const insttoken = String(creds?.insttoken || "").trim();
  if (!apiKey || !item?.pmid) return false;
  const pmid = String(item.pmid).trim();
  if (!/^\d+$/.test(pmid)) return false;
  const base = "https://api.elsevier.com/content/article/pubmed_id/" + pmid;
  const headers = { "X-ELS-APIKey": apiKey, "Accept": "application/pdf" };
  if (insttoken) headers["X-ELS-Insttoken"] = insttoken;

  rec("Elsevier API：GET " + base);
  let resp = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    resp = await fetch(base, { headers, signal: ctrl.signal });
  } catch (e) {
    rec("Elsevier API：連線失敗（" + (e?.name || e?.message || "?") + "），改走瀏覽器流程");
    return false;
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 404) {
    try { resp.body?.cancel(); } catch {}
    rec("Elsevier API：404（非 Elsevier 刊物），改走瀏覽器流程");
    return false;
  }
  if (resp.status === 401 || resp.status === 403) {
    try { resp.body?.cancel(); } catch {}
    rec("Elsevier API：HTTP " + resp.status + "（無權限），改走瀏覽器流程");
    workerLog(workerIdx, "  Elsevier API 權限不足（HTTP " + resp.status + "）；校外使用需向 Elsevier 申請 insttoken。改走瀏覽器流程。", "warn");
    return false;
  }
  if (resp.status === 429) {
    try { resp.body?.cancel(); } catch {}
    rec("Elsevier API：429（配額已用完），改走瀏覽器流程");
    workerLog(workerIdx, "  Elsevier API 每週配額已用完（429），改走瀏覽器流程。", "warn");
    return false;
  }
  if (!resp.ok) {
    try { resp.body?.cancel(); } catch {}
    rec("Elsevier API：HTTP " + resp.status + "，改走瀏覽器流程");
    return false;
  }

  // 驗明是真 PDF（讀開頭就取消，不整份抓下來）
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  let isPdf = ct.includes("application/pdf");
  if (isPdf) {
    try { resp.body?.cancel(); } catch {}
  } else {
    try {
      const reader = resp.body?.getReader();
      const { value } = await reader.read();
      try { reader.cancel(); } catch {}
      isPdf = !!value?.length && String.fromCharCode(...value.slice(0, 5)).startsWith("%PDF");
    } catch {}
  }
  if (!isPdf) {
    rec("Elsevier API：回應不是 PDF（content-type=" + (ct || "?") + "），改走瀏覽器流程");
    return false;
  }

  // 端點確認會給 PDF：把帶認證參數的網址交給下載 API 存檔
  // （官方文件允許 apiKey / insttoken 以 query string 傳遞）
  const params = new URLSearchParams({ httpAccept: "application/pdf", apiKey });
  if (insttoken) params.set("insttoken", insttoken);
  const dlUrl = base + "?" + params.toString();
  const downloadFolder = sanitizeDownloadFolder(folder);
  rec("Elsevier API：預檢為真 PDF，開始下載");
  addThreadLog("Elsevier API download starting", { pmid, rowIndex: item.rowIndex });
  const ok = await publisherApiDownloadUrlToFile(dlUrl, downloadFolder + "/" + item.safeTitle + ".pdf");
  rec("Elsevier API：下載" + (ok ? "成功" : "失敗或中斷"));
  addThreadLog("Elsevier API download finished", { pmid, ok });
  return ok;
}
