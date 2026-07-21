/**
 * 中文論文查詢流程（platform_handlers/chinese_paper_search.js）
 *
 * 背景：PubMed 上有些論文其實是中文期刊，PubMed 收錄的 Title 是英文翻譯，並用
 * 「[ ]」框住整個標題（例如「[Nasal endoscope negative pressure cleaning and
 * sinupret drops to treat radiation nasosinusitis]」），這類論文在 PubMed 上走
 * 原本流程（PMID 直達 / title 搜尋 → Full Text link → 各出版商 PDF 解析）常常
 * 找不到全文。這個檔案負責在原本 PubMed 流程「之前」，先用 Excel L 欄（DOI）
 * 到中國知網海外版（CNKI，經 CMU EZproxy）下載 PDF。
 *
 * 判定「是不是中文期刊」的方式：只看 Title 整個是不是被「[ ]」框住（見
 * isBracketedChineseTitle），不再檢查 Excel 語言欄（S 欄）。Excel 裡的 Title
 * 是 PubMed 的英文翻譯標題，不是中文原始篇名，所以不能拿它去 CNKI 用篇名搜尋
 * （搜不到），只能靠 DOI 查找目標文章。
 *
 * 查詢方式的演進：原本直接組 CNKI 一框式搜尋「DOI 精確搜尋」網址（搜尋欄位選
 * DOI、貼 DOI），但實測發現 CNKI 這個 DOI 欄位的比對邏輯是 bug：一框式搜尋用
 * PREFIX（前綴）比對，範圍過寬，會把整本期刊的文章都撈出來（例如查一篇文章的
 * DOI 卻跑出 17,841 筆結果）；高級檢索的「精確」模式又常常 0 筆（索引沒對上）。
 * 因此改用 CNKI 官方 DOI 解析服務（www.chndoi.org）來精確定位文章，不再依賴
 * CNKI 搜尋框：
 *   1. 先進中國知網海外版入口（CNKI_PORTAL_URL），確保 EZproxy 對這個資源已有 session
 *      （沿用 background.js 既有的 CMU EZproxy 登入狀態，非各自獨立登入）。
 *   2. 用 fetch 打 https://www.chndoi.org/Resolution/Handler?doi={DOI}，這是
 *      CNKI 官方的 DOI 解析服務（不需要登入、不吃 EZproxy session），回傳的頁面
 *      是「多重解析地址選擇頁面」，列出題名/作者/DOI 供核對，並提供「境內」
 *      （link.cnki.net）與「境外」（link.oversea.cnki.net）兩個連結。我們只需要
 *      「境外」那個連結（見 resolveOverseaArticleHrefViaChndoi）。
 *   3. 那個「境外」連結是原始網域（https://link.oversea.cnki.net/doi/{DOI}），
 *      不能直接拿去導航——CNKI 認的是「請求真的經過 CMU 這台 EZproxy」，不是
 *      cookie，直連原始網域會被當一般訪客，導向 CNKI 自家帳號登入頁（不是
 *      CMU 登入頁）。所以要先轉成跟 CNKI_PORTAL_URL 同一套轉換規則的代理網址
 *      （「.」換成「-」、接上 .autorpa.cmu.edu.tw:8443，見 toEzproxyCnkiUrl），
 *      再開新分頁導過去。這個代理連結本身會自動跳轉到最終的文章頁
 *      （oversea-cnki-net.autorpa.cmu.edu.tw:8443/kcms2/article/abstract?...），
 *      沿用步驟 1 建立的 EZproxy session 即可直接看到完整文章內容。
 *   4. 在文章頁點最下面的「下載」按鈕（a.btn-download-logo）展開選單，再點選單
 *      裡的 PDF 連結（a#pdfDown）觸發下載。這裡刻意都用「真的點擊 DOM 元素」而
 *      不是直接組網址 fetch/導航：CNKI 的下載端點會檢查 Referer 是不是真的從
 *      自己的文章頁點過去的（不是就回傳「來源應用不正確」的假 HTML 錯誤頁）。
 *   5. 用 chrome.downloads.onDeterminingFilename 攔截點擊觸發的原生下載，改存到
 *      呼叫端指定的資料夾/檔名；下載完成後檢查內容不是 HTML 假檔才算成功。
 *   6. 任何一步失敗（缺 DOI、chndoi.org 解析不到境外連結、逾時、下載內容是假檔
 *      等）都視為失敗，呼叫端會 fallback 回原本 PubMed 流程，不會讓整篇直接
 *      判定失敗。
 *
 * 這個檔案只給 background.js（service worker）用，透過 importScripts 載入，
 * 共用 background.js 裡的全域工具函式與 API（sleep、navigateTab、
 * navigateAndWaitStable、addThreadLog、isLoginPage、ensureLogin、traceStamp、
 * sanitizeDownloadFolder、registerPendingDownloadFilename、
 * getPendingDownloadFilename、chrome.downloads/chrome.tabs 等）。
 *
 * ── Debug 訊息 ──
 * 這個流程外部（CNKI 網站/chndoi.org/EZproxy）不受我們控制，容易因為頁面改版、
 * 登入逾時、解析頁結構變動、下載按鈕選擇器跟預期不同等原因悄悄失敗，所以每個
 * 關鍵步驟都留了兩層紀錄：
 *   1. addThreadLog(...)：寫進 thread log（背景詳細紀錄，THREAD_LOG 訊息），
 *      即時追蹤用，包含目前網址、輪詢次數、頁面診斷等細節。
 *   2. rec(...)（透過呼叫端傳入的 trace 陣列）：寫進「本篇處理過程紀錄」，
 *      這篇論文若最終判定失敗，這些紀錄會整段附加到「下載失敗檔案/*.txt」
 *      末尾，讓使用者不用另外去翻 thread log 就能看到 CNKI 那段到底發生什麼事、
 *      卡在哪一步（進入知網 / DOI 解析 / 點文章連結 / 點下載按鈕 / 攔截下載）。
 * 失敗時回傳的 failureReason 也會被 background.js 疊進 linkAttempts，
 * 即使之後又 fallback 回 PubMed 流程、PubMed 那邊也失敗，CNKI 這次嘗試的
 * 原因依然會出現在下載失敗 txt 的「連結嘗試紀錄」區塊，不會被蓋掉或遺失。
 */

// 中國知網海外版入口（經 CMU EZproxy）；先訪問這個網址，確保 EZproxy 已對此資源建立 session
const CNKI_PORTAL_URL = "http://oversea-cnki-net.autorpa.cmu.edu.tw:8080/tra/";

// CNKI 官方 DOI 解析服務：不吃 EZproxy session、不需要登入，直接回傳「多重解析
// 地址選擇頁面」（題名/作者/DOI + 境內/境外連結），比 CNKI 搜尋框的 DOI 欄位
// （PREFIX 比對 bug，見檔案開頭說明）精確可靠。
const CNKI_DOI_RESOLVER_BASE = "https://www.chndoi.org/Resolution/Handler";

// 判斷一篇論文是否為中文期刊：PubMed 的 Title 整個被「[ ]」框住即視為中文期刊
// （PubMed 慣例：非英文標題會用中括號框住英文翻譯標題）
function isBracketedChineseTitle(item) {
  const title = String(item?.title || "").trim();
  return title.length > 2 && title.startsWith("[") && title.endsWith("]");
}

function buildChndoiResolverUrl(doi) {
  return CNKI_DOI_RESOLVER_BASE + "?doi=" + encodeURIComponent(doi);
}

// 把原始 CNKI 網域網址轉成 CMU EZproxy 代理過的網址（「.」換成「-」、接上
// .autorpa.cmu.edu.tw:8443），跟 CNKI_PORTAL_URL 用的是同一套轉換規則。
// 直接訪問原始網域（例如 oversea.cnki.net）不會帶到 CMU 的機構授權——CNKI
// 是看「請求真的經過 CMU 這台 EZproxy」才放行，不是看 cookie；跳過 proxy
// 直連原始網域會被當成一般訪客，導向 CNKI 自家帳號登入頁。所以 chndoi.org
// 解析出來的「境外」連結（原始網域）一定要轉成這個代理網址再導航過去。
function toEzproxyCnkiUrl(rawUrl) {
  const u = new URL(rawUrl);
  const proxiedHost = u.hostname.replace(/\./g, "-") + ".autorpa.cmu.edu.tw";
  return "https://" + proxiedHost + ":8443" + u.pathname + u.search + u.hash;
}

// 打 chndoi.org DOI 解析服務，從回傳的「多重解析地址選擇頁面」HTML 裡抓出
// 「境外」（link.oversea.cnki.net）連結，並轉成 EZproxy 代理網址。
// 回傳 { ok, href?, reason?, url }。
async function resolveOverseaArticleHrefViaChndoi(doi) {
  const url = buildChndoiResolverUrl(doi);
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    return { ok: false, reason: "chndoi.org DOI 解析服務連線失敗：" + (e?.message || String(e)), url };
  }
  if (!resp.ok) {
    return { ok: false, reason: "chndoi.org DOI 解析服務回應異常，HTTP " + resp.status, url };
  }
  const html = await resp.text();
  const match = html.match(/<a href="(https:\/\/link\.oversea\.cnki\.net\/doi\/[^"]+)">[^<]*<\/a>\s*\(境外\)/);
  if (!match) {
    return { ok: false, reason: "chndoi.org DOI 解析頁未找到「境外」連結，可能查無此 DOI 或頁面結構已變動", url };
  }
  const ezproxyHref = toEzproxyCnkiUrl(match[1]);
  return { ok: true, href: ezproxyHref, rawHref: match[1], url };
}

// 中文論文查詢流程主入口（含下載）。
// trace：呼叫端（background.js）傳入的 itemTrace 陣列，用來記錄本篇的處理過程；
//        失敗時會整段附加到「下載失敗檔案/*.txt」，是排查 CNKI 問題最主要的管道。
// downloadName/folder：下載成功時要存成的檔名（不含副檔名）與資料夾，跟其他平台共用。
// 回傳 { pdfUrl, downloaded, failureReason, report }：
//   - downloaded 為 true：已經成功下載完成，呼叫端不用再走 triggerDownload，
//     也不用再跑原本 PubMed 流程。
//   - downloaded 為 false：呼叫端 fallback 回原本 PubMed 流程（title/PMID 搜尋）。
//   - report：{ enteredPortal, doiFound, downloadSucceeded, otherReason }，前三個
//     是 stageResult({ok, detail})（見 background.js），分別對應下載失敗 txt 裡
//     「進入中國知網」「以 DOI 找到目標論文」「目標論文下載」三個分段；為 null
//     代表這個階段沒跑到。
// 外層薄包裝：沒有 DOI 直接短路（不必佔用鎖），有 DOI 才對 CNKI 網域上鎖，避免多個
// worker 同時搶同一個知網 session/分頁（跟其他出版商共用 acquireDomainLock 機制）。
async function searchChinesePaperPdf(tabId, item, workerIdx, trace = null, downloadName = null, folder = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + "[中文論文查詢] " + line); };
  const doi = String(item?.doi || "").trim();
  const pmid = item?.pmid || "";

  if (!doi) {
    const reason = "中文論文查詢流程需要 DOI（Excel L 欄），此篇缺少 DOI，已略過。";
    const report = { enteredPortal: null, doiFound: null, downloadSucceeded: null, otherReason: reason };
    rec(reason);
    addThreadLog("Chinese paper search: missing DOI, skipped", { pmid, title: item?.title });
    return { pdfUrl: null, downloaded: false, failureReason: reason, report };
  }

  const lockKey = await acquireDomainLock(workerIdx, CNKI_PORTAL_URL, "CNKI");
  try {
    return await runChineseSearchAndDownload(tabId, item, doi, pmid, workerIdx, trace, downloadName, folder);
  } finally {
    releaseDomainLock(lockKey, workerIdx);
  }
}

async function runChineseSearchAndDownload(tabId, item, doi, pmid, workerIdx, trace, downloadName, folder) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + "[中文論文查詢] " + line); };
  const report = { enteredPortal: null, doiFound: null, downloadSucceeded: null, otherReason: "" };

  rec("開始查詢 | PMID=" + pmid + " DOI=" + doi);
  addThreadLog("Chinese paper search: begin", { pmid, doi, title: item?.title });

  // 先進 CNKI 入口，確保 EZproxy 對這個資源已建立 session；若被導去登入頁就先登入
  try {
    await navigateTab(tabId, CNKI_PORTAL_URL, 3000);
    rec("已導到 CNKI 入口：" + CNKI_PORTAL_URL);
  } catch (e) {
    const msg = e?.message || String(e);
    const reason = "CNKI 入口導航失敗：" + msg;
    report.enteredPortal = stageResult(false, reason);
    rec(reason);
    addThreadLog("Chinese paper search: portal navigation failed", { doi, error: msg });
    return { pdfUrl: null, downloaded: false, failureReason: reason, report };
  }

  if (await isLoginPage(tabId)) {
    rec("偵測到 CMU EZproxy 登入頁，先登入再繼續。");
    addThreadLog("Chinese paper search: login required before CNKI portal", { doi });
    await ensureLogin(tabId);
    await navigateTab(tabId, CNKI_PORTAL_URL, 3000);
    rec("登入完成，重新導到 CNKI 入口。");
  }
  report.enteredPortal = stageResult(true, "已進入 CNKI 入口：" + CNKI_PORTAL_URL);

  workerLog(workerIdx, "  透過 chndoi.org 解析 DOI：" + doi, "info");
  const resolved = await resolveOverseaArticleHrefViaChndoi(doi);
  rec("呼叫 chndoi.org DOI 解析：" + resolved.url);
  addThreadLog("Chinese paper search: chndoi.org resolution attempted", { doi, url: resolved.url, ok: resolved.ok });

  if (!resolved.ok) {
    report.doiFound = stageResult(false, resolved.reason);
    rec(resolved.reason);
    addThreadLog("Chinese paper search: chndoi.org resolution failed", { doi, reason: resolved.reason });
    return { pdfUrl: null, downloaded: false, failureReason: resolved.reason, report };
  }

  const articleHref = resolved.href;
  report.doiFound = stageResult(true, "已透過 chndoi.org 解析到境外文章連結（已轉 EZproxy 代理網址）：" + articleHref);
  rec("已透過 chndoi.org 解析到境外文章連結（已轉 EZproxy 代理網址）：" + articleHref);
  addThreadLog("Chinese paper search: resolved article href via chndoi.org", { doi, articleHref, rawHref: resolved.rawHref });

  // 進文章頁 → 點文章頁下載按鈕 → 攔截觸發的下載
  const dl = await downloadCnkiArticleViaClick(tabId, articleHref, downloadName, folder, workerIdx, trace);
  report.downloadSucceeded = stageResult(dl.ok, dl.ok ? "已成功下載" : dl.reason);
  if (!dl.ok) {
    rec("目標論文下載失敗：" + dl.reason);
    addThreadLog("Chinese paper search: article download failed", { doi, articleHref, reason: dl.reason });
    return { pdfUrl: articleHref, downloaded: false, failureReason: dl.reason, report };
  }
  rec("目標論文下載成功");
  addThreadLog("Chinese paper search: article download succeeded", { doi, articleHref });
  return { pdfUrl: articleHref, downloaded: true, failureReason: "", report };
}

// 開文章頁（articleHref 是 chndoi.org 解析出來的「境外」連結，導航過去會自動
// 跳轉到最終的文章頁）、點文章頁最下面的「下載」按鈕（a.btn-download-logo）
// 觸發真正下載。回傳 { ok, reason }。
async function downloadCnkiArticleViaClick(tabId, articleHref, downloadName, folder, workerIdx, trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + "[中文論文查詢] " + line); };
  const downloadFolder = sanitizeDownloadFolder(folder || "PubMed_PDFs");
  const targetPath = downloadFolder + "/" + (downloadName || ("PMID_" + Date.now())) + ".pdf";

  // 文章頁本身是一般內容頁（不像下載端點會檢查 Referer 來源），直接組網址
  // 導航過去即可，不必靠點擊；可見 CNKI 不是每個頁面都要求真實點擊鏈。開新分頁
  // 這段用 chrome.tabs.create 直接開，比較不會受頁面 JS 綁定時機、瀏覽器彈出
  // 視窗政策等因素影響而漏開分頁（先前用「模擬點擊 + 等 chrome.tabs.onCreated」
  // 偶爾會逾時偵測不到新分頁）。真正需要靠「真實點擊鏈」帶對 Referer 的只有
  // 最後一步的下載按鈕，那段仍然用真的點擊。
  // 注意：這裡刻意不傳 openerTabId。openerTabId 要求開新分頁的視窗跟
  // chrome.tabs.create 預設要放的視窗（目前使用中/最後聚焦的視窗）一致，但
  // worker 分頁池（background.js buildTabPool）都是背景分頁，不保證跟使用者
  // 當下聚焦的視窗相同，實測傳了 openerTabId 會讓 chrome.tabs.create 直接
  // reject（"開啟文章頁分頁失敗"）。跟其他地方（background.js 的
  // buildTabPool/recycleWorkerTab 等）一致，只傳 url/active，不指定
  // openerTabId/windowId。
  let articleTabId = null;

  try {
    let createError = "";
    const newTab = await chrome.tabs.create({ url: articleHref, active: false }).catch(e => {
      createError = e?.message || String(e);
      addThreadLog("Chinese paper search: chrome.tabs.create threw", { articleHref, error: createError });
      return null;
    });
    if (!newTab) {
      const reason = "開啟文章頁分頁失敗（chrome.tabs.create 未成功）。" + (createError ? "錯誤訊息：" + createError : "");
      rec("結果：" + reason);
      addThreadLog("Chinese paper search: failed to open article tab", { articleHref, createError });
      return { ok: false, reason };
    }
    articleTabId = newTab.id;
    rec("已開啟文章頁分頁（tabId=" + articleTabId + "），等待載入完成：" + articleHref);
    addThreadLog("Chinese paper search: opened article tab", { articleHref, articleTabId });

    const loadDeadline = Date.now() + 20000;
    while (Date.now() < loadDeadline) {
      const t = await chrome.tabs.get(articleTabId).catch(() => null);
      if (!t) break;
      if (t.status === "complete" && t.url && !/^about:/i.test(t.url)) break;
      await sleep(400);
    }
    rec("文章頁載入完成，準備尋找並點擊下載按鈕");
    addThreadLog("Chinese paper search: article page loaded", { articleTabId });
    // 同上：頁面「載入完成」不等於頁面上所有 JS（含下載按鈕的事件綁定）都跑完了，
    // 緩一下再開始互動，行為也比較接近真人操作
    await sleep(800);

    // 攔截點擊下載按鈕觸發的原生下載（跟其他平台共用的檔名登記機制一致）
    let adoptedId = null;
    const onDeterminingFilename = (dlItem, suggest) => {
      const intended = getPendingDownloadFilename(dlItem);
      if (intended) {
        suggest({ filename: intended, conflictAction: "overwrite" });
        return;
      }
      const src = [dlItem.url, dlItem.finalUrl, dlItem.referrer].filter(Boolean).join(" ");
      if (adoptedId == null && /cnki|kcms2|barnew/i.test(src)) {
        adoptedId = dlItem.id;
        suggest({ filename: targetPath, conflictAction: "overwrite" });
      } else {
        suggest();
      }
    };
    // 下載按鈕點擊也可能開新分頁（視站方 JS 實作而定），一併記住方便清理
    let popupTabId = null;
    const onPopupCreated = t => {
      if (popupTabId == null && t.openerTabId === articleTabId) popupTabId = t.id;
    };
    chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
    chrome.tabs.onCreated.addListener(onPopupCreated);

    try {
      // a.btn-download-logo 只是展開「下載」選單（CAJ / PDF）的開關，本身不會觸發下載；
      // 真正會下載的是選單裡的 #pdfDown（href 指向 barnew/download/order）。實測發現
      // #pdfDown 從頁面載入時就已經在 DOM 裡了（不是點開關後才動態插入），只是包住
      // 它的 <ul class="operate-btn-oversea-sub"> 預設 display:none，要先點一次開關
      // 讓它變成 display:block，才能真的點到會生效的 #pdfDown。所以要分兩個階段：
      // 階段一只點一次開關（重複點會把選單開開關關，反而更難成功）；階段二輪詢
      // 等 #pdfDown 變成可視（用 offsetParent 判斷，不能只看 querySelector 找不找
      // 得到，因為它一直都在 DOM 裡）再點它，不再碰開關。另外下載按鈕在頁面下方，
      // 點擊前先捲到可視範圍。
      const pdfLinkSelector = "a#pdfDown, li.btn-download-pdf a[href], .btn-dlpdf a#pdfDown";
      let clickedSelector = "";
      let succeeded = false;

      for (let attempt = 1; attempt <= 2 && !succeeded; attempt++) {
        if (attempt > 1) {
          rec("PDF 連結逾時未出現，重新點一次下載開關再試一次（第 " + attempt + " 次）");
          addThreadLog("Chinese paper search: retrying download toggle click", { articleTabId, attempt });
        }

        // 階段一：捲到下載開關可視範圍、點一次展開選單。#pdfDown 其實從頁面載入
        // 就已經在 DOM 裡了（不是動態插入的），只是包住它的 <ul> 有 display:none，
        // 所以不能用「document.querySelector 找不找得到」判斷選單是否已展開，
        // 要用 offsetParent（display:none 的元素 offsetParent 是 null）判斷可視度。
        let toggleReady = false;
        const toggleDeadline = Date.now() + 15000;
        while (Date.now() < toggleDeadline) {
          const r = await chrome.scripting.executeScript({
            target: { tabId: articleTabId },
            func: sel => {
              const existing = document.querySelector(sel);
              if (existing && existing.offsetParent !== null) return "already-open";
              const toggle = document.querySelector("a.btn-download-logo");
              if (!toggle) return "no-toggle";
              toggle.scrollIntoView({ block: "center" });
              toggle.click();
              return "clicked";
            },
            args: [pdfLinkSelector]
          }).catch(() => null);
          const status = r?.[0]?.result;
          if (status === "already-open" || status === "clicked") { toggleReady = true; break; }
          await sleep(500);
        }
        if (!toggleReady) {
          rec("結果：文章頁上找不到下載開關（a.btn-download-logo），逾時放棄");
          addThreadLog("Chinese paper search: download toggle not found on article page", { articleTabId });
          return { ok: false, reason: "文章頁上找不到下載開關（a.btn-download-logo），15 秒內未渲染出來。" };
        }
        rec("已點擊文章頁下載開關，等待 PDF 連結顯示出來");
        addThreadLog("Chinese paper search: clicked download toggle on article page", { articleTabId });

        // 階段二：只等 #pdfDown 變成可視並點它，不再碰開關（避免選單被重複開開關關）
        const pdfDeadline = Date.now() + 10000;
        while (Date.now() < pdfDeadline) {
          const r = await chrome.scripting.executeScript({
            target: { tabId: articleTabId },
            func: sel => {
              const pdfLink = document.querySelector(sel);
              if (!pdfLink || pdfLink.offsetParent === null) return { ok: false, selector: "" };
              pdfLink.click();
              return { ok: true, selector: pdfLink.id ? "#" + pdfLink.id : pdfLink.className };
            },
            args: [pdfLinkSelector]
          }).catch(() => null);
          if (r?.[0]?.result?.ok === true) {
            succeeded = true;
            clickedSelector = r[0].result.selector;
            break;
          }
          await sleep(500);
        }
      }

      if (!succeeded) {
        rec("結果：點過下載開關後，PDF 連結（#pdfDown）仍未顯示出來，逾時放棄");
        addThreadLog("Chinese paper search: PDF download link not found on article page", { articleTabId });
        return { ok: false, reason: "點過下載開關後，PDF 連結（#pdfDown）逾時未顯示出來。" };
      }
      rec("已點擊文章頁 PDF 下載連結（" + clickedSelector + "），等待瀏覽器觸發下載");
      addThreadLog("Chinese paper search: clicked PDF download link on article page", { articleTabId, selector: clickedSelector });

      const captureDeadline = Date.now() + 45000;
      while (adoptedId == null && Date.now() < captureDeadline) await sleep(500);
      if (adoptedId == null) {
        rec("結果：點擊下載按鈕後 45 秒內未攔截到下載，判定失敗");
        addThreadLog("Chinese paper search: no download captured after button click", { articleTabId });
        return { ok: false, reason: "點擊下載按鈕後 45 秒內未觸發下載。" };
      }
      rec("已攔截點擊觸發的下載，改存為 " + targetPath);
      addThreadLog("Chinese paper search: adopted download", { downloadId: adoptedId, targetPath });

      const doneDeadline = Date.now() + 300000;
      while (Date.now() < doneDeadline) {
        const items = await new Promise(res => chrome.downloads.search({ id: adoptedId }, res));
        const it = items?.[0];
        if (it?.state === "complete") {
          const fname = (it.filename || "").toLowerCase();
          const mime = (it.mime || "").toLowerCase();
          if (mime.includes("html") || fname.endsWith(".htm") || fname.endsWith(".html")) {
            chrome.downloads.removeFile(adoptedId, () => { void chrome.runtime.lastError; });
            rec("結果：下載完成但內容是網頁（mime=" + (mime || "?") + "），已刪除、判定失敗");
            addThreadLog("Chinese paper search: downloaded content was HTML, treated as failure", { mime, filename: it.filename });
            return { ok: false, reason: "下載完成但內容是網頁（mime=" + (mime || "?") + "），判定為假檔案。" };
          }
          rec("結果：下載成功");
          return { ok: true, reason: "" };
        }
        if (it?.state === "interrupted") {
          rec("結果：下載中斷（" + (it.error || "?") + "）");
          addThreadLog("Chinese paper search: download interrupted", { error: it.error });
          return { ok: false, reason: "下載中斷：" + (it.error || "未知原因") };
        }
        await sleep(500);
      }
      chrome.downloads.cancel(adoptedId, () => { void chrome.runtime.lastError; });
      rec("結果：下載逾時（5 分鐘），已取消");
      addThreadLog("Chinese paper search: download timed out", { adoptedId });
      return { ok: false, reason: "下載逾時（5 分鐘）。" };
    } finally {
      chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
      chrome.tabs.onCreated.removeListener(onPopupCreated);
      if (popupTabId != null) chrome.tabs.remove(popupTabId).catch(() => {});
    }
  } finally {
    if (articleTabId != null) chrome.tabs.remove(articleTabId).catch(() => {});
  }
}
