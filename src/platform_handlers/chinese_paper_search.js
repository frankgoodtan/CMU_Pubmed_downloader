/**
 * 中文論文查詢流程（platform_handlers/chinese_paper_search.js）
 *
 * 背景：PubMed 上有些論文其實是中文期刊，PubMed 收錄的 Title 是英文翻譯，並用
 * 「[ ]」框住整個標題（例如「[Nasal endoscope negative pressure cleaning and
 * sinupret drops to treat radiation nasosinusitis]」），這類論文在 PubMed 上走
 * 原本流程（PMID 直達 / title 搜尋 → Full Text link → 各出版商 PDF 解析）常常
 * 找不到全文。這個檔案負責在原本 PubMed 流程「之前」，先用 Excel L 欄（DOI）
 * 到中國知網海外版（CNKI，經 CMU EZproxy）用 DOI 精確搜尋、下載 PDF。
 *
 * 判定「是不是中文期刊」的方式：只看 Title 整個是不是被「[ ]」框住（見
 * isBracketedChineseTitle），不再檢查 Excel 語言欄（S 欄）。
 *
 * 查詢＋下載流程（呼叫時機見 background.js 的 getPdfUrlWithFallback）：
 *   1. 先進中國知網海外版入口（CNKI_PORTAL_URL），確保 EZproxy 對這個資源已有 session
 *      （沿用 background.js 既有的 CMU EZproxy 登入狀態，非各自獨立登入）。
 *   2. 直接組出「以 DOI 精確搜尋」的結果頁網址（CNKI 首頁把搜尋欄位從預設的
 *      「主題」改選「DOI」、貼上 DOI、按搜尋鍵之後，實際導向的就是這個網址結構；
 *      直接組網址等同模擬這個操作，且不必處理「按下搜尋鍵後開新分頁」的不確定性）。
 *   3. DOI 是精確查詢鍵，正常應該剛好 1 筆結果（讀 #totalCnt）；0 筆視為找不到、
 *      2 筆以上視為不符預期，兩者都直接回報失敗、不繼續往下走。
 *   4. 剛好 1 筆時，點擊結果列的文章標題連結（target="_blank"，開新分頁）進入
 *      文章頁，再點文章頁最下面的「下載」按鈕（a.btn-download-logo）觸發下載。
 *      這裡刻意都用「真的點擊 DOM 元素」而不是直接組網址 fetch/導航：CNKI 的
 *      下載端點會檢查 Referer 是不是真的從自己的頁面點過去的（不是就回傳
 *      「來源應用不正確」的假 HTML 錯誤頁），只有搜尋頁 → 文章頁 → 下載按鈕
 *      這條真實點擊鏈才會帶對 Referer。
 *   5. 用 chrome.downloads.onDeterminingFilename 攔截點擊觸發的原生下載，改存到
 *      呼叫端指定的資料夾/檔名；下載完成後檢查內容不是 HTML 假檔才算成功。
 *   6. 任何一步失敗（缺 DOI、搜尋 0/2+ 筆、逾時、下載內容是假檔等）都視為失敗，
 *      呼叫端會 fallback 回原本 PubMed 流程，不會讓整篇直接判定失敗。
 *
 * 這個檔案只給 background.js（service worker）用，透過 importScripts 載入，
 * 共用 background.js 裡的全域工具函式與 API（sleep、navigateTab、
 * navigateAndWaitStable、addThreadLog、isLoginPage、ensureLogin、traceStamp、
 * sanitizeDownloadFolder、registerPendingDownloadFilename、
 * getPendingDownloadFilename、chrome.downloads/chrome.tabs 等）。
 *
 * ── Debug 訊息 ──
 * 這個流程外部（CNKI 網站/EZproxy）不受我們控制，容易因為頁面改版、登入逾時、
 * DOI 沒命中、下載按鈕選擇器跟預期不同等原因悄悄失敗，所以每個關鍵步驟都留了
 * 兩層紀錄：
 *   1. addThreadLog(...)：寫進 thread log（背景詳細紀錄，THREAD_LOG 訊息），
 *      即時追蹤用，包含目前網址、輪詢次數、頁面診斷等細節。
 *   2. rec(...)（透過呼叫端傳入的 trace 陣列）：寫進「本篇處理過程紀錄」，
 *      這篇論文若最終判定失敗，這些紀錄會整段附加到「下載失敗檔案/*.txt」
 *      末尾，讓使用者不用另外去翻 thread log 就能看到 CNKI 那段到底發生什麼事、
 *      卡在哪一步（進入知網 / 確認搜尋筆數 / 點文章連結 / 點下載按鈕 / 攔截下載）。
 * 失敗時回傳的 failureReason 也會被 background.js 疊進 linkAttempts，
 * 即使之後又 fallback 回 PubMed 流程、PubMed 那邊也失敗，CNKI 這次嘗試的
 * 原因依然會出現在下載失敗 txt 的「連結嘗試紀錄」區塊，不會被蓋掉或遺失。
 */

// 中國知網海外版入口（經 CMU EZproxy）；先訪問這個網址，確保 EZproxy 已對此資源建立 session
const CNKI_PORTAL_URL = "http://oversea-cnki-net.autorpa.cmu.edu.tw:8080/tra/";

// DOI 精確搜尋結果頁（同 CNKI 首頁把搜尋欄改選 DOI、輸入 DOI、按搜尋鍵之後導向的網址）
const CNKI_SEARCH_BASE = "https://oversea-cnki-net.autorpa.cmu.edu.tw:8443/kns8s/defaultresult/index";

// 「總庫」跨庫檢索的預設資料庫分類代碼（對應 CNKI 首頁預設勾選的學術期刊/學位論文/
// 會議論文/報紙/年鑑/輯刊/圖書/標準/成果/特色期刊；不含專利，跟首頁預設一致）
const CNKI_DEFAULT_CROSSIDS =
  "ON8XK5WL,B7ZYGRCM,BT8YKI4I,TBRPZP83,4SCRTXA2,SZU0GLDC,I8IOAWAD,HT3U9UVL,BHWTLLXZ,IAF5Y951";

// 判斷一篇論文是否為中文期刊：PubMed 的 Title 整個被「[ ]」框住即視為中文期刊
// （PubMed 慣例：非英文標題會用中括號框住英文翻譯標題）
function isBracketedChineseTitle(item) {
  const title = String(item?.title || "").trim();
  return title.length > 2 && title.startsWith("[") && title.endsWith("]");
}

function buildCnkiDoiSearchUrl(doi) {
  const params = new URLSearchParams();
  params.set("crossids", CNKI_DEFAULT_CROSSIDS);
  params.set("language", "cht");
  params.set("korder", "DOI");
  params.set("kw", doi);
  return CNKI_SEARCH_BASE + "?" + params.toString();
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

  const searchUrl = buildCnkiDoiSearchUrl(doi);
  workerLog(workerIdx, "  CNKI 以 DOI 搜尋：" + doi, "info");
  rec("組出 DOI 搜尋網址：" + searchUrl);
  addThreadLog("Chinese paper search: navigating to DOI search URL", { doi, searchUrl });

  try {
    await navigateAndWaitStable(tabId, searchUrl, 2500, 20000);
    rec("搜尋結果頁載入完成");
  } catch (e) {
    const msg = e?.message || String(e);
    const reason = "CNKI 搜尋結果頁導航失敗：" + msg;
    report.doiFound = stageResult(false, reason);
    rec(reason);
    addThreadLog("Chinese paper search: search navigation failed", { doi, searchUrl, error: msg });
    return { pdfUrl: null, downloaded: false, failureReason: reason, report };
  }

  // 結果列表可能要一點時間才渲染完，輪詢確認搜尋結果筆數。DOI 是精確查詢鍵，
  // 正常應該剛好 1 筆；0 筆或 2 筆以上都不符合預期，直接回報、不繼續往下點。
  const countDeadline = Date.now() + 30000;
  let pollCount = 0;
  let lastScriptError = "";
  let articleHref = null;
  while (Date.now() < countDeadline) {
    pollCount++;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const totalCntEl = document.getElementById("totalCnt");
          const total = totalCntEl ? parseInt(totalCntEl.value, 10) : NaN;
          if (!Number.isFinite(total)) {
            return { pending: true, url: location.href };
          }
          const link = document.querySelector("table.result-table-list a.fz14.inline[href]");
          return { total, href: link ? link.getAttribute("href") : null, url: location.href };
        }
      });
      const result = r?.[0]?.result;
      if (result && Number.isFinite(result.total)) {
        if (result.total === 0) {
          const reason = "CNKI 以 DOI 搜尋無結果：" + doi;
          report.doiFound = stageResult(false, reason + "（搜尋網址：" + searchUrl + "）");
          rec(reason);
          addThreadLog("Chinese paper search: zero results", { doi, searchUrl });
          return { pdfUrl: null, downloaded: false, failureReason: reason, report };
        }
        if (result.total > 1) {
          const reason = "CNKI 以 DOI 搜尋出現 " + result.total + " 筆結果，不符合預期（DOI 應精確對應 1 篇），已略過此篇，請人工確認。";
          report.doiFound = stageResult(false, reason + "（搜尋網址：" + searchUrl + "）");
          rec(reason);
          addThreadLog("Chinese paper search: multiple results (unexpected)", { doi, searchUrl, total: result.total });
          return { pdfUrl: null, downloaded: false, failureReason: reason, report };
        }
        // total === 1：找到剛好 1 筆，抓文章連結；連結可能還沒渲染出來，繼續輪詢
        if (result.href) { articleHref = result.href; break; }
      }
      if (pollCount === 1 || pollCount % 5 === 0) {
        addThreadLog("Chinese paper search: still polling for result count", {
          doi, pollCount, currentUrl: result?.url || ""
        });
      }
    } catch (e) {
      lastScriptError = e?.message || String(e);
    }
    await sleep(500);
  }

  if (!articleHref) {
    const reason = "CNKI 搜尋結果頁逾時（30 秒），未能確認結果筆數或找到文章連結。" +
      (lastScriptError ? "最後一次讀取頁面時發生錯誤：" + lastScriptError + "；" : "") +
      "搜尋網址：" + searchUrl;
    report.doiFound = stageResult(false, reason);
    rec(reason);
    addThreadLog("Chinese paper search: timed out confirming result count", { doi, searchUrl, lastScriptError, pollCount });
    return { pdfUrl: null, downloaded: false, failureReason: reason, report };
  }

  report.doiFound = stageResult(true, "確認搜尋結果剛好 1 筆，文章連結：" + articleHref);
  rec("確認搜尋結果剛好 1 筆，文章連結：" + articleHref);
  addThreadLog("Chinese paper search: confirmed single result", { doi, articleHref });

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

// 點進文章頁、點文章頁最下面的「下載」按鈕（a.btn-download-logo）觸發真正下載。
// 比直接點搜尋結果列表的下載連結更穩定：搜尋頁 → 文章頁 → 下載按鈕這條路徑
// 完全是真實點擊鏈，Referer 完整，不會被 CNKI 的來源檢查擋下（見檔案開頭說明）。
// 回傳 { ok, reason }。
async function downloadCnkiArticleViaClick(tabId, articleHref, downloadName, folder, workerIdx, trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + "[中文論文查詢] " + line); };
  const downloadFolder = sanitizeDownloadFolder(folder || "PubMed_PDFs");
  const targetPath = downloadFolder + "/" + (downloadName || ("PMID_" + Date.now())) + ".pdf";

  // 文章頁本身是一般內容頁（不像下載端點會檢查 Referer 來源），實測搜尋結果頁
  // 本來就是直接組網址導航過去的（見 runChineseSearchAndDownload），並非靠點擊，
  // 可見 CNKI 不是每個頁面都要求真實點擊鏈。點文章列表連結（target="_blank"）
  // 開新分頁這段改用 chrome.tabs.create 直接開，比較不會受頁面 JS 綁定時機、
  // 瀏覽器彈出視窗政策等因素影響而漏開分頁（先前用「模擬點擊 + 等
  // chrome.tabs.onCreated」偶爾會逾時偵測不到新分頁）。真正需要靠「真實點擊鏈」
  // 帶對 Referer 的只有最後一步的下載按鈕，那段仍然用真的點擊。
  let articleTabId = null;

  try {
    const newTab = await chrome.tabs.create({ url: articleHref, openerTabId: tabId, active: false }).catch(e => {
      addThreadLog("Chinese paper search: chrome.tabs.create threw", { articleHref, error: e?.message || String(e) });
      return null;
    });
    if (!newTab) {
      rec("結果：開啟文章頁分頁失敗");
      addThreadLog("Chinese paper search: failed to open article tab", { articleHref });
      return { ok: false, reason: "開啟文章頁分頁失敗（chrome.tabs.create 未成功）。" };
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
