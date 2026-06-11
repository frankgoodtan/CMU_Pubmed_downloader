/**
 * popup.js v6
 * UI 控制、Excel 解析、與 background 通訊
 * popup 不會因切換分頁而消失（已改為固定視窗模式）
 */

// ── 欄位對應（0-based index）──
const COL_PMID    = 1;   // B
const COL_TITLE   = 2;   // C
const COL_INCLUDE = 12;  // M
const COL_RESULT  = 17;  // R（原始是否可取得全文）
const COL_STATUS  = 21;  // V（下載狀況，本程式寫入）
const SHEET_NAME  = "CANCER papers(all years)";

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
const stopAfterInput   = document.getElementById("stopAfterInput");
const stopAfterRow     = document.getElementById("stopAfterRow");
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
  // ── 從 storage 恢復上次的完成紀錄 & 資料夾名稱 ──
  chrome.storage.local.get(["completedPmids", "completedCount", "downloadFolder"], data => {
    const pmids = data.completedPmids || [];
    if (pmids.length > 0) {
      appendLog(`💾 Storage 紀錄：上次共完成 ${pmids.length} 篇，上傳進度 Excel 後將自動跳過`, "info");
    }
    // 恢復上次的資料夾名稱
    if (data.downloadFolder && downloadFolderInput && data.downloadFolder !== "PubMed_PDFs") {
      downloadFolderInput.value = data.downloadFolder;
    }
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
  if (msg.action === "LOGIN_OK") {
    hideLoginSection();
    hideManualLoginWait();
    statusText.textContent = "✅ 登入成功，下載中...";
  }
  if (msg.action === "CAPTCHA_OK")   hideCaptchaSection();
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

// ══════════════════════════════════
// Excel 解析
// ══════════════════════════════════
function sanitizeFilename(title) {
  if (!title) return "untitled";
  return title
    .replace(/[?/\\:*"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
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

function applyStartFrom(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { list, index: 0, matched: null };

  const index = list.findIndex(item => {
    const pmid = String(item.pmid || "").toLowerCase();
    const title = String(item.title || "").toLowerCase();
    return pmid === q || pmid.includes(q) || title.includes(q);
  });

  if (index < 0) return { list, index: 0, matched: null, notFound: true };
  return { list: list.slice(index), index, matched: list[index] };
}

function parseExcel(arrayBuffer, downloadAll, options = {}) {
  const recordInitial = options.recordInitial !== false;
  if (recordInitial) initialStatusMap = {};
  if (typeof XLSX === "undefined") throw new Error("SheetJS 未載入");
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  workbookData = wb;

  // 找目標工作表
  let ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    ws = wb.Sheets[wb.SheetNames[1]];
    if (!ws) throw new Error(`找不到工作表「${SHEET_NAME}」`);
  }

  const rows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // 動態找「下載狀況」欄位（允許不在固定欄）
  const headerRow = rows[0] || [];
  let statusColIdx = COL_STATUS;
  for (let c = 0; c < headerRow.length; c++) {
    if (String(headerRow[c] || "").trim() === "下載狀況") { statusColIdx = c; break; }
  }

  const found = [];
  let skippedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(v => v === null)) continue;

    // 篩選邏輯
    if (!downloadAll) {
      const include = String(row[COL_INCLUDE] || "").trim().toUpperCase();
      if (include !== "Y") continue;
    }

    const pmidRaw = row[COL_PMID];
    const title   = row[COL_TITLE];
    if (!pmidRaw && !title) continue;

    const pmid      = pmidRaw ? String(parseInt(String(pmidRaw), 10)) : null;
    const titleStr  = title ? String(title).trim() : "";
    const safeTitle = sanitizeFilename(titleStr);

    // ── 斷點續傳：跳過上次已成功或失敗的列 ──
    const prevStatus = String(row[statusColIdx] || "").trim();
    if (recordInitial && prevStatus) initialStatusMap[i + 1] = prevStatus;
    if (prevStatus === STATUS_SUCCESS || prevStatus === STATUS_FAIL) {
      skippedCount++;
      // 恢復進 resultsMap，讓 UI 能正確顯示
      resultsMap[i + 1] = prevStatus;
      continue;
    }

    found.push({
      rowIndex:  i + 1,
      pmid,
      title:     titleStr,
      safeTitle,
      status:    prevStatus || STATUS_PENDING,
    });
  }

  if (skippedCount > 0) {
    appendLog(`⏭ 已跳過 ${skippedCount} 篇（進度 Excel 標記為「下載成功」或「下載失敗」）`, "ok");
  }

  return found;
}

// ══════════════════════════════════
// 匯出結果 Excel
// ══════════════════════════════════
function exportResultExcel(rMap, originalFilename) {
  if (!workbookData) return;
  const wb = workbookData;
  const sheetName = wb.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : wb.SheetNames[1];
  const ws        = wb.Sheets[sheetName];

  // 找最後一欄（新增「自動下載狀態」）
  const range  = XLSX.utils.decode_range(ws["!ref"] || "A1");
  const newCol = range.e.c + 1;  // 緊接在最後一欄後

  // 寫標題
  const headerCell = XLSX.utils.encode_cell({ r: 0, c: newCol });
  ws[headerCell] = { v: "自動下載狀態", t: "s" };

  // 寫每列結果
  for (const [rowIndex, status] of Object.entries(rMap)) {
    const cellAddr = XLSX.utils.encode_cell({ r: parseInt(rowIndex) - 1, c: newCol });
    ws[cellAddr] = { v: status, t: "s" };
  }

  // 更新 range
  range.e.c = newCol;
  ws["!ref"] = XLSX.utils.encode_range(range);

  // 輸出
  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob  = new Blob([wbout], { type: "application/octet-stream" });
  const url   = URL.createObjectURL(blob);
  const base  = (originalFilename || "CANCER_PAPERS").replace(/\.xlsx$/i, "");
  chrome.downloads.download({ url, filename: `${base}_自動處理結果.xlsx`, saveAs: true });
}

// ══════════════════════════════════
// 上傳處理
// ══════════════════════════════════
// Excel 寫入鎖（防止並行 worker 同時觸發覆寫衝突）
let excelWriting = false;
let excelDebounceTimer = null;

function scheduleExcelWrite(rMap) {
  // debounce：最後一篇完成後 800ms 才寫，合併連續完成的多篇
  if (excelDebounceTimer) clearTimeout(excelDebounceTimer);
  excelDebounceTimer = setTimeout(() => {
    excelDebounceTimer = null;
    downloadProgressExcel(rMap, false);
  }, 800);
}

function downloadProgressExcel(rMap = {}, saveAs = false) {
  if (!cachedArrayBuffer) return;
  if (!saveAs && excelWriting) return;

  excelWriting = true;

  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) { excelWriting = false; return; }

  const workbook = new ExcelJS.Workbook();
  workbook.xlsx.load(cachedArrayBuffer).then(() => {
    const sheetName = workbook.worksheets.find(s => s.name === SHEET_NAME)
      ? SHEET_NAME : workbook.worksheets[1]?.name;
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) { excelWriting = false; return; }

    // 找或建「下載狀況」欄
    const headerRow = ws.getRow(1);
    let statusCol = -1;
    let failReasonCol = -1;
    headerRow.eachCell((cell, colNum) => {
      const v = String(cell.value || "").trim();
      if (v === "下載狀況") statusCol = colNum;
      if (v === "失敗訊息") failReasonCol = colNum;
    });
    if (statusCol < 0) {
      statusCol = ws.columnCount + 1;
      headerRow.getCell(statusCol).value = "下載狀況";
      headerRow.getCell(statusCol).font = { bold: true };
    }
    if (failReasonCol < 0) {
      failReasonCol = statusCol + 1;
      // 確保不蓋到已有資料的欄
      while (ws.getRow(1).getCell(failReasonCol).value &&
             String(ws.getRow(1).getCell(failReasonCol).value).trim() !== "失敗訊息") {
        failReasonCol++;
      }
      headerRow.getCell(failReasonCol).value = "失敗訊息";
      headerRow.getCell(failReasonCol).font = { bold: true };
    }

    const YELLOW   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } }; // 螢光黃：下載成功
    const ORANGE   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFA500" } }; // 橘色：下載失敗
    // ExcelJS 的「無填色」必須用 pattern:'none'，type:'none' 是無效格式
    const NO_FILL  = { type: "pattern", pattern: "none" };

    function getFill(status, inSession) {
      if (!inSession) return NO_FILL;
      if (status === STATUS_FAIL) return ORANGE;
      if (status === STATUS_RETRY) return { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      if (status === STATUS_SUCCESS) return YELLOW;
      return NO_FILL;
    }

    // ── Step 1：只清除螢光黃（#FFFF00）的欄位，其他填色保留 ──
    const YELLOW_ARGB = "FFFFFF00";
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 保留標題列
      const cell = row.getCell(statusCol);
      const argb = cell.fill?.fgColor?.argb || cell.fill?.bgColor?.argb || "";
      if (argb.toUpperCase() === YELLOW_ARGB.toUpperCase()) {
        cell.fill = NO_FILL;
      }
    });

    // ── Step 2：寫入狀態值，本次 session 處理過的列填色 ──
    // 成功 → 螢光黃；失敗 → 橘色；其他 → 無填色
    const allItems = allParsedTargets.length ? allParsedTargets : targets;
    for (const item of allItems) {
      const status = rMap[item.rowIndex] || initialStatusMap[item.rowIndex] || item.status || STATUS_PENDING;
      const row = ws.getRow(item.rowIndex);
      const cell = row.getCell(statusCol);
      cell.value = status;
      cell.fill = getFill(status, sessionUpdatedRows.has(item.rowIndex));
      // 失敗訊息欄
      const failCell = row.getCell(failReasonCol);
      if ((status === STATUS_FAIL || status === STATUS_RETRY) && resultsFailMap[item.rowIndex]) {
        failCell.value = resultsFailMap[item.rowIndex];
      } else if (status === STATUS_SUCCESS) {
        failCell.value = null; // 成功就清空失敗訊息
      }
    }

    // rMap 裡其他列（上次已成功跳過的）
    for (const [rowIndex, status] of Object.entries(rMap || {})) {
      const ri = parseInt(rowIndex, 10);
      if (!allItems.find(it => it.rowIndex === ri)) {
        const row = ws.getRow(ri);
        const cell = row.getCell(statusCol);
        cell.value = status || STATUS_FAIL;
        cell.fill = getFill(status || STATUS_FAIL, sessionUpdatedRows.has(ri));
        const failCell = row.getCell(failReasonCol);
        if (((status || STATUS_FAIL) === STATUS_FAIL || (status || STATUS_FAIL) === STATUS_RETRY) && resultsFailMap[ri]) {
          failCell.value = resultsFailMap[ri];
        }
      }
    }

    const base = (originalFilename || "CANCER_PAPERS")
      .replace(/\.xlsx$/i, "")
      .replace(/_下載進度管理$/i, "");
    const folder = sanitizeDownloadFolder(downloadFolderInput?.value || getDefaultDownloadFolder());

    workbook.xlsx.writeBuffer().then(buffer => {
      const blob = new Blob([buffer], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url,
        filename: `${folder}/${base}_下載進度管理.xlsx`,
        saveAs,
        conflictAction: "overwrite",
      }, () => {
        excelWriting = false;
        URL.revokeObjectURL(url);
      });
      setTimeout(() => { excelWriting = false; }, 10000);
    }).catch(() => { excelWriting = false; });

  }).catch(() => { excelWriting = false; });
}


function findOrCreateStatusColumn(ws, range) {
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    const value = String(cell?.v || cell?.w || "").trim();
    if (value === "下載狀況") return c;
  }
  return range.e.c + 1;
}

function handleFile(file) {
  if (!file.name.endsWith(".xlsx")) { alert("請選擇 .xlsx 格式！"); return; }
  originalFilename = file.name;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      cachedArrayBuffer = e.target.result;
      resultsMap = {}; resultsFailMap = {};
      sessionUpdatedRows = new Set();
      const downloadAll = document.getElementById("filterAll")?.checked || false;
      document.getElementById("downloadAllCheck").value = downloadAll ? "1" : "0";
      allParsedTargets = parseExcel(e.target.result, downloadAll);
      const startInfo = applyStartFrom(allParsedTargets, startFromInput?.value || "");
      targets = startInfo.list;
      if (startInfo.notFound) {
        appendLog("⚠ 找不到指定的起始 PMID/title，已改為從頭開始。", "warn");
      } else if (startInfo.matched) {
        appendLog(`↪ 從第 ${startInfo.index + 1} 筆目標開始: ${startInfo.matched.pmid || ""} ${startInfo.matched.title || ""}`, "info");
      }

      // 計算 Y 篇數和全部篇數供顯示
      try {
        const allTargets = parseExcel(e.target.result, true, { recordInitial: false });
        const yTargets   = parseExcel(e.target.result, false, { recordInitial: false });
        document.getElementById("countY").textContent   = yTargets.length;
        document.getElementById("countAll").textContent = allTargets.length;
      } catch(e) {}
      const modeText = downloadAll ? "全部論文" : "Column M = Y";
      fileInfo.style.display = "block";
      fileInfo.textContent   = `📎 ${file.name}　|　找到 ${targets.length} 篇（${modeText}）`;
      settingsRow.style.display = "flex";
      if (folderRow) folderRow.style.display = "flex";
      if (batchRow) batchRow.style.display = "flex";
      if (politeModeRow) politeModeRow.style.display = "flex";
      if (startFromRow) startFromRow.style.display = "flex";
      if (stopAfterRow) stopAfterRow.style.display = "flex";
      startBtn.disabled = targets.length === 0;
      appendLog(`✅ Excel 解析完成：${targets.length} 篇目標論文（${modeText}）`, "ok");
      statusText.textContent = `已載入 ${targets.length} 篇論文，可開始下載`;
      showProgressTableBtn();
      if (progressTablePanel.style.display !== "none") renderProgressTable();

      // ── 把原始 Excel binary 傳給 background 儲存，讓 background 負責寫入 ──
      const arr = new Uint8Array(cachedArrayBuffer);
      let b64 = "";
      const chunk = 8192;
      for (let i = 0; i < arr.length; i += chunk) {
        b64 += String.fromCharCode(...arr.subarray(i, i + chunk));
      }
      b64 = btoa(b64);
      const folder = sanitizeDownloadFolder(downloadFolderInput?.value || getDefaultDownloadFolder());
      const baseName = originalFilename.replace(/\.xlsx$/i, "").replace(/_下載進度管理$/i, "");
      chrome.runtime.sendMessage({
        action: "SAVE_SOURCE_EXCEL",
        b64,
        meta: {
          sheetName: SHEET_NAME,
          baseName,
          folder,
        }
      });
      appendLog("📤 Excel 已同步至背景，將由背景自動維護進度檔。", "info");
    } catch(err) {
      appendLog(`❌ 解析失敗：${err.message}`, "fail");
    }
  };
  reader.readAsArrayBuffer(file);
}

function rebuildTargetsFromCache() {
  if (!cachedArrayBuffer) return;
  const downloadAll = document.getElementById("filterAll")?.checked || false;
  document.getElementById("downloadAllCheck").value = downloadAll ? "1" : "0";
  allParsedTargets = parseExcel(cachedArrayBuffer, downloadAll);
  const startInfo = applyStartFrom(allParsedTargets, startFromInput?.value || "");
  targets = startInfo.list;
  const modeText = downloadAll ? "全部下載" : "Column M = Y";
  fileInfo.textContent = `📎 ${originalFilename} | 找到 ${targets.length} 篇（${modeText}）`;
  startBtn.disabled = targets.length === 0;
  updateStats(targets.length, 0, 0, 0);
  appendLog(`🔄 已切換下載範圍：${modeText}，共 ${targets.length} 篇`, "info");
}

document.querySelectorAll("input[name='filterMode']").forEach(input => {
  input.addEventListener("change", rebuildTargetsFromCache);
});

// ══════════════════════════════════
// 按鈕事件
// ══════════════════════════════════

// 開始
startBtn.addEventListener("click", () => {
  if (cachedArrayBuffer) {
    const downloadAll = document.getElementById("filterAll")?.checked || false;
    document.getElementById("downloadAllCheck").value = downloadAll ? "1" : "0";
    allParsedTargets = parseExcel(cachedArrayBuffer, downloadAll);
    const startInfo = applyStartFrom(allParsedTargets, startFromInput?.value || "");
    targets = startInfo.list;
    if (startInfo.notFound) {
      alert("找不到指定的起始 PMID/title，請修正或留空。");
      return;
    }
    const modeText = downloadAll ? "全部下載" : "Column M = Y";
    fileInfo.textContent = `📎 ${originalFilename} | 找到 ${targets.length} 篇（${modeText}）`;
  }
  if (!targets.length) return;
  const politeMode = politeModeInput?.checked || false;
  const selectedConcurrent = parseInt(concurrentSelect.value);
  const concurrent = politeMode ? Math.min(selectedConcurrent || 1, 2) : selectedConcurrent;
  const downloadFolder = sanitizeDownloadFolder(downloadFolderInput?.value || getDefaultDownloadFolder());
  const batchSize   = Math.max(0, parseInt(batchSizeInput?.value || "0", 10) || 0);
  const stopAfter   = Math.max(0, parseInt(stopAfterInput?.value  || "0", 10) || 0);
  // 記憶資料夾名稱，下次開啟自動帶入
  chrome.storage.local.set({ downloadFolder });
  resultsMap = {}; resultsFailMap = {};
  sessionUpdatedRows = new Set();
  // 清除 Worker log tab（重新開始）
  logTabWorkers.innerHTML = "";
  logTabMore.innerHTML = "<option value=''>\u66f4\u591a Worker \u25bc</option>";
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
  statusText.textContent = "⚙ 啟動中...";

  chrome.runtime.sendMessage({
    action:     "START_DOWNLOAD",
    targets,
    concurrent,
    downloadFolder,
    batchSize,
    politeMode,
    stopAfter,
  }, res => {
    if (!res?.ok) {
      appendLog(`❌ 啟動失敗：${res?.error}`, "fail");
      startBtn.disabled = false;
    } else {
      appendLog("🚀 下載已在背景啟動，可自由切換分頁", "info");
    }
  });
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
  // 暫停時取消 debounce，從 background 拿最新狀態立刻寫 Excel
  if (excelDebounceTimer) { clearTimeout(excelDebounceTimer); excelDebounceTimer = null; }
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
  // 結束時取消 debounce，從 background 拿最新狀態立刻寫 Excel
  if (excelDebounceTimer) { clearTimeout(excelDebounceTimer); excelDebounceTimer = null; }
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

// 清除／重設
clearBtn.addEventListener("click", () => {
  if (!confirm("重設介面？\n如果下載正在執行中，將會強制停止。")) return;
  chrome.runtime.sendMessage({ action: "RESET_EXTENSION" });

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
  if (startFromRow)     startFromRow.style.display     = "none";
  if (stopAfterRow)     stopAfterRow.style.display     = "none";
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
  if (stopAfterInput) stopAfterInput.value = "0";
  if (politeModeInput) politeModeInput.checked = true;
  const filterY = document.getElementById("filterY");
  const filterAll = document.getElementById("filterAll");
  if (filterY) filterY.checked = true;
  if (filterAll) filterAll.checked = false;
  document.getElementById("downloadAllCheck").value = "0";
  document.getElementById("countY").textContent = "-";
  document.getElementById("countAll").textContent = "-";
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
  excelWriting = false;
  if (excelDebounceTimer) { clearTimeout(excelDebounceTimer); excelDebounceTimer = null; }
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
    const clickable = isFail && anchorId
      ? `style="cursor:pointer;border-bottom:1px solid #f0f0f0;" onclick="jumpToWorkerLog('${anchorId}')" title="點擊查看 Worker Log"`
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

// 上傳 Excel 後顯示查看按鈕並初始化表格資料
function showProgressTableBtn() {
  progressTableBtn.style.display = "block";
}
