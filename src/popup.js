/**
 * popup.js v6
 * UI 控制、Excel 解析、與 background 通訊
 * popup 不會因切換分頁而消失（已改為固定視窗模式）
 */

// ── 欄位對應（0-based index）──
const COL_PMID    = 1;   // B
const COL_TITLE   = 2;   // C
const COL_DOI     = 11;  // L（DOI）
const COL_INCLUDE = 12;  // M
const COL_RESULT  = 17;  // R（原始是否可取得全文）
const COL_LANG    = 18;  // S（語言）
const COL_STATUS  = 21;  // V（下載狀況，本程式寫入）
const SHEET_NAME  = "CANCER papers(all years)";
// 本地資料夾模式檔名序號的固定補零寬度，見 buildAllRowsFromWorkbook() 內的說明。
const LOCAL_SEQ_WIDTH = 4;

// ── DOM ──
const uploadArea       = document.getElementById("uploadArea");
const fileInput        = document.getElementById("fileInput");
const fileInfo         = document.getElementById("fileInfo");
const settingsRow      = document.getElementById("settingsRow");
const folderRow        = document.getElementById("folderRow");
const batchRow         = document.getElementById("batchRow");
const startFromRow     = document.getElementById("startFromRow");
const downloadFolderInput = document.getElementById("downloadFolderInput");
const openDownloadSettingsBtn = document.getElementById("openDownloadSettingsBtn");
const batchSizeInput   = document.getElementById("batchSizeInput");
const politeModeRow    = document.getElementById("politeModeRow");
const politeModeInput  = document.getElementById("politeModeInput");
const startFromInput   = document.getElementById("startFromInput");
const startFromBrowseBtn = document.getElementById("startFromBrowseBtn");
const endAtRow         = document.getElementById("endAtRow");
const endAtInput       = document.getElementById("endAtInput");
const endAtBrowseBtn   = document.getElementById("endAtBrowseBtn");
const stopAfterInput   = document.getElementById("stopAfterInput");
const stopAfterRow     = document.getElementById("stopAfterRow");
// 起始/結束論文選擇器（可搜尋的彈出視窗，見 openPaperPicker()）
const paperPickerOverlay    = document.getElementById("paperPickerOverlay");
const paperPickerTitle      = document.getElementById("paperPickerTitle");
const paperPickerSearch     = document.getElementById("paperPickerSearch");
const paperPickerList       = document.getElementById("paperPickerList");
const paperPickerCancelBtn  = document.getElementById("paperPickerCancelBtn");
// 測試工具（Debug 用，統一收合成一顆小按鈕；點了才會展開，不會自動觸發任何動作）
const testToolsRow        = document.getElementById("testToolsRow");
const testToolsPanel      = document.getElementById("testToolsPanel");
const testToolsToggleBtn  = document.getElementById("testToolsToggleBtn");
const testToolsSummary    = document.getElementById("testToolsSummary");
const testDownloadInput    = document.getElementById("testDownloadInput");
const testDownloadBtn      = document.getElementById("testDownloadBtn");
const testDownloadMatchInfo = document.getElementById("testDownloadMatchInfo");
// 進階設定面板（人機驗證選項＋出版商 API 憑證）的 UI 邏輯在 api_settings.js（AdvancedSettings）
const manualVerifyPauseInput = document.getElementById("manualVerifyPauseInput");
const discordEnabledInput   = document.getElementById("discordEnabledInput");
const discordWebhookInput   = document.getElementById("discordWebhookInput");
const discordWebhookSaveBtn = document.getElementById("discordWebhookSaveBtn");
const discordWebhookStatus  = document.getElementById("discordWebhookStatus");
const verifySection    = document.getElementById("verifySection");
const verifyUrlNote    = document.getElementById("verifyUrlNote");
const verifyQueueNote  = document.getElementById("verifyQueueNote");
const verifyDoneBtn    = document.getElementById("verifyDoneBtn");
const testVerifyBtn    = document.getElementById("testVerifyBtn");
const concurrentSelect = document.getElementById("concurrentSelect");
const statsGrid        = document.getElementById("statsGrid");
const progressSection  = document.getElementById("progressSection");
const progressBar      = document.getElementById("progressBar");
const progressLabel    = document.getElementById("progressLabel");
const workersSection   = document.getElementById("workersSection");
const workerList       = document.getElementById("workerList");
const startBtn         = document.getElementById("startBtn");
const pauseBtn         = document.getElementById("pauseBtn");
const resumeBtn        = document.getElementById("resumeBtn");
const stopBtn          = document.getElementById("stopBtn");
const clearBtn         = document.getElementById("clearBtn");
const downloadExcelBtn = document.getElementById("downloadExcelBtn");
const statusText       = document.getElementById("statusText");
const resultDetailPanel = document.getElementById("resultDetailPanel");
const resultDetailTitle = document.getElementById("resultDetailTitle");
const resultDetailList  = document.getElementById("resultDetailList");
const resultDetailClose = document.getElementById("resultDetailClose");
const loginSection     = document.getElementById("loginSection");
const loginUsername    = document.getElementById("loginUsername");
const loginPassword    = document.getElementById("loginPassword");
const loginSubmitBtn   = document.getElementById("loginSubmitBtn");
const captchaSection   = document.getElementById("captchaSection");
const captchaImg       = document.getElementById("captchaImg");
const captchaInput     = document.getElementById("captchaInput");
const captchaSubmitBtn = document.getElementById("captchaSubmitBtn");
const threadLogToggle  = document.getElementById("threadLogToggle");
const threadLogPanel   = document.getElementById("threadLogPanel");
const threadLogText    = document.getElementById("threadLogText");
const threadLogCopyBtn = document.getElementById("threadLogCopyBtn");
const threadLogClearBtn = document.getElementById("threadLogClearBtn");
const threadLogCloseBtn = document.getElementById("threadLogCloseBtn");
// 本地資料夾模式（見 background.js 的 FILE_MANAGER_HOST 說明）
const localFolderModeInput     = document.getElementById("localFolderModeInput");
const localFolderControls      = document.getElementById("localFolderControls");
const localFolderRootInput     = document.getElementById("localFolderRootInput");
const localFolderNewProjectBtn    = document.getElementById("localFolderNewProjectBtn");
const localFolderResumeProjectBtn = document.getElementById("localFolderResumeProjectBtn");
const localFolderReconcileBtn  = document.getElementById("localFolderReconcileBtn");
const localFolderUpdateListBtn = document.getElementById("localFolderUpdateListBtn");
const updateExcelFileInput     = document.getElementById("updateExcelFileInput");
const localFolderSummary       = document.getElementById("localFolderSummary");
// 本地資料夾核對差異報告 modal
const localDiffOverlay    = document.getElementById("localDiffOverlay");
const diffSummaryLine     = document.getElementById("diffSummaryLine");
const diffMismatchSection = document.getElementById("diffMismatchSection");
const diffMismatchList    = document.getElementById("diffMismatchList");
const diffConflictSection = document.getElementById("diffConflictSection");
const diffConflictList    = document.getElementById("diffConflictList");
const diffAnomalySection  = document.getElementById("diffAnomalySection");
const diffAnomalyList     = document.getElementById("diffAnomalyList");
const diffCancelBtn       = document.getElementById("diffCancelBtn");
const diffApplyBtn        = document.getElementById("diffApplyBtn");
// 本地資料夾模式：四顆按鈕第一次點擊的操作說明提示 modal
const lfTipOverlay        = document.getElementById("lfTipOverlay");
const lfTipTitle          = document.getElementById("lfTipTitle");
const lfTipBody           = document.getElementById("lfTipBody");
const lfTipDontShowAgain  = document.getElementById("lfTipDontShowAgain");
const lfTipContinueBtn    = document.getElementById("lfTipContinueBtn");
const lfTipResetBtn       = document.getElementById("lfTipResetBtn");

// ── 狀態 ──
let workbookData = null;
let targets      = [];    // 解析出的論文清單
let resultsMap   = {};    // rowIndex → 'success'|'fail'|'skip'
let resultsFailMap = {};  // rowIndex → 失敗原因字串
let initialStatusMap = {}; // rowIndex -> status read from the uploaded workbook
const rowAnchorMap = {}; // rowIndex → anchorId（供進度表格跳轉用）
let sessionUpdatedRows = new Set(); // rows actually processed in this run
let allParsedTargets = [];
let isPaused     = false;
let cachedArrayBuffer = null;
let originalFilename = "";
let threadLogs = [];

function getDefaultDownloadFolder() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}自動下載pubmed論文`;
}

if (downloadFolderInput) downloadFolderInput.value = getDefaultDownloadFolder();


const STATUS_PENDING = "未下載";
const STATUS_SUCCESS = "下載成功";
const STATUS_FAIL    = "下載失敗";
const STATUS_SKIP    = "跳過";
const STATUS_RETRY   = "下次重試";

document.querySelector(".stat-box.total .lbl") && (document.querySelector(".stat-box.total .lbl").textContent = "總數");
document.querySelector(".stat-box.ok .lbl") && (document.querySelector(".stat-box.ok .lbl").textContent = "成功");
document.querySelector(".stat-box.fail .lbl") && (document.querySelector(".stat-box.fail .lbl").textContent = "失敗");
document.querySelector(".stat-box.skip .lbl") && (document.querySelector(".stat-box.skip .lbl").textContent = "未下載");

// ══════════════════════════════════
// 初始化：同步 background 狀態
// ══════════════════════════════════
window.addEventListener("load", () => {
  // ── 恢復 Discord 通知設定：跟 background 要「目前實際生效」的設定（不是
  //    直接讀 storage），這樣就算使用者從沒改過 webhook，欄位也會顯示
  //    discord_notifier.js 內建的預設網址，而不是一片空白讓人誤以為沒設定 ──
  chrome.runtime.sendMessage({ action: "GET_DISCORD_CONFIG" }, cfg => {
    if (!cfg) return;
    if (discordEnabledInput) discordEnabledInput.checked = !!cfg.enabled;
    if (discordWebhookInput) discordWebhookInput.value = cfg.webhookUrl || "";
  });

  // ── 從 storage 恢復上次的完成紀錄 & 資料夾名稱 ──
  chrome.storage.local.get(["completedPmids", "completedCount", "downloadFolder"], data => {
    const pmids = data.completedPmids || [];
    if (pmids.length > 0) {
      appendLog(`💾 Storage 紀錄：上次共完成 ${pmids.length} 篇，開始下載時將自動跳過這些 PMID`, "info");
    }
    // 恢復上次的資料夾名稱
    if (data.downloadFolder && downloadFolderInput && data.downloadFolder !== "PubMed_PDFs") {
      downloadFolderInput.value = data.downloadFolder;
    }
  });

  // ── 恢復本地資料夾模式設定；開著的話直接重新接上記住的專案資料夾，
  //    不用使用者重新點一次「選擇專案資料夾」 ──
  chrome.storage.local.get(["localFolderModeEnabled", "localFolderRootPath"], data => {
    // 預設開啟（取代 Chrome 下載 API）：只有使用者明確關過（存成 false）才維持關閉
    const enabled = data.localFolderModeEnabled !== false;
    if (localFolderModeInput) localFolderModeInput.checked = enabled;
    if (localFolderControls) localFolderControls.style.display = enabled ? "flex" : "none";
    if (enabled && data.localFolderRootPath) {
      localFolderRootInput.value = data.localFolderRootPath;
      openLocalProject(data.localFolderRootPath);
    } else if (!enabled) {
      // 傳統模式（本地資料夾模式關閉）：上傳 Excel 是唯一入口，一定要顯示。
      setUploadAreaVisible(true);
    }
    // enabled 但還沒選過專案資料夾：上傳區維持預設隱藏，等使用者按「🆕 建立並選取
    // 全新專案資料夾」選到空資料夾後才由 openLocalProject() 顯示出來。
  });

  chrome.runtime.sendMessage({ action: "GET_STATE" }, res => {
    if (!res?.state) return;
    const s = res.state;
    if (s.logs?.length) {
      logSection.style.display = "block";
      s.logs.forEach(l => appendLog(l.msg, l.type));
    }
    if (s.threadLogs?.length) {
      threadLogs = s.threadLogs.slice();
      renderThreadLog();
    }
    if (s.total > 0) {
      statsGrid.style.display    = "grid";
      progressSection.style.display = "block";
      workersSection.style.display  = "block";
      updateStats(s.total, s.ok, s.fail, s.skip);
      updateProgress(s.done, s.total);
    }
    if (s.running && !s.paused) {
      startBtn.disabled  = true;
      pauseBtn.disabled  = false;
      stopBtn.disabled   = false;
      statusText.textContent = "⚙ 下載中...";
    }
    if (s.paused) {
      pauseBtn.style.display  = "none";
      resumeBtn.style.display = "flex";
      resumeBtn.disabled      = false;
      statusText.textContent  = "⏸ 已暫停";
    }
    if (s.done && s.hasResult) {
      downloadExcelBtn.style.display = "block";
      document.getElementById("progressTableBtn").style.display = "block";
    }
    if (s.waitingLogin) showLoginSection();
    if (s.waitingCaptcha) showCaptchaSection(s.captchaImg);
    if (s.verifyPending) showVerifySection(s.verifyPendingUrl, s.verifyQueueLength || 0);
    if (s.workers) updateWorkers(s.workers);
  });
});

// ══════════════════════════════════
// 接收 background 通知
// ══════════════════════════════════
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "LOG") {
    appendLog(msg.msg, msg.type, msg.workerIdx ?? -1);
  }
  if (msg.action === "THREAD_LOG") {
    appendThreadLog(msg.entry);
  }
  if (msg.action === "LOG_ANCHOR") {
    // 補記 anchor（這條訊息緊接在 LOG 後面到達，el 已存在）
    // 找到剛才加入的最後一行並設 id
    const wrap = getLogWrap(msg.workerIdx);
    if (wrap?.lastChild) {
      wrap.lastChild.id = msg.anchorId;
      workerAnchorMap[msg.anchorId] = { workerIdx: msg.workerIdx, el: wrap.lastChild };
    }
  }
  if (msg.action === "PROGRESS") {
    updateStats(msg.total, msg.ok, msg.fail, msg.skip);
    updateProgress(msg.done, msg.total);
  }
  if (msg.action === "RESULT_UPDATE") {
    resultsMap = msg.resultsMap || resultsMap;
    if (msg.resultsFailMap) Object.assign(resultsFailMap, msg.resultsFailMap);
    if (msg.failureReason && msg.item?.rowIndex) {
      resultsFailMap[msg.item.rowIndex] = msg.failureReason;
    }
    if (msg.item?.rowIndex) {
      sessionUpdatedRows.add(parseInt(msg.item.rowIndex, 10));
      if (msg.anchorId) rowAnchorMap[msg.item.rowIndex] = msg.anchorId;
    }
    renderProgressTable();
    document.getElementById("progressTableBtn").style.display = "block";
    // Excel 寫入現在由 background 負責，popup 不再觸發
  }
  if (msg.action === "WORKERS") {
    updateWorkers(msg.workers, isPaused);
    // 更新 Worker tab 狀態
    if (msg.workers) {
      msg.workers.forEach((w, i) => markWorkerTabStatus(i, w.status));
    }
  }
  if (msg.action === "LOGIN_FAILED_STOP") {
    startBtn.disabled  = false;
    pauseBtn.disabled  = true;
    stopBtn.disabled   = true;
    pauseBtn.style.display  = "inline-block";
    resumeBtn.style.display = "none";
    statusText.textContent  = "❌ 登入失敗，請重試";
    appendLog("❌ 登入失敗已停止。請確認帳號密碼正確，等待冷卻後重新按「開始」。", "fail");
    downloadExcelBtn.style.display = "block";
    document.getElementById("progressTableBtn").style.display = "block";
  }
  if (msg.action === "DONE") {
    resultsMap = msg.resultsMap || {};
    // Excel 寫入由 background 負責
    renderProgressTable();
    startBtn.disabled  = false;
    pauseBtn.disabled  = true;
    resumeBtn.disabled = true;
    stopBtn.disabled   = true;
    pauseBtn.style.display  = "inline-block";
    resumeBtn.style.display = "none";
    downloadExcelBtn.style.display = "block";
    document.getElementById("progressTableBtn").style.display = "block";
    statusText.textContent = "✅ 完成！";
    isPaused = false;
  }
  if (msg.action === "NEED_LOGIN") {
    showLoginSection(msg.captchaImg, msg.retry || false);
  }
  if (msg.action === "NEED_LOGIN_MANUAL") {
    // 新模式：讓使用者直接在瀏覽器頁面操作，popup 只顯示等待提示
    showManualLoginWait();
  }
  if (msg.action === "LOGIN_FAIL") {
    const note = document.getElementById("loginNote");
    if (note) { note.textContent = msg.reason || "登入失敗，請重試"; note.style.color = "#dc2626"; }
    loginSubmitBtn.textContent = "重新登入";
    loginSubmitBtn.disabled = false;
  }
  if (msg.action === "SHOW_CAPTCHA") showCaptchaSection(msg.imgBase64);
  // 整批下載跑完後 background 主動核對本地資料夾，發現有差異時推這個訊息過來
  // （不是回應某個 popup 請求，見 background.js finishAll()）。
  if (msg.action === "SHOW_LOCAL_FOLDER_DIFF") renderLocalFolderDiff(msg.diff);
  if (msg.action === "LOGIN_OK") {
    hideLoginSection();
    hideManualLoginWait();
    statusText.textContent = "✅ 登入成功，下載中...";
  }
  if (msg.action === "CAPTCHA_OK")   hideCaptchaSection();
  if (msg.action === "VERIFY_REQUIRED") {
    showVerifySection(msg.url, msg.queueRemaining || 0);
  }
  if (msg.action === "VERIFY_OK") {
    hideVerifySection();
    statusText.textContent = "⚙ 下載中...";
  }
  if (msg.action === "BOT_DETECTED") {
    appendLog(`⚠ [機器人偵測] ${msg.pmid} — ${msg.detail}`, "bot");
    statusText.textContent = "⚠ 偵測到機器人驗證！";
  }
});

// ══════════════════════════════════
// UI 工具函式
// ══════════════════════════════════
// ══════════════════════════════════
// 多 Tab Log 系統
// ══════════════════════════════════

const logSection    = document.getElementById("logSection");
const logTabBar     = document.getElementById("logTabBar");
const logTabWorkers = document.getElementById("logTabWorkers");
const logTabMore    = document.getElementById("logTabMore");
const logPanels     = document.getElementById("logPanels");

let activeLogTab = -1;         // -1 = 全域，0/1/2... = Worker
let workerLogCount = 0;        // 目前建立的 Worker tab 數
const workerAnchorMap = {};    // { "w0-pmid-123": lineElement }

const WORKER_COLORS = ["#60a5fa","#34d399","#fb923c","#a78bfa","#f472b6","#facc15"];
const MAX_INLINE_WORKERS = 3;  // 超過此數改用下拉

function getLogWrap(workerIdx) {
  const id = workerIdx < 0 ? "logWrap-global" : `logWrap-w${workerIdx}`;
  return document.getElementById(id);
}

function ensureWorkerTab(workerIdx) {
  // 已存在就不重複建立（inline tab 或 dropdown option 任一存在即視為已建）
  if (document.getElementById(`logTab-w${workerIdx}`)) return;
  if (document.getElementById(`logOpt-w${workerIdx}`)) return;
  const color = WORKER_COLORS[workerIdx % WORKER_COLORS.length];
  workerLogCount++;

  // 建 log panel
  const panel = document.createElement("div");
  panel.className = "log-wrap";
  panel.id = `logWrap-w${workerIdx}`;
  logPanels.appendChild(panel);

  if (workerIdx < MAX_INLINE_WORKERS) {
    // 建 inline tab
    const btn = document.createElement("button");
    btn.className = "log-tab running";
    btn.id = `logTab-w${workerIdx}`;
    btn.dataset.tab = workerIdx;
    btn.style.color = color;
    btn.textContent = `W${workerIdx + 1}`;
    btn.addEventListener("click", () => switchLogTab(workerIdx));
    logTabWorkers.appendChild(btn);
  } else {
    // 加進下拉選單
    logTabMore.style.display = "inline-block";
    const opt = document.createElement("option");
    opt.value = workerIdx;
    opt.id = `logOpt-w${workerIdx}`;
    opt.textContent = `Worker ${workerIdx + 1}`;
    logTabMore.appendChild(opt);
  }
}

function switchLogTab(workerIdx) {
  activeLogTab = workerIdx;

  // 更新 tab 按鈕樣式
  document.querySelectorAll(".log-tab").forEach(b => b.classList.remove("active"));
  const tabId = workerIdx < 0 ? "logTab-global" : `logTab-w${workerIdx}`;
  const tabEl = document.getElementById(tabId);
  if (tabEl) tabEl.classList.add("active");

  // 更新 panel 顯示
  document.querySelectorAll(".log-wrap").forEach(p => p.classList.remove("active-log"));
  const panel = getLogWrap(workerIdx);
  if (panel) {
    panel.classList.add("active-log");
    panel.scrollTop = panel.scrollHeight;
  }

  // 下拉選單同步
  if (workerIdx >= MAX_INLINE_WORKERS) {
    logTabMore.value = workerIdx;
  } else {
    logTabMore.value = "";
  }
}

function appendLog(msg, type = "info", workerIdx = -1) {
  logSection.style.display = "block";

  // 確保 Worker tab 存在
  if (workerIdx >= 0) ensureWorkerTab(workerIdx);

  const wrap = getLogWrap(workerIdx);
  if (!wrap) return;

  const p = document.createElement("p");
  p.textContent = msg;
  p.className = type;
  wrap.appendChild(p);

  // 失敗時 tab 標紅
  if ((type === "fail") && workerIdx >= 0) {
    const tabEl = document.getElementById(`logTab-w${workerIdx}`);
    if (tabEl) tabEl.classList.add("has-fail");
  }

  // 若目前在看這個 tab，自動捲到底
  if (activeLogTab === workerIdx) {
    wrap.scrollTop = wrap.scrollHeight;
  }

  // 限制每個 panel 最多 500 行
  while (wrap.children.length > 500) wrap.removeChild(wrap.firstChild);

  return p;
}

function appendLogWithAnchor(msg, type, workerIdx, anchorId) {
  const el = appendLog(msg, type, workerIdx);
  if (anchorId && el) {
    el.id = anchorId;
    workerAnchorMap[anchorId] = { workerIdx, el };
  }
}

// 初始化：全域 tab 點擊
function formatThreadLogEntry(entry) {
  if (!entry) return "";
  const t = entry.time ? new Date(entry.time).toLocaleString("zh-TW") : new Date().toLocaleString("zh-TW");
  let line = `[${t}] ${entry.msg || ""}`;
  if (entry.data !== null && entry.data !== undefined) {
    try {
      line += `\n${JSON.stringify(entry.data, null, 2)}`;
    } catch {
      line += `\n${String(entry.data)}`;
    }
  }
  return line;
}

function renderThreadLog() {
  if (!threadLogText) return;
  threadLogText.value = threadLogs.map(formatThreadLogEntry).filter(Boolean).join("\n\n");
  threadLogText.scrollTop = threadLogText.scrollHeight;
}

function appendThreadLog(entry) {
  if (!entry) return;
  threadLogs.push(entry);
  if (threadLogs.length > 2000) threadLogs.shift();
  renderThreadLog();
}

threadLogToggle?.addEventListener("click", () => {
  if (!threadLogPanel) return;
  const open = !threadLogPanel.classList.contains("open");
  threadLogPanel.classList.toggle("open", open);
  threadLogPanel.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) renderThreadLog();
});

threadLogCloseBtn?.addEventListener("click", () => {
  threadLogPanel?.classList.remove("open");
  threadLogPanel?.setAttribute("aria-hidden", "true");
});

threadLogCopyBtn?.addEventListener("click", async () => {
  renderThreadLog();
  const text = threadLogText?.value || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    threadLogText?.focus();
    threadLogText?.select();
    document.execCommand("copy");
  }
  appendLog("thread log 已複製，可直接貼給我檢查。", "ok");
});

threadLogClearBtn?.addEventListener("click", () => {
  threadLogs = [];
  renderThreadLog();
});

document.getElementById("logTab-global")?.addEventListener("click", () => switchLogTab(-1));

// 下拉選單切換
logTabMore?.addEventListener("change", (e) => {
  const idx = parseInt(e.target.value);
  if (!isNaN(idx)) switchLogTab(idx);
});

// 清除當前 tab 的 log
document.getElementById("logClearBtn")?.addEventListener("click", () => {
  const wrap = getLogWrap(activeLogTab);
  if (wrap) wrap.innerHTML = "";
});

// 從進度表格點擊失敗文章 → 跳到對應 Worker log
function jumpToWorkerLog(anchorId) {
  const info = workerAnchorMap[anchorId];
  if (!info) return;
  switchLogTab(info.workerIdx);
  setTimeout(() => {
    info.el.scrollIntoView({ behavior: "smooth", block: "start" });
    info.el.style.background = "#3a3a00";
    setTimeout(() => { info.el.style.background = ""; }, 2000);
  }, 100);
}

// Worker tab 標記「處理中/已完成」
function markWorkerTabStatus(workerIdx, status) {
  const tabEl = document.getElementById(`logTab-w${workerIdx}`);
  const optEl = document.getElementById(`logOpt-w${workerIdx}`);
  if (tabEl) {
    tabEl.classList.toggle("running", status === "running");
    if (optEl) optEl.textContent = `Worker ${workerIdx + 1}${status === "running" ? " ⚙" : ""}`;
  }
}

function updateStats(total, ok, fail, skip) {
  statsGrid.style.display = "grid";
  document.getElementById("sTotal").textContent = total;
  document.getElementById("sOk").textContent    = ok;
  document.getElementById("sFail").textContent  = fail + skip;
  const pending = Math.max(0, total - ok - fail - skip);
  document.getElementById("sSkip").textContent  = pending;
}

function getStatusForItem(item) {
  return resultsMap[item.rowIndex] || STATUS_PENDING;
}

function showResultDetails(filter) {
  if (!targets.length || !resultDetailPanel) return;
  const labels = { all: "全部論文", success: "下載成功", fail: "下載失敗/跳過", pending: "未下載" };
  const rows = targets.filter(item => {
    const status = getStatusForItem(item);
    if (filter === "success") return status === STATUS_SUCCESS;
    if (filter === "fail") return status === STATUS_FAIL || status === STATUS_SKIP || status === STATUS_RETRY;
    if (filter === "pending") return status === STATUS_PENDING;
    return true;
  });

  resultDetailTitle.textContent = `${labels[filter] || "下載清單"} (${rows.length})`;
  resultDetailList.innerHTML = rows.length
    ? rows.map((item, i) => {
        const status = getStatusForItem(item);
        const pmid = item.pmid ? `PMID:${item.pmid}` : "PMID:-";
        return `<div style="padding:3px 0; border-top:1px solid #f1f5f9;">${i + 1}. [${status}] ${pmid} | ${item.title || item.safeTitle || ""}</div>`;
      }).join("")
    : "<div style='color:#64748b;'>目前沒有資料</div>";
  resultDetailPanel.style.display = "block";
}

function updateProgress(done, total) {
  progressSection.style.display = "block";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width    = pct + "%";
  progressLabel.textContent  = `${done} / ${total}（${pct}%）`;
}

function updateWorkers(workers, isPausingNow = false) {
  workersSection.style.display = "block";
  workerList.innerHTML = "";
  let stillRunning = 0;
  workers.forEach((w, i) => {
    const div = document.createElement("div");
    const isRunning = w.status === "running";
    if (isRunning) stillRunning++;
    let icon, label;
    if (isPaused && isRunning) {
      icon  = "⏳";
      label = `跑完這篇後暫停... ${w.label || ""}`;
      div.className = "worker-item running";
      div.style.borderLeftColor = "#ea580c";
    } else {
      icon  = isRunning ? "⚙" : w.status === "done" ? "✅" : w.status === "fail" ? "❌" : "💤";
      label = w.label || "待機中";
      div.className = `worker-item ${w.status}`;
    }
    div.textContent = `Worker ${i+1}: ${icon} ${label}`;
    workerList.appendChild(div);
  });
  // 暫停中且所有 worker 都停了 → 更新 statusText
  if (isPaused && stillRunning === 0) {
    statusText.textContent = "⏸ 已休息，可按「繼續」";
  }
}

// ── 登入 UI ──
function showLoginSection(captchaImg, isRetry) {
  loginSection.classList.add("show");

  // 顯示驗證碼圖片
  const capImg   = document.getElementById("loginCaptchaImg");
  const capWrap  = document.getElementById("loginCaptchaWrap");
  const capInput = document.getElementById("loginCaptchaInput");
  const note     = document.getElementById("loginNote");

  if (captchaImg && capImg) {
    capImg.src = captchaImg;
    if (capWrap) capWrap.style.display = "block";
  }
  if (isRetry && note) {
    note.textContent = "⚠ 驗證碼或帳密錯誤，請重新輸入";
    note.style.color = "#dc2626";
  } else if (note) {
    note.textContent = "";
  }

  // 重試時（背景送出 retry:true）要把按鈕從「登入中...」恢復成可再次送出
  loginSubmitBtn.textContent = isRetry ? "重新登入" : "登入 CMU 圖書館";
  loginSubmitBtn.disabled    = false;
  loginUsername.focus();
  statusText.textContent = "🔐 需要登入 CMU 圖書館";
}
function hideLoginSection() { loginSection.classList.remove("show"); }

function showManualLoginWait() {
  // 隱藏輸入式登入區，改顯示等待提示
  loginSection.classList.remove("show");
  const wait = document.getElementById("loginWaitSection");
  if (wait) wait.style.display = "block";
  statusText.textContent = "🔐 請在瀏覽器頁面完成登入";
}

function hideManualLoginWait() {
  const wait = document.getElementById("loginWaitSection");
  if (wait) wait.style.display = "none";
}

// ── 驗證碼 UI ──
function showCaptchaSection(imgBase64) {
  captchaSection.classList.add("show");
  if (imgBase64) captchaImg.src = imgBase64;
  captchaInput.value = "";
  captchaInput.focus();
  statusText.textContent = "🔒 請輸入驗證碼";
}
function hideCaptchaSection() { captchaSection.classList.remove("show"); }

// ── 人機驗證等待區 ──
function showVerifySection(url, queueRemaining = 0) {
  if (!verifySection) return;
  verifySection.style.display = "block";
  if (verifyUrlNote) verifyUrlNote.textContent = url || "";
  const titleEl = verifySection.querySelector("div");
  if (titleEl) titleEl.textContent = "🤖 偵測到人機驗證，下載已暫停";
  if (verifyQueueNote) {
    if (queueRemaining > 0) {
      verifyQueueNote.style.display = "block";
      verifyQueueNote.textContent = `⏳ 另有 ${queueRemaining} 筆驗證排隊中，完成這筆後會自動接著顯示`;
    } else {
      verifyQueueNote.style.display = "none";
      verifyQueueNote.textContent = "";
    }
  }
  statusText.textContent = queueRemaining > 0
    ? `🤖 等待人機驗證…（還有 ${queueRemaining} 筆排隊）`
    : "🤖 等待人機驗證…";
}
function hideVerifySection() {
  if (verifySection) verifySection.style.display = "none";
}
verifyDoneBtn?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "VERIFY_DONE" });
  hideVerifySection();
  statusText.textContent = "⚙ 下載中...";
  appendLog("✅ 已回報人機驗證完成，繼續下載。", "ok");
});
// 測試工具收合面板：預設收起，點小按鈕才展開（不觸發任何動作）
if (testToolsToggleBtn && testToolsPanel) {
  testToolsToggleBtn.addEventListener("click", () => {
    const open = testToolsPanel.style.display !== "none";
    testToolsPanel.style.display = open ? "none" : "flex";
    testToolsToggleBtn.textContent = open ? "🧪 測試工具" : "🧪 收起測試工具";
  });
}
testVerifyBtn?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "TEST_VERIFY" });
  appendLog("🧪 已觸發人機驗證模擬測試，請看是否有分頁切到最前景。", "info");
});

// ══════════════════════════════════
// Excel 解析
// ══════════════════════════════════
function sanitizeFilename(title) {
  if (!title) return "untitled";
  return title
    .replace(/[?/\\:*"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 120); // 過長標題會讓 Windows 完整路徑超過上限，導致 chrome.downloads 失敗
}

function sanitizeDownloadFolder(folder) {
  const cleaned = String(folder || getDefaultDownloadFolder())
    .replace(/\\/g, "/")
    .split("/")
    .map(part => part.replace(/[?:*"<>|]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
  return cleaned || getDefaultDownloadFolder();
}

function findTargetIndex(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { index: -1, matched: null, empty: true };
  const index = list.findIndex(item => {
    const pmid = String(item.pmid || "").toLowerCase();
    const title = String(item.title || "").toLowerCase();
    return pmid === q || pmid.includes(q) || title.includes(q);
  });
  return { index, matched: index >= 0 ? list[index] : null, empty: false };
}

// 「起始 PMID/title」～「結束 PMID/title」範圍下載：兩邊都用 PMID 或標題關鍵字在
// 目前這個篩選模式（Y/all/retry）的清單裡各自找一次位置，回傳只包含 [起點,終點]
// （含頭尾）的子清單。任一邊留空 = 那一邊不設限（起點留空從頭開始、終點留空到底
// 為止）；找不到指定的起點/終點時整個範圍視為無效，回傳原始清單並標記錯誤，交由
// 呼叫端決定要不要擋下開始下載。
function applyRange(list, startQuery, endQuery) {
  const startInfo = findTargetIndex(list, startQuery);
  const endInfo   = findTargetIndex(list, endQuery);

  if (!startInfo.empty && startInfo.index < 0) {
    return { list, startInfo, endInfo, startNotFound: true };
  }
  if (!endInfo.empty && endInfo.index < 0) {
    return { list, startInfo, endInfo, endNotFound: true };
  }

  const startIndex = startInfo.empty ? 0 : startInfo.index;
  const endIndex   = endInfo.empty ? list.length - 1 : endInfo.index;

  if (endIndex < startIndex) {
    return { list, startInfo, endInfo, rangeInvalid: true };
  }

  return { list: list.slice(startIndex, endIndex + 1), startInfo, endInfo, startIndex, endIndex };
}

function logRangeApplied(rangeInfo) {
  if (rangeInfo.startNotFound) {
    appendLog("⚠ 找不到指定的起始 PMID/title，已忽略範圍設定，改用全部清單。", "warn");
  } else if (rangeInfo.endNotFound) {
    appendLog("⚠ 找不到指定的結束 PMID/title，已忽略範圍設定，改用全部清單。", "warn");
  } else if (rangeInfo.rangeInvalid) {
    appendLog("⚠ 結束論文出現在起始論文之前，範圍設定無效，已改用全部清單。", "warn");
  } else if (rangeInfo.startInfo?.matched || rangeInfo.endInfo?.matched) {
    const startLabel = rangeInfo.startInfo?.matched ? `第 ${rangeInfo.startIndex + 1} 篇` : "第 1 篇";
    const endLabel   = rangeInfo.endInfo?.matched   ? `第 ${rangeInfo.endIndex + 1} 篇`   : "最後一篇";
    appendLog(`↪ 下載範圍：${startLabel}～${endLabel}（共 ${rangeInfo.list.length} 篇）`, "info");
  }
}

// ══════════════════════════════════
// 起始/結束論文選擇器：可搜尋的彈出視窗，列出目前篩選模式（Y/all/retry）下的
// 清單（跟 applyRange() 切範圍用的是同一份 allParsedTargets，序號才會一致），
// 點一筆就把 PMID（沒有 PMID 才用標題）填進對應輸入框，觸發 change 讓範圍即時重算。
// ══════════════════════════════════
let paperPickerTargetInput = null;

function renderPaperPickerList(filterText) {
  if (!paperPickerList) return;
  const q = String(filterText || "").trim().toLowerCase();
  const source = (allParsedTargets || []).map((item, idx) => ({ item, idx }));
  const matched = q
    ? source.filter(({ item }) => {
        const pmid = String(item.pmid || "").toLowerCase();
        const title = String(item.title || "").toLowerCase();
        return pmid.includes(q) || title.includes(q);
      })
    : source;

  paperPickerList.innerHTML = "";
  if (!matched.length) {
    paperPickerList.innerHTML = '<div class="picker-empty">沒有符合的論文</div>';
    return;
  }
  const LIMIT = 200;
  matched.slice(0, LIMIT).forEach(({ item, idx }) => {
    const row = document.createElement("div");
    row.className = "picker-item";
    row.innerHTML = `<span class="picker-item-seq">#${idx + 1}</span>` +
      (item.pmid ? `<span class="picker-item-pmid">PMID:${item.pmid}</span>` : "") +
      `<span>${diffTruncate(item.title || "(無標題)", 60)}</span>`;
    row.addEventListener("click", () => {
      if (paperPickerTargetInput) {
        paperPickerTargetInput.value = item.pmid || item.title || "";
        paperPickerTargetInput.dispatchEvent(new Event("change"));
      }
      closePaperPicker();
    });
    paperPickerList.appendChild(row);
  });
  if (matched.length > LIMIT) {
    const more = document.createElement("div");
    more.className = "picker-empty";
    more.textContent = `還有 ${matched.length - LIMIT} 筆，請輸入關鍵字縮小範圍`;
    paperPickerList.appendChild(more);
  }
}

function openPaperPicker(targetInput, titleText) {
  if (!allParsedTargets || !allParsedTargets.length) {
    appendLog("⚠ 請先上傳/載入 Excel 後再瀏覽論文清單。", "warn");
    return;
  }
  paperPickerTargetInput = targetInput;
  if (paperPickerTitle) paperPickerTitle.textContent = titleText;
  if (paperPickerSearch) paperPickerSearch.value = "";
  renderPaperPickerList("");
  paperPickerOverlay?.classList.add("show");
  paperPickerSearch?.focus();
}

function closePaperPicker() {
  paperPickerOverlay?.classList.remove("show");
  paperPickerTargetInput = null;
}

startFromBrowseBtn?.addEventListener("click", () => openPaperPicker(startFromInput, "選擇起始論文"));
endAtBrowseBtn?.addEventListener("click", () => openPaperPicker(endAtInput, "選擇結束論文"));
paperPickerCancelBtn?.addEventListener("click", closePaperPicker);
paperPickerSearch?.addEventListener("input", () => renderPaperPickerList(paperPickerSearch.value));
paperPickerOverlay?.addEventListener("click", e => { if (e.target === paperPickerOverlay) closePaperPicker(); });

// 讀取目前選取的下載範圍："Y"（Column M = Y）| "all"（全部）| "retry"（僅「下次重試」）
function getFilterMode() {
  if (document.getElementById("filterRetry")?.checked) return "retry";
  if (document.getElementById("filterAll")?.checked) return "all";
  return "Y";
}

function filterModeText(mode) {
  if (mode === "all") return "全部下載";
  if (mode === "retry") return "僅「下次重試」";
  return "Column M = Y";
}

function parseExcel(arrayBuffer, mode, options = {}) {
  // 向下相容：舊呼叫傳 boolean（true=全部、false=Column M=Y）
  if (mode === true) mode = "all";
  else if (mode === false || !mode) mode = "Y";
  const recordInitial = options.recordInitial !== false;
  if (recordInitial) initialStatusMap = {};
  if (typeof XLSX === "undefined") throw new Error("SheetJS 未載入");
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  workbookData = wb;

  // 序號前綴跟 buildAllRowsFromWorkbook() 共用同一套「略過空列」規則走出來的順位，
  // 這裡直接借用它算好的 seqLabel/seq，確保兩邊對同一列算出來的序號永遠一致（就算
  // 這裡因為斷點續傳/Column M 篩選而跳過某些列，序號本身不受影響）。多解析一次工作表
  // 不是熱路徑，用簡單換一致性是合理取捨。
  //
  // 這個順位＝整份 Excel 裡「有資料的列」（跳過空列/標題列）由上往下數的第幾篇，
  // 不管 Column M 是 Y 或 N 都算進去——跟檔案命名/核對用的序號是同一套，這樣「第
  // 幾篇」在檔名、log、核對報告裡才會永遠對得起來，也不會因為之後改動 Y/N 篩選
  // 判斷而跟著跳號。
  const allWorkbookRows = buildAllRowsFromWorkbook(arrayBuffer);
  const seqLabelByRowIndex = new Map(allWorkbookRows.map(r => [r.rowIndex, r.seqLabel]));
  const paperNoByRowIndex  = new Map(allWorkbookRows.map(r => [r.rowIndex, r.seq]));

  // 找目標工作表
  let ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    // 先退第 2 張（本專案檔案格式），只有一張工作表時退第 1 張
    ws = wb.Sheets[wb.SheetNames[1]] || wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error(`找不到工作表「${SHEET_NAME}」`);
  }

  const rows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // 動態找「下載狀況」「語言」欄位（允許不在固定欄）
  const headerRow = rows[0] || [];
  let statusColIdx = COL_STATUS;
  let langColIdx   = COL_LANG;
  for (let c = 0; c < headerRow.length; c++) {
    const h = String(headerRow[c] || "").trim();
    if (h === "下載狀況") statusColIdx = c;
    else if (h === "語言") langColIdx = c;
  }

  const found = [];
  let skippedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(v => v === null)) continue;

    // 篩選邏輯（retry 模式不看 Column M：能標到「下次重試」代表先前已是下載目標）
    if (mode === "Y") {
      const include = String(row[COL_INCLUDE] || "").trim().toUpperCase();
      if (include !== "Y") continue;
    }

    const pmidRaw = row[COL_PMID];
    const title   = row[COL_TITLE];
    if (!pmidRaw && !title) continue;

    // parseInt 失敗會得到 NaN，直接轉字串會產生 pmid "NaN" 拿去組錯誤的 URL
    const pmidNum   = pmidRaw != null ? parseInt(String(pmidRaw).trim(), 10) : NaN;
    const pmid      = Number.isFinite(pmidNum) && pmidNum > 0 ? String(pmidNum) : null;
    const titleStr  = title ? String(title).trim() : "";
    const safeTitle = sanitizeFilename(titleStr);
    const language   = String(row[langColIdx] || "").trim();
    const doi        = String(row[COL_DOI] || "").trim();

    // ── 斷點續傳：跳過上次已成功或失敗的列 ──
    const prevStatus = String(row[statusColIdx] || "").trim();
    if (recordInitial && prevStatus) initialStatusMap[i + 1] = prevStatus;
    if (prevStatus === STATUS_SUCCESS || prevStatus === STATUS_FAIL) {
      skippedCount++;
      // 恢復進 resultsMap，讓 UI 能正確顯示
      resultsMap[i + 1] = prevStatus;
      continue;
    }
    // retry 模式：只收「下次重試」的列
    if (mode === "retry" && prevStatus !== STATUS_RETRY) continue;

    found.push({
      rowIndex:  i + 1,
      paperNo:   paperNoByRowIndex.get(i + 1) ?? null,
      pmid,
      title:     titleStr,
      safeTitle,
      seqLabel:  seqLabelByRowIndex.get(i + 1),
      language,
      doi,
      status:    prevStatus || STATUS_PENDING,
    });
  }

  if (skippedCount > 0 && recordInitial) {
    appendLog(`⏭ 已跳過 ${skippedCount} 篇（進度 Excel 標記為「下載成功」或「下載失敗」）`, "ok");
  }

  return found;
}

// ══════════════════════════════════
// 測試下載（Debug 用）：依指定的 PMID / Title 從 Excel 找出對應列，
// 完全忽略 Column M 篩選與「下載狀況」斷點續傳跳過邏輯 —— 只要指定到就一定下載。
// 回傳 { items, unmatchedQueries }
// ══════════════════════════════════
// 把整張工作表轉成「每一列的完整 item」，不套用 Column M / 下載狀況 的任何篩選或
// 跳過邏輯——parseExcel() 是拿來組「這次要下載哪些」的工作佇列，會刻意跳過已經
// 標記成功/失敗的列；這個函式是拿來組「這份 Excel 全部的列」，本地資料夾模式的
// 核對（computeLocalFolderDiff）需要看到已經標記完成的列，才能發現「Excel 說成功，
// 但資料夾裡其實沒有那個檔案」這種資料飄移。這裡順便算好每一列的 seqLabel（序號
// 前綴），parseExcel() 直接借用同一份結果，確保兩邊順位一致。
function buildAllRowsFromWorkbook(arrayBuffer) {
  if (typeof XLSX === "undefined") throw new Error("SheetJS 未載入");
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });

  let ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    ws = wb.Sheets[wb.SheetNames[1]] || wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error(`找不到工作表「${SHEET_NAME}」`);
  }

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const headerRow = rows[0] || [];
  let statusColIdx = COL_STATUS;
  let langColIdx   = COL_LANG;
  for (let c = 0; c < headerRow.length; c++) {
    const h = String(headerRow[c] || "").trim();
    if (h === "下載狀況") statusColIdx = c;
    else if (h === "語言") langColIdx = c;
  }

  const allRows = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(v => v === null)) continue;
    const pmidRaw = row[COL_PMID];
    const title   = row[COL_TITLE];
    if (!pmidRaw && !title) continue;
    const pmidNum   = pmidRaw != null ? parseInt(String(pmidRaw).trim(), 10) : NaN;
    const pmid      = Number.isFinite(pmidNum) && pmidNum > 0 ? String(pmidNum) : null;
    const titleStr  = title ? String(title).trim() : "";
    allRows.push({
      rowIndex:  i + 1,
      pmid,
      title:     titleStr,
      safeTitle: sanitizeFilename(titleStr),
      language:  String(row[langColIdx] || "").trim(),
      doi:       String(row[COL_DOI] || "").trim(),
      status:    String(row[statusColIdx] || "").trim() || STATUS_PENDING,
    });
  }

  // 序號前綴（本地資料夾模式的檔名用）：這篇論文在「Excel 全部有資料的列」中的
  // 1-based 順位，補零到固定寬度（LOCAL_SEQ_WIDTH，見常數定義）。序號在整份 Excel
  // 裡天生唯一，靠檔名本身就能反推「這是第幾篇、應該是什麼標題」，不需要額外的
  // 撞名後綴或持久化對照表。
  //
  // 寬度固定、不隨「目前總篇數」動態計算：用「更新論文清單」在既有專案後面加新
  // 論文時，總篇數會變多，如果寬度也跟著變寬（例如 999→1000 篇讓 3 碼變 4 碼），
  // 既有論文重新算出來的 seqLabel 字串就會跟磁碟上舊檔名裡的序號對不起來（核對
  // 時是用字串相等比對，"050" 不等於 "0050"），造成一大批已下載的檔案被誤判成
  // 「異常/找不到」。固定寬度可以讓每一列的 seqLabel 一旦算出來就永遠不變。
  allRows.forEach((r, i) => {
    r.seq = i + 1;
    r.seqLabel = String(i + 1).padStart(LOCAL_SEQ_WIDTH, "0");
  });

  return allRows;
}

function parseExcelForTest(arrayBuffer, queryLines) {
  const allRows = buildAllRowsFromWorkbook(arrayBuffer);
  const matchedByRowIndex = new Map();
  const unmatchedQueries = [];

  queryLines.forEach(rawQuery => {
    const query = rawQuery.trim();
    if (!query) return;
    const isPmidQuery = /^\d{4,}$/.test(query);
    let hit;
    if (isPmidQuery) {
      hit = allRows.filter(r => r.pmid === query);
    } else {
      const qLower = query.toLowerCase();
      hit = allRows.filter(r => {
        const tLower = r.title.toLowerCase();
        return tLower.includes(qLower) || qLower.includes(tLower);
      });
    }
    if (!hit.length) {
      unmatchedQueries.push(query);
      return;
    }
    hit.forEach(r => matchedByRowIndex.set(r.rowIndex, r));
  });

  return { items: Array.from(matchedByRowIndex.values()), unmatchedQueries };
}

// 目前接的本地資料夾專案（僅取最後一層資料夾名稱，路徑太長顯示會爆版），沒開本地
// 資料夾模式或還沒選資料夾時回傳 ""。
function currentProjectFolderLabel() {
  if (!(localFolderModeInput?.checked) || !localFolderRootInput?.value) return "";
  const raw = localFolderRootInput.value;
  return raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || raw;
}

// 「正在處理哪個 Excel、幾篇、哪個專案資料夾」只用這一行顯示——之前 fileInfo 跟
// localFolderSummary 各自顯示一次類似的內容（檔名＋篇數 vs 專案名＋篇數），兩行
// 同時出現、數字重複，容易讓人搞不清楚是不是兩份不同的東西。現在統一只在這裡
// 組字串，localFolderSummary 之後只保留「讀取中／核對中／錯誤／警告」這種一次性
// 過渡訊息，穩定狀態下會清空，避免跟這行重複。
function renderFileInfoLine(displayName, count, modeText) {
  const folderLabel = currentProjectFolderLabel();
  fileInfo.style.display = "block";
  fileInfo.textContent = folderLabel
    ? `📁 專案資料夾：${folderLabel}　|　📎 Excel：${displayName}　|　找到 ${count} 篇（${modeText}）`
    : `📎 ${displayName}　|　找到 ${count} 篇（${modeText}）`;
}

// ══════════════════════════════════
// 上傳處理
// ══════════════════════════════════
// 把已經拿到的 ArrayBuffer 解析、灌進畫面（targets/allParsedTargets/各種計數與設定列
// 顯示）。handleFile()（使用者手動上傳 .xlsx）跟 openLocalProject()（本地資料夾模式
// 接續舊專案、從 native host 讀回既有進度檔）共用這段邏輯，差別只在 bytes 從哪裡來。
function ingestExcelArrayBuffer(arrayBuffer, displayName) {
  cachedArrayBuffer = arrayBuffer;
  resultsMap = {}; resultsFailMap = {};
  sessionUpdatedRows = new Set();
  const filterMode = getFilterMode();
  document.getElementById("downloadAllCheck").value = filterMode === "all" ? "1" : "0";
  allParsedTargets = parseExcel(arrayBuffer, filterMode);
  const rangeInfo = applyRange(allParsedTargets, startFromInput?.value || "", endAtInput?.value || "");
  targets = rangeInfo.list;
  logRangeApplied(rangeInfo);

  // 計算各模式篇數供顯示
  try {
    const allTargets   = parseExcel(arrayBuffer, "all",   { recordInitial: false });
    const yTargets     = parseExcel(arrayBuffer, "Y",     { recordInitial: false });
    const retryTargets = parseExcel(arrayBuffer, "retry", { recordInitial: false });
    document.getElementById("countY").textContent     = yTargets.length;
    document.getElementById("countAll").textContent   = allTargets.length;
    document.getElementById("countRetry").textContent = retryTargets.length;
    if (retryTargets.length > 0) {
      appendLog(`🔁 偵測到 ${retryTargets.length} 篇標記「下次重試」，可切換「僅「下次重試」」只跑這些。`, "info");
    }
  } catch(e) {}
  const modeText = filterModeText(filterMode);
  renderFileInfoLine(displayName, targets.length, modeText);
  // 每次載入/接續一份新的 Excel，統計欄位（總數/成功/失敗/未下載）都要立刻歸零
  // 重算，跟「下載範圍」篩選出來的篇數對齊——不然如果 background 手上還留著
  // 上一個專案（或上一次中斷的任務）的舊統計數字，GET_STATE 回傳時會把畫面蓋回
  // 那組舊數字，跟這裡剛解析出來的篇數對不起來。之後如果真的開始下載，PROGRESS
  // 訊息會接手即時更新，不受這裡的初始化影響。
  updateStats(targets.length, 0, 0, 0);
  settingsRow.style.display = "flex";
  if (folderRow) folderRow.style.display = "flex";
  if (batchRow) batchRow.style.display = "flex";
  if (politeModeRow) politeModeRow.style.display = "flex";
  AdvancedSettings.show();
  if (startFromRow) startFromRow.style.display = "flex";
  if (endAtRow) endAtRow.style.display = "flex";
  if (stopAfterRow) stopAfterRow.style.display = "flex";
  if (testToolsRow) testToolsRow.style.display = "flex";
  startBtn.disabled = targets.length === 0;
  appendLog(`✅ Excel 解析完成：${targets.length} 篇目標論文（${modeText}）`, "ok");
  statusText.textContent = `已載入 ${targets.length} 篇論文，可開始下載`;
  showProgressTableBtn();
  if (progressTablePanel.style.display !== "none") renderProgressTable();
}

function handleFile(file) {
  if (!file.name.endsWith(".xlsx")) { alert("請選擇 .xlsx 格式！"); return; }
  originalFilename = file.name;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      ingestExcelArrayBuffer(e.target.result, file.name);

      // ── 把原始 Excel binary 傳給 background 儲存 ──
      const arr = new Uint8Array(cachedArrayBuffer);
      let b64 = "";
      const chunk = 8192;
      for (let i = 0; i < arr.length; i += chunk) {
        b64 += String.fromCharCode(...arr.subarray(i, i + chunk));
      }
      b64 = btoa(b64);
      const baseName = originalFilename.replace(/\.xlsx$/i, "").replace(/_下載進度管理$/i, "").replace(/_進度管理$/i, "");

      if (localFolderModeInput?.checked) {
        // 本地資料夾模式的新專案第一次上傳：background 會寫 <base>_原檔.xlsx（保留不動）
        // + <base>_進度管理.xlsx（往後每次下載完會被覆寫的工作副本），順便把 Excel bytes
        // 存進 storage.local（_buildAndSaveExcel 每次寫進度都靠這份資料）。
        const folder = sanitizeDownloadFolder(downloadFolderInput?.value || getDefaultDownloadFolder());
        chrome.runtime.sendMessage({ action: "INIT_LOCAL_PROJECT_EXCEL", b64, baseName, sheetName: SHEET_NAME, folder }, res => {
          if (res?.ok) {
            appendLog(`📤 已建立本地專案「${res.base}」，往後進度會寫進這個資料夾。`, "ok");
            // 這裡不重複寫「目前專案：X」——上面的 fileInfo 那行已經同時顯示資料夾
            // 跟 Excel／篇數了，兩邊都寫容易讓人搞不清楚是不是兩份不同的東西。
            if (localFolderSummary) localFolderSummary.textContent = "";
            // 專案已經建立、進度檔已經接上，收起上傳區，避免之後又被誤導成「要繼續
            // 得再上傳一次」——繼續下載永遠只需要選資料夾。
            setUploadAreaVisible(false);
          } else {
            appendLog(`❌ 建立本地專案失敗：${res?.error || "未知錯誤"}`, "fail");
            if (localFolderSummary) localFolderSummary.textContent = `❌ 建立本地專案失敗：${res?.error || "未知錯誤"}`;
          }
        });
      } else {
        const folder = sanitizeDownloadFolder(downloadFolderInput?.value || getDefaultDownloadFolder());
        chrome.runtime.sendMessage({
          action: "SAVE_SOURCE_EXCEL",
          b64,
          meta: { sheetName: SHEET_NAME, baseName, folder },
        }, res => {
          if (res?.ok) {
            appendLog("📤 Excel 已同步至背景，將由背景自動維護進度檔。", "info");
          } else {
            appendLog(`❌ Excel 同步至背景失敗：${res?.error || "未知錯誤"}`, "fail");
          }
        });
      }
    } catch(err) {
      appendLog(`❌ 解析失敗：${err.message}`, "fail");
    }
  };
  reader.readAsArrayBuffer(file);
}

// 本地資料夾模式「更新論文清單」：比對新上傳的 Excel 跟目前專案的原始列，抓出
// 「新上傳裡有、但目前專案完全沒有」的列（用 PMID 優先比對，沒有 PMID 才退回標題
// 完全相同比對），回傳這些列「原始儲存格陣列」（不是簡化過的 JS 物件）——因為
// 工作表裡可能還有很多我們平常沒特別解析的欄位（作者、期刊等），只有整列原樣搬過
// 去才不會漏資料。既有的列完全不動、不比對其他欄位是否有變化：這個功能只負責
// 「加新論文」，不負責「修改既有列」（要改既有列的 Column M／標題等，直接在
// 進度管理/xxx_進度管理.xlsx 用 Excel 開來改，重新選一次專案資料夾就會讀到）。
function diffNewRowsAgainstCurrent(newArrayBuffer, currentArrayBuffer) {
  if (typeof XLSX === "undefined") throw new Error("SheetJS 未載入");
  const pickSheet = wb => wb.Sheets[SHEET_NAME] || wb.Sheets[wb.SheetNames[1]] || wb.Sheets[wb.SheetNames[0]];

  const newWb = XLSX.read(newArrayBuffer, { type: "array", cellDates: true });
  const curWb = XLSX.read(currentArrayBuffer, { type: "array", cellDates: true });
  const newWs = pickSheet(newWb), curWs = pickSheet(curWb);
  if (!newWs || !curWs) throw new Error(`找不到工作表「${SHEET_NAME}」`);

  const newRows = XLSX.utils.sheet_to_json(newWs, { header: 1, defval: null });
  const curRows = XLSX.utils.sheet_to_json(curWs, { header: 1, defval: null });
  const headerMismatch = (newRows[0]?.length || 0) !== (curRows[0]?.length || 0);

  const keyOf = row => {
    const pmidRaw = row[COL_PMID];
    const pmidNum = pmidRaw != null ? parseInt(String(pmidRaw).trim(), 10) : NaN;
    if (Number.isFinite(pmidNum) && pmidNum > 0) return "pmid:" + pmidNum;
    const title = row[COL_TITLE] ? String(row[COL_TITLE]).trim().toLowerCase() : "";
    return title ? "title:" + title : null;
  };

  const existingKeys = new Set();
  for (let i = 1; i < curRows.length; i++) {
    const row = curRows[i];
    if (!row || row.every(v => v === null)) continue;
    const k = keyOf(row);
    if (k) existingKeys.add(k);
  }

  const newRawRows = [];
  let skippedCount = 0;
  for (let i = 1; i < newRows.length; i++) {
    const row = newRows[i];
    if (!row || row.every(v => v === null)) continue;
    const k = keyOf(row);
    if (!k) continue; // 沒有 PMID 也沒有標題，沒辦法辨識，直接略過（跟其他解析邏輯一致）
    if (existingKeys.has(k)) { skippedCount++; continue; }
    existingKeys.add(k); // 防止這份新檔案內部自己就有重複列，被算成兩筆新論文
    newRawRows.push(row);
  }

  return { newRawRows, skippedCount, headerMismatch };
}

function handleUpdateExcelFile(file) {
  if (!file.name.endsWith(".xlsx")) { alert("請選擇 .xlsx 格式！"); return; }
  if (!cachedArrayBuffer) { appendLog("⚠ 請先連接一個本地專案資料夾，再更新論文清單。", "warn"); return; }

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const { newRawRows, skippedCount, headerMismatch } = diffNewRowsAgainstCurrent(e.target.result, cachedArrayBuffer);
      if (headerMismatch) {
        appendLog("❌ 更新清單失敗：這份 Excel 的欄位結構跟目前專案不一致，請確認選對檔案。", "fail");
        return;
      }
      if (!newRawRows.length) {
        appendLog(`ℹ️ 更新清單：這份 Excel 裡沒有找到新論文（${skippedCount} 篇都已經在目前專案裡），沒有變更任何東西。`, "info");
        return;
      }
      appendLog(`🔄 正在更新論文清單：新增 ${newRawRows.length} 篇、略過 ${skippedCount} 篇已存在的...`, "info");
      chrome.runtime.sendMessage({ action: "UPDATE_LOCAL_PROJECT_EXCEL", newRawRows }, res => {
        if (res?.ok) {
          appendLog(`✅ 清單已更新：新增 ${res.addedCount} 篇，目前共 ${res.newTotal} 篇。重新載入專案中…`, "ok");
          openLocalProject(localFolderRootInput.value);
        } else {
          appendLog(`❌ 更新清單失敗：${res?.error || "未知錯誤"}`, "fail");
        }
      });
    } catch (err) {
      appendLog(`❌ 解析失敗：${err.message}`, "fail");
    }
  };
  reader.readAsArrayBuffer(file);
}

localFolderUpdateListBtn?.addEventListener("click", () => {
  if (!cachedArrayBuffer) { appendLog("⚠ 請先連接一個本地專案資料夾，再更新論文清單。", "warn"); return; }
  showLfTipThen("updateList", () => updateExcelFileInput.click());
});
updateExcelFileInput?.addEventListener("change", e => {
  const f = e.target.files[0];
  updateExcelFileInput.value = "";
  if (f) handleUpdateExcelFile(f);
});

function rebuildTargetsFromCache() {
  if (!cachedArrayBuffer) return;
  const filterMode = getFilterMode();
  document.getElementById("downloadAllCheck").value = filterMode === "all" ? "1" : "0";
  allParsedTargets = parseExcel(cachedArrayBuffer, filterMode);
  const rangeInfo = applyRange(allParsedTargets, startFromInput?.value || "", endAtInput?.value || "");
  targets = rangeInfo.list;
  const modeText = filterModeText(filterMode);
  renderFileInfoLine(originalFilename, targets.length, modeText);
  startBtn.disabled = targets.length === 0;
  updateStats(targets.length, 0, 0, 0);
  appendLog(`🔄 已切換下載範圍：${modeText}，共 ${targets.length} 篇`, "info");
}

document.querySelectorAll("input[name='filterMode']").forEach(input => {
  input.addEventListener("change", rebuildTargetsFromCache);
});
// 起始/結束範圍改變時即時重算篇數顯示，不用等到按下「開始」才知道範圍對不對
startFromInput?.addEventListener("change", rebuildTargetsFromCache);
endAtInput?.addEventListener("change", rebuildTargetsFromCache);

// ══════════════════════════════════
// 本地資料夾模式：一份 Excel 對應一個專屬資料夾（下載成功/下載失敗/下次重試/
// 進度管理），PDF/失敗筆記/進度 Excel 都寫到這裡，不受限於 Chrome 預設下載資料夾。
// 見 background.js 的 FILE_MANAGER_HOST 那段說明（native_host/python_file_manager.py）。
// ══════════════════════════════════
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

// 本地資料夾模式已經接上一個專案（不管是接續舊專案還是剛建立新專案）時，「點擊或
// 拖曳上傳 Excel」這個上傳區應該收起來——留著容易誤導使用者以為「要繼續下載得
// 重新上傳一次」，而重新上傳會被 INIT_LOCAL_PROJECT_EXCEL 的防呆擋下來，一來一回
// 反而更困惑。只有「還沒接上任何專案」時（傳統模式，或本地模式但還沒選資料夾／
// 選了全新空資料夾）才需要顯示。
function setUploadAreaVisible(visible) {
  if (uploadArea) uploadArea.style.display = visible ? "" : "none";
}

// 清空畫面上跟「目前載入的 Excel」有關的一切狀態（切換到不同專案資料夾時要用，
// 不然舊專案的 targets/resultsMap 會被誤當成新專案的內容）。
// showUpload：這次清空後要不要順便打開「點擊或拖曳上傳 Excel」的入口——只有「真的
// 是全新空資料夾，等你上傳原始 Excel 建立專案」或「專案存在但進度檔遺失，需要重新
// 上傳同名原始 Excel 補回」這兩種情況才要 true；其餘（按錯按鈕的提醒訊息等）應該
// 維持隱藏，逼使用者重選資料夾，而不是誤導成「可以直接上傳」。
function resetLoadedExcelState(showUpload = true) {
  cachedArrayBuffer = null;
  originalFilename = "";
  targets = []; allParsedTargets = [];
  resultsMap = {}; resultsFailMap = {};
  sessionUpdatedRows = new Set();
  setUploadAreaVisible(showUpload);
  fileInfo.style.display = "none";
  settingsRow.style.display = "none";
  if (folderRow) folderRow.style.display = "none";
  if (batchRow) batchRow.style.display = "none";
  if (politeModeRow) politeModeRow.style.display = "none";
  if (startFromRow) startFromRow.style.display = "none";
  if (endAtRow) endAtRow.style.display = "none";
  if (stopAfterRow) stopAfterRow.style.display = "none";
  if (testToolsRow) testToolsRow.style.display = "none";
  AdvancedSettings.hide();
  startBtn.disabled = true;
}

// 本地資料夾模式核對報告：完全一致就只記一筆 log；有差異就跳出 modal 讓使用者決定
// 要不要同步（見 background.js 的 computeLocalFolderDiff/applyLocalFolderDiff——
// 兩者都直接讀 storage 裡最新的 Excel 本身，這裡不需要也不會傳遞任何列清單）。
function renderLocalFolderDiff(diff) {
  if (!diff || diff.skipped) return;
  if (diff.clean) {
    appendLog("✅ 核對完成：Excel 與資料夾狀態完全一致，沒有需要同步的差異。", "ok");
    return;
  }
  showLocalFolderDiffModal(diff);
}

function diffTruncate(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function renderDiffSection(section, listEl, items, cls, renderText) {
  listEl.innerHTML = "";
  if (!items.length) {
    section.classList.add("empty");
    return;
  }
  section.classList.remove("empty");
  items.forEach(it => {
    const row = document.createElement("div");
    row.className = "diff-row " + cls;
    row.textContent = renderText(it);
    listEl.appendChild(row);
  });
}

const DIFF_CONFLICT_LABEL = {
  pdf_vs_txt:   "保留成功 PDF，刪除失敗/重試記錄",
  fail_vs_retry:"以較新時間的紀錄為準",
};

function showLocalFolderDiffModal(diff) {
  diffSummaryLine.textContent =
    `共 ${diff.summary.total} 篇：不一致 ${diff.summary.mismatchCount}、衝突 ${diff.summary.conflictCount}、異常檔案 ${diff.summary.anomalyCount}`;

  renderDiffSection(diffMismatchSection, diffMismatchList, diff.mismatches, "mismatch", r =>
    `第 ${r.seqLabel} 篇《${diffTruncate(r.title, 30)}》：Excel＝「${r.excelStatus || "未下載"}」，資料夾實際＝「${r.folderStatus || "未下載"}」`
  );

  renderDiffSection(diffConflictSection, diffConflictList, diff.conflicts, "conflict", r =>
    `第 ${r.seqLabel} 篇《${diffTruncate(r.title, 30)}》：${r.type === "pdf_vs_txt" ? "成功 PDF 與失敗/重試記錄同時存在" : "失敗與重試記錄同時存在"}，建議：${DIFF_CONFLICT_LABEL[r.type] || ""}`
  );

  renderDiffSection(diffAnomalySection, diffAnomalyList, diff.anomalies, "anomaly", a =>
    `【${a.folder}】${a.file}：${a.reason}`
  );

  localDiffOverlay.classList.add("show");

  diffApplyBtn.onclick = () => {
    localDiffOverlay.classList.remove("show");
    appendLog("🔄 正在同步本地資料夾狀態回 Excel…", "info");
    chrome.runtime.sendMessage({ action: "APPLY_LOCAL_FOLDER_SYNC" }, res => {
      if (res?.ok) {
        appendLog(`🔄 已同步：修正 ${res.changed || 0} 列、清掉 ${res.deletedStaleFiles || 0} 個殘留檔案${res.anomalyCount ? `，另有 ${res.anomalyCount} 個異常檔案僅供你自行確認` : ""}。`, "ok");
        // background 已經把最新狀態寫進磁碟上的進度管理 Excel，但 popup 手上的
        // cachedArrayBuffer 還是同步前那份舊的——不重新載入的話，下次按「🔄 核對
        // 進度」送出的 excelStatus 還是舊值，會讓已經修好的差異看起來「又跑出來了」。
        // 用跟「更新論文清單」完成後一樣的做法：重新開啟目前這個專案資料夾，直接
        // 從磁碟讀最新版本回來。
        if (localFolderRootInput?.value) openLocalProject(localFolderRootInput.value);
      } else {
        appendLog(`❌ 同步失敗：${res?.error || "未知錯誤"}`, "fail");
      }
    });
  };
  diffCancelBtn.onclick = () => {
    localDiffOverlay.classList.remove("show");
    appendLog("已取消同步，未變更任何檔案。", "info");
  };
}

// 選好（或恢復）一個專案資料夾後呼叫：background 會確保四個子資料夾存在，並回報
// 「進度管理/」底下有沒有既有的 *_進度管理.xlsx——有就是接續舊專案（直接把內容灌
// 進畫面，不用使用者重新上傳），沒有就是新專案（走原本的上傳流程建立）。
//
// expectedMode：使用者按的是「🆕 建立並選取全新專案資料夾」("new") 還是「📂 選取
// 已存在專案資料夾」("resume")，還是沒有明確預期（null，例如開 popup 時自動接上次
// 記住的資料夾）。有明確預期時，如果背景回報的實際狀況跟預期不符（例如按了「全新
// 專案」卻選到一個已經有進度的資料夾，或按了「選取已存在專案」卻選到空資料夾），
// 要擋下來提醒改按另一顆按鈕，不要靜默照對方沒預期到的方式處理掉。
function openLocalProject(root, expectedMode = null) {
  if (localFolderSummary) localFolderSummary.textContent = "🔎 正在讀取專案資料夾…";
  chrome.runtime.sendMessage({ action: "OPEN_LOCAL_PROJECT", root }, res => {
    if (!res?.ok) {
      if (localFolderSummary) localFolderSummary.textContent = `❌ 開啟專案資料夾失敗：${res?.error || "未知錯誤（可能是 native host 未安裝）"}`;
      appendLog(`❌ 開啟本地專案資料夾失敗：${res?.error || "未知錯誤"}`, "fail");
      return;
    }
    if (res.resumed) {
      if (expectedMode === "new") {
        // 選錯資料夾（已經有進度了），不是「新資料夾等上傳」的狀態，上傳區維持隱藏。
        resetLoadedExcelState(false);
        if (localFolderSummary) {
          localFolderSummary.textContent = `⚠ 你選的是「🆕 建立並選取全新專案資料夾」，但這個資料夾已經是「${res.base}」的進行中專案。請改按「📂 選取已存在專案資料夾」接續，或換一個空資料夾。`;
        }
        appendLog(`⚠「建立並選取全新專案資料夾」選到了已經有進度的資料夾（「${res.base}」），已略過，請改用「📂 選取已存在專案資料夾」。`, "warn");
        return;
      }
      originalFilename = res.base + "_進度管理.xlsx";
      ingestExcelArrayBuffer(base64ToArrayBuffer(res.dataB64), originalFilename);
      // 已經接上既有專案了，不需要（也不該）再讓使用者看到「上傳 Excel」的入口——
      // 重新上傳只會被 INIT_LOCAL_PROJECT_EXCEL 的防呆擋下來，留著徒增困惑。
      setUploadAreaVisible(false);
      // 「這是哪個資料夾／目前用哪份 Excel／幾篇」已經統一交給下面的 fileInfo 那行
      // 顯示（見 renderFileInfoLine()），這裡只留「還在核對中」這個會自然被下面
      // 的核對結果覆蓋掉的過渡訊息，核對完就清空，不重複講一次資料夾名稱跟篇數。
      if (localFolderSummary) localFolderSummary.textContent = "🔎 核對進度中…";
      appendLog(`📂 已接續本地專案「${res.base}」，開始核對資料夾與進度是否一致…`, "info");
      // 核對比對的是 background 那邊 storage 裡現存最新的 Excel 本身（見
      // background.js buildAllRowsFromStorage()），不需要這裡先算好列清單再送過去。
      chrome.runtime.sendMessage({ action: "RECONCILE_LOCAL_FOLDER" }, rres => {
        if (rres?.ok) {
          // 核對完成：清掉過渡訊息，不然「✅ 目前專案：X（已核對）」會跟下面
          // fileInfo 那行的資料夾/檔名/篇數重複，看起來像兩件不同的事。乾不乾淨的
          // 結果本身已經由 renderLocalFolderDiff()（log 或跳出的核對報告）交代過了。
          if (localFolderSummary) localFolderSummary.textContent = "";
          renderLocalFolderDiff(rres.diff);
        } else {
          appendLog(`⚠ 核對進度失敗：${rres?.error || "未知錯誤"}`, "warn");
        }
      });
    } else if (res.hasOriginal && res.base) {
      // 有原檔但找不到進度管理檔（例如進度檔被手動刪掉）——不管按的是哪顆按鈕，
      // 都不是單純「全新」或「正常接續」，維持既有的提示語，請使用者自行判斷處理。
      // 這裡明確需要使用者重新上傳原始 Excel 補回，所以上傳區要打開。
      resetLoadedExcelState(true);
      if (localFolderSummary) {
        localFolderSummary.textContent = `⚠ 這個資料夾已經是「${res.base}」專案，但找不到進度管理檔，請重新上傳原始 Excel（檔名需一致）。`;
      }
      appendLog(`⚠ 專案「${res.base}」缺少進度管理檔，請重新上傳原始 Excel 補回。`, "warn");
    } else if (expectedMode === "resume") {
      // 選錯資料夾（是空的），應該改按另一顆按鈕，不是「來上傳 Excel」，上傳區維持隱藏。
      resetLoadedExcelState(false);
      if (localFolderSummary) {
        localFolderSummary.textContent = "⚠ 你選的是「📂 選取已存在專案資料夾」，但這個資料夾裡還沒有專案。請改按「🆕 建立並選取全新專案資料夾」建立，或確認選對資料夾。";
      }
      appendLog("⚠「選取已存在專案資料夾」選到了空資料夾，已略過，請改用「🆕 建立並選取全新專案資料夾」。", "warn");
    } else {
      // 真正的「全新空資料夾」流程：這是唯一需要顯示上傳區的正常路徑。
      resetLoadedExcelState(true);
      if (localFolderSummary) localFolderSummary.textContent = "📁 新資料夾，請上傳這批論文的原始 Excel 建立專案。";
      appendLog("📂 已選擇新的本地專案資料夾，請上傳原始 Excel 建立專案。", "info");
    }
  });
}

localFolderModeInput?.addEventListener("change", () => {
  const enabled = localFolderModeInput.checked;
  chrome.storage.local.set({ localFolderModeEnabled: enabled });
  if (localFolderControls) localFolderControls.style.display = enabled ? "flex" : "none";
  if (!enabled) {
    if (localFolderSummary) localFolderSummary.textContent = "";
    // 切回傳統模式：那條路唯一的入口就是手動上傳 Excel，上傳區一定要顯示回來
    // （可能剛才在本地資料夾模式下因為已接上專案而被收起）。
    setUploadAreaVisible(true);
  }
});

discordEnabledInput?.addEventListener("change", () => {
  chrome.storage.local.set({ discordEnabled: discordEnabledInput.checked });
});

discordWebhookSaveBtn?.addEventListener("click", () => {
  const value = (discordWebhookInput?.value || "").trim();
  if (value && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(value)) {
    if (discordWebhookStatus) {
      discordWebhookStatus.textContent = "⚠ 看起來不像 Discord Webhook 網址（應該以 https://discord.com/api/webhooks/ 開頭），沒有儲存。";
      discordWebhookStatus.style.color = "#dc2626";
    }
    return;
  }
  // 留空＝清掉 storage 裡的覆寫值，退回 discord_notifier.js 內建的預設 webhook
  const apply = value
    ? chrome.storage.local.set({ discordWebhookUrl: value })
    : chrome.storage.local.remove(["discordWebhookUrl"]);
  Promise.resolve(apply).then(() => {
    if (discordWebhookStatus) {
      discordWebhookStatus.textContent = value ? "✅ 已更新 Webhook 網址，之後都會用這個。" : "✅ 已清空，改用預設 Webhook。";
      discordWebhookStatus.style.color = "#16a34a";
    }
  });
});

// ══════════════════════════════════
// 本地資料夾模式四顆按鈕的「第一次點擊說明提示」：每顆按鈕第一次點擊時彈出一個
// 簡短說明（modal），使用者可以勾選「知道了，下次不顯示」把該按鈕的提示存進
// chrome.storage.local 記住（之後就直接執行，不再彈出）；忘記勾選也沒關係，可以在
// 「⚙ 驗證與 API 進階設定 → 📁 本地資料夾模式」按「🔄 重新顯示操作說明提示」把四顆
// 全部恢復。這裡只負責「要不要彈出說明」，實際動作（選資料夾／核對／更新清單）都在
// onContinue callback 裡執行，跟原本沒有說明提示時的邏輯完全一樣。
// ══════════════════════════════════
const LF_TIP_CONTENT = {
  newProject: {
    storageKey: "lfTipDismiss_newProject",
    title: "🆕 建立並選取全新專案資料夾",
    body: "建立一個全新的專案資料夾後，上傳一份目標下載的該專案 Excel，會自動配置資料夾設置（下載成功／下載失敗／下次重試／進度管理 四個子資料夾）。",
  },
  resumeProject: {
    storageKey: "lfTipDismiss_resumeProject",
    title: "📂 選取已存在專案資料夾",
    body: "選擇已存在的專案資料夾，會自動搜尋該資料夾內的專案進度 Excel，讀取並分析目前進度，接續下載不需要重新上傳 Excel。",
  },
  reconcile: {
    storageKey: "lfTipDismiss_reconcile",
    title: "🔄 核對進度",
    body: "比對進度 Excel 記錄的下載狀況，跟資料夾裡實際存在的 PDF／失敗筆記是否一致。有落差時會列出報告，讓你確認要不要同步回 Excel。",
  },
  updateList: {
    storageKey: "lfTipDismiss_updateList",
    title: "📋 更新論文清單",
    body: "上傳一份新的 Excel，只把裡面沒出現過的新論文（依 PMID／標題比對）加進目前專案，不會動到既有進度。",
  },
};

function showLfTipThen(tipKey, onContinue) {
  const tip = LF_TIP_CONTENT[tipKey];
  if (!tip || !lfTipOverlay) { onContinue(); return; }
  chrome.storage.local.get([tip.storageKey], data => {
    if (data[tip.storageKey]) { onContinue(); return; }
    lfTipTitle.textContent = tip.title;
    lfTipBody.textContent = tip.body;
    lfTipDontShowAgain.checked = false;
    lfTipOverlay.classList.add("show");
    lfTipContinueBtn.onclick = () => {
      lfTipOverlay.classList.remove("show");
      if (lfTipDontShowAgain.checked) {
        chrome.storage.local.set({ [tip.storageKey]: true });
      }
      onContinue();
    };
  });
}

lfTipResetBtn?.addEventListener("click", () => {
  const keys = Object.values(LF_TIP_CONTENT).map(t => t.storageKey);
  chrome.storage.local.remove(keys, () => {
    appendLog("✅ 已重新開啟本地資料夾模式的操作說明提示，四顆按鈕下次點擊會再顯示一次。", "ok");
  });
});

// 選資料夾分成兩個明確的入口，不讓使用者猜「這次選了會發生什麼事」：
//   🆕 建立並選取全新專案資料夾：預期這個資料夾是空的（或還沒建過專案），選完接著
//     要上傳原始 Excel。
//   📂 選取已存在專案資料夾：預期這個資料夾已經有進度管理 Excel，選完直接讀進來
//     接續。
// 兩邊都送同一個 PICK_LOCAL_FOLDER + OPEN_LOCAL_PROJECT，差別在 openLocalProject()
// 收到結果後，會依 expectedMode 檢查跟使用者的預期是否相符，不符就擋下來提醒改按
// 另一顆按鈕，而不是靜默照對方原本沒預期的方式處理掉。
function pickLocalFolderAndConnect(expectedMode, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;
  chrome.runtime.sendMessage({ action: "PICK_LOCAL_FOLDER" }, res => {
    if (triggerBtn) triggerBtn.disabled = false;
    if (!res?.ok) {
      appendLog(`❌ 選擇資料夾失敗：${res?.error || "未知錯誤（可能是 native host 未安裝，見 native_host/安裝說明.txt）"}`, "fail");
      return;
    }
    if (res.cancelled || !res.path) return;
    const prevRoot = localFolderRootInput.value || "";
    localFolderRootInput.value = res.path;
    chrome.storage.local.set({ localFolderRootPath: res.path });
    if (prevRoot && prevRoot !== res.path) {
      // 切換到不同的專案資料夾：先清掉畫面上舊專案的資料，避免混在一起。真正的
      // 上傳區顯示與否交給接下來的 openLocalProject() 依實際結果決定。
      resetLoadedExcelState(false);
    }
    openLocalProject(res.path, expectedMode);
  });
}

localFolderNewProjectBtn?.addEventListener("click", () => {
  showLfTipThen("newProject", () => pickLocalFolderAndConnect("new", localFolderNewProjectBtn));
});
localFolderResumeProjectBtn?.addEventListener("click", () => {
  showLfTipThen("resumeProject", () => pickLocalFolderAndConnect("resume", localFolderResumeProjectBtn));
});

function runLocalFolderReconcile() {
  if (!cachedArrayBuffer) {
    appendLog("⚠ 請先選擇專案資料夾並載入 Excel 後再核對。", "warn");
    return;
  }
  localFolderReconcileBtn.disabled = true;
  appendLog("🔄 開始核對進度…", "info");
  // 核對比對的是 background 那邊 storage 裡現存最新的 Excel 本身（見
  // background.js buildAllRowsFromStorage()），不是這裡送過去的任何快照。
  chrome.runtime.sendMessage({ action: "RECONCILE_LOCAL_FOLDER" }, res => {
    localFolderReconcileBtn.disabled = false;
    if (res?.ok) {
      renderLocalFolderDiff(res.diff);
    } else {
      appendLog(`❌ 核對進度失敗：${res?.error || "未知錯誤"}`, "fail");
    }
  });
}

localFolderReconcileBtn?.addEventListener("click", () => {
  showLfTipThen("reconcile", runLocalFolderReconcile);
});

// ══════════════════════════════════
// 按鈕事件
// ══════════════════════════════════

// 共用啟動邏輯：一般下載與測試下載都走這裡，只有 targetsList 跟 testMode 不同
function launchDownload(targetsList, { testMode = false } = {}) {
  if (!targetsList.length) return;
  const politeMode = politeModeInput?.checked || false;
  const selectedConcurrent = parseInt(concurrentSelect.value);
  const concurrent = politeMode ? Math.min(selectedConcurrent || 1, 2) : selectedConcurrent;
  const downloadFolder = sanitizeDownloadFolder(downloadFolderInput?.value || getDefaultDownloadFolder());
  const batchSize   = Math.max(0, parseInt(batchSizeInput?.value || "0", 10) || 0);
  const stopAfter   = Math.max(0, parseInt(stopAfterInput?.value  || "0", 10) || 0);
  // 記憶資料夾名稱（API 憑證由 api_settings.js 隨輸入即時儲存）
  chrome.storage.local.set({ downloadFolder });
  resultsMap = {}; resultsFailMap = {};
  sessionUpdatedRows = new Set();
  // 清除 Worker log tab（重新開始）
  logTabWorkers.innerHTML = "";
  logTabMore.innerHTML = "<option value=''>更多 Worker ▼</option>";
  logTabMore.style.display = "none";
  document.querySelectorAll(".log-wrap:not(#logWrap-global)").forEach(el => el.remove());
  Object.keys(workerAnchorMap).forEach(k => delete workerAnchorMap[k]);
  Object.keys(rowAnchorMap).forEach(k => delete rowAnchorMap[k]);
  workerLogCount = 0;
  switchLogTab(-1);
  // Excel 寫入由 background 負責

  startBtn.disabled  = true;
  pauseBtn.disabled  = false;
  stopBtn.disabled   = false;
  statusText.textContent = testMode ? "⚙ 測試下載啟動中..." : "⚙ 啟動中...";

  chrome.runtime.sendMessage({
    action:     "START_DOWNLOAD",
    targets:    targetsList,
    concurrent,
    downloadFolder,
    batchSize,
    politeMode,
    stopAfter,
    manualVerifyPause: manualVerifyPauseInput?.checked !== false,
    publisherApiCreds: AdvancedSettings.getCreds(),
    testMode,
  }, res => {
    if (!res?.ok) {
      appendLog(`❌ 啟動失敗：${res?.error}`, "fail");
      startBtn.disabled = false;
    } else {
      appendLog(testMode
        ? `🧪 測試下載已在背景啟動（共 ${targetsList.length} 篇，忽略下載狀況與篩選）`
        : "🚀 下載已在背景啟動，可自由切換分頁", "info");
    }
  });
}

// 開始
startBtn.addEventListener("click", () => {
  if (cachedArrayBuffer) {
    const filterMode = getFilterMode();
    document.getElementById("downloadAllCheck").value = filterMode === "all" ? "1" : "0";
    allParsedTargets = parseExcel(cachedArrayBuffer, filterMode);
    const rangeInfo = applyRange(allParsedTargets, startFromInput?.value || "", endAtInput?.value || "");
    if (rangeInfo.startNotFound) {
      alert("找不到指定的起始 PMID/title，請修正或留空。");
      return;
    }
    if (rangeInfo.endNotFound) {
      alert("找不到指定的結束 PMID/title，請修正或留空。");
      return;
    }
    if (rangeInfo.rangeInvalid) {
      alert("結束論文出現在起始論文之前，請修正起始/結束範圍。");
      return;
    }
    targets = rangeInfo.list;
    const modeText = filterModeText(filterMode);
    renderFileInfoLine(originalFilename, targets.length, modeText);
  }
  launchDownload(targets, { testMode: false });
});

// 測試下載（Debug 用）：依指定的 PMID/Title 強制下載，忽略下載狀況與 Column M 篩選
testDownloadBtn?.addEventListener("click", () => {
  if (!cachedArrayBuffer) { alert("請先上傳 Excel。"); return; }
  const queryLines = (testDownloadInput?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
  if (!queryLines.length) { alert("請輸入至少一個 PMID 或 Title（每行一個）。"); return; }

  let parsed;
  try {
    parsed = parseExcelForTest(cachedArrayBuffer, queryLines);
  } catch (e) {
    alert("解析失敗：" + e.message);
    return;
  }

  const { items, unmatchedQueries } = parsed;
  if (!items.length) {
    if (testDownloadMatchInfo) testDownloadMatchInfo.textContent = "⚠ 找不到符合的文獻";
    alert("找不到符合指定 PMID/Title 的文獻，請確認輸入是否正確。");
    return;
  }

  const shortTitle = t => (t.length > 40 ? t.slice(0, 40) + "…" : t);
  const summary = items.map(it => `PMID ${it.pmid || "-"}｜${shortTitle(it.title)}`).join("\n");
  const unmatchedNote = unmatchedQueries.length
    ? `\n\n⚠ 以下查詢沒有找到符合的文獻：\n${unmatchedQueries.join("\n")}`
    : "";
  if (!confirm(`即將測試下載 ${items.length} 篇（忽略下載狀況、Storage 完成紀錄與 Column M 篩選）：\n\n${summary}${unmatchedNote}\n\n確定要開始嗎？`)) return;

  if (testDownloadMatchInfo) {
    testDownloadMatchInfo.textContent = `✅ 已匹配 ${items.length} 篇` +
      (unmatchedQueries.length ? `，${unmatchedQueries.length} 筆查詢未匹配` : "");
  }
  appendLog(`🧪 測試下載：匹配到 ${items.length} 篇 → ${items.map(it => it.pmid || shortTitle(it.title)).join(", ")}`, "warn");
  if (unmatchedQueries.length) {
    appendLog(`⚠ 測試下載：${unmatchedQueries.length} 筆查詢沒有匹配到文獻：${unmatchedQueries.join(" | ")}`, "warn");
  }
  launchDownload(items, { testMode: true });
});

// 暫停
pauseBtn.addEventListener("click", () => {
  isPaused = true;
  pauseBtn.style.display  = "none";
  resumeBtn.style.display = "inline-block";
  resumeBtn.disabled = false;
  chrome.runtime.sendMessage({ action: "PAUSE_DOWNLOAD" });
  statusText.textContent = "⏸ 等待當前篇完成後暫停...";
  appendLog("⏸ 休息一下（當前篇跑完後才會停，Worker 狀態列會顯示進度）", "warn");
  // 立刻更新 worker 顯示，告訴使用者還在跑
  chrome.runtime.sendMessage({ action: "GET_STATE" }, res => {
    if (res?.state?.workers) updateWorkers(res.state.workers, true);
  });
  // 從 background 拿最新狀態同步顯示（Excel 寫入由 background 負責）
  chrome.runtime.sendMessage({ action: "GET_RESULTS" }, res => {
    if (res?.resultsMap) resultsMap = res.resultsMap;
    if (res?.resultsFailMap) Object.assign(resultsFailMap, res.resultsFailMap);
    // Excel 寫入由 background 負責
  });
});

// 繼續
resumeBtn.addEventListener("click", () => {
  isPaused = false;
  resumeBtn.style.display = "none";
  pauseBtn.style.display  = "inline-block";
  pauseBtn.disabled = false;
  chrome.runtime.sendMessage({ action: "RESUME_DOWNLOAD" });
  statusText.textContent = "⚙ 繼續下載...";
  appendLog("▶ 繼續下載", "ok");
});

// 停止
stopBtn.addEventListener("click", () => {
  if (!confirm("確定要結束本次任務？已完成的進度會保留。")) return;
  chrome.runtime.sendMessage({ action: "STOP_DOWNLOAD" });
  // 從 background 拿最新狀態同步顯示（Excel 寫入由 background 負責）
  chrome.runtime.sendMessage({ action: "GET_RESULTS" }, res => {
    if (res?.resultsMap) resultsMap = res.resultsMap;
    if (res?.resultsFailMap) Object.assign(resultsFailMap, res.resultsFailMap);
    if (cachedArrayBuffer && Object.keys(resultsMap).length > 0) {
      // Excel 寫入由 background 負責
      appendLog("💾 進度已儲存至 Excel", "info");
    }
  });
  startBtn.disabled  = false;
  pauseBtn.disabled  = true;
  resumeBtn.disabled = true;
  stopBtn.disabled   = true;
  pauseBtn.style.display  = "inline-block";
  resumeBtn.style.display = "none";
  downloadExcelBtn.style.display = "block";
  document.getElementById("progressTableBtn").style.display = "block";
  statusText.textContent  = "⏹ 已結束本次任務";
  isPaused = false;
});

// 清除／重設：回到「就像剛裝好擴充功能」的一片空白狀態——不管手上這個專案處理到
// 一半發生什麼問題，都可以直接砍掉重練：停止進行中的下載、清掉目前接的本地資料夾
// 專案連結（含 storage 裡記住的路徑），畫面也一併歸零，之後用「🆕 建立並選取全新
// 專案資料夾」或「📂 選取已存在專案資料夾」重新選擇即可，不會殘留任何舊專案的痕跡。
clearBtn.addEventListener("click", () => {
  if (!confirm("重設介面？\n如果下載正在執行中，將會強制停止；本地資料夾模式目前接的專案連結也會一併斷開（不會刪除資料夾裡的任何檔案，只是清掉「目前接的是哪個專案」這個記錄）。")) return;
  chrome.runtime.sendMessage({ action: "RESET_EXTENSION" });

  // 本地資料夾模式的連結狀態：storage 那份已經交給 RESET_EXTENSION 清了，這裡
  // 同步歸零畫面，並恢復成預設開啟、但還沒接任何專案的樣子——上傳區維持隱藏，
  // 等使用者按「🆕 建立並選取全新專案資料夾」選到空資料夾後才顯示。
  if (localFolderRootInput) localFolderRootInput.value = "";
  if (localFolderSummary) localFolderSummary.textContent = "";
  if (localFolderModeInput) localFolderModeInput.checked = true;
  if (localFolderControls) localFolderControls.style.display = "flex";
  setUploadAreaVisible(false);

  targets = []; allParsedTargets = []; workbookData = null; resultsMap = {}; resultsFailMap = {};
  initialStatusMap = {};
  sessionUpdatedRows = new Set();
  cachedArrayBuffer = null; originalFilename = "";
  Object.keys(workerAnchorMap).forEach(k => delete workerAnchorMap[k]);
  Object.keys(rowAnchorMap).forEach(k => delete rowAnchorMap[k]);
  document.querySelectorAll(".log-wrap").forEach(el => el.innerHTML = "");
  document.querySelectorAll(".log-wrap:not(#logWrap-global)").forEach(el => el.remove());
  logTabWorkers.innerHTML = "";
  logTabMore.innerHTML = "<option value=''>更多 Worker ▼</option>";
  logTabMore.style.display = "none";
  switchLogTab(-1);
  fileInfo.style.display        = "none";
  settingsRow.style.display     = "none";
  if (folderRow)        folderRow.style.display        = "none";
  if (batchRow)         batchRow.style.display         = "none";
  if (politeModeRow)    politeModeRow.style.display    = "none";
  AdvancedSettings.hide();
  if (verifySection)    verifySection.style.display    = "none";
  if (startFromRow)     startFromRow.style.display     = "none";
  if (endAtRow)         endAtRow.style.display         = "none";
  if (stopAfterRow)     stopAfterRow.style.display     = "none";
  if (testToolsRow) testToolsRow.style.display = "none";
  if (testToolsPanel) testToolsPanel.style.display = "none";
  if (testToolsToggleBtn) testToolsToggleBtn.textContent = "🧪 測試工具";
  if (testDownloadInput)   testDownloadInput.value = "";
  if (testDownloadMatchInfo) testDownloadMatchInfo.textContent = "";
  if (resultDetailPanel) resultDetailPanel.style.display = "none";
  if (progressTablePanel) progressTablePanel.style.display = "none";
  if (progressTableBtn)   progressTableBtn.style.display   = "none";
  threadLogs = [];
  renderThreadLog();
  threadLogPanel?.classList.remove("open");
  threadLogPanel?.setAttribute("aria-hidden", "true");
  statsGrid.style.display       = "none";
  progressSection.style.display = "none";
  workersSection.style.display  = "none";
  logSection.style.display      = "none";
  downloadExcelBtn.style.display = "none";
  startBtn.disabled  = true;
  pauseBtn.disabled  = true;
  resumeBtn.disabled = true;
  stopBtn.disabled   = true;
  fileInput.value    = "";
  if (downloadFolderInput) downloadFolderInput.value = getDefaultDownloadFolder();
  if (batchSizeInput) batchSizeInput.value = "0";
  if (startFromInput) startFromInput.value = "";
  if (endAtInput) endAtInput.value = "";
  if (stopAfterInput) stopAfterInput.value = "200";
  if (politeModeInput) politeModeInput.checked = true;
  if (manualVerifyPauseInput) manualVerifyPauseInput.checked = true;
  const filterY = document.getElementById("filterY");
  const filterAll = document.getElementById("filterAll");
  const filterRetry = document.getElementById("filterRetry");
  if (filterY) filterY.checked = true;
  if (filterAll) filterAll.checked = false;
  if (filterRetry) filterRetry.checked = false;
  document.getElementById("downloadAllCheck").value = "0";
  document.getElementById("countY").textContent = "-";
  document.getElementById("countAll").textContent = "-";
  const countRetryEl = document.getElementById("countRetry");
  if (countRetryEl) countRetryEl.textContent = "-";
  updateStats(0, 0, 0, 0);
  updateProgress(0, 0);
  statsGrid.style.display       = "none";
  progressSection.style.display = "none";
  if (workerList) workerList.innerHTML = "";
  if (resultDetailList) resultDetailList.innerHTML = "";
  if (progressTableBtn) progressTableBtn.textContent = "\ud83d\udccb \u67e5\u770b\u4e0b\u8f09\u9032\u5ea6";
  pauseBtn.style.display  = "inline-block";
  resumeBtn.style.display = "none";
  isPaused = false;
  statusText.textContent = "請上傳 Excel 檔案";
});

// 下載結果 Excel
downloadExcelBtn.addEventListener("click", () => {
  // 請 background 從 storage 讀最新 Excel 並讓使用者選位置下載
  chrome.runtime.sendMessage({ action: "EXPORT_EXCEL" }, res => {
    if (!res?.ok) appendLog(`❌ 匯出失敗：${res?.error || "未知錯誤"}`, "fail");
  });
});

// ── 登入送出 ──
loginSubmitBtn.addEventListener("click", sendLogin);
openDownloadSettingsBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
});
document.querySelectorAll(".stat-box[data-result-filter]").forEach(box => {
  box.addEventListener("click", () => showResultDetails(box.dataset.resultFilter));
});
document.querySelector(".stat-box.total")?.addEventListener("click", () => showResultDetails("all"));
document.querySelector(".stat-box.ok")?.addEventListener("click", () => showResultDetails("success"));
document.querySelector(".stat-box.fail")?.addEventListener("click", () => showResultDetails("fail"));
document.querySelector(".stat-box.skip")?.addEventListener("click", () => showResultDetails("pending"));
resultDetailClose?.addEventListener("click", () => {
  resultDetailPanel.style.display = "none";
});
loginPassword.addEventListener("keydown", e => { if (e.key === "Enter") sendLogin(); });

function sendLogin() {
  const u   = loginUsername.value.trim();
  const p   = loginPassword.value;
  const cap = (document.getElementById("loginCaptchaInput")?.value || "").trim();
  if (!u || !p) { alert("請輸入帳號和密碼"); return; }

  const capWrap = document.getElementById("loginCaptchaWrap");
  if (capWrap && capWrap.style.display !== "none" && !cap) {
    alert("請輸入驗證碼"); return;
  }

  chrome.runtime.sendMessage({ action: "LOGIN_SUBMIT", username: u, password: p, captcha: cap });
  loginSubmitBtn.textContent = "登入中...";
  loginSubmitBtn.disabled    = true;
}

// ── 驗證碼送出 ──
captchaSubmitBtn.addEventListener("click", sendCaptcha);
captchaInput.addEventListener("keydown", e => { if (e.key === "Enter") sendCaptcha(); });

function sendCaptcha() {
  const answer = captchaInput.value.trim();
  if (!answer) { alert("請輸入驗證碼"); return; }
  hideCaptchaSection();
  chrome.runtime.sendMessage({ action: "CAPTCHA_ANSWER", answer });
}

// ── 上傳事件 ──
uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("dragover", e => { e.preventDefault(); uploadArea.classList.add("drag-over"); });
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("drag-over"));
uploadArea.addEventListener("drop", e => {
  e.preventDefault(); uploadArea.classList.remove("drag-over");
  const f = e.dataTransfer.files[0]; if (f) handleFile(f);
});
fileInput.addEventListener("change", e => { const f = e.target.files[0]; if (f) handleFile(f); });

// 清除 storage 進度紀錄
document.getElementById("clearStorageBtn")?.addEventListener("click", () => {
  if (!confirm("確定要清除 Storage 進度紀錄？\n（這不會影響已下載的 PDF 或 Excel 檔案）")) return;
  chrome.storage.local.remove(["completedPmids", "downloadFolder"], () => {
    appendLog("🗑 Storage 進度紀錄已清除，下次上傳 Excel 將從頭計算", "warn");
  });
});

// ── Alt+S 暫停/繼續 ──
document.addEventListener("keydown", e => {
  if (e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!pauseBtn.disabled && pauseBtn.style.display !== "none") {
      pauseBtn.click();
    } else if (!resumeBtn.disabled && resumeBtn.style.display !== "none") {
      resumeBtn.click();
    }
  }
});

// ══════════════════════════════════════════════════
// 進度表格
// ══════════════════════════════════════════════════

const progressTablePanel = document.getElementById("progressTablePanel");
const progressTableBtn   = document.getElementById("progressTableBtn");
const progressTableClose = document.getElementById("progressTableClose");
const ptSearch           = document.getElementById("ptSearch");
const ptFilter           = document.getElementById("ptFilter");
const ptBody             = document.getElementById("ptBody");
const ptCount            = document.getElementById("ptCount");
const ptTotal            = document.getElementById("ptTotal");
const ptSummaryBar       = document.getElementById("ptSummaryBar");

const STATUS_COLOR = {
  "下載成功": { bg: "#dcfce7", color: "#15803d", icon: "✅" },
  "下載失敗": { bg: "#fee2e2", color: "#dc2626", icon: "❌" },
  "下次重試": { bg: "#fef3c7", color: "#b45309", icon: "↻" },
  "未下載":   { bg: "#f1f5f9", color: "#64748b", icon: "⏳" },
  "跳過":     { bg: "#f3f4f6", color: "#9ca3af", icon: "⚪" },
};

function getItemStatus(item) {
  return resultsMap[item.rowIndex] || item.status || STATUS_PENDING;
}

function renderProgressTable() {
  // 只在面板開著時才更新，節省效能
  if (progressTablePanel.style.display === "none") return;

  const search    = (ptSearch.value || "").toLowerCase();
  const filterVal = ptFilter.value;

  // 合併 allParsedTargets（包含跳過的）和 targets（本次要跑的）
  const allItems = allParsedTargets.length ? allParsedTargets : targets;

  // 更新摘要列
  let ok = 0, fail = 0, skip = 0, pending = 0;
  allItems.forEach(item => {
    const s = getItemStatus(item);
    if (s === STATUS_SUCCESS) ok++;
    else if (s === STATUS_FAIL || s === STATUS_RETRY) fail++;
    else if (s === "跳過") skip++;
    else pending++;
  });
  ptSummaryBar.textContent =
    `✅ 成功 ${ok}　❌ 失敗 ${fail}　⚪ 跳過 ${skip}　⏳ 未下載 ${pending}　共 ${allItems.length} 篇`;
  ptTotal.textContent = allItems.length;

  // 篩選
  const filtered = allItems.filter(item => {
    const status = getItemStatus(item);
    if (filterVal !== "all" && status !== filterVal) return false;
    if (search) {
      const pmid  = String(item.pmid || "").toLowerCase();
      const title = String(item.title || "").toLowerCase();
      if (!pmid.includes(search) && !title.includes(search)) return false;
    }
    return true;
  });

  ptCount.textContent = filtered.length;

  // 渲染（只渲染前 500 筆，超過時顯示提示）
  const MAX_ROWS = 500;
  const toRender = filtered.slice(0, MAX_ROWS);

  ptBody.innerHTML = toRender.map(item => {
    const status  = getItemStatus(item);
    const style   = STATUS_COLOR[status] || STATUS_COLOR["未下載"];
    const titleShort = item.title ? (item.title.length > 80 ? item.title.slice(0, 80) + "…" : item.title) : "（無標題）";
    const isFail = (status === STATUS_FAIL);
    const anchorId = rowAnchorMap[item.rowIndex] || "";
    // MV3 CSP 禁止 inline onclick（會被靜默擋掉），改用 data-anchor + 事件委派
    const clickable = isFail && anchorId
      ? `data-anchor="${anchorId}" style="cursor:pointer;border-bottom:1px solid #f0f0f0;" title="點擊查看 Worker Log"`
      : `style="border-bottom:1px solid #f0f0f0;"`;
    return `<tr ${clickable}>
      <td style="padding:4px 8px;color:#555;font-family:Consolas,monospace;">${item.pmid || "-"}</td>
      <td style="padding:4px 8px;color:#222;" title="${item.title || ""}">${titleShort}${isFail && anchorId ? ' <span style="color:#aaa;font-size:9px;">→ log</span>' : ''}</td>
      <td style="padding:4px 8px;text-align:center;">
        <span style="background:${style.bg};color:${style.color};padding:2px 6px;border-radius:10px;font-size:10px;white-space:nowrap;">
          ${style.icon} ${status}
        </span>
      </td>
    </tr>`;
  }).join("");

  if (filtered.length > MAX_ROWS) {
    ptBody.innerHTML += `<tr><td colspan="3" style="padding:6px 8px;color:#999;text-align:center;font-size:10px;">
      僅顯示前 ${MAX_ROWS} 筆，請使用搜尋或篩選縮小範圍
    </td></tr>`;
  }
}

// 開關表格面板
progressTableBtn?.addEventListener("click", () => {
  const isOpen = progressTablePanel.style.display !== "none";
  progressTablePanel.style.display = isOpen ? "none" : "block";
  progressTableBtn.textContent = isOpen ? "📋 查看下載進度" : "📋 收起進度表";
  if (!isOpen) renderProgressTable();
});

progressTableClose?.addEventListener("click", () => {
  progressTablePanel.style.display = "none";
  progressTableBtn.textContent = "📋 查看下載進度";
});

document.getElementById("progressTableClose2")?.addEventListener("click", () => {
  progressTablePanel.style.display = "none";
  progressTableBtn.textContent = "📋 查看下載進度";
});

// 搜尋 / 篩選即時更新
ptSearch?.addEventListener("input", renderProgressTable);
ptFilter?.addEventListener("change", renderProgressTable);

// 失敗列點擊 → 跳到對應 Worker log（inline onclick 會被擴充功能 CSP 擋掉，用事件委派）
ptBody?.addEventListener("click", e => {
  const tr = e.target.closest("tr[data-anchor]");
  if (tr) jumpToWorkerLog(tr.dataset.anchor);
});

// 上傳 Excel 後顯示查看按鈕並初始化表格資料
function showProgressTableBtn() {
  progressTableBtn.style.display = "block";
}
