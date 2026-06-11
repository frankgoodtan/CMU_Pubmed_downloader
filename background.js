/**
 * PubMed PDF downloader background service worker.
 */
try {
  importScripts("exceljs.bare.min.js");
} catch(e) {
  console.warn("ExcelJS load failed:", e);
}

let controlWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (controlWindowId !== null) {
    try {
      await chrome.windows.update(controlWindowId, { focused: true });
      return;
    } catch(e) {
      controlWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 540,
    height: 680,
    top: 100,
    left: 100,
    focused: true,
  });
  controlWindowId = win.id;

  chrome.windows.onRemoved.addListener(function onRemoved(wid) {
    if (wid === controlWindowId) {
      controlWindowId = null;
      chrome.windows.onRemoved.removeListener(onRemoved);
    }
  });
});
/**
 * background.js v6
 * 
 * 並行下載引擎，支援 EZproxy 登入、批次控制、Excel 進度寫入

 */

// ── 常數 ──
const EZPROXY_BASE  = "autorpa.cmu.edu.tw:8443";
const PUBMED_EZPROXY = `https://pubmed-ncbi-nlm-nih-gov.${EZPROXY_BASE}`;
const LOGIN_URL     = "https://autorpa.cmu.edu.tw/user/login/?next=/er/geter/DB000000043/";
const PUBMED_DIRECT = "https://pubmed.ncbi.nlm.nih.gov";
const STATUS_SUCCESS = "下載成功";
const STATUS_FAIL    = "下載失敗";
const STATUS_RETRY   = "下次重試";

// ?? ?典??????
let G = resetState();

function resetState() {
  return {
    running:       false,
    paused:        false,
    stopped:       false,
    targets:       [],
    queue:         [],
    concurrent:    3,
    workers:       [],
    ok:            0,
    fail:          0,
    skip:          0,
    done:          0,
    total:         0,
    logs:          [],
    threadLogs:    [],
    resultsMap:    {},
    downloadFolder:"PubMed_PDFs",
    batchSize:     0,
    politeMode:    true,
    lastPdfFailureReason: "",
    lastFullTextLinks:    [],   // [{source, label, url}] Full Text 連結清單
    stopAfter:            0,
    dispatched:           0,
    resultsFailMap:       {},
    loginLock:      false,
    loginDone:      false,
    loginWaiters:   [],
    waitingLogin:   false,
    loginResolve:   null,
    waitingCaptcha: false,
    captchaResolve: null,
    captchaImg:     null,
    tabPool:        [],
    domainLocks:    {},
    activeWorkers:  0,
    cookieCleanupRequested: false,
    cookieCleanupInProgress: false,
    cookieCleanupEvery: 10,
    cookieCleanupReason: "",
    cookieCleanupEpoch: 0,
    cookieCleanupRestartEpoch: 0,
  };
}

// ── 訊息處理 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    case "GET_STATE":
      sendResponse({ state: getPublicState() });
      return true;

    case "GET_RESULTS":
      sendResponse({ resultsMap: G.resultsMap, resultsFailMap: G.resultsFailMap || {} });
      return true;

    case "SAVE_SOURCE_EXCEL":
      chrome.storage.local.set({
        sourceExcelB64: msg.b64,
        excelMeta: msg.meta,
        latestExcelB64: msg.b64,
      });
      addThreadLog("SAVE_SOURCE_EXCEL", { b64Length: msg.b64?.length || 0, meta: msg.meta });
      sendResponse({ ok: true });
      return true;

    case "EXPORT_EXCEL":
      chrome.storage.local.get(["latestExcelB64", "excelMeta"], data => {
        const b64  = data.latestExcelB64;
        const meta = data.excelMeta || {};
        addThreadLog("EXPORT_EXCEL", { b64Length: b64?.length || 0, hasExcelJS: !!self.ExcelJS });
        if (!b64) { sendResponse({ ok: false, error: "找不到 Excel 資料，請重新上傳 Excel 檔案" }); return; }
        const base = (meta.baseName || "CANCER_PAPERS").replace(/_下載進度管理$/i, "");
        const folder = meta.folder || "PubMed_PDFs";
        const dataUrl = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + b64;
        chrome.downloads.download({
          url: dataUrl,
          filename: `${folder}/${base}_下載進度管理.xlsx`,
          saveAs: true,
        }, (dlId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true });
          }
        });
      });
      return true;

    case "START_DOWNLOAD":
      if (G.running) { sendResponse({ ok: false, error: "找不到 Excel 資料，請重新上傳 Excel 檔案" }); return true; }
      G = resetState();
      G.targets    = msg.targets;
      G.concurrent = msg.concurrent || 3;
      G.downloadFolder = sanitizeDownloadFolder(msg.downloadFolder || "PubMed_PDFs");
      G.batchSize  = Math.max(0, parseInt(msg.batchSize  || 0, 10) || 0);
      G.stopAfter  = Math.max(0, parseInt(msg.stopAfter  || 0, 10) || 0);
      G.politeMode = msg.politeMode !== false;
      G.total      = msg.targets.length;
      G.queue      = msg.targets.map((_, i) => i);
      G.running    = true;
      for (let i = 0; i < G.concurrent; i++) {
        G.workers.push({ tabId: null, pmid: null, label: "等待中", status: "idle" });
      }
      sendResponse({ ok: true });
      startDownloadEngine();
      return true;

    case "PAUSE_DOWNLOAD":
      G.paused = true;
      triggerExcelWrite({ toDownload: true });
      sendResponse({ ok: true });
      return true;

    case "RESUME_DOWNLOAD":
      G.paused = false;
      sendResponse({ ok: true });
      schedulePendingWorkers();
      return true;

    case "STOP_DOWNLOAD":
      G.stopped = true;
      G.running = false;
      G.tabPool.forEach(id => chrome.tabs.remove(id).catch(() => {}));
      G.tabPool = [];
      if (G.loginResolve)  G.loginResolve(null);
      if (G.captchaResolve) G.captchaResolve(null);
      triggerExcelWrite({ toDownload: true });
      sendResponse({ ok: true });
      return true;

    case "RESET_EXTENSION":
      G.stopped = true;
      G.running = false;
      if (bgExcelTimer) { clearTimeout(bgExcelTimer); bgExcelTimer = null; }
      bgPendingDownload = false;
      G.tabPool.forEach(id => chrome.tabs.remove(id).catch(() => {}));
      G.tabPool = [];
      if (G.loginResolve)  G.loginResolve(null);
      if (G.captchaResolve) G.captchaResolve(null);
      G = resetState();
      chrome.storage.local.remove([
        "completedPmids",
        "completedCount",
        "downloadFolder",
        "sourceExcelB64",
        "latestExcelB64",
        "excelMeta"
      ], () => sendResponse({ ok: true }));
      return true;

    case "LOGIN_SUBMIT":
      handleLoginSubmit(msg.username, msg.password, msg.captcha);
      sendResponse({ ok: true });
      return true;

    case "CAPTCHA_ANSWER":
      if (G.captchaResolve) {
        G.captchaResolve(msg.answer);
        G.captchaResolve = null;
        G.waitingCaptcha = false;
      }
      sendResponse({ ok: true });
      return true;
  }
});

// ── 狀態快照（回傳給 popup）──
function getPublicState() {
  return {
    running:       G.running,
    paused:        G.paused,
    total:         G.total,
    done:          G.done,
    ok:            G.ok,
    fail:          G.fail,
    skip:          G.skip,
    logs:          G.logs.slice(-100),
    threadLogs:    (G.threadLogs || []).slice(-200),
    hasResult:     G.done > 0,
    waitingLogin:  G.waitingLogin,
    waitingCaptcha:G.waitingCaptcha,
    captchaImg:    G.captchaImg,
    workers:       G.workers.map(w => ({ label: w.label, status: w.status })),
  };
}

// ── 日誌 & 通知 ──
function addLog(msg, type = "info", workerIdx = -1) {
  G.logs.push({ msg, type, workerIdx, time: Date.now() });
  if (G.logs.length > 1000) G.logs.shift();
  chrome.runtime.sendMessage({ action: "LOG", msg, type, workerIdx }).catch(() => {});
}

function addThreadLog(msg, data = null) {
  if (!G.threadLogs) G.threadLogs = [];
  const entry = { msg, data, time: Date.now() };
  G.threadLogs.push(entry);
  if (G.threadLogs.length > 2000) G.threadLogs.shift();
  chrome.runtime.sendMessage({ action: "THREAD_LOG", entry }).catch(() => {});
}

function workerLog(workerIdx, msg, type = "info", anchorId = null) {
  addLog(msg, type, workerIdx);
  if (anchorId) {
    chrome.runtime.sendMessage({ action: "LOG_ANCHOR", anchorId, workerIdx }).catch(() => {});
  }
}

function handleLoginSubmit(username, password, captcha) {
  if (!G.loginResolve) {
    addLog("收到登入資料，但目前沒有等待中的登入流程。", "warn");
    chrome.runtime.sendMessage({ action: "LOGIN_FAILED_STOP" }).catch(() => {});
    return;
  }

  G.loginResolve({ username, password, captcha });
  G.loginResolve = null;
}

function notifyProgress() {
  chrome.runtime.sendMessage({
    action: "PROGRESS",
    total: G.total, done: G.done,
    ok: G.ok, fail: G.fail, skip: G.skip,
  }).catch(() => {});
}

function notifyWorkers() {
  chrome.runtime.sendMessage({
    action: "WORKERS",
    workers: G.workers.map(w => ({ label: w.label, status: w.status })),
  }).catch(() => {});

  if (G.paused && !G.stopped && G.workers.length > 0) {
    const allIdle = G.workers.every(w => w.status !== "running");
    if (allIdle) {
      triggerExcelWrite({ toDownload: true });
    }
  }
}

async function startDownloadEngine() {
  addLog(`開始下載，共 ${G.total} 篇，並行數量 ${G.concurrent}${G.politeMode ? "，已啟用保守模式" : ""}`, "info");

  addLog("檢查 EZproxy 登入狀態...", "info");
  const checkTab = await chrome.tabs.create({ url: "about:blank", active: false });

  const isLoggedIn = await checkLogin(checkTab.id);
  if (!isLoggedIn) {

    G.loginLock = true;
    await requestLogin(checkTab.id);
    const afterLogin = await chrome.tabs.get(checkTab.id).catch(() => null);
    const afterUrl   = afterLogin?.url || "";
    const loginSuccess = !afterUrl.includes("/user/login") && !afterUrl.includes("/proxy/login");

    G.loginDone = loginSuccess;
    G.loginLock = false;
    G.loginWaiters.splice(0).forEach(r => r());

    if (!loginSuccess) {
      addLog("登入失敗，已停止本次任務。", "fail");
      G.stopped = true;
      G.running = false;
      chrome.tabs.remove(checkTab.id).catch(() => {});
      chrome.runtime.sendMessage({ action: "LOGIN_FAILED_STOP" }).catch(() => {});
      return;
    }
    addLog("登入成功，繼續下載。", "ok");
  } else {
    G.loginDone = true;
    addLog("已登入 EZproxy，繼續下載。", "ok");
  }

  // ???冽?瑼Ｘ??
  chrome.tabs.remove(checkTab.id).catch(() => {});

  await buildTabPool(G.concurrent);

  // ????worker
  const workerPromises = [];
  for (let i = 0; i < G.concurrent; i++) {
    workerPromises.push(runWorker(i));
  }
  await Promise.all(workerPromises);

  finishAll();
}

async function buildTabPool(count) {
  for (let i = 0; i < count; i++) {
    const tab = await chrome.tabs.create({
      url:    "about:blank",
      active: false,
    });
    G.tabPool.push(tab.id);
  }
  addLog(`已建立 ${count} 個背景分頁`, "info");
}

/** 單一 worker 迴圈 */
async function runWorker(workerIdx) {
  const tabId = G.tabPool[workerIdx];

  while (true) {
 
    while (G.paused && !G.stopped) await sleep(500);
    if (G.stopped) break;

    while (G.cookieCleanupRequested && !G.stopped) await waitForCookieCleanup(workerIdx);
    if (G.stopped) break;

    if (G.queue.length === 0) break;

    if (G.stopAfter > 0 && G.dispatched >= G.stopAfter) break;
    const idx  = G.queue.shift();
    G.dispatched = (G.dispatched || 0) + 1;
    const item = G.targets[idx];
    if (!item) continue;
    G.activeWorkers = (G.activeWorkers || 0) + 1;
    const itemFolder = getBatchFolderForIndex(idx);

    G.workers[workerIdx] = { tabId, pmid: item.pmid, label: truncate(item.title, 40), status: "running" };
    notifyWorkers();

 
    const anchorId = `w${workerIdx}-pmid-${item.pmid}`;
    workerLog(workerIdx, `\n[Worker ${workerIdx+1}] PMID:${item.pmid} | ${truncate(item.title, 55)}`, "info", anchorId);
    let itemExcelStatus = STATUS_FAIL;
    let failureReason = "";
    let localLinks = [];
    let localLinkAttempts = [];
    let pdfDownloadAttempts = [];
    const countersBeforeItem = { ok: G.ok, fail: G.fail, skip: G.skip };
    const itemCleanupEpoch = G.cookieCleanupEpoch || 0;

    let status = "失敗";
    try {
      const result = await getPdfUrlWithFallback(tabId, item, workerIdx);
      const pdfUrl      = normalizePdfUrlValue(result?.pdfUrl ?? result);
      localLinks        = result?.fullTextLinks ?? [];
      const localReason = result?.failureReason ?? "";
      localLinkAttempts = result?.linkAttempts ?? [];

      if (pdfUrl === "SKIP") {
        itemExcelStatus = "跳過";
        status = "未下載";
        failureReason = localReason || "此篇在找到可下載 PDF 前被略過。";
        G.skip++;
        workerLog(workerIdx, "  無全文連結，標記未下載", "warn");
      } else if (pdfUrl === "BOT") {
        itemExcelStatus = STATUS_FAIL;
        status = "失敗";
        failureReason = "偵測到機器人/驗證頁，無法繼續下載。";
        G.fail++;
        workerLog(workerIdx, "  偵測到機器人/驗證頁，跳過此篇", "bot");
      } else if (pdfUrl) {
        const pdfCandidates = normalizePdfCandidates(result, pdfUrl);
        let ok = false;
        let lastDownloadUrl = "";
        for (let i = 0; i < pdfCandidates.length; i++) {
          const candidate = pdfCandidates[i];
          lastDownloadUrl = candidate.pdfUrl;
          if (i > 0) {
            workerLog(workerIdx, `  前一個 PDF 下載失敗，改試候選 PDF ${i + 1}/${pdfCandidates.length}：${candidate.label || "未知來源"}`, "warn");
          }
          const downloadLockKey = await acquireDomainLock(workerIdx, candidate.sourceUrl || candidate.pdfUrl, candidate.label || "PDF 下載");
          addThreadLog("Trying PDF download candidate", {
            workerIdx,
            rowIndex: item.rowIndex,
            pmid: item.pmid,
            index: i + 1,
            total: pdfCandidates.length,
            label: candidate.label || "",
            sourceUrl: candidate.sourceUrl || "",
            pdfUrl: candidate.pdfUrl
          });
          try {
            ok = await triggerDownload(candidate.pdfUrl, item.safeTitle, itemFolder);
          } finally {
            releaseDomainLock(downloadLockKey, workerIdx);
          }
          if (ok) {
            pdfDownloadAttempts.push(`PDF 候選 ${i + 1}/${pdfCandidates.length} 成功：${candidate.label || "未知來源"} | ${candidate.pdfUrl}`);
            addThreadLog("PDF download candidate succeeded", {
              workerIdx,
              rowIndex: item.rowIndex,
              pmid: item.pmid,
              index: i + 1,
              total: pdfCandidates.length,
              label: candidate.label || "",
              pdfUrl: candidate.pdfUrl
            });
          }
          if (ok) break;
          pdfDownloadAttempts.push(`PDF 候選 ${i + 1}/${pdfCandidates.length} 下載失敗或中斷：${candidate.label || "未知來源"} | ${candidate.pdfUrl}`);
          addThreadLog("PDF download candidate failed", {
            workerIdx,
            rowIndex: item.rowIndex,
            pmid: item.pmid,
            index: i + 1,
            total: pdfCandidates.length,
            label: candidate.label || "",
            pdfUrl: candidate.pdfUrl
          });
        }
        if (ok) {
          itemExcelStatus = STATUS_SUCCESS;
          status = "成功";
          G.ok++;
          workerLog(workerIdx, `  下載成功：${item.safeTitle}.pdf`, "ok");
        } else {
          const attemptsDetail = (result?.linkAttempts?.length)
            ? `\n連結嘗試紀錄：${result.linkAttempts.join(" | ")}`
            : "";
          const decision = decideFailureStatus(item, result, `已找到 PDF 連結，但 Chrome 回報下載失敗或中斷。已嘗試 ${pdfCandidates.length} 個候選 PDF${lastDownloadUrl ? `；最後嘗試：${lastDownloadUrl}` : ""}${attemptsDetail}`);
          itemExcelStatus = decision.excelStatus;
          status = decision.workerStatus;
          failureReason = decision.reason;
          if (itemExcelStatus === STATUS_RETRY) G.skip++;
          else G.fail++;
          workerLog(workerIdx, "  下載失敗：PDF 候選皆無法完成", "fail");
          if (localLinks.length) {
            localLinks.forEach((ft, i) =>
              workerLog(workerIdx, `     [連結 ${i+1}] ${ft.label || ft.source}: ${ft.url}`, "warn")
            );
          }
        }
      } else {
        const decision = decideFailureStatus(item, result, localReason || "找不到可下載的 PDF 連結。");
        itemExcelStatus = decision.excelStatus;
        status = decision.workerStatus;
        failureReason = decision.reason;
        if (itemExcelStatus === STATUS_RETRY) G.skip++;
        else G.fail++;
        if (localLinks.length) {
          workerLog(workerIdx, `  找到 ${localLinks.length} 個 Full Text 連結，但無法取得 PDF`, "warn");
          localLinks.forEach((ft, i) =>
            workerLog(workerIdx, `     [連結 ${i+1}] ${ft.label || ft.source}: ${ft.url}`, "warn")
          );
        } else {
          workerLog(workerIdx, "  PubMed 頁面沒有 Full Text 連結", "warn");
        }
      }
    } catch(e) {
      const decision = decideFailureStatus(item, null, e?.message || "處理此篇時發生未知錯誤。");
      itemExcelStatus = decision.excelStatus;
      status = decision.workerStatus;
      failureReason = decision.reason;
      if (itemExcelStatus === STATUS_RETRY) G.skip++;
      else G.fail++;
      workerLog(workerIdx, `  發生錯誤：${e.message}`, "fail");
    }

    const shouldRestartAfterCookieCleanup =
      (G.cookieCleanupRequested && G.cookieCleanupReason === "header-too-large") ||
      ((G.cookieCleanupRestartEpoch || 0) > itemCleanupEpoch);
    const itemSucceeded = G.ok > countersBeforeItem.ok;
    if (shouldRestartAfterCookieCleanup && !itemSucceeded && (item._cleanupRetryCount || 0) < 2) {
      item._cleanupRetryCount = (item._cleanupRetryCount || 0) + 1;
      G.ok = countersBeforeItem.ok;
      G.fail = countersBeforeItem.fail;
      G.skip = countersBeforeItem.skip;
      G.queue.unshift(idx);
      G.dispatched = Math.max(0, (G.dispatched || 1) - 1);
      G.activeWorkers = Math.max(0, (G.activeWorkers || 1) - 1);
      workerLog(workerIdx, `  偵測到 cookie/redirect cleanup，清理後重試此篇（${item._cleanupRetryCount}/2）`, "warn");
      addThreadLog("Cookie cleanup pending; unsuccessful item will restart after cleanup.", {
        workerIdx,
        retryCount: item._cleanupRetryCount,
        reason: G.cookieCleanupReason,
        rowIndex: item.rowIndex,
        pmid: item.pmid,
        title: item.title
      });
      await waitForCookieCleanup(workerIdx);
      if (!G.stopped) await navigateTab(tabId, "about:blank", 200);
      continue;
    }
    if (shouldRestartAfterCookieCleanup && itemSucceeded) {
      workerLog(workerIdx, "  已成功下載；等待 cookie/redirect cleanup 後再處理下一篇。", "ok");
      addThreadLog("Cookie cleanup pending, item succeeded; keeping result and waiting before next item.", {
        workerIdx,
        reason: G.cookieCleanupReason,
        rowIndex: item.rowIndex,
        pmid: item.pmid,
        title: item.title
      });
    }

    G.resultsMap[item.rowIndex] = itemExcelStatus;
    if (itemExcelStatus !== STATUS_SUCCESS) {
      const noteAttempts = [
        ...localLinkAttempts,
        ...pdfDownloadAttempts
      ];
      const noteOk = await createFailureNote(item, itemExcelStatus, itemFolder, failureReason, localLinks, noteAttempts);
      if (!noteOk) {
        workerLog(workerIdx, "  下載失敗 txt 產生失敗，請查看 thread log。", "fail");
      }
    }

    if (itemExcelStatus === STATUS_SUCCESS && item.pmid) {
      chrome.storage.local.get(["completedPmids"], data => {
        const set = new Set(data.completedPmids || []);
        set.add(String(item.pmid));
        chrome.storage.local.set({ completedPmids: [...set] });
      });
    }

    G.done++;
 
    if (failureReason) {
      G.resultsFailMap = G.resultsFailMap || {};
      G.resultsFailMap[item.rowIndex] = failureReason;
    }
    chrome.runtime.sendMessage({
      action: "RESULT_UPDATE", item, status: itemExcelStatus,
      resultsMap: G.resultsMap,
      resultsFailMap: G.resultsFailMap || {},
      failureReason,
      workerIdx,
      anchorId
    }).catch(() => {});
    G.workers[workerIdx] = { tabId, pmid: null, label: `完成：${status}`, status: status === "成功" ? "done" : status === "失敗" ? "fail" : "idle" };
    notifyProgress();
    notifyWorkers();
    G.activeWorkers = Math.max(0, (G.activeWorkers || 1) - 1);
    if (G.cookieCleanupEvery > 0 && G.done > 0 && G.done % G.cookieCleanupEvery === 0) {
      requestCookieCleanup(`每處理 ${G.cookieCleanupEvery} 篇後清理 cookie；目前已完成 ${G.done} 篇`);
    }
    await waitForCookieCleanup(workerIdx);

    const toDownload = (G.done % 5 === 0);
    triggerExcelWrite({ toDownload });

    if (G.stopAfter > 0 && G.dispatched >= G.stopAfter && G.queue.length > 0) {
      G.queue = [];
      addLog(`已派發 ${G.dispatched} 篇，達到本次上限 ${G.stopAfter} 篇，停止派發新任務。`, "warn");
    }

    if (G.politeMode && G.done > 0 && G.done % 25 === 0) {
      const restMs = 60000 + Math.random() * 60000;
      addLog(`  保守模式：已完成 ${G.done} 篇，休息 ${Math.round(restMs / 1000)} 秒`, "info");
      await sleep(restMs);
    }

    await sleep(getInterItemDelayMs());
  }

  chrome.tabs.remove(tabId).catch(() => {});
  G.workers[workerIdx] = { tabId: null, pmid: null, label: "已完成", status: "idle" };
  notifyWorkers();
}

function schedulePendingWorkers() {
 
}

function decideFailureStatus(item, result, reason) {
  const finalFailure = result?.finalFailure === true || result?.retryable === false;
  const wasRetry = String(item?.status || "").trim() === STATUS_RETRY;
  const baseReason = reason || "缺少詳細失敗原因。";

  if (!finalFailure && !wasRetry) {
    return {
      excelStatus: STATUS_RETRY,
      workerStatus: STATUS_RETRY,
      reason: baseReason,
    };
  }

  return {
    excelStatus: STATUS_FAIL,
    workerStatus: "失敗",
    reason: wasRetry && !baseReason.startsWith("重試後失敗")
      ? `重試後失敗：${baseReason}`
      : baseReason,
  };
}

function finishAll() {
  G.running = false;
  G.tabPool = [];
  addLog("\n全部完成：成功 " + G.ok + "，失敗 " + G.fail + "，未下載 " + G.skip, "ok");

  triggerExcelWrite({ toDownload: true });
  chrome.runtime.sendMessage({ action: "DONE", resultsMap: G.resultsMap }).catch(() => {});
  chrome.notifications.create({
    type:    "basic",
    iconUrl: "icons/icon48.png",
    title:   "PubMed 下載完成",
    message: "成功 " + G.ok + " 篇，失敗 " + G.fail + " 篇，未下載 " + G.skip + " 篇",
  });
}

let bgExcelWriting  = false;
let bgExcelTimer    = null;
let bgPendingDownload = false;

/**
 * triggerExcelWrite
 * toDownload=true  寫入 storage 並觸發 chrome.downloads（第5篇/暫停/停止/完成時）

 */
function triggerExcelWrite({ toDownload = false } = {}) {
  if (toDownload) bgPendingDownload = true;

  if (toDownload) {
    if (bgExcelTimer) { clearTimeout(bgExcelTimer); bgExcelTimer = null; }
    _doExcelWrite();
  } else {
    if (bgExcelTimer) clearTimeout(bgExcelTimer);
    bgExcelTimer = setTimeout(() => {
      bgExcelTimer = null;
      _doExcelWrite();
    }, 500);
  }
}

async function _doExcelWrite() {
  if (bgExcelWriting) {

    setTimeout(() => _doExcelWrite(), 300);
    return;
  }
  bgExcelWriting = true;
  const doDownload = bgPendingDownload;
  bgPendingDownload = false;
  try {
    await _buildAndSaveExcel({ toDownload: doDownload });
  } catch(e) {
    addThreadLog("Background Excel write error", { message: e?.message || String(e), stack: e?.stack || "" });
  } finally {
    bgExcelWriting = false;
  }
}

async function _buildAndSaveExcel({ toDownload = false } = {}) {
  const data = await chrome.storage.local.get(["sourceExcelB64", "excelMeta"]);
  const b64  = data.sourceExcelB64;
  const meta = data.excelMeta || {};
  addThreadLog("_buildAndSaveExcel start", { b64Bytes: b64?.length || 0, hasExcelJS: !!self.ExcelJS, toDownload });
  if (!b64) { addThreadLog("_buildAndSaveExcel skipped: sourceExcelB64 is empty"); return; }

  let binStr, buf;
  try {
    binStr = atob(b64);
    buf = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) buf[i] = binStr.charCodeAt(i);
    addThreadLog("_buildAndSaveExcel base64 decode OK", { bytes: buf.length });
  } catch(e) { addThreadLog("_buildAndSaveExcel base64 decode FAIL", { message: e.message }); return; }

  const ExcelJS = self.ExcelJS;
  if (!ExcelJS) { addThreadLog("_buildAndSaveExcel failed: ExcelJS not found"); return; }

  let workbook, ws;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf.buffer);
    addThreadLog("_buildAndSaveExcel workbook loaded", { sheets: workbook.worksheets.map(s=>s.name) });
    const SHEET_NAME = meta.sheetName || workbook.worksheets[1]?.name;
    ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[1];
    addThreadLog("_buildAndSaveExcel worksheet selected", { worksheet: ws?.name || "NOT FOUND" });
    if (!ws) return;
  } catch(e) { addThreadLog("_buildAndSaveExcel workbook load FAIL", { message: e.message }); return; }

  const headerRow = ws.getRow(1);
  let statusCol = -1, failReasonCol = -1;
  headerRow.eachCell((cell, colNum) => {
    const v = String(cell.value || "").trim();
    if (v === "下載狀況") statusCol = colNum;
    if (v === "失敗原因") failReasonCol = colNum;
  });
  if (statusCol < 0) {
    statusCol = ws.columnCount + 1;
    headerRow.getCell(statusCol).value = "下載狀況";
    headerRow.getCell(statusCol).font = { bold: true };
    addThreadLog("_buildAndSaveExcel: 新增「下載狀況」欄（全新檔案）", { col: statusCol });
  }
  if (failReasonCol < 0) {
    failReasonCol = statusCol + 1;
    while (ws.getRow(1).getCell(failReasonCol).value &&
           String(ws.getRow(1).getCell(failReasonCol).value).trim() !== "失敗原因") {
      failReasonCol++;
    }
    headerRow.getCell(failReasonCol).value = "失敗原因";
    headerRow.getCell(failReasonCol).font = { bold: true };
    addThreadLog("_buildAndSaveExcel: 新增「失敗原因」欄（全新檔案）", { col: failReasonCol });
  }

  const YELLOW  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  const ORANGE  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFA500" } };
  const AMBER   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFCC99" } };
  const NO_FILL = { type: "pattern", pattern: "none" };

  const rMap     = G.resultsMap     || {};
  const failMap  = G.resultsFailMap || {};
  const sessionRows = new Set(Object.keys(rMap).map(Number));

 
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = row.getCell(statusCol);
    const argb = (cell.fill?.fgColor?.argb || "").toUpperCase();
    if (argb === "FFFFFF00") cell.fill = NO_FILL;
  });

 
  for (const [rowIndex, status] of Object.entries(rMap)) {
    const ri  = parseInt(rowIndex, 10);
    const row = ws.getRow(ri);
    const cell = row.getCell(statusCol);
    cell.value = status;
    cell.fill  = status === STATUS_SUCCESS ? YELLOW
               : status === STATUS_FAIL ? ORANGE
               : status === STATUS_RETRY ? AMBER
               : NO_FILL;
    const failCell = row.getCell(failReasonCol);
    if ((status === STATUS_FAIL || status === STATUS_RETRY) && failMap[ri]) {
      failCell.value = failMap[ri];
    } else if (status === STATUS_SUCCESS) {
      failCell.value = null;
    }
  }

 
  let outBuf;
  try {
    outBuf = await workbook.xlsx.writeBuffer();
    addThreadLog("_buildAndSaveExcel writeBuffer OK", { bytes: outBuf.byteLength });
  } catch(e) { addThreadLog("_buildAndSaveExcel writeBuffer FAIL", { message: e.message }); return; }

 
  try {
    const outArr = new Uint8Array(outBuf);
    let outB64 = "";
    const chunkSize = 8192;
    for (let i = 0; i < outArr.length; i += chunkSize) {
      outB64 += String.fromCharCode(...outArr.subarray(i, i + chunkSize));
    }
    outB64 = btoa(outB64);
    await chrome.storage.local.set({ latestExcelB64: outB64 });
    addThreadLog("_buildAndSaveExcel storage saved", { chars: outB64.length });
  } catch(e) { addThreadLog("_buildAndSaveExcel storage save FAIL", { message: e.message }); return; }

  addThreadLog("_buildAndSaveExcel toDownload check", { toDownload });
  if (!toDownload) return;

  const base   = (meta.baseName || "CANCER_PAPERS").replace(/_下載進度管理$/i, "");
  const folder = meta.folder || "PubMed_PDFs";

  const dlArr = new Uint8Array(outBuf);
  let dlB64 = "";
  const dlChunk = 8192;
  for (let i = 0; i < dlArr.length; i += dlChunk) {
    dlB64 += String.fromCharCode(...dlArr.subarray(i, i + dlChunk));
  }
  const dataUrl = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + btoa(dlB64);

  const progressFilename = folder + "/" + base + "_下載進度管理.xlsx";
  addThreadLog("_buildAndSaveExcel triggering download", { filename: progressFilename });
  chrome.downloads.download({
    url: dataUrl,
    filename: progressFilename,
    saveAs:   false,
    conflictAction: "overwrite",
  }, (dlId) => {
    if (chrome.runtime.lastError) {
      addLog("進度 Excel 下載失敗：" + chrome.runtime.lastError.message, "fail");
      addThreadLog("_buildAndSaveExcel download FAIL", { message: chrome.runtime.lastError.message });
    } else {
      addLog("已更新下載進度 Excel", "ok");
      addThreadLog("_buildAndSaveExcel download OK", { downloadId: dlId });
    }
  });
}

async function getPdfUrl(tabId, item, workerIdx) {

  const isLoggedIn = await checkLogin(tabId);
  if (!isLoggedIn) {
    await ensureLogin(tabId);
  }

  let pubmedUrl = null;

  if (item.title) {
    addLog("  Title 搜尋: " + truncate(item.safeTitle, 50), "info");
    const titleResult = await searchByTitle(tabId, item.safeTitle);
    if (titleResult === "__NEED_LOGIN__") {
      addLog("  搜尋時需要重新登入，正在處理...", "warn");
      await ensureLogin(tabId);
      const retry = await searchByTitle(tabId, item.safeTitle);
      pubmedUrl = (retry && retry !== "__NEED_LOGIN__") ? retry : null;
    } else {
      pubmedUrl = titleResult;
    }
  }

  if (!pubmedUrl && item.pmid) {
    addLog("  改用 PMID 搜尋: " + item.pmid, "info");
    pubmedUrl = PUBMED_EZPROXY + "/" + item.pmid + "/";
  }

  if (!pubmedUrl) return "SKIP";

  await navigateTab(tabId, pubmedUrl, 4000);

  if (await isLoginPage(tabId)) {
    addLog("  偵測到登入頁面，重新登入中...", "warn");
    await ensureLogin(tabId);
    await navigateTab(tabId, pubmedUrl, 4000);
  }

  const pageState = await checkPageState(tabId);
  if (pageState === "bot") {
    chrome.runtime.sendMessage({
      action: "BOT_DETECTED", pmid: item.pmid,
      detail: "偵測到機器人/驗證頁面"
    }).catch(() => {});
    return "BOT";
  }

  const ft = await pollForFullTextLink(tabId, 10000);
  if (!ft?.url) return null;
  const ftUrl = ft.url;
  addLog("  找到 Full Text 連結：" + (ft.label || ft.source || "未知來源"), "info");
  addThreadLog("Single Full Text source found", {
    label: ft.label || ft.source || "unknown",
    url: ftUrl
  });

  addThreadLog("Single Full Text option selected", {
    label: ft.label || ft.source || "unknown",
    url: ftUrl
  });

  let pdfUrl = null;
  if (ft.source === "jama" || ftUrl.includes("jamanetwork") || ftUrl.includes("silverchair")) {
    pdfUrl = await getPdfFromJama(tabId, ftUrl);
  } else if (ftUrl.includes("linkinghub-elsevier") || ftUrl.includes("sciencedirect")) {
    pdfUrl = await getPdfFromElsevier(tabId, ftUrl);
  } else if (ftUrl.includes("pmc.ncbi.nlm") || ftUrl.includes("pmc-ncbi-nlm")) {
    pdfUrl = await getPdfFromPmc(tabId, ftUrl);
  } else if (ftUrl.includes("serialssolutions") || ftUrl.includes("SS_UIDType")) {
    pdfUrl = null;
  } else {
    pdfUrl = await getPdfFromGenericPage(tabId, ftUrl);
  }

  return pdfUrl;
}

/**

 */
async function getPdfUrlWithFallback(tabId, item, workerIdx) {
  let localFailureReason = "";
  let localFullTextLinks = [];

  if (await isLoginPage(tabId)) {
    await ensureLogin(tabId);
  }

  let pubmedUrl = null;

  if (item.title) {
    workerLog(workerIdx, "  Title 搜尋: " + truncate(item.safeTitle, 50), "info");
    const titleResult = await searchByTitle(tabId, item.safeTitle);
    if (titleResult === "__NEED_LOGIN__") {
      workerLog(workerIdx, "  Title 搜尋需要重新登入，登入後重試。", "warn");
      await ensureLogin(tabId);
      const retry = await searchByTitle(tabId, item.safeTitle);
      pubmedUrl = (retry && retry !== "__NEED_LOGIN__") ? retry : null;
    } else {
      pubmedUrl = titleResult;
    }
  }

  if (!pubmedUrl && item.pmid) {
    workerLog(workerIdx, "  改用 PMID 搜尋: " + item.pmid, "info");
    pubmedUrl = PUBMED_EZPROXY + "/" + item.pmid + "/";
  }

  if (!pubmedUrl) return { pdfUrl: "SKIP", failureReason: "", fullTextLinks: [] };

  await navigateTab(tabId, pubmedUrl, 4000);

  if (await isLoginPage(tabId)) {
    workerLog(workerIdx, "  PubMed 頁面要求重新登入，登入後重試。", "warn");
    await ensureLogin(tabId);
    await navigateTab(tabId, pubmedUrl, 4000);
  }

  const pageState = await checkPageState(tabId);
  if (pageState === "bot") {
    chrome.runtime.sendMessage({
      action: "BOT_DETECTED", pmid: item.pmid,
      detail: "Bot/captcha/access challenge detected"
    }).catch(() => {});
    return { pdfUrl: "BOT", failureReason: "", fullTextLinks: [] };
  }

  const fullTextLinks = await pollForFullTextLink(tabId, 10000);
  localFullTextLinks = fullTextLinks || [];
  if (!fullTextLinks?.length) {
    localFailureReason = "PubMed 頁面沒有 Full Text 連結。";
    return { pdfUrl: null, failureReason: localFailureReason, fullTextLinks: localFullTextLinks };
  }

  const nonCmuLinks = fullTextLinks.filter(ft => !isCmuLibFullTextLink(ft));
  const cmuLinks = fullTextLinks.filter(isCmuLibFullTextLink);
  if (!nonCmuLinks.length && cmuLinks.length) {
    localFailureReason = "只找到 CMULib / SerialsSolutions Full Text link，無法直接解析 PDF。";
    return { pdfUrl: null, failureReason: localFailureReason, fullTextLinks: localFullTextLinks, retryable: false, finalFailure: true };
  }

  if (fullTextLinks.length === 1 && fullTextLinks[0].source === "serialssolutions") {
    localFailureReason = "Full Text 只有 CMU Library / SerialsSolutions resolver，可能無法直接取得 PDF。";
  }

  workerLog(workerIdx, "  找到 " + fullTextLinks.length + " 個 Full Text 連結，會依序嘗試。", "info");
  const linkAttempts = [];
  const pdfCandidates = [];

  for (let i = 0; i < fullTextLinks.length; i++) {
    const ft = fullTextLinks[i];
    const ftUrl = ft.url;
    const ftLabel = ft.label || ft.source || "未知來源";
    workerLog(workerIdx, "  嘗試 Full Text 連結 " + (i + 1) + "/" + fullTextLinks.length + "：" + ftLabel, "info");
    addThreadLog("Trying Full Text link", {
      workerIdx,
      index: i + 1,
      total: fullTextLinks.length,
      label: ftLabel,
      url: ftUrl
    });

    const lockKey = await acquireDomainLock(workerIdx, ftUrl, ftLabel);
    let pdfUrl = null;
    let linkError = "";
    try {
      pdfUrl = await getPdfFromFullTextOption(tabId, ft);
    } catch(e) {
      linkError = e?.message || String(e);
      addThreadLog("Full Text link threw error", {
        workerIdx,
        label: ftLabel,
        url: ftUrl,
        error: linkError
      });
    } finally {
      releaseDomainLock(lockKey, workerIdx);
    }
    if (pdfUrl) {
      workerLog(workerIdx, "  已從 " + ftLabel + " 找到 PDF。", "ok");
      pdfCandidates.push({
        pdfUrl,
        label: ftLabel,
        sourceUrl: ftUrl,
        fullTextIndex: i + 1
      });
      addThreadLog("PDF found from Full Text link", {
        workerIdx,
        label: ftLabel,
        pdfUrl
      });
      continue;
    }

    const reason = isCmuLibFullTextLink(ft)
      ? "CMULib / SerialsSolutions resolver 無法直接解析 PDF。"
      : linkError
        ? "查詢此 Full Text link 時發生錯誤：" + linkError
        : (await getCurrentPageFailureReason(tabId)) || "進入 Full Text link 後未找到 PDF 下載連結。";
    linkAttempts.push(ftLabel + ": " + reason);
    workerLog(workerIdx, "  這個 Full Text 連結沒有取得 PDF，改試下一個。", "warn");
    addThreadLog("No PDF from Full Text link", {
      workerIdx,
      label: ftLabel,
      url: ftUrl,
      reason
    });
  }

  if (pdfCandidates.length) {
    return {
      pdfUrl: pdfCandidates[0].pdfUrl,
      pdfCandidates,
      failureReason: "",
      fullTextLinks: localFullTextLinks,
      linkAttempts,
    };
  }

  if (!localFailureReason) {
    const tried = linkAttempts.length ? linkAttempts.join(" | ") : fullTextLinks.map(x => x.label || x.source || x.url).join(" | ");
    localFailureReason = cmuLinks.length
      ? "已嘗試非 CMULib 與 CMULib Full Text link，但都沒有取得 PDF：" + tried
      : "已嘗試所有 Full Text link，但都沒有取得 PDF：" + tried;
  }
  return { pdfUrl: null, failureReason: localFailureReason, fullTextLinks: localFullTextLinks, linkAttempts };
}

function isCmuLibFullTextLink(ft) {
  const url = String(ft?.url || "").toLowerCase();
  const label = ((ft?.label || "") + " " + (ft?.source || "")).toLowerCase();
  return ft?.source === "serialssolutions" ||
         url.includes("serialssolutions") ||
         url.includes("ss_uidtype") ||
         label.includes("cmulib") ||
         label.includes("china medical university library");
}

function getPublisherLockKey(urlOrHost = "", label = "") {
  try {
    const u = new URL(urlOrHost);
    let host = u.hostname.toLowerCase();
    const hint = ((label || "") + " " + host).toLowerCase();
    host = host.replace(/\.autorpa\.cmu\.edu\.tw$/i, "");
    host = host.replace(/:\d+$/i, "");

    const rules = [
      ["pmc", ["pmc-ncbi-nlm-nih-gov", "pmc.ncbi.nlm.nih.gov"]],
      ["pubmed", ["pubmed-ncbi-nlm-nih-gov", "pubmed.ncbi.nlm.nih.gov"]],
      ["doi", ["doi-org", "dx-doi-org", "doi.org", "dx.doi.org"]],
      ["cmulib", ["serialssolutions", "search-serialssolutions"]],
      ["wiley", ["wiley", "onlinelibrary-wiley-com", "hindawi", "downloads-hindawi-com"]],
      ["springer", ["springer", "link-springer-com"]],
      ["elsevier", ["elsevier", "sciencedirect", "linkinghub-elsevier-com", "www-sciencedirect-com"]],
      ["sage", ["sagepub", "journals-sagepub-com"]],
      ["oup", ["academic-oup-com", "oup.com"]],
      ["karger", ["karger-com"]],
      ["worldscientific", ["worldscientific", "www-worldscientific-com"]],
      ["rsc", ["pubs-rsc-org"]],
      ["lww", ["lww.com", "journals-lww-com"]]
    ];
    for (const [key, needles] of rules) {
      if (needles.some(n => host.includes(n) || hint.includes(n))) return key;
    }
    return host || "unknown";
  } catch {
    return String(label || urlOrHost || "unknown").toLowerCase() || "unknown";
  }
}

async function acquireDomainLock(workerIdx, url, label = "") {
  const key = getPublisherLockKey(url, label);
  if (!G.domainLocks) G.domainLocks = {};
  let loggedWait = false;
  while (!G.stopped && G.domainLocks[key] !== undefined && G.domainLocks[key] !== workerIdx) {
    if (!loggedWait) {
      workerLog(workerIdx, "  等待同平台下載鎖：" + key + "（" + (label || "Full Text") + "）", "info");
      addThreadLog("Domain lock waiting", {
        workerIdx,
        key,
        owner: G.domainLocks[key],
        label,
        url
      });
      loggedWait = true;
    }
    await sleep(800);
  }
  if (G.stopped) return null;
  G.domainLocks[key] = workerIdx;
  addThreadLog("Domain lock acquired", { workerIdx, key, label, url });
  return key;
}

function releaseDomainLock(key, workerIdx) {
  if (!key || !G.domainLocks) return;
  if (G.domainLocks[key] === workerIdx) {
    delete G.domainLocks[key];
    addThreadLog("Domain lock released", { workerIdx, key });
  }
}

async function getCurrentPageFailureReason(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = [
          document.title || "",
          document.body?.innerText || "",
          document.documentElement?.innerText || ""
        ].join("\n").replace(/\s+/g, " ").trim();
        const lower = text.toLowerCase();
        if (lower.includes("service unavailable") || lower.includes("http error 503") || lower.includes("http status 503")) {
          return "Publisher 回傳 Service Unavailable / HTTP 503，可能是暫時性阻擋或流量限制。";
        }
        if (lower.includes("403") || lower.includes("forbidden") || lower.includes("access denied")) {
          return "Publisher 回傳 403 Forbidden / Access denied。";
        }
        if (lower.includes("404") || lower.includes("not found")) {
          return "Publisher 回傳 404 Not Found。";
        }
        if (lower.includes("request header is too large")) {
          return "頁面回傳 Request header is too large。";
        }
        if (lower.includes("too many requests") || lower.includes("429")) {
          return "Publisher 回傳 Too Many Requests / HTTP 429。";
        }
        return "";
      }
    });
    return r?.[0]?.result || "";
  } catch {
    return "";
  }
}

async function getPdfFromFullTextOption(tabId, ft) {
  const ftUrl = ft.url;
  if (ft.source === "jama" || ftUrl.includes("jamanetwork") || ftUrl.includes("silverchair")) {
    return await getPdfFromJama(tabId, ftUrl);
  }
  if (ftUrl.includes("linkinghub-elsevier") || ftUrl.includes("sciencedirect")) {
    return await getPdfFromElsevier(tabId, ftUrl);
  }
  if (ftUrl.includes("pmc.ncbi.nlm") || ftUrl.includes("pmc-ncbi-nlm")) {
    return await getPdfFromPmc(tabId, ftUrl);
  }
  if (ftUrl.includes("serialssolutions") || ftUrl.includes("SS_UIDType")) {
    return null;
  }
  if (ft.source === "scielo" || ftUrl.includes("scielo.br") || ftUrl.includes("scielo-br")) {
    return await getPdfFromSciELORobust(tabId, ftUrl);
  }
  if (ftUrl.includes("onlinelibrary-wiley-com") || ftUrl.includes("onlinelibrary.wiley.com")) {
    return await getPdfFromWiley(tabId, ftUrl);
  }
  return await getPdfFromGenericPage(tabId, ftUrl);
}

async function getPdfFromSciELORobust(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId);
    const currentUrl = tab.url || url;
    const base = currentUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || "";

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

async function getPdfFromSciELO(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab.url || url;
  const base = currentUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || "";

  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {

        const meta = document.querySelector("meta[name='citation_pdf_url']")?.content;
        if (meta) return { type: "meta", url: meta };

        for (const a of document.querySelectorAll("a[href*='format=pdf']")) {
          if (a.href) return { type: "link", url: a.getAttribute("href") };
        }

        for (const a of document.querySelectorAll("a[href*='format=pdf'], a[href$='.pdf']")) {
          if (a.href) return { type: "link", url: a.getAttribute("href") };
        }

        return null;
      }
    });

    const result = r?.[0]?.result;
    if (!result) return null;

    let pdfUrl = result.url;
    // ?詨?頝臬?鋆?
    if (pdfUrl.startsWith("/")) pdfUrl = base + pdfUrl;

    if (pdfUrl.includes("scielo.br/") && base.includes("autorpa.cmu.edu.tw")) {
      pdfUrl = pdfUrl.replace("https://www.scielo.br", base);
    }

    return pdfUrl || null;
  } catch { return null; }
}

async function checkLogin(tabId) {
  try {
    await navigateTab(tabId, PUBMED_EZPROXY + "/?otool=itwcmulib", 4000);
    const t   = await chrome.tabs.get(tabId);
    const url = t.url || "";

    if (url.includes("/user/login")) return false;
    if (url.includes("/proxy/login")) return false;
    if (url.match(/autorpa\.cmu\.edu\.tw\/login\//)) return false;

    // URL 敹???pubmed-ncbi-nlm-nih-gov.autorpa.cmu.edu.tw:8443 ?
    if (url.startsWith("https://pubmed-ncbi-nlm-nih-gov." + EZPROXY_BASE)) return true;
    if (url.startsWith("https://pubmed.ncbi.nlm.nih.gov")) return true;

    addLog("  checkLogin 尚未確認登入：" + url.substring(0, 80), "warn");
    return false;
  } catch { return false; }
}

/**

 */
async function ensureLogin(tabId) {
  if (G.loginDone && !(await isLoginPage(tabId))) return;
  if (G.loginDone) resetLoginState();

  if (G.loginLock) {
    addLog("  等待其他 Worker 完成登入...", "info");
    await new Promise(resolve => G.loginWaiters.push(resolve));
    return;
  }

  G.loginLock = true;
  addLog("需要登入，暫停其他 Worker。", "warn");

  try {
    await requestLogin(tabId);
    const t   = await chrome.tabs.get(tabId).catch(() => null);
    const url = t?.url || "";
    const loginSuccess = !url.includes("/user/login") && !url.includes("/proxy/login");

    if (loginSuccess) {
      G.loginDone = true;
      addLog("登入完成，其他 Worker 繼續。", "ok");
    } else {
      G.loginDone  = false;
      G.stopped    = true;
      addLog("登入失敗，已停止下載。", "fail");
      chrome.runtime.sendMessage({ action: "LOGIN_FAILED_STOP" }).catch(() => {});
    }
  } finally {
    G.loginLock = false;
    G.loginWaiters.splice(0).forEach(resolve => resolve());
  }
}

function resetLoginState() {
  G.loginDone = false;
  G.waitingLogin = false;
  G.loginResolve = null;
  G.waitingCaptcha = false;
  G.captchaResolve = null;
  G.captchaImg = null;
}

/** ?菜葫?嗅????臬?箇?仿? */
async function isLoginPage(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const url = t.url || "";

    const isLogin = url.includes("/user/login")
                 || url.includes("/proxy/login")
                 || !!url.match(/autorpa\.cmu\.edu\.tw\/login\//);

    if (isLogin) {
      if (G.loginDone) resetLoginState();
      return true;
    }

    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!document.getElementById("id_username") && !!document.getElementById("id_captcha_value")
    });
    const result = r?.[0]?.result === true;
    if (result && G.loginDone) resetLoginState();
    return result;
  } catch { return false; }
}

async function requestLogin(tabId) {
  addLog("需要登入 CMU EZproxy，請填入帳號...", "warn");
  G.waitingLogin = true;

  let captchaBase64 = null;
  try {
 
    let imgSrc = null;
    for (let i = 0; i < 10; i++) {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const img = document.getElementById("captcha_img");
          // img.src 有時是 blob URL，需用 fetch 轉換
          return (img && img.naturalWidth > 0) ? img.src : null;
        }
      });
      imgSrc = r?.[0]?.result;
      if (imgSrc) break;
      await sleep(500);
    }

    if (imgSrc) {
      captchaBase64 = await fetchImgBase64(imgSrc);
      if (captchaBase64) addLog("  已擷取登入驗證碼圖片。", "info");
    }
  } catch(e) {
    addLog("  驗證碼擷取失敗：" + e.message, "warn");
  }

  chrome.runtime.sendMessage({
    action:     "NEED_LOGIN",
    captchaImg: captchaBase64,
  }).catch(() => {});

 
  const creds = await new Promise(resolve => { G.loginResolve = resolve; });
  if (!creds || G.stopped) { G.waitingLogin = false; return; }

  addLog("  已收到帳號，正在填入表單並送出...", "info");

 
  try {
    const submitResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: (u, p, cap) => {
        const setValue = (el, value) => {
          if (!el) return false;
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };

        const form = document.querySelector("form[name='form1']")
                  || document.querySelector("form[action*='/proxy/login/']")
                  || document.querySelector("form");
        const un = document.getElementById("id_username") || form?.querySelector("[name='username']");
        const pw = document.getElementById("id_password") || form?.querySelector("[name='password']");
        const cv = document.getElementById("id_captcha_value") || form?.querySelector("[name='captcha_value']");

        setValue(un, u);
        setValue(pw, p);
        setValue(cv, cap);

        if (!form || !un?.value || !pw?.value || (cv && !cv.value)) {
          return { ok: false, reason: "missing_or_empty_fields" };
        }

        if (form.requestSubmit) {
          form.requestSubmit();
        } else {
          const btn = form.querySelector("button[type='submit'], input[type='submit']");
          if (btn) btn.click();
          else form.submit();
        }

        return { ok: true, action: form.getAttribute("action") || "" };
      },
      args: [creds.username, creds.password, creds.captcha || ""]
    });
    const res = submitResult?.[0]?.result;
    if (!res?.ok) addLog("  登入表單送出失敗：" + (res?.reason || "unknown"), "warn");
    else addLog("  已送出登入表單：" + (res.action || "(current form)"), "info");
  } catch(e) {
    addLog("  自動填入登入資料失敗：" + e.message, "warn");
  }

  await sleep(3000);

  const finalTab = await chrome.tabs.get(tabId).catch(() => null);
  const finalUrl = finalTab?.url || "";
  if (finalUrl.includes("/user/login") || finalUrl.includes("/proxy/login")) {
    addLog("  登入後仍在登入頁面，驗證碼可能錯誤", "warn");
  } else {
    addLog("  登入成功", "ok");
  }

  G.waitingLogin = false;
  chrome.runtime.sendMessage({ action: "LOGIN_OK" }).catch(() => {});
}

async function detectCaptcha(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const img   = document.getElementById("captcha_img");
        const input = document.getElementById("id_captcha_value");
        if (!img || !input) return { has: false };
        return { has: true, src: img.src };
      }
    });
    const res = r?.[0]?.result;
    if (!res?.has) return false;

    const imgBase64 = await fetchImgBase64(res.src);
    G.captchaImg = imgBase64;
    return true;
  } catch { return false; }
}

async function handleCaptcha(tabId) {
  G.waitingCaptcha = true;
  addLog("偵測到驗證碼頁面，等待輸入...", "warn");
  chrome.runtime.sendMessage({ action: "SHOW_CAPTCHA", imgBase64: G.captchaImg }).catch(() => {});

  const answer = await new Promise(resolve => { G.captchaResolve = resolve; });
  if (!answer || G.stopped) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (ans) => {
      const input = document.getElementById("id_captcha_value");
      if (input) {
        input.value = ans;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.querySelector("button[type='submit']")?.click();
    },
    args: [answer]
  });

  G.waitingCaptcha = false;
  chrome.runtime.sendMessage({ action: "CAPTCHA_OK" }).catch(() => {});
  await sleep(2000);
}

async function fetchImgBase64(url) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await new Promise(resolve => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  } catch { return null; }
}

async function searchByTitle(tabId, safeTitle) {
  const query     = encodeURIComponent(safeTitle.substring(0, 100));
  const searchUrl = PUBMED_EZPROXY + "/?term=" + query + "&otool=itwcmulib";

  await navigateTab(tabId, searchUrl, 4000);

  if (await isLoginPage(tabId)) return "__NEED_LOGIN__";

  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const url = window.location.href;
        if (document.querySelector(".search-results-chunk") || document.querySelector("article.full-docsum")) {
          const first = document.querySelector("a.docsum-title");
          return first ? first.href : null;
        }
        if (document.querySelector("h1.heading-title") || url.match(/\/\d{6,}\/$/)) {
          return url;
        }
        if (document.querySelector(".search-results-empty") || document.title.includes("No results")) {
          return null;
        }
        return null;
      }
    });
    return r?.[0]?.result || null;
  } catch { return null; }
}

async function checkPageState(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const url = t.url || "";
    if (url.includes("/user/login")) return "login";

    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const body = document.body?.innerText?.toLowerCase() || "";
        if (body.includes("robot") || body.includes("captcha") ||
            body.includes("unusual traffic") || body.includes("access denied") ||
            body.includes("too many requests") || document.title.includes("403") ||
            document.title.includes("429")) {
          return "bot";
        }
        return "ok";
      }
    });
    return r?.[0]?.result || "ok";
  } catch { return "ok"; }
}

async function pollForFullTextLink(tabId, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(500);
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
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

          const candidates = [
            pick("jama", "JAMA / Silverchair", [
              "a.link-item[href*='jamanetwork-com']",
              "a.link-item[href*='jamanetwork.com']",
              "a.link-item[href*='silverchair']"
            ]),
            pick("elsevier", "Elsevier / ScienceDirect", [
              "a.link-item[href*='linkinghub-elsevier-com']",
              "a.link-item[href*='sciencedirect-com']"
            ]),
            pick("pmc", "PMC", [
              "a.link-item[href*='pmc.ncbi.nlm.nih.gov']",
              "a.link-item[href*='pmc-ncbi-nlm-nih-gov']"
            ]),
            pick("scielo", "SciELO", [
              "a.link-item[href*='scielo.br']",
              "a.link-item[href*='scielo-br']",
              "a.link-item[title*='Scientific Electronic Library Online']",
              "a.link-item[data-ga-action*='Scientific Electronic Library Online']"
            ]),
            pick("generic", "First full text link", [
              "div.full-text-links-list a.link-item:not([href*='serialssolutions']):not([href*='SS_UIDType=pmid'])"
            ]),
            pick("serialssolutions", "CMU Library / SerialsSolutions", [
              "a.link-item[href*='serialssolutions']",
              "a.link-item[href*='SS_UIDType=pmid']"
            ])
          ].filter(Boolean);

          const seen = new Set();
          return candidates.filter(item => {
            if (!item?.url || seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
          });
        }
      });
      if (r?.[0]?.result?.length) return r[0].result;
    } catch(e) {}
  }
  return [];
}

async function getPdfFromJama(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const tab = await chrome.tabs.get(tabId);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          for (const s of [
            "a[href*='fullarticlepdf']",
            "a[href*='/articlepdf/']",
            "a[href*='downloadpdf']",
            "a[href*='.pdf']",
            "a[aria-label*='PDF']",
            "a[title*='PDF']",
            "a[class*='pdf']"
          ]) {
            const el = document.querySelector(s);
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

async function getPdfFromElsevier(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const tab = await chrome.tabs.get(tabId);
  const deadline = Date.now() + 8000;
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

async function getPdfFromPmc(tabId, url) {
  const finalUrl = await navigateAndWaitStable(tabId, url, 2000, 12000);
  const base = finalUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const metaPdf = document.querySelector("meta[name='citation_pdf_url']")?.content;
          if (metaPdf) return metaPdf;
          for (const s of [
            "a[aria-label*='Download PDF']",
            "a[data-ga-label*='pdf_download']",
            "a[href^='pdf/'][href*='.pdf']",
            "a[href*='/pdf/'][href*='.pdf']",
            "a.int-view[href*='.pdf']",
            "a.pdf-link", "li.pdf a"
          ]) {
            const el = document.querySelector(s);
            if (el?.href) return el.href;
          }
          return null;
        }
      });
      const href = r?.[0]?.result;
      if (href) {
        if (/^https?:\/\//i.test(href)) return href;
        return base + (href.startsWith("/") ? href : "/" + href);
      }
    } catch { return null; }
    await sleep(500);
  }
  return null;
}

async function getPdfFromWiley(tabId, url) {
  const finalUrl = await navigateAndWaitStable(tabId, url, 3500, 22000);

  // Proxy redirect loop？cookie 清理後重試，不繼續刮 16 秒
  const recoveredFromLoop = await recoverPdfFromRedirectLoop(tabId);
  if (recoveredFromLoop) return recoveredFromLoop;
  if (G.cookieCleanupRequested) return null;

  const deadline = Date.now() + 16000;
  const candidates = buildPdfCandidatesFromUrl(finalUrl);
  const addCandidate = (href, baseUrl = finalUrl) => {
    if (!href) return;
    try {
      const absolute = new URL(href, baseUrl).href;
      for (const candidate of buildPdfCandidatesFromUrl(absolute)) {
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
      if (!candidates.includes(absolute)) candidates.push(absolute);
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

async function getPdfViaSerialsSolutions(tabId, url) {
  await navigateTab(tabId, url, 4000);
  const tab  = await chrome.tabs.get(tabId);
  const dest = tab.url || "";
  if (dest.includes("elsevier") || dest.includes("sciencedirect")) return await getPdfFromElsevier(tabId, dest);
  if (dest.includes("pmc.ncbi") || dest.includes("pmc-ncbi"))      return await getPdfFromPmc(tabId, dest);
  return await getPdfFromGenericPage(tabId, dest);
}

function isCmuProxyUrl(url) {
  try {
    return new URL(url).hostname.endsWith(".autorpa.cmu.edu.tw");
  } catch {
    return false;
  }
}

function isCmuProxyCookieDomain(domain) {
  const host = String(domain || "").replace(/^\./, "").toLowerCase();
  // 只保護真正的 CMU/EZproxy 登入域，不保護出版商 proxy 子域
  // 出版商 proxy 子域格式：onlinelibrary-wiley-com.autorpa.cmu.edu.tw（含 .autorpa.）
  if (host.endsWith(".autorpa.cmu.edu.tw")) return false;
  return host === "autorpa.cmu.edu.tw" || host === "cmu.edu.tw" || host.endsWith(".cmu.edu.tw");
}

function isTrackingCookieName(name) {
  const n = String(name || "").toLowerCase();
  return n.startsWith("_ga") ||
         n.startsWith("_gid") ||
         n.startsWith("_gcl") ||
         n.startsWith("_fbp") ||
         n.startsWith("_uet") ||
         n.startsWith("amp_") ||
         n.startsWith("amcv") ||
         n.startsWith("__utm") ||
         n.startsWith("__qca") ||
         n.startsWith("_mkto") ||
         n.startsWith("mbox") ||
         n.startsWith("panorama") ||
         n.startsWith("_rollupga") ||
         n === "_cc_id";
}

function isLikelyCmuSessionCookie(name) {
  const n = String(name || "").toLowerCase();
  return n === "sid" || n === "lid" || n === "fcsid";
}

function shouldRemoveCookie(cookie) {
  if (!isCmuProxyCookieDomain(cookie.domain)) return true;
  if (isLikelyCmuSessionCookie(cookie.name)) return false;
  return isTrackingCookieName(cookie.name);
}

function getCookieRemovalUrl(cookie) {
  const host = String(cookie.domain || "").replace(/^\./, "");
  const path = String(cookie.path || "/").startsWith("/") ? cookie.path : "/" + (cookie.path || "");
  return (cookie.secure ? "https" : "http") + "://" + host + path;
}

async function clearNonCmuProxyCookies(workerIdx = -1) {
  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) return;

  try {
    const cookies = await new Promise(resolve => {
      chrome.cookies.getAll({}, items => resolve(items || []));
    });
    const removable = cookies.filter(shouldRemoveCookie);
    if (!removable.length) return;

    let removed = 0;
    await Promise.all(removable.map(cookie => new Promise(resolve => {
      chrome.cookies.remove({
        url: getCookieRemovalUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId,
      }, () => {
        if (!chrome.runtime.lastError) removed++;
        resolve();
      });
    })));

    if (removed > 0) {
      workerLog(workerIdx, "  已清除 " + removed + " 個非必要 cookie，保留 CMU EZproxy 登入狀態。", "info");
    } else {
      addThreadLog("Cookie cleanup completed; nothing removed.", { workerIdx });
    }
  } catch(e) {
    workerLog(workerIdx, "  cookie 清理略過：" + e.message, "warn");
    addThreadLog("Cookie cleanup skipped", { workerIdx, message: e.message });
  }
}

function cookieCleanupReasonLabel(reason) {
  if (reason === "header-too-large") return "Request header 過大";
  return reason || "排程清理";
}

function cookieCleanupShouldRestartItem(reason) {
  return reason === "header-too-large" ||
         String(reason || "").includes("proxy 連線錯誤") ||
         String(reason || "").includes("proxy 連線錯誤");
}

async function waitForCookieCleanup(workerIdx = -1) {
  while (G.cookieCleanupRequested && !G.stopped) {
    if (!G.cookieCleanupInProgress && (G.activeWorkers || 0) === 0) {
      G.cookieCleanupInProgress = true;
      try {
        workerLog(workerIdx, "  到達 cookie 清理點：" + cookieCleanupReasonLabel(G.cookieCleanupReason) + "，等待所有 worker 暫停。", "info");
        addThreadLog("Cookie cleanup point reached; all workers pending.", {
          workerIdx,
          reason: G.cookieCleanupReason || "scheduled",
          activeWorkers: G.activeWorkers,
          done: G.done,
          epoch: G.cookieCleanupEpoch
        });
        await clearNonCmuProxyCookies(workerIdx);
      } finally {
        G.cookieCleanupEpoch = (G.cookieCleanupEpoch || 0) + 1;
        workerLog(workerIdx, "  cookie 清理完成，worker 繼續。批次 " + G.cookieCleanupEpoch, "ok");
        addThreadLog("Cookie cleanup finished; workers may continue.", {
          workerIdx,
          epoch: G.cookieCleanupEpoch
        });
        G.cookieCleanupRequested = false;
        G.cookieCleanupInProgress = false;
        G.cookieCleanupReason = "";
      }
      return;
    }
    await sleep(500);
  }
}

function requestCookieCleanup(reason = "scheduled") {
  const shouldRestart = cookieCleanupShouldRestartItem(reason);
  if (!G.cookieCleanupRequested) {
    G.cookieCleanupRequested = true;
    G.cookieCleanupReason = reason;
    if (shouldRestart) {
      G.cookieCleanupRestartEpoch = (G.cookieCleanupEpoch || 0) + 1;
    }
    addLog("已排程 cookie 清理：" + cookieCleanupReasonLabel(reason), "warn");
    addThreadLog("Cookie cleanup requested", {
      reason,
      epoch: G.cookieCleanupEpoch,
      restartEpoch: G.cookieCleanupRestartEpoch,
      activeWorkers: G.activeWorkers
    });
  } else if (shouldRestart) {
    G.cookieCleanupReason = reason;
    G.cookieCleanupRestartEpoch = Math.max(G.cookieCleanupRestartEpoch || 0, (G.cookieCleanupEpoch || 0) + 1);
    addThreadLog("Cookie cleanup already pending; restart epoch updated.", {
      reason,
      epoch: G.cookieCleanupEpoch,
      restartEpoch: G.cookieCleanupRestartEpoch,
      activeWorkers: G.activeWorkers
    });
  }
}

async function requestCookieCleanupIfHeaderTooLarge(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = [
          document.title || "",
          document.body?.innerText || "",
          document.documentElement?.innerText || ""
        ].join("\n").toLowerCase();
        return (
          text.includes("request header is too large") ||
          (text.includes("http status 400") && text.includes("bad request")) ||
          (text.includes("bad request") && text.includes("header") && text.includes("large"))
        );
      }
    });
    if (r?.[0]?.result === true) {
      addLog("偵測到 Request header 過大，將清理非必要 cookie 後重試。", "warn");
      addThreadLog("Header too large detected on current tab.", { tabId });
      requestCookieCleanup("header-too-large");
    }
  } catch(e) {
    addThreadLog("Header-too-large detection failed", { tabId, message: e?.message || String(e) });
  }
}

function restoreCmuProxyUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".autorpa.cmu.edu.tw")) return null;

    const encodedHost = u.hostname.replace(/\.autorpa\.cmu\.edu\.tw$/i, "");
    if (!encodedHost || encodedHost === "pubmed-ncbi-nlm-nih-gov") return null;

    const originalHost = encodedHost.replaceAll("-", ".");
    return "https://" + originalHost + u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

function buildPdfCandidatesFromUrl(url) {
  try {
    const u = new URL(url);
    const candidates = [];

    const doiMatch = u.pathname.match(/\/doi\/(?:full\/|abs\/|epdf\/|pdf\/|pdfdirect\/)?(.+)$/i);
    if (doiMatch?.[1]) {
      const doi = doiMatch[1].replace(/[?#].*$/, "");
      if (u.hostname.includes("wiley")) {
        candidates.push("https://" + u.hostname + "/doi/pdfdirect/" + doi + "?download=true");
      }
      candidates.push("https://" + u.hostname + "/doi/pdf/" + doi);
      candidates.push("https://" + u.hostname + "/doi/epdf/" + doi);
    }

    if (/\.pdf(?:$|[?#])/i.test(url) || /\/(?:pdf|epdf|pdfdirect)\//i.test(u.pathname)) {
      candidates.push(url);
    }

    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

async function recoverPdfFromRedirectLoop(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || "";
        const errorCode = document.querySelector(".error-code")?.textContent || "";
        const isRedirectLoop =
          errorCode.includes("ERR_TOO_MANY_REDIRECTS") ||
          text.includes("ERR_TOO_MANY_REDIRECTS") ||
          text.toLowerCase().includes("too many redirects");
        const failedUrl =
          document.querySelector("#reload-button")?.dataset?.url ||
          window.loadTimeDataRaw?.reloadButton?.reloadUrl ||
          window.location.href;
        return { isRedirectLoop, failedUrl };
      }
    });

    const state = r?.[0]?.result;
    if (!state?.isRedirectLoop || !state.failedUrl || !isCmuProxyUrl(state.failedUrl)) return null;

    // Cookie 導致 redirect loop，排程清理並要求重試此項目
    requestCookieCleanup("proxy 連線錯誤，需要清理後重試");

    const restoredUrl = restoreCmuProxyUrl(state.failedUrl);
    const candidates = restoredUrl ? buildPdfCandidatesFromUrl(restoredUrl) : [];
    if (!candidates.length) {
      G.lastPdfFailureReason = "偵測到 proxy redirect loop，但無法從 " + state.failedUrl + " 推出可嘗試的 PDF URL。";
      return null;
    }

    addLog("  偵測到 proxy redirect loop，改試原始出版社 PDF URL。", "warn");
    addThreadLog("Proxy redirect loop detected; trying original publisher PDF.", {
      failedUrl: state.failedUrl,
      candidate: candidates[0]
    });
    G.lastPdfFailureReason = "偵測到 proxy redirect loop，已改試原始 publisher PDF URL。原始錯誤 URL: " + state.failedUrl;
    return candidates[0];
  } catch {
    return null;
  }
}

async function getPdfFromGenericPage(tabId, url) {
  try {
    const u = new URL(url);
    if (/\.pdf(?:$|[?#])/i.test(url) || /\/(?:pdf|epdf)\//i.test(u.pathname)) {
      return url;
    }
  } catch {}

  const finalUrl = await navigateAndWaitStable(tabId, url, 2000, 12000);
  const currentUrl = finalUrl || url;
  const currentCandidates = buildPdfCandidatesFromUrl(currentUrl);
  if (currentCandidates.length) return currentCandidates[0];

  const recoveredPdf = await recoverPdfFromRedirectLoop(tabId);
  if (recoveredPdf) return recoveredPdf;

  const deadline = Date.now() + 10000;
  let navigationErrorHandled = false;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const metaPdf = document.querySelector("meta[name='citation_pdf_url']")?.content
                       || document.querySelector("meta[name='dc.identifier'][content$='.pdf']")?.content;
          if (metaPdf) return metaPdf;

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
            const lowerHref = href.toLowerCase();
            const lowerRawHref = rawHref.toLowerCase();
            const blockedHosts = [
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
                            href.includes("#") && cleanHref === location.href.split(/[?#]/)[0].toLowerCase() ||
                            blockedHosts.some(host => lowerHref.includes(host));
            let score = 0;
            if (cleanHref.endsWith(".pdf")) score += 100;
            if (cleanHref.includes("/pdf/") || cleanHref.includes("pdfft") || cleanHref.includes("downloadpdf")) score += 60;
            if (lowerHref.includes("/download") && lowerHref.includes("attachtype=")) score += 80;
            if (lowerHref.includes("lowqualitypdf") || lowerHref.includes("highqualitypdf") || lowerHref.includes("fulltextpdf")) score += 100;
            if (lowerRawHref.includes(".pdf")) score += 40;

            if (lowerHref.includes("format=pdf") || lowerRawHref.includes("format=pdf")) score += 80;
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

          const best = usableCandidates.find(item => item.score > 0)
                    || usableCandidates.find(item => item.score === 0);
          return best?.href || null;
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

function sanitizeDownloadFolder(folder) {
  const cleaned = String(folder || "PubMed_PDFs")
    .replace(/\\/g, "/")
    .split("/")
    .map(part => part.replace(/[?:*"<>|]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
  return cleaned || "PubMed_PDFs";
}

function getBatchFolderForIndex(idx) {
  const base = sanitizeDownloadFolder(G.downloadFolder || "PubMed_PDFs");
  const size = Math.max(0, parseInt(G.batchSize || 0, 10) || 0);
  if (!size) return base;
  const start = Math.floor(idx / size) * size + 1;
  const end = Math.min(start + size - 1, G.total || start + size - 1);
  return base + "/第" + start + "-" + end + "篇";
}

function createFailureNote(item, status, folder, reason = "", fullTextLinks = [], linkAttempts = []) {
  const pmid = item.pmid || "no-pmid";
  const rawTitle = item.safeTitle || item.title || ("PMID_" + pmid) || "untitled";
  const safeTitle = sanitizeDownloadFolder(rawTitle).replace(/\//g, " ").substring(0, 160) || ("PMID_" + pmid);
  const reasonText = reason || "缺少詳細失敗原因。";

  const links = fullTextLinks || [];
  const linksText = links.length
    ? links.map((ft, i) => "  " + (i + 1) + ". " + (ft.label || ft.source || "unknown") + "\n     " + ft.url).join("\n")
    : "  無；PubMed 頁面沒有可用的 Full Text 連結。";

  const attemptsSection = linkAttempts?.length
    ? ["", "連結嘗試紀錄（共 " + linkAttempts.length + " 筆）：", linkAttempts.map((a, i) => "  " + (i + 1) + ". " + a).join("\n")]
    : ["", "連結嘗試紀錄：無詳細紀錄（可能在取得 Full Text link 前就失敗）。"];
  const triedAllLinks = links.length > 0 && linkAttempts?.length >= links.length
    ? "是"
    : links.length > 0
      ? "不完整，請查看下方嘗試紀錄。"
      : "沒有可嘗試的 Full Text link。";

  const body = [
    "錯誤論文Title: " + (item.title || ""),
    "PMID / id: " + pmid,
    "Excel row: " + (item.rowIndex || ""),
    "下載狀況: " + status,
    "失敗原因: " + reasonText,
    "Time: " + new Date().toISOString(),
    "",
    "找到的 Full Text 連結（共 " + links.length + " 個）:",
    linksText,
    "",
    "是否已嘗試所有 Full Text link: " + triedAllLinks,
    ...attemptsSection
  ].join("\n");
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(body);
  return new Promise(resolve => {
    const filename = sanitizeDownloadFolder(folder) + "/下載失敗檔案/" + safeTitle + ".txt";
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "overwrite",
    }, () => {
      const err = chrome.runtime.lastError?.message || "";
      if (err) {
        addLog("失敗記錄 txt 下載失敗：" + err, "fail");
        addThreadLog("Failure note download failed", { filename, error: err, rowIndex: item.rowIndex, pmid });
        resolve(false);
      } else {
        addThreadLog("Failure note downloaded", { filename, rowIndex: item.rowIndex, pmid });
        resolve(true);
      }
    });
  });
}

function normalizePdfUrlValue(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return normalizePdfUrlValue(value.pdfUrl || value.url || value.href);
  }
  return null;
}

function normalizePdfCandidates(result, fallbackPdfUrl = null) {
  const raw = Array.isArray(result?.pdfCandidates) ? result.pdfCandidates : [];
  const candidates = [];
  const seen = new Set();
  const add = (entry) => {
    const pdfUrl = normalizePdfUrlValue(entry);
    if (!pdfUrl || seen.has(pdfUrl)) return;
    seen.add(pdfUrl);
    candidates.push({
      pdfUrl,
      label: entry?.label || entry?.source || "",
      sourceUrl: entry?.sourceUrl || entry?.url || entry?.href || "",
      fullTextIndex: entry?.fullTextIndex || candidates.length + 1
    });
  };
  raw.forEach(add);
  add({ pdfUrl: fallbackPdfUrl, label: "備用 PDF 來源" });
  return candidates;
}

function triggerDownload(pdfUrl, safeTitle, folder = "PubMed_PDFs") {
  return new Promise(resolve => {
    pdfUrl = normalizePdfUrlValue(pdfUrl);
    if (!pdfUrl) { resolve(false); return; }
    const downloadFolder = sanitizeDownloadFolder(folder);
    chrome.downloads.download({
      url:      pdfUrl,
      filename: downloadFolder + "/" + safeTitle + ".pdf",
      saveAs:   false,
      conflictAction: "overwrite",
    }, downloadId => {
      if (chrome.runtime.lastError || !downloadId) { resolve(false); return; }
      const listener = delta => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete") {
          chrome.downloads.onChanged.removeListener(listener); resolve(true);
        } else if (delta.state?.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener); resolve(false);
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      setTimeout(() => { chrome.downloads.onChanged.removeListener(listener); resolve(false); }, 30000);
    });
  });
}

function navigateTab(tabId, url, extraMs = 2000) {
  return new Promise(async resolve => {
    await chrome.tabs.update(tabId, { url });
    const onComplete = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      finishNavigation(tabId, extraMs).then(resolve);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") onComplete();
    };
    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); finishNavigation(tabId, extraMs).then(resolve); }, 15000);
  });
}

async function navigateAndWaitStable(tabId, url, minStableMs = 2000, maxWaitMs = 15000) {
  await chrome.tabs.update(tabId, { url });
  const start = Date.now();
  let lastUrl = "";
  let lastChangeAt = start;

  while (Date.now() - start < maxWaitMs) {
    await sleep(400);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) break;
    const cur = tab.url || "";
    if (cur && cur !== lastUrl) {
      lastUrl = cur;
      lastChangeAt = Date.now();
    }
    const stableMs = Date.now() - lastChangeAt;
    if (tab.status !== "loading" && stableMs >= minStableMs && lastUrl && lastUrl !== "about:blank") break;
  }

  await autoAcceptCookieBanners(tabId);
  await requestCookieCleanupIfHeaderTooLarge(tabId);
  return lastUrl;
}

async function finishNavigation(tabId, extraMs) {
  await sleep(extraMs);
  await autoAcceptCookieBanners(tabId);
  await requestCookieCleanupIfHeaderTooLarge(tabId);
}

async function autoAcceptCookieBanners(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const positive = [
          "accept all", "accept cookies", "allow all", "agree", "i agree", "got it",
          "continue", "continue to site", "ok", "okay"
        ];
        const negative = ["reject", "decline", "deny", "manage", "settings", "customize", "拒絕"];
        const selectors = [
          "#onetrust-accept-btn-handler",
          "button[id*='accept']",
          "button[class*='accept']",
          "button[aria-label*='Accept']",
          "button[title*='Accept']",
          "a[id*='accept']",
          "a[class*='accept']",
          "[role='button']"
        ];
        const seen = new Set();
        const candidates = [];
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector))) {
            if (!seen.has(el)) { seen.add(el); candidates.push(el); }
          }
        }
        for (const el of candidates) {
          const text = [
            el.textContent || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
            el.id || "",
            el.className || ""
          ].join(" ").trim().toLowerCase();
          if (!text) continue;
          if (negative.some(x => text.includes(x))) continue;
          if (positive.some(x => text.includes(x))) {
            el.click();
            return true;
          }
        }
        return false;
      }
    });
    if (r?.[0]?.result === true) await sleep(800);
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getInterItemDelayMs() {
  if (G.politeMode) return 8000 + Math.random() * 7000;
  return 2000 + Math.random() * 2000;
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.substring(0, len) + "..." : str;
}

chrome.runtime.onSuspend.addListener(() => {
  triggerExcelWrite({ toDownload: true });
});
