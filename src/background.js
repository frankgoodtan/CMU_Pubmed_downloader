/**
 * PubMed PDF downloader background service worker.
 */
try {
  importScripts("exceljs.bare.min.js");
} catch(e) {
  console.warn("ExcelJS load failed:", e);
}
// 出版商官方 API（Elsevier 等）的註冊表與下載實作，獨立檔案方便維護
try {
  importScripts("publisher_apis.js");
} catch(e) {
  console.warn("publisher_apis load failed:", e);
}
// Full Text 連結的平台判斷表與各平台 PDF 抓取邏輯，獨立資料夾方便維護
// （見 platform_handlers/full_text_platforms.js 開頭的說明）
try {
  importScripts("platform_handlers/full_text_platforms.js");
} catch(e) {
  console.warn("full_text_platforms load failed:", e);
}
// 中文論文（Excel 語言欄=Chinese）查詢流程，獨立檔案方便維護
// （見 platform_handlers/chinese_paper_search.js 開頭的說明）
try {
  importScripts("platform_handlers/chinese_paper_search.js");
} catch(e) {
  console.warn("chinese_paper_search load failed:", e);
}
// 人機驗證流程的模擬測試按鈕，獨立檔案方便維護（見該檔開頭說明）
try {
  importScripts("verify_test.js");
} catch(e) {
  console.warn("verify_test load failed:", e);
}
// 「定位目標元素→算出螢幕絕對座標」的獨立模組，畫愛心提醒動畫時用來對準驗證挑戰
// 元件（見該檔開頭說明，locateTargetElement 是它匯出的全域函式）
try {
  importScripts("location_target/location_target.js");
} catch(e) {
  console.warn("location_target load failed:", e);
}
// Discord 下載狀況通知，獨立資料夾方便維護（見 discord/discord_notifier.js 開頭說明）
try {
  importScripts("discord/discord_notifier.js");
} catch(e) {
  console.warn("discord_notifier load failed:", e);
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
    url: chrome.runtime.getURL("src/popup.html"),
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
// 「🧪 測試下載指定文獻」專用的資料夾（一般 Chrome 下載模式下是 downloadFolder
// 底下的子資料夾；本地資料夾模式下是專案根目錄底下的子資料夾，沒有就用 write_bytes
// 寫檔時自動建立，不需要跟其他保留子資料夾一樣在 init_root 時就先建好）。測試下載
// 全程都用這個資料夾，不進 下載成功/下載失敗/下次重試，也不寫入 G.resultsMap／
// 進度 Excel／Storage 完成紀錄，確保跟正式下載的檔案與進度統計完全分開。
const TEST_FOLDER_NAME = "測試資料夾";
// 本地資料夾模式專案根目錄底下固定會有的四個保留子資料夾名稱（見
// native_host/python_file_manager.py 的 SUBFOLDERS）。OPEN_LOCAL_PROJECT 用這份
// 名單擋下「選到了專案內部的子資料夾，而不是專案本身」的選擇錯誤——不擋的話
// init_root 會在裡面又建一次同樣四個子資料夾，越選越深，見 PROJECT_ROOT_RESERVED_NAMES
// 的呼叫點。
const PROJECT_ROOT_RESERVED_NAMES = [STATUS_SUCCESS, STATUS_FAIL, STATUS_RETRY, "進度管理", TEST_FOLDER_NAME];
const PUBMED_FULL_TEXT_WAIT_MS = 60000;
const WORKER_TAB_RECYCLE_EVERY = 15;

// 彈性 worker 池：某篇處理太久時（反覆重試、等待逾時等，目前還不確定具體會是
// 哪些狀況），讓該 worker 繼續把手上這篇處理完（完成後就結束，不再拿下一篇），
// 同時另開一個新 worker 頂上、接手佇列，避免整體下載速度被單一篇卡住拖慢。
// 為避免系統性問題（例如整段網路斷線，每篇都會卡住）觸發無限新開 worker，
// 同時存在的 worker 總數（原本並行數 + 接手用的）有上限。
const STALL_THRESHOLD_MS      = 40000;  // 單篇處理超過這個時間視為「卡住」
const STALL_THRESHOLD_MS_POLITE = 100000; // 保守模式下卡住視窗拉長，避免慢站被誤判成卡住
const STALL_MAX_TOTAL_WORKERS = 10;     // 同時存在的 worker 總數上限
const STALL_CHECK_INTERVAL_MS = 5000;   // 多久巡視一次是否有 worker 卡住

// ── MV3 service worker keepalive + 系統睡眠阻擋 ──
// 長時間純等待（暫停、等使用者輸入帳密、保守模式休息 1-2 分鐘）期間沒有任何
// chrome API 呼叫，SW 會因 30 秒閒置被 Chrome 終止，記憶體狀態 G 全部消失。
// 下載期間每 20 秒呼叫一次輕量 API 重置閒置計時器。
//
// 同一組 start/stop 順便管 chrome.power：200 篇這種規模跑起來動輒一兩小時，
// 很容易撞到 Windows 預設的系統睡眠時間，睡眠會把整個分頁/網路連線凍結，
// 等於下載被硬生生中斷。requestKeepAwake("system") 只擋「系統睡眠」，不擋
// 「螢幕關閉」——螢幕該多久關掉還是照使用者原本的電源設定走，不需要整台
// 電腦的螢幕一直亮著。暫停不釋放（暫停期間一樣不希望睡眠打斷），只有真正
// 停止/完成/重設才 release。
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
  chrome.power.requestKeepAwake("system");
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  chrome.power.releaseKeepAwake();
}

// ── 下載檔名登記表 ──
// Chrome 已知行為（crbug.com/40706258）：只要「有任何 onDeterminingFilename 監聽器
// 註冊著」，chrome.downloads.download() 的 filename 參數就會被忽略，落回預設檔名
// （data: URL 會變成「下載」並存到下載根目錄）。LWW 中轉頁下載期間必須掛這種監聽器，
// 若其他 worker 恰好在同一時間寫失敗筆記/進度 Excel/PDF，檔名就會被打掉。
// 因此所有由我們發起的下載，呼叫前先在這裡登記「URL → 預定檔名」，
// 監聽器對登記過的下載重新 suggest 同一個檔名，確保命名與路徑不受影響。
const pendingDownloadFilenames = new Map();
function registerPendingDownloadFilename(url, filename) {
  if (!url || !filename) return;
  pendingDownloadFilenames.set(url, filename);
  // 下載一啟動 determining 就會發生，10 分鐘後清掉避免 Map 無限成長
  setTimeout(() => pendingDownloadFilenames.delete(url), 600000);
}
function getPendingDownloadFilename(item) {
  return pendingDownloadFilenames.get(item?.url) ||
         pendingDownloadFilenames.get(item?.finalUrl) ||
         null;
}

// ?? ?典??????
let G = resetState();

function resetState() {
  return {
    running:       false,
    paused:        false,
    stopped:       false,
    testMode:      false,
    targets:       [],
    queue:         [],
    concurrent:    3,
    workers:       [],
    ok:            0,
    fail:          0,
    skip:          0,
    done:          0,
    total:         0,
    // 目前 ok/fail/skip/done/total 這組數字是哪個本地資料夾專案的——見
    // resetRunStatsForProject()，用來偵測「切換到別的專案，但這組數字還是上一個
    // 專案留下的」這種情況。
    statsProjectBase: "",
    logs:          [],
    threadLogs:    [],
    // 本次執行的完整留痕紀錄（debug log 檔案用）：跟 logs/threadLogs 不同，這裡
    // 不設上限、不會被 shift 掉舊資料——logs/threadLogs 是給即時 UI 顯示用，太長
    // 會拖垮畫面所以有 cap；debug log 要的是「這一整批跑下來全部發生過的事」，
    // 只在 finishAll() 寫成檔案那一刻才用完即棄，所以沒有保留上限的理由。
    debugRun: { logs: [], threadLogs: [], failureNotes: [], startedAt: Date.now() },
    // Discord 通知用：discordBatch 累積到 DISCORD_BATCH_SIZE 篇就送一次進度訊息、
    // 送完清空；discordAllItems 整個 run 不清空，跑完/中途停止時餵給最終總結訊息。
    discordBatch:    [],
    discordAllItems: [],
    resultsMap:    {},
    downloadFolder:"PubMed_PDFs",
    batchSize:     0,
    politeMode:    true,
    lastPdfFailureReason: "",
    lastFullTextLinks:    [],   // [{source, label, url}] Full Text 連結清單
    stopAfter:            0,
    dispatched:           0,
    resultsFailMap:       {},
    // 檔名重複保護：folder+檔名(小寫) → 已認領該檔名的項目清單（依 rowIndex 排序認領）
    // 同一 rowIndex 重跑（重試/cookie 清理後重來）沿用原本認領到的檔名，不會再往後遞增
    filenameClaims:       {},
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
    // 彈性 worker 池狀態（見 STALL_* 常數說明）
    nextWorkerIdx:      0,
    liveWorkerPromises: new Set(),
    workerRetireFlags:  new Set(),
    stallCapWarned:     0,
    cookieCleanupRequested: false,
    cookieCleanupInProgress: false,
    cookieCleanupEvery: 10,
    cookieCleanupReason: "",
    cookieCleanupEpoch: 0,
    cookieCleanupRestartEpoch: 0,
    // 人機驗證暫停機制：偵測到出版社驗證頁時暫停派發，開分頁讓使用者手動通過
    manualVerifyPause: true,
    // 出版商官方 API 憑證（publisher_apis.js 的註冊表；例：{ elsevier: { apiKey, insttoken } }）
    // 有設定的出版商，其論文優先走 API 下載
    publisherApiCreds: {},
    verifyPending: false,
    verifyPendingUrl: "",
    verifyPendingTabId: null,
    verifyPreserveTab: false,
    verifyEpoch: 0,
    verifyRestartEpoch: 0,
    // 同時有多筆人機驗證出現時，排隊依序顯示，全部處理完才恢復派發
    // （見 requestManualVerificationPause／finishManualVerification）
    verifyQueue: [],
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
      }, () => {
        // 大檔可能超過 storage 配額，靜默失敗會導致之後「找不到 Excel 資料」
        const err = chrome.runtime.lastError?.message || "";
        addThreadLog("SAVE_SOURCE_EXCEL", { b64Length: msg.b64?.length || 0, meta: msg.meta, error: err });
        sendResponse(err ? { ok: false, error: err } : { ok: true });
      });
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
        registerPendingDownloadFilename(dataUrl, `${folder}/${base}_下載進度管理.xlsx`);
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

    // ── 本地資料夾模式：見 background.js 上方 FILE_MANAGER_HOST 那段說明 ──
    case "PICK_LOCAL_FOLDER":
      fmRequest("pick_folder")
        .then(res => sendResponse({ ok: true, cancelled: !!res.cancelled, path: res.path || "" }))
        .catch(e => {
          addThreadLog("PICK_LOCAL_FOLDER failed (host not installed?)", { error: e.message });
          sendResponse({ ok: false, error: e.message });
        });
      return true;

    // popup 選完/恢復一個專案資料夾後送這個：確保四個子資料夾存在，並偵測
    // 「進度管理/」底下有沒有既有的 *_進度管理.xlsx——有就是接續舊專案（把內容
    // 回傳給 popup 餵進既有的 parseExcel 流程），沒有就是新專案（popup 改走上傳流程）。
    case "OPEN_LOCAL_PROJECT": {
      const root = (msg.root || "").trim();
      if (!root) { sendResponse({ ok: false, error: "缺少資料夾路徑" }); return true; }
      // 資料夾選擇對話框有時會預設停在使用者上次瀏覽過的目錄（例如剛好停在專案
      // 裡的「進度管理」資料夾），使用者沒注意就直接按下選取，選到的其實是專案
      // 內部的子資料夾，而不是專案本身。這裡先擋下來，不然 init_root 會在裡面
      // 又建一次四個保留子資料夾，一路越選越深、越巢越多層（實際發生過：桌面的
      // 「Cancer paper」資料夾裡的「進度管理」底下又長出一整組「下載成功／下載
      // 失敗／下次重試／進度管理」，Excel 也被多寫了一份進去）。
      const rootBaseName = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
      if (PROJECT_ROOT_RESERVED_NAMES.includes(rootBaseName)) {
        sendResponse({
          ok: false,
          error: `你選到的是專案內部使用的子資料夾「${rootBaseName}」，請選這個資料夾的「上一層」（也就是專案本身的資料夾），不要選到裡面的子資料夾。`,
        });
        return true;
      }
      (async () => {
        try {
          await fmRequest("init_root", { root });
          const found = await fmRequest("find_progress_excel", { root });
          if (found.found) {
            const cleanedB64 = await stripStatusHighlightB64(found.dataB64, { baseName: found.base });
            if (cleanedB64 !== found.dataB64) {
              // 清掉的黃色高亮也要落地回磁碟上的進度檔，不然只清記憶體/畫面，
              // 使用者直接用 Excel 開那個檔案還是會看到上一輪的舊黃色。
              await fmRequest("write_bytes", {
                root, relPath: `進度管理/${found.base}_進度管理.xlsx`, dataB64: cleanedB64,
              }).catch(e => addThreadLog("Rewrite cleaned progress excel failed", { error: e?.message || String(e) }));
            }
            await chrome.storage.local.set({
              sourceExcelB64: cleanedB64,
              latestExcelB64: cleanedB64,
              excelMeta: { baseName: found.base, folder: "PubMed_PDFs" },
              localFolderRootPath: root,
              localFolderModeEnabled: true,
              localFolderProjectBase: found.base,
            });
            resetRunStatsForProject(found.base);
            addThreadLog("OPEN_LOCAL_PROJECT resumed", { root, base: found.base });
            sendResponse({ ok: true, resumed: true, base: found.base, dataB64: cleanedB64 });
          } else {
            await chrome.storage.local.set({
              localFolderRootPath: root,
              localFolderModeEnabled: true,
              localFolderProjectBase: found.hasOriginal ? (found.base || "") : "",
            });
            resetRunStatsForProject(found.base || "");
            addThreadLog("OPEN_LOCAL_PROJECT new/empty", { root, hasOriginal: !!found.hasOriginal });
            sendResponse({ ok: true, resumed: false, hasOriginal: !!found.hasOriginal, base: found.base || "" });
          }
        } catch (e) {
          addThreadLog("OPEN_LOCAL_PROJECT failed", { error: e.message, root });
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    // 新專案第一次上傳原始 Excel：寫一份不會再更動的 <base>_原檔.xlsx（只有還不存在
    // 時才寫），跟一份往後每次下載完會被覆寫的 <base>_進度管理.xlsx（初始內容跟原檔
    // 一樣）。防呆：如果這個資料夾其實已經屬於另一份 base name 不同的 Excel，拒絕寫入。
    case "INIT_LOCAL_PROJECT_EXCEL": {
      const newBase = (msg.baseName || "").trim();
      (async () => {
        const cfg = await getLocalFolderConfig();
        if (!cfg.enabled) { sendResponse({ ok: false, error: "本地資料夾模式未開啟或未選擇資料夾" }); return; }
        if (!newBase) { sendResponse({ ok: false, error: "缺少檔名" }); return; }
        try {
          const check = await fmRequest("find_progress_excel", { root: cfg.root });
          // 防呆：這個資料夾已經有進度檔了（不管 base name 是否一樣），一律拒絕用
          // 「上傳」去覆蓋——不然使用者為了「接續昨天的進度」誤上傳一次原始 Excel，
          // 就會把已經累積的下載狀況整個洗成空白。想接續一定要走「選擇專案資料夾」；
          // 真的要在這個資料夾重新開始，請先手動清空/搬走裡面的舊檔案。
          if (check.found) {
            sendResponse({
              ok: false,
              alreadyExists: true,
              error: `此資料夾已經有進行中的專案「${check.base}」，重新上傳 Excel 會把已累積的下載進度覆蓋成空白。請改用「📂 選擇專案資料夾」接續既有進度，或換一個全新的空資料夾建立新專案。`,
            });
            return;
          }
          const existingBase = check.base || "";
          if (existingBase && existingBase !== newBase) {
            sendResponse({
              ok: false,
              error: `此資料夾已經屬於「${existingBase}」這份 Excel 的專案，請換一個新資料夾，或改用「選擇專案資料夾」接續 ${existingBase}。`,
            });
            return;
          }
          if (!check.hasOriginal) {
            await fmRequest("write_bytes", { root: cfg.root, relPath: `進度管理/${newBase}_原檔.xlsx`, dataB64: msg.b64 });
          }
          await fmRequest("write_bytes", { root: cfg.root, relPath: `進度管理/${newBase}_進度管理.xlsx`, dataB64: msg.b64 });
          // 這裡也要把 Excel bytes 存進 storage.local（跟 SAVE_SOURCE_EXCEL 一樣），
          // _buildAndSaveExcel() 每次寫進度都是從這裡讀資料，不然新建專案（走這條
          // 路徑，不是接續舊專案的 OPEN_LOCAL_PROJECT resumed 分支）之後所有寫檔
          // （含核對同步、正式下載時的進度更新）都會因為讀不到資料而靜默略過。
          await chrome.storage.local.set({
            localFolderProjectBase: newBase,
            sourceExcelB64: msg.b64,
            latestExcelB64: msg.b64,
            excelMeta: { sheetName: msg.sheetName || "", baseName: newBase, folder: msg.folder || "" },
          });
          resetRunStatsForProject(newBase);
          addThreadLog("INIT_LOCAL_PROJECT_EXCEL done", { root: cfg.root, base: newBase });
          sendResponse({ ok: true, base: newBase });
        } catch (e) {
          addThreadLog("INIT_LOCAL_PROJECT_EXCEL failed", { error: e.message });
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    // 「更新論文清單」：只把 popup 已經比對過、目前專案完全沒有的新論文列（原始
    // 儲存格陣列，保留全部欄位）加進既有的進度 Excel 尾端，不動任何既有列——
    // 用來在不洗掉進度的前提下擴充清單，見 appendNewRowsToLocalProject()。
    case "UPDATE_LOCAL_PROJECT_EXCEL": {
      const newRawRows = msg.newRawRows || [];
      (async () => {
        if (!newRawRows.length) { sendResponse({ ok: false, error: "沒有新論文可以新增" }); return; }
        const result = await appendNewRowsToLocalProject(newRawRows);
        if (!result.ok) { sendResponse({ ok: false, error: result.error }); return; }
        addThreadLog("UPDATE_LOCAL_PROJECT_EXCEL done", { added: newRawRows.length, newTotal: result.newTotal });
        sendResponse({ ok: true, addedCount: newRawRows.length, newTotal: result.newTotal });
      })();
      return true;
    }

    // 只計算差異、不寫入任何東西——回傳的 diff 交給 popup 呈現報告，使用者確認
    // 「同步更新」後才會另外送 APPLY_LOCAL_FOLDER_SYNC 真正套用。
    case "RECONCILE_LOCAL_FOLDER":
      computeLocalFolderDiff()
        .then(diff => sendResponse({ ok: true, diff }))
        .catch(e => {
          addThreadLog("RECONCILE_LOCAL_FOLDER failed", { error: e.message });
          sendResponse({ ok: false, error: e.message });
        });
      return true;

    // 使用者在核對報告上按下「同步更新」才會送這個，真正把差異寫回 resultsMap/Excel、
    // 刪掉衝突標記要清的殘留檔。
    case "APPLY_LOCAL_FOLDER_SYNC":
      applyLocalFolderDiff()
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(e => {
          addThreadLog("APPLY_LOCAL_FOLDER_SYNC failed", { error: e.message });
          sendResponse({ ok: false, error: e.message });
        });
      return true;

    case "START_DOWNLOAD":
      if (G.running) { sendResponse({ ok: false, error: "已有下載任務執行中，請先停止或等待完成" }); return true; }
      chrome.storage.local.get(["completedPmids", "excelMeta"], data => {
        G = resetState();
        const testMode = !!msg.testMode;
        // 依 Storage 完成紀錄跳過已成功下載的 PMID（可用「清除 Storage 完成紀錄」重置）；
        // 測試下載模式（popup.js 的「🧪 測試下載」區塊）無條件強制下載指定文獻，不套用此跳過邏輯
        const doneSet = new Set((data.completedPmids || []).map(String));
        const rawTargets = msg.targets || [];
        const targets = testMode ? rawTargets : rawTargets.filter(t => !(t.pmid && doneSet.has(String(t.pmid))));
        const skippedByStorage = rawTargets.length - targets.length;

        if (!targets.length) {
          sendResponse({ ok: false, error: skippedByStorage > 0
            ? "所有目標依 Storage 完成紀錄皆已下載完成；若要重新下載請先按「清除 Storage 完成紀錄」"
            : "沒有可下載的目標" });
          return;
        }

        G.targets    = targets;
        G.testMode   = testMode;
        G.concurrent = msg.concurrent || 3;
        G.downloadFolder = sanitizeDownloadFolder(msg.downloadFolder || "PubMed_PDFs");
        G.batchSize  = Math.max(0, parseInt(msg.batchSize  || 0, 10) || 0);
        G.stopAfter  = Math.max(0, parseInt(msg.stopAfter  || 0, 10) || 0);
        G.politeMode = msg.politeMode !== false;
        G.manualVerifyPause = msg.manualVerifyPause !== false;
        G.publisherApiCreds = msg.publisherApiCreds || {};
        G.total      = targets.length;
        G.queue      = targets.map((_, i) => i);
        G.running    = true;
        for (let i = 0; i < G.concurrent; i++) {
          G.workers.push({ tabId: null, pmid: null, label: "等待中", status: "idle" });
        }

        // 進度 Excel 的資料夾跟著本次設定，避免上傳後才改資料夾造成 PDF 與進度檔分家
        const meta = data.excelMeta || {};
        meta.folder = G.downloadFolder;
        chrome.storage.local.set({ excelMeta: meta });

        sendResponse({ ok: true });
        if (skippedByStorage > 0) {
          addLog(`⏭ 依 Storage 完成紀錄跳過 ${skippedByStorage} 篇已成功下載的論文`, "info");
        }
        if (testMode) {
          addLog(`🧪 測試下載模式：忽略下載狀況與 Storage 完成紀錄，強制下載指定的 ${targets.length} 篇：` +
            targets.map(t => t.pmid || t.title).join("、"), "warn");
        }
        startDownloadEngine();
      });
      return true;

    case "PAUSE_DOWNLOAD":
      G.paused = true;
      triggerExcelWrite({ toDownload: true });
      sendResponse({ ok: true });
      return true;

    case "RESUME_DOWNLOAD":
      G.paused = false;
      // 暫停期間不算「卡住」，恢復時重置每個運作中 worker 的計時，
      // 避免暫停太久一恢復就被誤判成卡住而立刻新開 worker
      { const now = Date.now(); G.workers.forEach(w => { if (w && w.status === "running") w.startedAt = now; }); }
      sendResponse({ ok: true });
      return true;

    case "STOP_DOWNLOAD":
      G.stopped = true;
      G.running = false;
      stopKeepAlive();
      G.tabPool.forEach(id => chrome.tabs.remove(id).catch(() => {}));
      G.tabPool = [];
      if (G.loginResolve)  G.loginResolve(null);
      if (G.captchaResolve) G.captchaResolve(null);
      if (G.verifyPendingTabId != null) chrome.tabs.remove(G.verifyPendingTabId).catch(() => {});
      (G.verifyQueue || []).forEach(e => { if (e.tabId != null) chrome.tabs.remove(e.tabId).catch(() => {}); });
      G.verifyQueue = [];
      G.verifyPending = false;
      G.verifyPendingTabId = null;
      triggerExcelWrite({ toDownload: true });
      sendResponse({ ok: true });
      return true;

    case "RESET_EXTENSION":
      (async () => {
        // 先擋下後續 worker 繼續動 G.resultsMap，再把「目前已經完成、但還沒寫進
        // Excel 狀態欄」的最新進度強制 flush 一次（含實體檔案），才不會因為平常
        // 每 5 篇才寫一次、非整除的那幾篇用 500ms debounce 的機制，剛好被重設的
        // 瞬間打斷、白白漏掉最後幾篇明明已經下載成功的紀錄。就算真的有極短的
        // race window漏到（worker 剛好在這個 flush 跟下面清空 G 之間才寫入），
        // 實體 PDF/txt 檔案本身不受這個 debounce 影響、已經確實落地，之後用
        // 「📂 選取已存在專案」接回來核對一次也會照資料夾實際內容校正回來。
        G.stopped = true;
        G.running = false;
        stopKeepAlive();
        if (bgExcelTimer) { clearTimeout(bgExcelTimer); bgExcelTimer = null; }
        bgPendingDownload = false;
        try { await _buildAndSaveExcel({ toDownload: true }); } catch (e) {
          addThreadLog("RESET_EXTENSION final flush failed", { error: e?.message || String(e) });
        }

        G.tabPool.forEach(id => chrome.tabs.remove(id).catch(() => {}));
        G.tabPool = [];
        if (G.loginResolve)  G.loginResolve(null);
        if (G.captchaResolve) G.captchaResolve(null);
        if (G.verifyPendingTabId != null) chrome.tabs.remove(G.verifyPendingTabId).catch(() => {});
        (G.verifyQueue || []).forEach(e => { if (e.tabId != null) chrome.tabs.remove(e.tabId).catch(() => {}); });
        G = resetState();
        chrome.storage.local.remove([
          "completedPmids",
          "completedCount",
          "downloadFolder",
          "sourceExcelB64",
          "latestExcelB64",
          "excelMeta",
          // 本地資料夾模式的專案連結也要一併斷開——「重設」要做到真的回到一片空白、
          // 跟剛裝好擴充功能一樣，不然資料夾路徑還留著，下次開 popup 會自動接回去，
          // 使用者看不出「重設」到底重設了什麼。localFolderModeEnabled 用 remove
          // 而非設成 false：popup.js 對這個 key 的預設值就是「沒有值＝啟用」，移除
          // 它會自然回到預設開啟的狀態，不需要另外记一個「使用者到底設過什麼」。
          "localFolderRootPath",
          "localFolderModeEnabled",
          "localFolderProjectBase",
        ], () => sendResponse({ ok: true }));
      })();
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

    case "VERIFY_DONE":
      finishManualVerification("user");
      sendResponse({ ok: true });
      return true;

    case "TEST_VERIFY":
      runManualVerificationTest();
      sendResponse({ ok: true });
      return true;
  }
});

// 連接／切換到一個本地資料夾專案時呼叫：如果 G.total/ok/fail/skip/done 這組
// 「這次執行」的統計數字，記錄的其實是另一個專案（或同一個資料夾但已經被核對/
// 重建過的舊狀態），就歸零重算——不然（實際發生過）核對進度、更新論文清單，或
// 單純換一個專案資料夾之後，popup 的統計欄位會顯示上一個專案殘留的舊數字，跟這個
// 專案「下載範圍」篩選出來的真正篇數對不起來。只有目前沒有下載正在跑時才會歸零，
// 避免打斷正在進行中的任務。
function resetRunStatsForProject(base) {
  if (G.running) return;
  const normalized = base || "";
  if (G.statsProjectBase === normalized) return;
  G.total = 0; G.done = 0; G.ok = 0; G.fail = 0; G.skip = 0;
  G.statsProjectBase = normalized;
}

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
    verifyPending: G.verifyPending,
    verifyPendingUrl: G.verifyPendingUrl,
    verifyQueueLength: (G.verifyQueue || []).length,
    workers:       G.workers.map(w => w ? { label: w.label, status: w.status } : { label: "", status: "idle" }),
  };
}

// ── 日誌 & 通知 ──
function addLog(msg, type = "info", workerIdx = -1) {
  const entry = { msg, type, workerIdx, time: Date.now() };
  G.logs.push(entry);
  if (G.logs.length > 1000) G.logs.shift();
  if (G.debugRun) G.debugRun.logs.push(entry);
  chrome.runtime.sendMessage({ action: "LOG", msg, type, workerIdx }).catch(() => {});
}

function addThreadLog(msg, data = null) {
  if (!G.threadLogs) G.threadLogs = [];
  const entry = { msg, data, time: Date.now() };
  G.threadLogs.push(entry);
  if (G.threadLogs.length > 2000) G.threadLogs.shift();
  if (G.debugRun) G.debugRun.threadLogs.push(entry);
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
    workers: G.workers.map(w => w ? { label: w.label, status: w.status } : { label: "", status: "idle" }),
  }).catch(() => {});

  if (G.paused && !G.stopped && G.workers.length > 0) {
    const allIdle = G.workers.every(w => !w || w.status !== "running");
    if (allIdle) {
      triggerExcelWrite({ toDownload: true });
    }
  }
}

async function startDownloadEngine() {
  startKeepAlive();
  addLog(`開始下載，共 ${G.total} 篇，並行數量 ${G.concurrent}${G.politeMode ? "，已啟用保守模式" : ""}`, "info");
  if (publisherApiConfigured(G.publisherApiCreds)) {
    addLog("已啟用出版商官方 API（" + publisherApiConfiguredLabels(G.publisherApiCreds).join("、") + "）：每篇先詢問 API，命中就直接下載（不經出版社網頁、不會遇人機驗證）。", "info");
  }

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
      stopKeepAlive();
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

  // 啟動 worker（含彈性 worker 池：卡住的 worker 會被接手，見 STALL_* 常數說明）
  G.nextWorkerIdx = G.concurrent;
  G.liveWorkerPromises = new Set();
  G.workerRetireFlags  = new Set();
  G.stallCapWarned     = 0;

  for (let i = 0; i < G.concurrent; i++) launchWorker(i, { needsTab: false });

  const stallTimer = setInterval(checkStalledWorkers, STALL_CHECK_INTERVAL_MS);
  try {
    while (G.liveWorkerPromises.size > 0) {
      await Promise.race(G.liveWorkerPromises);
    }
  } finally {
    clearInterval(stallTimer);
  }

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

/**
 * 啟動一個 worker 迴圈並掛進彈性 worker 池的存活追蹤集合。
 * needsTab=true 用於中途接手用的新 worker（原本並行數以外的），會現開一個背景分頁；
 * 一開始的 G.concurrent 個 worker 沿用 buildTabPool 已建好的分頁，不用再開。
 */
function launchWorker(workerIdx, { needsTab = false } = {}) {
  let settleReserved;
  const reserved = new Promise(res => { settleReserved = res; });
  // 先同步把佔位 promise 加進存活集合，讓 checkStalledWorkers 的總數上限判斷
  // 在分頁還沒建好前就已經把這個名額算進去，避免同一輪巡視內
  // 連續判斷多個卡住的 worker 時，因為非同步建分頁的時間差而超過上限。
  G.liveWorkerPromises.add(reserved);

  (async () => {
    try {
      if (needsTab) {
        const tab = await chrome.tabs.create({ url: "about:blank", active: false }).catch(() => null);
        if (!tab) {
          addThreadLog("Overflow worker tab creation failed; skip spawn", { workerIdx });
          return;
        }
        G.tabPool[workerIdx] = tab.id;
      }
      G.workers[workerIdx] = { tabId: G.tabPool[workerIdx] || null, pmid: null, label: "等待中", status: "idle" };
      notifyWorkers();
      await runWorker(workerIdx);
    } catch(e) {
      addThreadLog("Worker crashed", { workerIdx, message: e?.message || String(e) });
    } finally {
      G.liveWorkerPromises.delete(reserved);
      settleReserved();
    }
  })();

  return reserved;
}

/**
 * 巡視所有運作中的 worker，找出處理單篇已超過 STALL_THRESHOLD_MS 的，
 * 標記它「完成這篇後就結束」，並另開一個新 worker 頂上接手佇列，
 * 讓整體並行數盡量維持在原本設定的數量。總 worker 數有上限，
 * 避免系統性問題（例如網路整段斷線，每篇都卡住）觸發無限新開 worker。
 */
function checkStalledWorkers() {
  if (!G.running || G.stopped || G.paused) return;
  if (!G.queue || G.queue.length === 0) return;

  // 保守模式下不完全關閉補 worker（唯一的卡死恢復機制），而是拉長判定門檻、
  // 且最多只多補 1 個，避免慢站被誤判成卡住、也避免多開分頁刺激出版社風控
  const threshold = G.politeMode ? STALL_THRESHOLD_MS_POLITE : STALL_THRESHOLD_MS;
  const maxTotal = G.politeMode
    ? (G.concurrent || 1) + 1
    : Math.max(G.concurrent || 1, STALL_MAX_TOTAL_WORKERS);
  const now = Date.now();

  for (let idx = 0; idx < G.workers.length; idx++) {
    if (G.queue.length === 0) break;
    const w = G.workers[idx];
    if (!w || w.status !== "running" || !w.startedAt) continue;
    if (G.workerRetireFlags.has(idx)) continue;
    if (now - w.startedAt < threshold) continue;

    if (G.liveWorkerPromises.size >= maxTotal) {
      if (!G.stallCapWarned || now - G.stallCapWarned > 60000) {
        addLog(`⚠ 偵測到 worker 處理過久（PMID:${w.pmid || "?"}），但目前 worker 總數已達上限（${maxTotal}），暫不新開，避免無限增生（例如整體網路異常導致每篇都卡住）。`, "warn");
        G.stallCapWarned = now;
      }
      break;
    }

    G.workerRetireFlags.add(idx);
    const elapsedSec = Math.round((now - w.startedAt) / 1000);
    workerLog(idx, `  本篇已處理超過 ${elapsedSec} 秒，另開一個新 worker 接手後續佇列；此 worker 會繼續處理完這篇後才結束（不再拿下一篇）。`, "warn");
    addThreadLog("Worker stalled beyond threshold; spawning replacement worker", {
      workerIdx: idx, pmid: w.pmid, elapsedMs: now - w.startedAt, thresholdMs: threshold,
      liveWorkers: G.liveWorkerPromises.size, maxTotal, politeMode: !!G.politeMode
    });
    launchWorker(G.nextWorkerIdx++, { needsTab: true });
  }
}

async function recycleWorkerTab(workerIdx, oldTabId, reason = "") {
  if (G.stopped) return oldTabId;
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  G.tabPool[workerIdx] = tab.id;
  if (G.workers?.[workerIdx]) G.workers[workerIdx].tabId = tab.id;
  if (oldTabId) chrome.tabs.remove(oldTabId).catch(() => {});
  workerLog(workerIdx, "  已更換背景分頁" + (reason ? "：" + reason : "") + "，避免長時間載入後分頁變慢。", "info");
  addThreadLog("Worker tab recycled", { workerIdx, oldTabId, newTabId: tab.id, reason });
  return tab.id;
}

/** 單一 worker 迴圈 */
async function runWorker(workerIdx) {
  let tabId = G.tabPool[workerIdx];
  let processedSinceRecycle = 0;

  while (true) {
 
    while (G.paused && !G.stopped) await sleep(500);
    if (G.stopped) break;

    if (G.workerRetireFlags && G.workerRetireFlags.has(workerIdx)) {
      workerLog(workerIdx, "  已有其他 worker 接手佇列，此 worker 到此結束。", "info");
      break;
    }

    while (G.cookieCleanupRequested && !G.stopped) await waitForCookieCleanup(workerIdx);
    if (G.stopped) break;

    await waitForManualVerification(workerIdx);
    if (G.stopped) break;

    if (G.queue.length === 0) break;

    if (G.stopAfter > 0 && G.dispatched >= G.stopAfter) break;
    const idx  = G.queue.shift();
    G.dispatched = (G.dispatched || 0) + 1;
    const item = G.targets[idx];
    if (!item) continue;
    G.activeWorkers = (G.activeWorkers || 0) + 1;
    const itemFolder = getBatchFolderForIndex(idx);
    // 檔名重複保護（一般 Chrome 下載模式用）：本篇實際要存的檔名（撞名時會是「標題 (2)」之類）
    const filenameClaim = claimDownloadFilename(item, itemFolder, ".pdf");
    // 本地資料夾模式：序號前綴（item.seqLabel）在整份 Excel 裡天生唯一，直接用
    // 「序號_標題」當檔名，不需要 claimDownloadFilename() 那套撞名後綴。
    const itemLocalCfg = await getLocalFolderConfig();
    const downloadName = itemLocalCfg.enabled ? localSuccessFilename(item) : filenameClaim.finalName;
    const downloadItem = (itemLocalCfg.enabled || filenameClaim.duplicate) ? { ...item, safeTitle: downloadName } : item;
    if (processedSinceRecycle >= WORKER_TAB_RECYCLE_EVERY) {
      tabId = await recycleWorkerTab(workerIdx, tabId, `已處理 ${processedSinceRecycle} 篇`);
      processedSinceRecycle = 0;
    }

    G.workers[workerIdx] = { tabId, pmid: item.pmid, label: truncate(item.title, 40), status: "running", startedAt: Date.now() };
    notifyWorkers();

 
    const anchorId = `w${workerIdx}-pmid-${item.pmid}`;
    workerLog(workerIdx, `\n[Worker ${workerIdx+1}] PMID:${item.pmid} | ${truncate(item.title, 55)}`, "info", anchorId);
    if (filenameClaim.duplicate) {
      workerLog(workerIdx, `  ⚠ 清理後檔名與其他篇重複，本篇改存為「${downloadName}.pdf」，避免互相覆蓋，請稍後核對。`, "warn");
      addThreadLog("Duplicate filename detected; using suffixed name", {
        rowIndex: item.rowIndex, pmid: item.pmid, baseTitle: item.safeTitle, finalName: downloadName
      });
    }
    let itemExcelStatus = STATUS_FAIL;
    let failureReason = "";
    let localLinks = [];
    let localLinkAttempts = [];
    let localReport = null;
    let pdfDownloadAttempts = [];
    G.lastPdfFailureReason = "";
    // 本篇的細部處理過程紀錄；失敗時會附到 下載失敗檔案/*.txt 末尾，方便回頭 debug
    const itemTrace = [];
    const countersBeforeItem = { ok: G.ok, fail: G.fail, skip: G.skip };
    const itemCleanupEpoch = G.cookieCleanupEpoch || 0;
    const itemVerifyEpoch = G.verifyEpoch || 0;

    let status = "失敗";
    try {
      // 出版商官方 API（publisher_apis.js）：有設定憑證時先試 API 直接抓 PDF
      //（不開出版社頁面、不會遇到人機驗證）；非該社刊物或無權限時回退瀏覽器流程
      let apiDownloaded = false;
      if (item.pmid && publisherApiConfigured(G.publisherApiCreds)) {
        apiDownloaded = await tryPublisherApiDownload(downloadItem, itemFolder, workerIdx, itemTrace, G.publisherApiCreds);
      }
      const result = apiDownloaded ? null : await getPdfUrlWithFallback(tabId, item, workerIdx, itemTrace, downloadName, itemFolder);
      const pdfUrl      = apiDownloaded ? null : normalizePdfUrlValue(result?.pdfUrl ?? result);
      localLinks        = result?.fullTextLinks ?? [];
      const localReason = result?.failureReason ?? "";
      localLinkAttempts = result?.linkAttempts ?? [];
      localReport       = result?.report ?? null;

      if (apiDownloaded || result?.alreadyDownloaded) {
        itemExcelStatus = STATUS_SUCCESS;
        status = "成功";
        G.ok++;
        const successVia = apiDownloaded ? "出版商官方 API" : "中文論文查詢流程（CNKI）";
        workerLog(workerIdx, `  已透過${successVia}下載：${downloadName}.pdf`, "ok");
      } else if (pdfUrl === "SKIP") {
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
          const downloadLockKey = await acquireDomainLock(workerIdx, candidate.sourceUrl || candidate.printUrl || candidate.pdfUrl, candidate.label || "PDF 下載");
          addThreadLog("Trying PDF download candidate", {
            workerIdx,
            rowIndex: item.rowIndex,
            pmid: item.pmid,
            index: i + 1,
            total: pdfCandidates.length,
            label: candidate.label || "",
            sourceUrl: candidate.sourceUrl || "",
            pdfUrl: candidate.pdfUrl,
            printPmc: !!candidate.printPmc
          });
          itemTrace.push(traceStamp() + `── 候選 ${i + 1}/${pdfCandidates.length}：${candidate.label || "未知來源"}`);
          itemTrace.push("   " + (candidate.printPmc ? (candidate.printUrl || candidate.sourceUrl || candidate.pdfUrl) : candidate.pdfUrl));
          try {
            if (candidate.printPmc) {
              ok = await printPmcPageToPdf(tabId, candidate.printUrl || candidate.sourceUrl, downloadName, itemFolder, itemTrace);
            } else {
              ok = await triggerDownload(candidate.pdfUrl, downloadName, itemFolder, tabId, itemTrace);
            }
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
          workerLog(workerIdx, `  下載成功：${downloadName}.pdf`, "ok");
        } else {
          const attemptsDetail = (result?.linkAttempts?.length)
            ? `\n連結嘗試紀錄：${result.linkAttempts.join(" | ")}`
            : "";
          const pdfFailureDetail = G.lastPdfFailureReason ? `\n最後 PDF 預檢診斷：${G.lastPdfFailureReason}` : "";
          const atyponNote = hasAtyponContext(pdfCandidates, localLinks, result?.linkAttempts)
            ? "\nAtypon 註記：此平台常將 /doi/pdf、/doi/epdf、/doi/pdfdirect 回傳為 HTML 閱讀頁而非真正 PDF；若三種 PDF 端點都回 HTML，找不到可直接下載的 PDF 屬常見狀況。"
            : "";
          const decision = decideFailureStatus(item, result, `已找到 PDF 連結，但 Chrome 回報下載失敗或中斷。已嘗試 ${pdfCandidates.length} 個候選 PDF${lastDownloadUrl ? `；最後嘗試：${lastDownloadUrl}` : ""}${attemptsDetail}${pdfFailureDetail}${atyponNote}`);
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

    if (G.stopped && itemExcelStatus !== STATUS_SUCCESS) {
      // 使用者按了停止：這篇是被中斷而不是真的失敗（分頁已被移除、腳本必然拋錯），
      // 不寫入結果，避免把「未嘗試完」污染成「下載失敗」記進 Excel
      G.ok = countersBeforeItem.ok;
      G.fail = countersBeforeItem.fail;
      G.skip = countersBeforeItem.skip;
      G.activeWorkers = Math.max(0, (G.activeWorkers || 1) - 1);
      workerLog(workerIdx, "  已停止，此篇未完成，維持原狀態不記錄。", "warn");
      break;
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

    // 人機驗證等待中（或本篇處理期間剛完成一輪驗證）：失敗不定案，
    // 等使用者通過驗證後從頭重跑此篇（重跑會拿到全新的簽名 PDF URL）
    const shouldRestartAfterVerify =
      G.verifyPending || ((G.verifyRestartEpoch || 0) > itemVerifyEpoch);
    if (shouldRestartAfterVerify && !itemSucceeded && (item._verifyRetryCount || 0) < 2) {
      item._verifyRetryCount = (item._verifyRetryCount || 0) + 1;
      G.ok = countersBeforeItem.ok;
      G.fail = countersBeforeItem.fail;
      G.skip = countersBeforeItem.skip;
      G.queue.unshift(idx);
      G.dispatched = Math.max(0, (G.dispatched || 1) - 1);
      G.activeWorkers = Math.max(0, (G.activeWorkers || 1) - 1);
      workerLog(workerIdx, `  遇到人機驗證，通過後重試此篇（${item._verifyRetryCount}/2）`, "warn");
      addThreadLog("Manual verification pending; unsuccessful item will restart after verification.", {
        workerIdx,
        retryCount: item._verifyRetryCount,
        rowIndex: item.rowIndex,
        pmid: item.pmid,
        title: item.title
      });
      await waitForManualVerification(workerIdx);
      if (!G.stopped) await navigateTab(tabId, "about:blank", 200);
      continue;
    }

    // 撞名且最終成功：把提醒寫進「失敗原因」欄（Excel 匯出時該欄對成功列也會保留此註記），
    // 提醒使用者這篇的檔名被改過，需核對是否對應正確
    if (!itemLocalCfg.enabled && filenameClaim.duplicate && itemExcelStatus === STATUS_SUCCESS && !failureReason) {
      failureReason = `⚠ 檔名重複：清理後標題與其他篇相同，本篇已存為「${downloadName}.pdf」（而非「${item.safeTitle}.pdf」）以避免覆蓋，請核對此列對應的 PDF 是否正確。`;
    }

    // 測試下載（G.testMode）完全不動 G.resultsMap／進度 Excel／Storage 完成紀錄、
    // 也不去清另外兩個狀態資料夾的殘留——這些都是「正式進度」的一部分，測試下載
    // 只是驗證某幾篇抓不抓得到 PDF，跟正式進度統計要完全分開。失敗 txt 診斷筆記
    // 還是照寫（對除錯有用），只是 createFailureNote 內部已經把目的資料夾換成
    // TEST_FOLDER_NAME，不會混進 下載失敗/下次重試。
    if (!G.testMode) {
      G.resultsMap[item.rowIndex] = itemExcelStatus;
    }
    if (itemExcelStatus !== STATUS_SUCCESS) {
      const noteOk = await createFailureNote(
        item, itemExcelStatus, itemFolder, failureReason,
        localLinks, localLinkAttempts, pdfDownloadAttempts, itemTrace, localReport
      );
      if (!noteOk) {
        workerLog(workerIdx, "  下載失敗 txt 產生失敗，請查看 thread log。", "fail");
      }
    } else if (!G.testMode) {
      // 這篇可能在之前的執行中失敗過、留有舊的 下載失敗檔案/*.txt；
      // 這次成功了就順手清掉，避免使用者看到「明明成功卻還有失敗檔案」
      await removeStaleFailureNote(item, itemFolder);
    }

    // 本地資料夾模式：同一篇論文的檔案只能存在於 下載成功/下載失敗/下次重試 三個
    // 資料夾其中一個，這裡主動清掉另外兩個資料夾裡的同名殘留（跟上面 removeStaleFailureNote
    // 是同一個概念，只是這裡是檔案系統版本、三個資料夾互相清）。測試下載不寫入這三個
    // 資料夾，自然也不需要（也不該）清它們的東西。
    if (!G.testMode && itemLocalCfg.enabled) {
      const staleRelPaths = itemExcelStatus === STATUS_SUCCESS
        ? [STATUS_FAIL + "/" + localFailureFilename(item, STATUS_FAIL) + ".txt",
           STATUS_RETRY + "/" + localFailureFilename(item, STATUS_RETRY) + ".txt"]
        : [STATUS_SUCCESS + "/" + localSuccessFilename(item) + ".pdf"];
      fmRequest("delete_paths", { root: itemLocalCfg.root, relPaths: staleRelPaths }).catch(e => {
        addThreadLog("Local mode stale-file cleanup failed", { error: e?.message || String(e), rowIndex: item.rowIndex });
      });
    }

    if (!G.testMode && itemExcelStatus === STATUS_SUCCESS && item.pmid) {
      chrome.storage.local.get(["completedPmids"], data => {
        const set = new Set(data.completedPmids || []);
        set.add(String(item.pmid));
        chrome.storage.local.set({ completedPmids: [...set] });
      });
    }

    G.done++;

    if (!G.testMode && failureReason) {
      G.resultsFailMap = G.resultsFailMap || {};
      G.resultsFailMap[item.rowIndex] = failureReason;
    }

    // 全域 log：讓使用者不用切到個別 Worker tab，就能在全域看到「哪個 worker
    // 處理完第幾篇論文、結果是成功/失敗/重試」的總覽。paperNo 是整份 Excel 裡
    // 「有資料的列」由上往下數的第幾篇（跟 localSuccessFilename() 檔名前綴用的
    // seqLabel 是同一套順位，不論 Column M 是 Y 或 N 都算進去），所以跟檔名、核對
    // 報告永遠對得起來，也不受斷點續傳/retry 篩選、或之後改動 Y/N 判斷影響；測試
    // 下載模式走的是另一套查找邏輯，item 不會有 paperNo，退回顯示 Excel 列號。
    const paperLabel = item.paperNo != null ? `第 ${item.paperNo} 篇` : `Excel 第 ${item.rowIndex} 列`;
    addLog(
      `[Worker ${workerIdx + 1}] ${paperLabel}（PMID:${item.pmid || "無"}）處理完成 → ${itemExcelStatus}`,
      itemExcelStatus === STATUS_SUCCESS ? "ok" : itemExcelStatus === STATUS_RETRY ? "warn" : "fail"
    );

    // Discord 通知：測試下載不算數。每滿 DISCORD_BATCH_SIZE 篇送一次進度訊息，
    // discordAllItems 整個 run 都留著，跑完/中途停止時餵給 finishAll() 的總結訊息。
    if (!G.testMode) {
      const discordItem = { paperNo: item.paperNo, pmid: item.pmid, title: item.title, status: itemExcelStatus };
      G.discordBatch.push(discordItem);
      G.discordAllItems.push(discordItem);
      if (G.discordBatch.length >= DISCORD_BATCH_SIZE) {
        const batch = G.discordBatch;
        G.discordBatch = [];
        sendDiscordBatchUpdate(batch, G.done, G.total).catch(() => {});
      }
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
    processedSinceRecycle++;
    if (G.stopped) break;
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

function decideFailureStatus(item, result, reason) {
  const finalFailure = result?.finalFailure === true || result?.retryable === false;
  const wasRetry = String(item?.status || "").trim() === STATUS_RETRY;
  const baseReason = reason || "缺少詳細失敗原因。";
  const unauthorizedFailure =
    /HTTP\s*403|403 Forbidden|Access forbidden|not authorized|not authorised|無授權|沒有授權/i.test(baseReason);
  // baseReason 是 pipeline 自己組出來的訊息（見 requestManualVerificationPause／
  // G.lastPdfFailureReason 各處），只要真的判定為人工驗證就一定會帶「需要人工驗證」
  // 前綴；不比對 Cloudflare 等裸字，避免 e.message 之類的原始例外文字誤觸發
  // （例如錯誤訊息裡剛好出現 cdnjs.cloudflare.com 這類網域）
  const manualVerification =
    /需要人工驗證|真人驗證/i.test(baseReason);

  if (manualVerification) {
    return {
      excelStatus: STATUS_RETRY,
      workerStatus: STATUS_RETRY,
      reason: baseReason,
    };
  }

  if (!finalFailure && !wasRetry && !unauthorizedFailure) {
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

// ════════════════════════════════════════════════════════════════
// Debug log 留痕機制：每次正式下載（測試下載不觸發）跑完，把這次執行的完整
// logs/threadLogs/失敗筆記彙整成一個 txt，透過 file_manager native host 寫進
// native_host/debug_log/（跟本地資料夾模式選的專案 root 無關，固定放在 host
// 腳本旁邊，所以檔名要自己帶專案/Excel 名稱才分得出是哪次跑的）。資料夾裡最多
// 留 20 個檔案，超過的由 native host 那邊依 mtime 砍最舊的。
// ════════════════════════════════════════════════════════════════
function formatDebugLogTime(ts) {
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
}

function sanitizeDebugLogNamePart(s) {
  const cleaned = String(s || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .trim()
    .substring(0, 60);
  return cleaned || "unknown";
}

function buildDebugLogText(runMeta) {
  const run = G.debugRun || { logs: [], threadLogs: [], failureNotes: [], startedAt: Date.now() };
  const lines = [];

  lines.push("========================================");
  lines.push("PubMed PDF 批次下載 - Debug Log");
  lines.push("========================================");
  lines.push("專案資料夾: " + (runMeta.projectFolder || "(未使用本地資料夾模式，走 Chrome 下載)"));
  lines.push("Excel: " + (runMeta.excelBase || "(未知)"));
  lines.push("開始時間: " + formatDebugLogTime(run.startedAt));
  lines.push("結束時間: " + formatDebugLogTime(Date.now()));
  lines.push("結果統計: 共 " + G.total + " 篇，成功 " + G.ok + "，失敗 " + G.fail + "，待重試 " + G.skip);
  lines.push("");

  lines.push("======== 摘要 Log（各 worker 處理過程，含中文說明）========");
  run.logs.forEach(e => {
    const w = e.workerIdx >= 0 ? `[Worker ${e.workerIdx + 1}] ` : "";
    lines.push(`[${formatDebugLogTime(e.time)}] ${w}${e.msg}`);
  });
  lines.push("");

  lines.push("======== 詳細技術追蹤（含每篇的連結/鎖/下載細節，走什麼路徑、定位哪個元件）========");
  run.threadLogs.forEach(e => {
    lines.push(`[${formatDebugLogTime(e.time)}] ${e.msg}` + (e.data ? "\n" + JSON.stringify(e.data, null, 2) : ""));
  });
  lines.push("");

  lines.push("======== 失敗/重試筆記（本次執行期間產生過的失敗診斷內容，即使後來重跑成功、原本的 txt 被自動清掉，這裡仍保留）========");
  if (!run.failureNotes.length) {
    lines.push("（本次沒有產生任何失敗筆記）");
  } else {
    run.failureNotes.forEach((n, i) => {
      lines.push(`---- 第 ${i + 1} 篇失敗筆記（Excel row ${n.rowIndex}, PMID ${n.pmid}, 狀態 ${n.status}）----`);
      lines.push(n.body);
      lines.push("");
    });
  }

  return lines.join("\n");
}

async function writeDebugLogFile() {
  if (G.testMode || !G.debugRun) return;
  try {
    const [localCfg, storageData] = await Promise.all([
      getLocalFolderConfig(),
      chrome.storage.local.get(["excelMeta"]),
    ]);
    const meta = storageData.excelMeta || {};
    const projectFolder = (localCfg.enabled && localCfg.root)
      ? localCfg.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
      : (G.downloadFolder || meta.folder || "chrome_downloads");
    const excelBase = (localCfg.enabled && localCfg.base) || meta.baseName || "unknown_excel";

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `debug_log_${sanitizeDebugLogNamePart(projectFolder)}_${sanitizeDebugLogNamePart(excelBase)}_${ts}.txt`;
    const content = buildDebugLogText({ projectFolder, excelBase });

    await fmRequest("write_debug_log", { filename, content, maxFiles: 20 });
    addThreadLog("Debug log written", { filename });
  } catch (e) {
    // 沒裝 file_manager native host 或寫檔失敗都只記一筆 threadLog，不影響下載
    // 流程本身——這是留痕的附加功能，不是下載能不能成功的必要條件。
    addThreadLog("Debug log write failed (native host missing or error)", { error: e?.message || String(e) });
  }
}

function finishAll() {
  G.running = false;
  G.tabPool = [];
  stopKeepAlive();
  addLog("\n全部完成：成功 " + G.ok + "，失敗 " + G.fail + "，未下載 " + G.skip, "ok");

  writeDebugLogFile();
  if (!G.testMode) {
    sendDiscordFinalReport({
      doneCount: G.done,
      totalCount: G.total,
      ok: G.ok,
      fail: G.fail,
      skip: G.skip,
      stoppedEarly: G.stopped,
      allItems: G.discordAllItems,
    }).catch(() => {});
  }
  triggerExcelWrite({ toDownload: true });
  // 本地資料夾模式：整批跑完後自動核對一次，抓出資料夾實際內容跟 Excel 狀態不一致
  // 的地方（例如某篇途中被中斷、寫檔失敗但沒正確回報）。這裡不是由 popup 發請求
  // 觸發，只能算完 diff 後主動推訊息給常駐的 popup 視窗，跟 SHOW_CAPTCHA 同一套
  // 「背景推播、popup 決定要不要跳窗」模式；乾淨就只記一筆 log，不用跳窗。
  getLocalFolderConfig().then(cfg => {
    if (!cfg.enabled) return;
    computeLocalFolderDiff().then(diff => {
      if (diff.skipped) return;
      if (diff.clean) {
        addThreadLog("Auto reconcile after finishAll: clean", diff.summary);
        return;
      }
      chrome.runtime.sendMessage({ action: "SHOW_LOCAL_FOLDER_DIFF", diff }).catch(() => {});
    }).catch(e => addThreadLog("Auto reconcile after finishAll failed", { error: e?.message || String(e) }));
  });
  chrome.runtime.sendMessage({ action: "DONE", resultsMap: G.resultsMap }).catch(() => {});
  chrome.notifications.create({
    type:    "basic",
    iconUrl: chrome.runtime.getURL("icons/icon48.png"),
    title:   "PubMed 下載完成",
    message: "成功 " + G.ok + " 篇，失敗 " + G.fail + " 篇，未下載 " + G.skip + " 篇",
  });
}

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
  const doDownload = bgPendingDownload;
  bgPendingDownload = false;
  try {
    await _buildAndSaveExcel({ toDownload: doDownload });
  } catch(e) {
    addThreadLog("Background Excel write error", { message: e?.message || String(e), stack: e?.stack || "" });
  }
}

// 「更新論文清單」的實作：把 popup 已經比對過、目前完全沒有的新論文（原始儲存格
// 陣列，欄位保留原樣）加到目前進度 Excel 的尾端。只新增列，不改動任何既有列——
// popup.js 那邊的序號前綴（seqLabel）是固定寬度、依「列在工作表裡的順位」算的，
// 只要新論文永遠加在最後面，既有列的順位、序號、對應到磁碟上舊檔名的關係就完全
// 不會變，不需要額外去搬動或改名任何已經下載好的檔案。
async function appendNewRowsToLocalProject(newRawRows) {
  const data = await chrome.storage.local.get(["latestExcelB64", "sourceExcelB64", "excelMeta"]);
  const b64  = data.latestExcelB64 || data.sourceExcelB64;
  const meta = data.excelMeta || {};
  if (!b64) return { ok: false, error: "storage 裡沒有目前的 Excel 資料，請先重新選擇專案資料夾接續一次" };

  const ExcelJS = self.ExcelJS;
  if (!ExcelJS) return { ok: false, error: "ExcelJS 未載入" };

  let workbook, ws;
  try {
    const binStr = atob(b64);
    const buf = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) buf[i] = binStr.charCodeAt(i);
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf.buffer);
    const SHEET_NAME = meta.sheetName || workbook.worksheets[1]?.name || workbook.worksheets[0]?.name;
    ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[1] || workbook.worksheets[0];
    if (!ws) return { ok: false, error: "找不到工作表" };
  } catch (e) {
    return { ok: false, error: "讀取目前的 Excel 失敗：" + e.message };
  }

  for (const rawRow of newRawRows) ws.addRow(rawRow);

  let outB64;
  try {
    const outBuf = await workbook.xlsx.writeBuffer();
    const outArr = new Uint8Array(outBuf);
    let bin = "";
    const chunkSize = 8192;
    for (let i = 0; i < outArr.length; i += chunkSize) bin += String.fromCharCode(...outArr.subarray(i, i + chunkSize));
    outB64 = btoa(bin);
  } catch (e) {
    return { ok: false, error: "寫出合併後的 Excel 失敗：" + e.message };
  }

  await chrome.storage.local.set({ latestExcelB64: outB64, sourceExcelB64: outB64 });

  const cfg = await getLocalFolderConfig();
  if (cfg.enabled) {
    const localBase = cfg.base || (meta.baseName || "").replace(/_下載進度管理$/i, "") || "CANCER_PAPERS";
    // 原檔也要跟著更新——它代表「目前已知的完整論文清單」，之後核對/續跑都要用
    // 含新論文的這份最新清單為準，不能永遠停在建專案那一刻的舊內容。
    await fmRequest("write_bytes", { root: cfg.root, relPath: `進度管理/${localBase}_原檔.xlsx`, dataB64: outB64 }).catch(() => {});
  }

  await _buildAndSaveExcel({ toDownload: true });

  return { ok: true, newTotal: ws.rowCount - 1 };
}

// 從既有專案資料夾讀回進度 Excel 時（OPEN_LOCAL_PROJECT 接續舊專案），把上一輪
// 執行留下的黃色高亮（狀態欄的 fill，代表「上次那次執行有動過這列」）整欄清掉，
// 只清 fill、不動文字顏色或內容——文字顏色才是持續累積的狀態紀錄（見
// _buildAndSaveExcelImpl 開頭同樣的 YELLOW/NO_FILL 區分）。不這樣做的話，這次
// 還沒開始跑，畫面上／磁碟上的 Excel 就已經有一批「看起來像剛處理過」的黃色列，
// 跟這次執行實際處理的列混在一起，分不出哪些才是「這次」動過的。
// 失敗就靜默回傳原始 b64，呼叫端當作沒清成功，不影響接續專案的主流程。
async function stripStatusHighlightB64(b64, meta = {}) {
  const ExcelJS = self.ExcelJS;
  if (!ExcelJS || !b64) return b64;
  try {
    const binStr = atob(b64);
    const buf = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) buf[i] = binStr.charCodeAt(i);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf.buffer);
    const SHEET_NAME = meta.sheetName || workbook.worksheets[1]?.name || workbook.worksheets[0]?.name;
    const ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[1] || workbook.worksheets[0];
    if (!ws) return b64;

    let statusCol = -1;
    ws.getRow(1).eachCell((cell, colNum) => {
      if (String(cell.value || "").trim() === "下載狀況") statusCol = colNum;
    });
    if (statusCol < 0) return b64;

    const NO_FILL = { type: "pattern", pattern: "none" };
    let cleared = 0;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = row.getCell(statusCol);
      if (cell.fill && cell.fill.pattern && cell.fill.pattern !== "none") {
        cell.fill = NO_FILL;
        cleared++;
      }
    });
    if (!cleared) return b64;

    const outBuf = await workbook.xlsx.writeBuffer();
    const outArr = new Uint8Array(outBuf);
    let bin = "";
    const chunkSize = 8192;
    for (let i = 0; i < outArr.length; i += chunkSize) bin += String.fromCharCode(...outArr.subarray(i, i + chunkSize));
    addThreadLog("stripStatusHighlightB64: cleared stale yellow highlight", { rows: cleared });
    return btoa(bin);
  } catch (e) {
    addThreadLog("stripStatusHighlightB64 failed", { error: e?.message || String(e) });
    return b64;
  }
}

// 所有真正的「讀 storage → 改 workbook → 寫回 storage/磁碟」都要走這個共用鎖排隊，
// 不能只靠 _doExcelWrite() 自己過去那個 bgExcelWriting 旗標——applyLocalFolderDiff()、
// appendNewRowsToLocalProject()、RESET_EXTENSION 收尾的 flush 都是直接呼叫這個函式，
// 沒有經過那層旗標。如果剛好跟下載進行中的正常寫入撞在一起，兩邊會各自讀到「對方
// 寫入前」的舊 storage 內容、各自算完再寫回，較晚寫完的那個會把較早寫完的那次整個
// 覆蓋掉，等於憑空遺失一批狀態更新。用同一個鎖把所有呼叫序列化，確保後面排隊的
// 那次一定是讀到「前一次已經真正寫完」之後的最新內容，不會互相蓋掉彼此的結果。
let _excelWriteLock = Promise.resolve();
function _buildAndSaveExcel(opts) {
  const run = () => _buildAndSaveExcelImpl(opts);
  const result = _excelWriteLock.then(run, run);
  // 用 .catch(()=>{}) 接住失敗結果才串進下一棒的鎖，不然某次失敗會讓鎖永遠卡在
  // rejected 狀態，之後排隊的呼叫全部連鎖失敗（.then 的第二個 rejection handler
  // 接住了、不會拋出，但拿來當「下一棒」的 _excelWriteLock 本身還是要是個一定會
  // resolve 的 promise，才能繼續放行後面排隊的呼叫）。
  _excelWriteLock = result.catch(() => {});
  return result;
}

async function _buildAndSaveExcelImpl({ toDownload = false } = {}) {
  // 以最新進度檔為基底（跨 session 累積結果，重跑不會覆蓋掉上一輪的紀錄），
  // 沒有才退回原始上傳檔
  const data = await chrome.storage.local.get(["latestExcelB64", "sourceExcelB64", "excelMeta"]);
  const b64  = data.latestExcelB64 || data.sourceExcelB64;
  const meta = data.excelMeta || {};
  addThreadLog("_buildAndSaveExcel start", { b64Bytes: b64?.length || 0, hasExcelJS: !!self.ExcelJS, toDownload });
  if (!b64) { addThreadLog("_buildAndSaveExcel skipped: no excel data in storage"); return false; }

  let binStr, buf;
  try {
    binStr = atob(b64);
    buf = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) buf[i] = binStr.charCodeAt(i);
    addThreadLog("_buildAndSaveExcel base64 decode OK", { bytes: buf.length });
  } catch(e) { addThreadLog("_buildAndSaveExcel base64 decode FAIL", { message: e.message }); return false; }

  const ExcelJS = self.ExcelJS;
  if (!ExcelJS) { addThreadLog("_buildAndSaveExcel failed: ExcelJS not found"); return false; }

  let workbook, ws;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf.buffer);
    addThreadLog("_buildAndSaveExcel workbook loaded", { sheets: workbook.worksheets.map(s=>s.name) });
    const SHEET_NAME = meta.sheetName || workbook.worksheets[1]?.name || workbook.worksheets[0]?.name;
    ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[1] || workbook.worksheets[0];
    addThreadLog("_buildAndSaveExcel worksheet selected", { worksheet: ws?.name || "NOT FOUND" });
    if (!ws) return false;
  } catch(e) { addThreadLog("_buildAndSaveExcel workbook load FAIL", { message: e.message }); return false; }

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

  // 框框填色＝「這次有處理過」的高亮記號（跟狀態無關，一律黃色）；
  // 文字顏色＝狀態本身，是持續累積的紀錄，不會被下一輪清掉。
  const YELLOW    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  const NO_FILL   = { type: "pattern", pattern: "none" };
  const FONT_BLACK = "FF000000"; // 下載成功
  const FONT_RED   = "FFFF0000"; // 下載失敗
  const FONT_BLUE  = "FF0000FF"; // 下次重試

  const rMap     = G.resultsMap     || {};
  const failMap  = G.resultsFailMap || {};

  // 上一輪處理留下的黃色高亮先整欄清掉（不管當時是什麼狀態，反正黃色只代表
  // 「上次有動過」），文字顏色不動——那是用來看所有列目前狀態的持續紀錄。
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.getCell(statusCol).fill = NO_FILL;
  });

  for (const [rowIndex, status] of Object.entries(rMap)) {
    const ri  = parseInt(rowIndex, 10);
    const row = ws.getRow(ri);
    const cell = row.getCell(statusCol);
    cell.value = status;
    cell.fill  = YELLOW; // 本次處理過的列都標黃，代表「這次有動過」
    const fontColor = status === STATUS_SUCCESS ? FONT_BLACK
                     : status === STATUS_FAIL ? FONT_RED
                     : status === STATUS_RETRY ? FONT_BLUE
                     : FONT_BLACK;
    cell.font = { ...(cell.font || {}), color: { argb: fontColor } };
    const failCell = row.getCell(failReasonCol);
    if ((status === STATUS_FAIL || status === STATUS_RETRY) && failMap[ri]) {
      failCell.value = failMap[ri];
    } else if (status === STATUS_SUCCESS) {
      // 成功列一般清空此欄；但若是「檔名重複」提醒（見 filenameClaim 邏輯），要保留下來
      failCell.value = failMap[ri] || null;
    } else if (!status) {
      // 空白／未下載（例如本地資料夾核對同步把某列打回未下載）：不該留著舊的失敗
      // 原因文字，不然使用者會誤以為這篇還是同一個舊原因失敗，其實根本還沒處理過。
      failCell.value = null;
    }
    // 其餘情況（狀態是 FAIL/RETRY 但這次沒有新的失敗原因文字）維持舊值不動——
    // 通常是核對同步只知道狀態、沒有詳細原因時，保留舊原因還算合理的近似值。
  }

 
  let outBuf;
  try {
    outBuf = await workbook.xlsx.writeBuffer();
    addThreadLog("_buildAndSaveExcel writeBuffer OK", { bytes: outBuf.byteLength });
  } catch(e) { addThreadLog("_buildAndSaveExcel writeBuffer FAIL", { message: e.message }); return false; }

 
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
  } catch(e) { addThreadLog("_buildAndSaveExcel storage save FAIL", { message: e.message }); return false; }

  addThreadLog("_buildAndSaveExcel toDownload check", { toDownload });
  if (!toDownload) return true;

  // 本地資料夾模式：進度 Excel 固定寫回 進度管理/<base>_進度管理.xlsx（覆蓋），
  // 完全跳過 chrome.downloads，天生滿足「只保留一份、不會愈積愈多」。
  const localCfg = await getLocalFolderConfig();
  if (localCfg.enabled) {
    const localBase = localCfg.base || (meta.baseName || "").replace(/_下載進度管理$/i, "") || "CANCER_PAPERS";
    try {
      await fmRequest("write_bytes", {
        root: localCfg.root,
        relPath: "進度管理/" + localBase + "_進度管理.xlsx",
        dataB64: bufferToBase64(outBuf),
      });
      addLog("已更新下載進度 Excel（本地資料夾模式）", "ok");
      addThreadLog("_buildAndSaveExcel local write OK", { root: localCfg.root, base: localBase });
      return true;
    } catch (e) {
      if (!localCfg.allowFallback) {
        addLog("進度 Excel 寫入本地資料夾失敗：" + (e?.message || e) + "（未開啟「失敗退回 Chrome 下載」進階設定）", "fail");
        addThreadLog("_buildAndSaveExcel local write FAIL, fallback disabled", { message: e?.message || String(e) });
        return false;
      }
      addLog("進度 Excel 寫入本地資料夾失敗：" + (e?.message || e) + "，退回一般下載流程", "fail");
      addThreadLog("_buildAndSaveExcel local write FAIL, falling back", { message: e?.message || String(e) });
      // 不 return——讓下面既有的 chrome.downloads 流程當退路
    }
  }

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
  registerPendingDownloadFilename(dataUrl, progressFilename);
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
  // chrome.downloads.download 是 fire-and-forget（上面的 callback 非同步才會知道結果，
  // 這裡沒有結構化去 await 它），樂觀回傳 true——這條路徑本來就不是本地資料夾模式
  // 在乎的路徑，真正需要精準回報成功/失敗的是上面 local write 那段。
  return true;
}

// 本地資料夾模式的檔名解析：依所在資料夾預期的格式反推「序號、狀態字樣、標題」。
// 成功資料夾是 {seq}_{title}；失敗/重試資料夾是 {seq}_{狀態字樣}_{title}，狀態字樣
// 一定要跟資料夾名稱相符（不符代表檔案被搬錯位置或改過名）。解析失敗（不符任何
// 格式）回傳 null，呼叫端會把它歸進「異常檔案」。
function parseLocalStem(folderName, stem) {
  if (folderName === STATUS_SUCCESS) {
    const m = /^(\d+)_(.+)$/.exec(stem);
    return m ? { seq: m[1], statusWord: null, title: m[2] } : null;
  }
  const m = /^(\d+)_(下載失敗|下次重試)_(.+)$/.exec(stem);
  return m ? { seq: m[1], statusWord: m[2], title: m[3] } : null;
}

// 以下欄位配置、seqLabel 算法必須跟 popup.js 的 buildAllRowsFromWorkbook() 保持完全
// 一致，兩邊各自對同一份 Excel 算出來的序號才會對得起來（下載時的檔名前綴是 popup
// 那邊算的，核對時如果這裡算出不同的序號，等於全部誤判）。
const BG_COL_PMID  = 2;  // ExcelJS 1-based 欄號，對應 popup.js COL_PMID（0-based=1，欄 B）
const BG_COL_TITLE = 3;  // 欄 C
const BG_LOCAL_SEQ_WIDTH  = 4;  // 需跟 popup.js LOCAL_SEQ_WIDTH 保持一致

function sanitizeFilenameBg(title) {
  if (!title) return "untitled";
  return String(title)
    .replace(/[?/\\:*"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 120);
}

// 核對要比對的是「Excel 本身」，不是任何時間點拍下來的快照——每次呼叫都直接從
// chrome.storage.local 現存最新的 Excel bytes（跟 _buildAndSaveExcelImpl() 寫回的
// 同一份 latestExcelB64）重新解析，確保拿到的永遠是目前為止最新的內容，不會因為
// 「這次要下載的目標清單只是子集」或「拍照時間點太舊」而漏掉/誤判任何一列。
async function buildAllRowsFromStorage() {
  const data = await chrome.storage.local.get(["latestExcelB64", "sourceExcelB64", "excelMeta"]);
  const b64 = data.latestExcelB64 || data.sourceExcelB64;
  if (!b64) return [];

  const ExcelJS = self.ExcelJS;
  if (!ExcelJS) return [];

  const meta = data.excelMeta || {};
  const binStr = atob(b64);
  const buf = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) buf[i] = binStr.charCodeAt(i);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf.buffer);
  const SHEET_NAME = meta.sheetName || workbook.worksheets[1]?.name || workbook.worksheets[0]?.name;
  const ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[1] || workbook.worksheets[0];
  if (!ws) return [];

  let statusCol = -1;
  ws.getRow(1).eachCell((cell, colNum) => {
    const v = String(cell.value || "").trim();
    if (v === "下載狀況") statusCol = colNum;
  });

  const allRows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const pmidRaw  = row.getCell(BG_COL_PMID).value;
    const titleRaw = row.getCell(BG_COL_TITLE).value;
    const pmidStr  = pmidRaw != null ? String(pmidRaw).trim() : "";
    const titleStr = titleRaw != null ? String(titleRaw).trim() : "";
    if (!pmidStr && !titleStr) return;
    const pmidNum = pmidStr ? parseInt(pmidStr, 10) : NaN;
    const statusRaw = statusCol > 0 ? row.getCell(statusCol).value : null;
    allRows.push({
      rowIndex:  rowNumber,
      pmid:      Number.isFinite(pmidNum) && pmidNum > 0 ? String(pmidNum) : null,
      title:     titleStr,
      safeTitle: sanitizeFilenameBg(titleStr),
      status:    statusRaw != null ? String(statusRaw).trim() : "",
    });
  });

  allRows.forEach((r, i) => {
    r.seqLabel = String(i + 1).padStart(BG_LOCAL_SEQ_WIDTH, "0");
  });

  return allRows;
}

// 本地資料夾模式的核對：只計算差異，完全不寫入任何東西（不改 resultsMap、不刪檔、
// 不動 Excel）。回傳的結構供 popup 呈現報告，使用者確認後才會呼叫
// applyLocalFolderDiff() 真正套用。呼叫時機見 OPEN_LOCAL_PROJECT（接續舊專案）、
// 整批下載跑完的收尾點、popup 的「🔄 核對進度」按鈕——三個呼叫點都不用自己組列
// 清單，一律由這裡當場重新讀 Excel 本身。
async function computeLocalFolderDiff() {
  const cfg = await getLocalFolderConfig();
  if (!cfg.enabled) return { skipped: true, reason: "本地資料夾模式未開啟或未選擇資料夾" };

  const rowList = await buildAllRowsFromStorage();
  if (!rowList.length) return { skipped: true, reason: "沒有可核對的列（尚未載入 Excel）" };

  const listed = await fmRequest("list_status_folders", { root: cfg.root });
  const folders = listed.folders || {};

  const rowBySeq = new Map(rowList.filter(r => r.seqLabel).map(r => [r.seqLabel, r]));
  const anomalies = [];

  for (const folderName of [STATUS_SUCCESS, STATUS_FAIL, STATUS_RETRY]) {
    for (const entry of (folders[folderName] || [])) {
      const stem = entry.title; // native host 回傳的 title 其實是檔名去掉副檔名
      const parsed = parseLocalStem(folderName, stem);
      if (!parsed) {
        anomalies.push({ folder: folderName, file: stem, reason: "檔名格式不符命名規則" });
        continue;
      }
      if (parsed.statusWord && parsed.statusWord !== folderName) {
        anomalies.push({ folder: folderName, file: stem, reason: `檔名內狀態字樣「${parsed.statusWord}」與所在資料夾「${folderName}」不符` });
        continue;
      }
      const row = rowBySeq.get(parsed.seq);
      if (!row) {
        anomalies.push({ folder: folderName, file: stem, reason: `Excel 中不存在第 ${parsed.seq} 篇論文` });
        continue;
      }
      if (row.safeTitle !== parsed.title) {
        anomalies.push({
          folder: folderName, file: stem, rowIndex: row.rowIndex,
          reason: `第 ${parsed.seq} 篇檔名與 Excel 記錄的論文標題不符（Excel：「${row.title}」，可能遭改名）`,
        });
        continue;
      }
      row._found = row._found || {};
      row._found[folderName] = { mtime: entry.mtime || 0, stem };
    }
  }

  const mismatches = [];
  const conflicts = [];

  for (const row of rowList) {
    const found = row._found || {};
    const hasPdf   = !!found[STATUS_SUCCESS];
    const hasFail  = !!found[STATUS_FAIL];
    const hasRetry = !!found[STATUS_RETRY];

    let folderStatus = "";
    let conflict = null;
    if (hasPdf && (hasFail || hasRetry)) {
      // 成功的 PDF 跟失敗/重試的診斷 txt 同時存在（例如手動把之前失敗的論文補下載
      // 進去，卻沒清掉舊的失敗紀錄）：PDF 優先，多餘的 txt 留給使用者確認後再刪。
      folderStatus = STATUS_SUCCESS;
      const toDelete = [];
      if (hasFail)  toDelete.push(`${STATUS_FAIL}/${found[STATUS_FAIL].stem}.txt`);
      if (hasRetry) toDelete.push(`${STATUS_RETRY}/${found[STATUS_RETRY].stem}.txt`);
      conflict = { type: "pdf_vs_txt", resolution: "keep_pdf", toDelete };
    } else if (hasFail && hasRetry) {
      // 沒有 PDF 可以當依據，兩份診斷 txt 都在，用檔案 mtime 較新的那份為準
      // （比較可能是「後來重試又失敗」這個更接近事實的最新結果）。
      const failNewer = (found[STATUS_FAIL].mtime || 0) >= (found[STATUS_RETRY].mtime || 0);
      folderStatus = failNewer ? STATUS_FAIL : STATUS_RETRY;
      conflict = {
        type: "fail_vs_retry",
        resolution: failNewer ? "keep_fail" : "keep_retry",
        toDelete: [failNewer ? `${STATUS_RETRY}/${found[STATUS_RETRY].stem}.txt` : `${STATUS_FAIL}/${found[STATUS_FAIL].stem}.txt`],
      };
    } else if (hasPdf) {
      folderStatus = STATUS_SUCCESS;
    } else if (hasFail) {
      folderStatus = STATUS_FAIL;
    } else if (hasRetry) {
      folderStatus = STATUS_RETRY;
    }
    // 三個資料夾都沒有 → folderStatus 維持 ""，視為未下載

    delete row._found;

    const excelStatus = (row.status === STATUS_SUCCESS || row.status === STATUS_FAIL || row.status === STATUS_RETRY)
      ? row.status : "";

    const entry = { rowIndex: row.rowIndex, seqLabel: row.seqLabel, title: row.title, excelStatus, folderStatus };
    if (conflict) {
      conflicts.push({ ...entry, type: conflict.type, resolution: conflict.resolution, toDelete: conflict.toDelete });
    } else if (excelStatus !== folderStatus) {
      mismatches.push(entry);
    }
  }

  const diff = {
    clean: mismatches.length === 0 && conflicts.length === 0 && anomalies.length === 0,
    mismatches, conflicts, anomalies,
    summary: {
      total: rowList.length,
      mismatchCount: mismatches.length,
      conflictCount: conflicts.length,
      anomalyCount: anomalies.length,
    },
  };
  addThreadLog("computeLocalFolderDiff done", diff.summary);
  return diff;
}

// 使用者在核對報告上按「同步更新」後才會呼叫：重新算一次最新的差異（不信任呼叫端
// 手上那份可能已經過時的結果），把 mismatches/conflicts 兩桶的列寫回 resultsMap、
// 刪掉 conflicts 標記要清的殘留檔，最後重新產生 Excel。anomalies 完全不動——那些
// 檔案的歸屬需要人工判斷，不屬於「哪個資料夾為準」這種能自動決定的情況。
async function applyLocalFolderDiff() {
  const diff = await computeLocalFolderDiff();
  if (diff.skipped) return diff;

  const cfg = await getLocalFolderConfig();
  const newResultsMap = { ...G.resultsMap };
  const toDelete = [];

  for (const row of [...diff.mismatches, ...diff.conflicts]) {
    newResultsMap[row.rowIndex] = row.folderStatus;
    if (row.toDelete) toDelete.push(...row.toDelete);
  }

  if (toDelete.length) {
    await fmRequest("delete_paths", { root: cfg.root, relPaths: toDelete }).catch(() => {});
  }

  G.resultsMap = newResultsMap;
  const excelWriteOk = await _buildAndSaveExcel({ toDownload: true });
  if (!excelWriteOk) {
    // _buildAndSaveExcel 已經把詳細原因寫進 thread log（storage 沒有 Excel 資料／
    // native host 寫檔失敗等），這裡不重複判斷原因，只確保呼叫端不會被誤導成
    // 「同步成功了」——resultsMap 雖然在記憶體裡已經改好，但沒有真的落到磁碟上。
    throw new Error("Excel 寫入失敗，變更未儲存（詳見 thread log 的 _buildAndSaveExcel 相關訊息）");
  }

  const result = {
    changed: diff.mismatches.length + diff.conflicts.length,
    deletedStaleFiles: toDelete.length,
    anomalyCount: diff.anomalies.length,
    totalRows: diff.summary.total,
  };
  addThreadLog("applyLocalFolderDiff done", result);
  return result;
}

// 一個 stage 結果：{ ok: true/false, detail: "說明文字" }。ok 為 undefined 代表這個
// 階段根本沒跑到（被前面某個失敗擋住），createFailureNote 會顯示成「未執行」。
function stageResult(ok, detail = "") {
  return { ok, detail };
}

async function getPdfUrlWithFallback(tabId, item, workerIdx, trace = null, downloadName = null, itemFolder = null) {
  let localFailureReason = "";
  let localFullTextLinks = [];
  // 提早宣告：中文論文查詢流程（若有嘗試）的紀錄要留在這裡，不管後面從哪個
  // return 點離開，都會帶著這筆紀錄一起回去，最後才不會在下載失敗 txt 裡消失。
  const linkAttempts = [];

  // 分段除錯報告：下載失敗 txt 會依這個結構分段列出「中文查詢流程」與「PubMed 流程」
  // 各階段是成功/失敗，取代舊版一大段不好讀的自由文字。見 createFailureNote()。
  const report = {
    isChineseTitle: isBracketedChineseTitle(item),
    chinese: null,
    pubmed: {
      entered: null,        // stageResult：是否成功導到 PubMed 網址
      articleFound: null,   // stageResult：是否確認為有效文章頁
      fullTextLinks: null,  // { ...stageResult, list: [{label,url}] }
      linkAttempts: [],     // [{ label, url, pdfFound: stageResult }]
    },
  };

  if (await isLoginPage(tabId)) {
    await ensureLogin(tabId);
  }

  // 中文期刊（PubMed Title 整段被「[ ]」框住）：PubMed 上常找不到可用的 Full Text
  // link，先試中文論文查詢流程（見 platform_handlers/chinese_paper_search.js）；
  // 失敗才落回下面原本的 PubMed PMID/title 流程，不影響非中文論文的行為。
  if (report.isChineseTitle) {
    workerLog(workerIdx, "  Title 被中括號框住，判定為中文期刊，先嘗試中文論文查詢流程。", "info");
    addThreadLog("Chinese paper search flow starting", { pmid: item.pmid, title: item.title, doi: item.doi });
    // 搜尋＋下載（含點文章頁、點下載按鈕、攔截檔案）整段都在
    // searchChinesePaperPdf 裡完成，這裡只需要看 downloaded 這個布林結果。
    const cnResult = await searchChinesePaperPdf(tabId, item, workerIdx, trace, downloadName, itemFolder);
    report.chinese = cnResult?.report || { otherReason: "中文論文查詢流程未回傳分段報告（非預期狀況）。" };
    if (cnResult?.downloaded) {
      workerLog(workerIdx, "  中文論文查詢流程下載成功，不需再嘗試 PubMed 流程。", "ok");
      addThreadLog("Chinese paper search flow succeeded", { pmid: item.pmid, articleUrl: cnResult.pdfUrl });
      return {
        pdfUrl: cnResult.pdfUrl,
        alreadyDownloaded: true,
        failureReason: "",
        fullTextLinks: [],
        linkAttempts: [ "中文論文查詢流程（CNKI）：已下載成功 " + cnResult.pdfUrl ],
        report,
      };
    }
    const cnReason = cnResult?.failureReason || "未知原因（流程未回傳失敗說明）";
    workerLog(workerIdx, "  中文論文查詢流程未取得 PDF：" + cnReason + "；改用原本 PubMed 流程。", "warn");
    addThreadLog("Chinese paper search flow failed; falling back to PubMed flow", {
      pmid: item.pmid, reason: cnReason
    });
    // 留一筆紀錄：就算後面 PubMed 流程也失敗，下載失敗 txt 裡才看得到 CNKI 那次
    // 到底發生了什麼事，而不是只看到「PubMed 沒有 Full Text 連結」這種沒有幫助的說明。
    linkAttempts.push("中文論文查詢流程（CNKI）：" + cnReason);
  }

  let pubmedUrl = null;
  let usedPmidDirect = false;

  // PMID 是精確識別碼，優先使用；title 搜尋取第一筆結果，可能命中相似標題的別篇論文
  if (item.pmid && /^\d{4,}$/.test(String(item.pmid))) {
    pubmedUrl = PUBMED_EZPROXY + "/" + item.pmid + "/";
    usedPmidDirect = true;
    workerLog(workerIdx, "  以 PMID 直達: " + item.pmid, "info");
  } else if (item.title) {
    workerLog(workerIdx, "  Title 搜尋: " + truncate(item.safeTitle, 50), "info");
    const titleResult = await searchByTitle(tabId, item.safeTitle, item.title);
    if (titleResult === "__NEED_LOGIN__") {
      workerLog(workerIdx, "  Title 搜尋需要重新登入，登入後重試。", "warn");
      await ensureLogin(tabId);
      const retry = await searchByTitle(tabId, item.safeTitle, item.title);
      pubmedUrl = (retry && retry !== "__NEED_LOGIN__") ? retry : null;
    } else {
      pubmedUrl = titleResult;
    }
  }

  if (!pubmedUrl) {
    report.pubmed.entered = stageResult(false, "沒有可用的 PMID 或 Title，無法組出 PubMed 網址。");
    return { pdfUrl: "SKIP", failureReason: "", fullTextLinks: [], linkAttempts, report };
  }

  await navigateTab(tabId, pubmedUrl, 4000);
  report.pubmed.entered = stageResult(true, "已導到：" + pubmedUrl);

  if (await isLoginPage(tabId)) {
    workerLog(workerIdx, "  PubMed 頁面要求重新登入，登入後重試。", "warn");
    await ensureLogin(tabId);
    await navigateTab(tabId, pubmedUrl, 4000);
    report.pubmed.entered = stageResult(true, "已導到：" + pubmedUrl + "（過程中重新登入過一次）");
  }

  // PMID 頁面無效（Excel 內 PMID 可能有誤）時，退回 title 搜尋一次
  if (usedPmidDirect && item.title && !(await isPubmedArticlePage(tabId))) {
    workerLog(workerIdx, "  PMID 頁面無效，改用 Title 搜尋: " + truncate(item.safeTitle, 50), "warn");
    let titleResult = await searchByTitle(tabId, item.safeTitle, item.title);
    if (titleResult === "__NEED_LOGIN__") {
      await ensureLogin(tabId);
      titleResult = await searchByTitle(tabId, item.safeTitle, item.title);
      if (titleResult === "__NEED_LOGIN__") titleResult = null;
    }
    if (titleResult) {
      pubmedUrl = titleResult;
      await navigateTab(tabId, pubmedUrl, 4000);
    }
  }

  const pageState = await checkPageState(tabId);
  if (pageState === "bot") {
    report.pubmed.articleFound = stageResult(false, "偵測到機器人/驗證頁，無法確認文章頁。");
    chrome.runtime.sendMessage({
      action: "BOT_DETECTED", pmid: item.pmid,
      detail: "Bot/captcha/access challenge detected"
    }).catch(() => {});
    return { pdfUrl: "BOT", failureReason: "", fullTextLinks: [], linkAttempts, report };
  }

  const articleOk = await isPubmedArticlePage(tabId);
  report.pubmed.articleFound = stageResult(
    articleOk,
    articleOk ? "已確認為有效的 PubMed 文章頁：" + pubmedUrl
              : "PubMed 頁面看起來不是有效的文章頁（PMID 或 Title 可能有誤）：" + pubmedUrl
  );

  const fullTextLinks = await waitForPubMedFullTextLinks(tabId, pubmedUrl, workerIdx);
  localFullTextLinks = fullTextLinks || [];
  if (!fullTextLinks?.length) {
    localFailureReason = "PubMed 頁面在等待與重載後仍未載入 Full Text 連結。";
    report.pubmed.fullTextLinks = stageResult(false, "無可用的 Full Text 連結。");
    report.pubmed.fullTextLinks.list = [];
    return { pdfUrl: null, failureReason: localFailureReason, fullTextLinks: localFullTextLinks, linkAttempts, report };
  }
  report.pubmed.fullTextLinks = stageResult(
    true,
    "共找到 " + fullTextLinks.length + " 個 Full Text 連結。"
  );
  report.pubmed.fullTextLinks.list = fullTextLinks.map(ft => ({
    label: ft.label || ft.source || "未知來源",
    url: ft.url
  }));

  const nonCmuLinks = fullTextLinks.filter(ft => !isCmuLibFullTextLink(ft));
  const cmuLinks = fullTextLinks.filter(isCmuLibFullTextLink);
  if (!nonCmuLinks.length && cmuLinks.length) {
    localFailureReason = "只找到 CMULib / SerialsSolutions Full Text link，無法直接解析 PDF。";
    return { pdfUrl: null, failureReason: localFailureReason, fullTextLinks: localFullTextLinks, retryable: false, finalFailure: true, linkAttempts, report };
  }

  if (fullTextLinks.length === 1 && fullTextLinks[0].source === "serialssolutions") {
    localFailureReason = "Full Text 只有 CMU Library / SerialsSolutions resolver，可能無法直接取得 PDF。";
  }

  workerLog(workerIdx, "  找到 " + fullTextLinks.length + " 個 Full Text 連結，會依序嘗試。", "info");
  const pdfCandidates = [];

  for (let i = 0; i < fullTextLinks.length; i++) {
    if (G.stopped) break;
    const ft = fullTextLinks[i];
    const ftUrl = ft.url;
    const ftLabel = ft.label || ft.source || "未知來源";
    if (isCmuLibFullTextLink(ft)) {
      linkAttempts.push(ftLabel + ": CMULib / SerialsSolutions resolver 視為不可用，略過不嘗試。");
      report.pubmed.linkAttempts.push({
        label: ftLabel, url: ftUrl,
        pdfFound: stageResult(false, "CMULib / SerialsSolutions resolver 視為不可用，略過不嘗試。")
      });
      workerLog(workerIdx, "  略過 CMU Library / SerialsSolutions 連結。", "warn");
      continue;
    }
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
      workerLog(workerIdx, isPmcPrintCandidate(pdfUrl)
        ? "  PMC 沒有原生 PDF 連結，已改列入列印成 PDF 候選。"
        : "  已從 " + ftLabel + " 找到 PDF。", "ok");
      pdfCandidates.push({
        pdfUrl,
        label: ftLabel,
        sourceUrl: ftUrl,
        fullTextIndex: i + 1
      });
      addThreadLog("PDF found from Full Text link", {
        workerIdx,
        label: ftLabel,
        pdfUrl,
        printPmc: isPmcPrintCandidate(pdfUrl)
      });
      report.pubmed.linkAttempts.push({
        label: ftLabel, url: ftUrl,
        pdfFound: stageResult(true, (isPmcPrintCandidate(pdfUrl) ? "PMC 無原生 PDF，改列印成 PDF：" : "找到 PDF：") + pdfUrl)
      });
      continue;
    }

    let reason = isCmuLibFullTextLink(ft)
      ? "CMULib / SerialsSolutions resolver 無法直接解析 PDF。"
      : linkError
        ? "查詢此 Full Text link 時發生錯誤：" + linkError
        : (await getCurrentPageFailureReason(tabId)) || "進入 Full Text link 後未找到 PDF 下載連結。";
    if (isAtyponContext(ft)) {
      reason += " Atypon 註記：此平台常見只有 HTML 閱讀頁，沒有可直接下載的 PDF 端點。";
    }
    linkAttempts.push(ftLabel + ": " + reason);
    report.pubmed.linkAttempts.push({ label: ftLabel, url: ftUrl, pdfFound: stageResult(false, reason) });
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
      report,
    };
  }

  if (!localFailureReason) {
    const tried = linkAttempts.length ? linkAttempts.join(" | ") : fullTextLinks.map(x => x.label || x.source || x.url).join(" | ");
    localFailureReason = cmuLinks.length
      ? "已嘗試非 CMULib 與 CMULib Full Text link，但都沒有取得 PDF：" + tried
      : "已嘗試所有 Full Text link，但都沒有取得 PDF：" + tried;
  }
  return { pdfUrl: null, failureReason: localFailureReason, fullTextLinks: localFullTextLinks, linkAttempts, report };
}

// 偵測「文章內容區的 DOM 是否已經穩定不再變動」：連續 quietMs 毫秒沒有任何
// mutation 就視為穩定。PubMed 的 Full Text links 是頁面載入後另外發一支 AJAX
// （articleLinksAjaxUrl）才把連結填進 DOM，單純輪詢一段固定時間後放棄，無法分辨
// 「這篇真的沒有連結」跟「AJAX 還沒回來」。用 MutationObserver 直接觀察內容區：
// 觀察範圍只鎖定文章內容區（不含 header/footer），避開背景分析/追蹤 script
// 對 body 其他角落的持續性 DOM 異動，才不會一直被重置安靜計時器。
// 回傳 "settled"＝已確認穩定；"timeout"＝時限內仍在變動，無法確定，交給呼叫端走原本的輪詢/重試。
async function waitForArticleDomSettle(tabId, quietMs = 2500, maxMs = 15000) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: (quiet, maxWait) => new Promise(resolve => {
        const root = document.querySelector("main#article-details, main.article-details, #full-view-heading") || document.body;
        let settled = false;
        let quietTimer = null;
        let hardCap = null;
        const finish = reason => {
          if (settled) return;
          settled = true;
          try { observer.disconnect(); } catch {}
          if (quietTimer) clearTimeout(quietTimer);
          if (hardCap) clearTimeout(hardCap);
          resolve(reason);
        };
        const resetQuietTimer = () => {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish("settled"), quiet);
        };
        const observer = new MutationObserver(resetQuietTimer);
        observer.observe(root, { childList: true, subtree: true, attributes: true });
        hardCap = setTimeout(() => finish("timeout"), maxWait);
        resetQuietTimer();
      }),
      args: [quietMs, maxMs]
    });
    return r?.[0]?.result || "timeout";
  } catch {
    return "timeout";
  }
}

async function waitForPubMedFullTextLinks(tabId, pubmedUrl, workerIdx) {
  workerLog(workerIdx, "  等待 PubMed Full Text link 載入...", "info");

  // 先確認文章內容區的 DOM 是否已經穩定：若穩定下來仍然沒有 Full Text 連結，
  // 代表頁面（含它自己載入全文連結用的 AJAX）已經跑完，這篇是真的沒有全文連結，
  // 不必再乾等固定的 60 秒＊2；DOM 仍在變動（未在時限內穩定）才落回原本的長輪詢。
  const settleResult = await waitForArticleDomSettle(tabId, 2500, 15000);
  let links = await pollForFullTextLink(tabId, 600); // 立即檢查一次目前 DOM 狀態
  if (links?.length) return links;
  if (settleResult === "settled") {
    workerLog(workerIdx, "  頁面內容已穩定且無 Full Text 連結，判定此篇真的沒有全文連結（非逾時判定）。", "info");
    addThreadLog("Article DOM settled with no full text links; treating as confirmed empty", { workerIdx, pubmedUrl });
    return [];
  }

  links = await pollForFullTextLink(tabId, PUBMED_FULL_TEXT_WAIT_MS);
  if (links?.length) return links;

  workerLog(workerIdx, "  PubMed Full Text link 尚未出現，重新載入 PubMed 頁面後再等待一次。", "warn");
  addThreadLog("PubMed full text links missing; reloading article page", { workerIdx, pubmedUrl });
  await navigateTab(tabId, pubmedUrl, 6000);

  if (await isLoginPage(tabId)) {
    workerLog(workerIdx, "  PubMed 重新載入後要求登入，登入後再重試。", "warn");
    await ensureLogin(tabId);
    await navigateTab(tabId, pubmedUrl, 6000);
  }

  links = await pollForFullTextLink(tabId, PUBMED_FULL_TEXT_WAIT_MS);
  if (links?.length) {
    workerLog(workerIdx, "  PubMed 重新載入後找到 Full Text link。", "ok");
    return links;
  }

  const pageState = await getPubMedLoadState(tabId);
  addThreadLog("PubMed full text links still missing after reload", { workerIdx, pubmedUrl, pageState });
  return [];
}

async function getPubMedLoadState(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: document.title || "",
        hasArticleTitle: !!document.querySelector("h1.heading-title, .heading-title"),
        linkItemCount: document.querySelectorAll("a.link-item").length,
        bodyTextStart: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240)
      })
    });
    return r?.[0]?.result || null;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
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
  } catch (e) {
    // 無法對這個分頁執行腳本，通常代表分頁正顯示 Chrome 自己的網路層錯誤頁
    //（chrome-error://，例如跳轉太多次 ERR_TOO_MANY_REDIRECTS、連線逾時
    // ERR_CONNECTION_TIMED_OUT、DNS 解析失敗等），而不是出版商網站真的回應了
    // 什麼內容——以前這種情況只會回傳空字串，呼叫端會退回成完全沒有資訊量的
    // 「進入 Full Text link 後未找到 PDF 下載連結」，這裡改成盡量說明清楚。
    return await describeUnscriptablePage(tabId, e?.message || String(e));
  }
}

// 分頁無法執行腳本時（通常是 chrome-error:// 網路層錯誤頁）盡量拼出有意義的說明：
// 摘錄 executeScript 拋出的原始錯誤訊息，並附上分頁目前卡在哪個網址方便對照除錯。
async function describeUnscriptablePage(tabId, rawErrorMessage) {
  const looksLikeErrorPage = /showing error page|chrome-error|cannot access/i.test(rawErrorMessage);
  let currentUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab?.url || "";
  } catch {}
  if (looksLikeErrorPage) {
    return "疑似連線層級錯誤（例如跳轉太多次、連線逾時、DNS 或憑證問題），而非出版商頁面內容回傳的錯誤" +
      "（分頁顯示瀏覽器自己的錯誤頁，程式無法讀取頁面文字）。" +
      (currentUrl ? "分頁卡在：" + currentUrl + "。" : "") +
      "原始錯誤：" + rawErrorMessage;
  }
  return "無法讀取此頁面內容以判斷失敗原因（" + rawErrorMessage + "）" +
    (currentUrl ? "，分頁目前網址：" + currentUrl : "") + "。";
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

async function captureLoginCaptcha(tabId) {
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
  return captchaBase64;
}

async function requestLogin(tabId) {
  addLog("需要登入 CMU EZproxy，請填入帳號...", "warn");
  G.waitingLogin = true;
  // 帳密/驗證碼錯誤時重新擷取驗證碼讓使用者重試，而不是直接終止整批任務
  const MAX_LOGIN_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {

  const captchaBase64 = await captureLoginCaptcha(tabId);

  chrome.runtime.sendMessage({
    action:     "NEED_LOGIN",
    captchaImg: captchaBase64,
    retry:      attempt > 1,
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
  const stillOnLoginPage = finalUrl.includes("/user/login") || finalUrl.includes("/proxy/login");
  if (!stillOnLoginPage) {
    addLog("  登入成功", "ok");
    G.waitingLogin = false;
    // 只有真的成功才通知 popup 成功；失敗會回到迴圈頂端拿新驗證碼重試
    chrome.runtime.sendMessage({ action: "LOGIN_OK" }).catch(() => {});
    return;
  }
  addLog(`  登入後仍在登入頁面（第 ${attempt}/${MAX_LOGIN_ATTEMPTS} 次），帳密或驗證碼可能錯誤`, "warn");

  }

  addLog("已連續登入失敗 " + MAX_LOGIN_ATTEMPTS + " 次，放棄本次登入。", "fail");
  G.waitingLogin = false;
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

// 兩個標題的 token 重合率（0~1），用來驗證搜尋結果是不是目標論文
function titleSimilarity(a, b) {
  const tokens = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2);
  const ta = tokens(a), tb = new Set(tokens(b));
  if (!ta.length || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / ta.length;
}

async function isPubmedArticlePage(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!document.querySelector("h1.heading-title")
    });
    return r?.[0]?.result === true;
  } catch { return false; }
}

async function searchByTitle(tabId, safeTitle, originalTitle = "") {
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
          return first ? { href: first.href, title: (first.innerText || "").replace(/\s+/g, " ").trim() } : null;
        }
        if (document.querySelector("h1.heading-title") || url.match(/\/\d{6,}\/$/)) {
          return { href: url, title: (document.querySelector("h1.heading-title")?.innerText || "").replace(/\s+/g, " ").trim() };
        }
        return null;
      }
    });
    const res = r?.[0]?.result;
    if (!res?.href) return null;

    // 搜尋結果第一筆不一定是目標論文：標題差太多就不採用，避免下載到別篇還標成功
    const targetTitle = originalTitle || safeTitle;
    if (res.title && targetTitle) {
      const sim = titleSimilarity(targetTitle, res.title);
      if (sim < 0.5) {
        addLog("  搜尋結果標題與目標相似度過低（" + Math.round(sim * 100) + "%），不採用：" + truncate(res.title, 60), "warn");
        return null;
      }
    }
    return res.href;
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
        // 只認明確的驗證頁特徵。單一字詞（robot / captcha / 403）會誤判論文內文，
        // 例如 robotic surgery 相關論文的摘要就含有 "robot"
        if (document.querySelector(
          "#challenge-form, #cf-challenge-running, .g-recaptcha, #px-captcha, " +
          "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']"
        )) return "bot";

        const title = (document.title || "").toLowerCase();
        if (title.includes("just a moment") ||
            title.includes("attention required") ||
            title.includes("access denied") ||
            title.startsWith("403 forbidden") ||
            title.includes("429 too many requests")) {
          return "bot";
        }

        const text = (document.body?.innerText || "").substring(0, 3000).toLowerCase();
        const phrases = [
          "verify you are a human",
          "verify that you are not a robot",
          "confirm you are not a robot",
          "unusual traffic from your",
          "complete the security check",
          "detected unusual activity",
          "your access to this site has been limited"
        ];
        if (phrases.some(p => text.includes(p))) return "bot";
        return "ok";
      }
    });
    return r?.[0]?.result || "ok";
  } catch { return "ok"; }
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

function isLikelyAuthOrSessionCookieName(name) {
  const n = String(name || "").toLowerCase();
  return n === "sid" ||
         n === "session" ||
         n === "sessionid" ||
         n === "jsessionid" ||
         n.includes("session") ||
         n.includes("login") ||
         n.includes("auth") ||
         n.includes("token") ||
         n.includes("access") ||
         n.includes("entitlement") ||
         n.includes("license") ||
         n.includes("shib") ||
         n.includes("saml");
}

function isLikelyCmuSessionCookie(name) {
  const n = String(name || "").toLowerCase();
  return n === "sid" || n === "lid" || n === "fcsid";
}

// Cloudflare 等反爬蟲挑戰的通行 cookie：使用者手動通過人機驗證後才拿得到，
// 清掉會逼所有站台重新跳驗證，故任何網域都保留
function isChallengeClearanceCookie(name) {
  const n = String(name || "").toLowerCase();
  return n === "cf_clearance" || n.startsWith("cf_chl") || n === "__cf_bm";
}

// ScienceDirect 的 PDF 資產站用 Elsevier 自家 craft 挑戰（cookie 名稱不固定），
// 通過人機驗證後的通行狀態存在這個網域的 cookie 裡，清掉就會再跳驗證
function isChallengeProtectedDomain(domain) {
  const host = String(domain || "").replace(/^\./, "").toLowerCase();
  return host === "sciencedirectassets.com" || host.endsWith(".sciencedirectassets.com");
}

// 中國知網（CNKI）的各個 proxy 子網域：EZproxy 把網域裡的「.」換成「-」，
// 所以 oversea.cnki.net、o.oversea.cnki.net、piccache.oversea.cnki.net 等
// 全部會變成「...-cnki-net.autorpa.cmu.edu.tw」這種型式。
// 注意：這個函式現在只用來讓 requestCookieCleanupIfHeaderTooLarge 跳過 CNKI
// 自家 Tomcat 通用 400 頁面的誤判（見下方），不再用來保護 cookie 不被清除——
// 實測發現 CNKI 的 session cookie 在同一輪長時間跑下來會累積到搜尋開始出錯
// （症狀：同一組 DOI 有時查得到、有時查不到），必須靠使用者手動清 cookie
// 重新整個 session 才會恢復正常。真正安全的作法是：讓它跟其他出版商 proxy
// 子網域一樣，在排程的「全部 worker 閒置」清理點被整個清掉重建（見
// shouldRemoveCookie），而不是完全豁免。EZproxy 的登入 session 是掛在根網域
// autorpa.cmu.edu.tw（isCmuProxyCookieDomain 保護的對象），跟這裡清的
// CNKI 子網域 cookie 是分開的，所以清掉不會逼使用者重新登入 EZproxy，
// 下次進 CNKI portal 會自動用既有的 EZproxy 通道重新取得一組乾淨的 session。
function isCnkiProxyDomain(domain) {
  const host = String(domain || "").replace(/^\./, "").toLowerCase();
  if (!host.endsWith(".autorpa.cmu.edu.tw")) return false;
  const sub = host.slice(0, -".autorpa.cmu.edu.tw".length);
  return sub === "cnki-net" || sub.endsWith("-cnki-net") || sub.endsWith(".cnki-net");
}

function shouldRemoveCookie(cookie, mode = "routine") {
  if (isChallengeClearanceCookie(cookie.name)) return false;
  if (isChallengeProtectedDomain(cookie.domain)) return false;
  if (isCmuProxyCookieDomain(cookie.domain) && isLikelyCmuSessionCookie(cookie.name)) return false;

  // 例行清理只移除追蹤/分析 cookie，避免每 10 篇破壞出版社授權或 challenge session。
  if (mode === "routine") return isTrackingCookieName(cookie.name);

  // header 過大時才較積極，但仍保留看起來像登入、授權、session、token 的 cookie。
  if (mode === "header-too-large") {
    if (isLikelyAuthOrSessionCookieName(cookie.name)) return false;
    return true;
  }

  return isTrackingCookieName(cookie.name);
}

function getCookieRemovalUrl(cookie) {
  const host = String(cookie.domain || "").replace(/^\./, "");
  const path = String(cookie.path || "/").startsWith("/") ? cookie.path : "/" + (cookie.path || "");
  return (cookie.secure ? "https" : "http") + "://" + host + path;
}

async function clearNonCmuProxyCookies(workerIdx = -1, reason = "scheduled") {
  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) return;

  try {
    const cookies = await new Promise(resolve => {
      chrome.cookies.getAll({}, items => resolve(items || []));
    });
    // header-too-large 與 redirect-loop（proxy 連線錯誤）都是壞掉的 session/proxy cookie
    // 造成的實際錯誤，需要積極清理；其餘（例行排程）只清追蹤 cookie，見 cookieCleanupShouldRestartItem
    const mode = (reason === "header-too-large" || cookieCleanupShouldRestartItem(reason))
      ? "header-too-large" : "routine";
    const removable = cookies.filter(cookie => shouldRemoveCookie(cookie, mode));
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
      workerLog(workerIdx, "  已清除 " + removed + " 個非必要 cookie（" + cookieCleanupReasonLabel(reason) + "），保留 CMU EZproxy 登入與驗證通行狀態。", "info");
    } else {
      addThreadLog("Cookie cleanup completed; nothing removed.", { workerIdx, reason, mode });
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
        await clearNonCmuProxyCookies(workerIdx, G.cookieCleanupReason || "scheduled");
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
    // CNKI（中國知網）用 Tomcat，不管 400 是什麼原因（包括它自己的 Referer 來源
    // 檢查、暫時性問題等）一律顯示同一個通用錯誤頁「HTTP Status 400 – Bad
    // Request」——跟真正的「header 過大」完全無關，卻會命中下面寬鬆的比對條件，
    // 誤觸發整批暫停清 cookie（清了也解決不了 Referer 驗證失敗的問題，只會
    // 白白卡住下載，還會提早清掉還沒累積到需要重建的 CNKI session）。
    // 所以寬鬆比對（只認「400」+「Bad Request」這種通用字樣）在 CNKI 網域上跳過，
    // 只保留精確比對「request header is too large」這句真正明確的錯誤訊息。
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let onCnki = false;
    try { onCnki = isCnkiProxyDomain(new URL(tab?.url || "").hostname); } catch {}

    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = [
          document.title || "",
          document.body?.innerText || "",
          document.documentElement?.innerText || ""
        ].join("\n").toLowerCase();
        return {
          exact: text.includes("request header is too large"),
          genericBadRequest400:
            (text.includes("http status 400") && text.includes("bad request")) ||
            (text.includes("bad request") && text.includes("header") && text.includes("large"))
        };
      }
    });
    const result = r?.[0]?.result;
    const triggered = !!result?.exact || (!onCnki && !!result?.genericBadRequest400);
    if (triggered) {
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

// ── 人機驗證暫停機制 ──
// 偵測到出版社（ScienceDirect/Cloudflare 等）人機驗證時：開一個前景分頁讓使用者
// 手動完成驗證，期間所有 worker 暫停派發；通過後（自動偵測或使用者按鈕確認）
// 失敗的那篇會從頭重跑。驗證通過的 clearance cookie 會留在瀏覽器，
// 之後同站的下載就不會再被擋。

async function waitForManualVerification(workerIdx = -1) {
  if (!G.verifyPending) return;
  workerLog(workerIdx, "  等待人機驗證完成中…", "warn");
  while (G.verifyPending && !G.stopped) await sleep(500);
}

// 檢查分頁目前是否顯示人機驗證頁。true=是、false=不是、null=無法判定（載入中/錯誤頁）
async function tabShowsManualVerification(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 很多正常頁面掛著「隱形 reCAPTCHA」（如 LWW 每頁都有的 Email to Colleague
        // 功能），DOM 裡有 recaptcha iframe 但根本沒有要使用者驗證。
        // 只認「看得見、且不是角落徽章」的挑戰元件，避免把正常頁面誤判成驗證頁。
        const isVisibleChallenge = el => {
          if (!el) return false;
          if (el.closest?.(".grecaptcha-badge")) return false; // 隱形 reCAPTCHA 的角落徽章
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 40 && rect.height > 40;
        };
        const challengeEls = Array.from(document.querySelectorAll(
          "#challenge-form, #cf-challenge-running, .cf-turnstile, .g-recaptcha, #px-captcha, " +
          "iframe[src*='turnstile'], iframe[src*='recaptcha'], iframe[src*='hcaptcha']"
        ));
        return {
          hasChallengeDom: challengeEls.some(isVisibleChallenge),
          title: document.title || "",
          text: (document.body?.innerText || "").slice(0, 4000),
        };
      }
    });
    const state = r?.[0]?.result;
    if (!state) return null;
    if (state.hasChallengeDom) return true;
    return isManualVerificationText(state.title + " " + state.text);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// 本地資料夾模式：chrome.downloads.download() 的 filename 只能是 Chrome
// 預設下載資料夾底下的相對路徑，跳不出去，這是 Chrome API 本身的限制。
// 這裡透過另一個常駐的 Native Messaging host（native_host/python_file_manager.py，
// 見 native_host/install_file_manager.ps1 安裝說明）把 PDF／下載失敗筆記／
// 進度 Excel 寫到使用者自選的專案資料夾，不受此限制。
//
// 跟畫愛心那個 host（一次性 spawn、收一則訊息就結束）不同，這個 host 在一次
// 批次下載期間會被連續呼叫很多次，所以用 chrome.runtime.connectNative() 開一條
// 長駐 Port，而不是每次都 sendNativeMessage 各自 spawn 一次行程。
// ════════════════════════════════════════════════════════════════
const FILE_MANAGER_HOST = "com.pubmed_downloader.file_manager";
let fmPort = null;
let fmReqId = 0;
const fmPending = new Map(); // id -> { resolve, reject, chunks: [] }

function fmHandleMessage(msg) {
  const p = fmPending.get(msg.id);
  if (!p) return;
  if (msg.chunk != null) {
    p.chunks.push(msg.chunk);
    if (!msg.done) return;
    msg.dataB64 = p.chunks.join("");
  }
  fmPending.delete(msg.id);
  if (msg.ok) p.resolve(msg);
  else p.reject(new Error(msg.error || "native host 回報失敗"));
}

// 呼叫 file_manager native host。找不到/沒裝 host 時會 reject，呼叫端一律要
// try/catch 包起來，失敗就靜默退回原本的 chrome.downloads 流程（本地資料夾模式
// 本來就是可選功能，沒裝這個 host 不該讓下載整個掛掉）。
function fmRequest(cmd, params = {}) {
  return new Promise((resolve, reject) => {
    if (!fmPort) {
      try {
        fmPort = chrome.runtime.connectNative(FILE_MANAGER_HOST);
      } catch (e) {
        reject(e);
        return;
      }
      fmPort.onMessage.addListener(fmHandleMessage);
      fmPort.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message || "file_manager native host 已中斷（可能尚未安裝）";
        fmPending.forEach(p => p.reject(new Error(err)));
        fmPending.clear();
        fmPort = null;
      });
    }
    const id = ++fmReqId;
    fmPending.set(id, { resolve, reject, chunks: [] });
    try {
      fmPort.postMessage({ id, cmd, ...params });
    } catch (e) {
      fmPending.delete(id);
      reject(e);
    }
  });
}

// 本地資料夾模式的設定：關閉，或沒選資料夾，一律視同關閉，所有寫檔邏輯照舊
// 走 chrome.downloads。localFolderProjectBase 是目前這個專案資料夾綁定的
// Excel base name（不含 _原檔/_進度管理 尾綴），OPEN_LOCAL_PROJECT 決定好之後
// 存進 storage，後面每次寫進度 Excel 都要用同一個 base，不必重新算。
// 大檔案 base64 編碼：一次把整個大 Uint8Array 展開進 String.fromCharCode(...) 可能
// 爆呼叫堆疊，比照 _buildAndSaveExcel 既有的作法分塊處理。
function bufferToBase64(buf) {
  const arr = new Uint8Array(buf);
  let bin = "";
  const chunkSize = 8192;
  for (let i = 0; i < arr.length; i += chunkSize) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

// 本地資料夾模式下，triggerDownload() 的一般分支改用 fetch() 直接把完整內容抓進
// JS 記憶體（這個分支只有在 preflightPdfCheck() 已經用 fetch() 驗證過該 URL 真的
// 是 PDF 才會走到，所以這裡不用重跑一次完整的 preflight，只做最基本的二次確認，
// 沿用 preflightPdfCheck 判斷「像不像 HTML 偽裝成 PDF」的同一套邏輯）。
function looksLikePdfBytes(buf, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/pdf")) return true;
  if (ct.includes("text/html")) return false;
  const head = new Uint8Array(buf.slice(0, 1024));
  let text = "";
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  if (text.includes("%PDF")) return true;
  const lower = text.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<html")) return false;
  return true; // 不確定就放行（跟 preflightPdfCheck 的 null 語意一致，交給下載後續核對）
}

function getLocalFolderConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ["localFolderModeEnabled", "localFolderRootPath", "localFolderProjectBase", "allowChromeDownloadsFallback"],
      d => resolve({
        enabled: !!d.localFolderModeEnabled && !!d.localFolderRootPath,
        root: d.localFolderRootPath || "",
        base: d.localFolderProjectBase || "",
        // 預設關閉：本地資料夾模式寫檔失敗時，預設不悄悄退回 chrome.downloads（存進 Chrome
        // 下載資料夾會讓使用者搞不清楚這篇到底存到哪裡去了），直接判定失敗逼你先修好
        // native host 安裝；使用者可在「⚙ 驗證與 API 進階設定」勾選這個選項改回舊行為。
        allowFallback: !!d.allowChromeDownloadsFallback,
      })
    );
  });
}

// 偵測到人機驗證時，經 Chrome Native Messaging 呼叫本機的 python_write_love.bat
// （見 native_host/ 資料夾）畫一個愛心當提醒動畫。純粹錦上添花：使用者若沒跑過
// native_host/install_write_love.ps1 安裝 native host，這裡會拿到 lastError，
// 只記一筆 threadLog 靜默略過，不影響驗證暫停/佇列的主流程。
//
// 送出訊息前會先用 locateTargetElement 找頁面上的驗證挑戰元件（跟
// tabShowsManualVerification 認的是同一組 selector），把它的螢幕絕對座標
// (x/y) 跟外框 (left/top/width/height) 一併帶進 payload。native host 那邊
// 不會直接採信這個座標——checkbox 通常在跨網域 iframe 裡，DOM 端本來就看
// 不到它，只看得到外框——而是把外框當「去哪裡找 checkbox」的範圍提示，實際
// 座標還是 native host 自己比對樣板決定。找不到目標元件（例如純文字判斷出的
// 驗證、或分頁還是 about:blank）就不帶這些欄位，native host 退回自己的
// logo 樣板 / 全螢幕搜尋。
const NATIVE_HEART_HOST = "com.pubmed_downloader.write_love";
// 預設值：跟 tabShowsManualVerification 認的挑戰元件是同一組，只影響「畫愛心要定位
// 哪個元素」，不影響「有沒有偵測到人機驗證」本身的判斷（那個判斷邏輯不受這裡影響）。
// 使用者可以在 popup 的「⚙ 驗證與 API 進階設定」裡換成常見類型之一，或自訂 selector，
// 存在 chrome.storage.local 的 manualVerificationChallengeSelector。
// [id^="cf-chl-widget-"]：Cloudflare Turnstile 實際渲染出的 widget 容器，不管網頁
// 是用 .cf-turnstile 自動渲染還是像 ScienceDirect 那樣手動 turnstile.render('#別的id')，
// 渲染完後都會生出這個 id 前綴的節點，比對 .cf-turnstile 這種「呼叫端指定的容器」更可靠。
// iframe[src*='challenges.cloudflare.com']：真正的挑戰 iframe 網域，src 裡不會出現
// 字面上的 "turnstile"，原本的 iframe[src*='turnstile'] 對這類頁面永遠配不到。
const MANUAL_VERIFICATION_CHALLENGE_SELECTOR_DEFAULT =
  "#challenge-form, #cf-challenge-running, .cf-turnstile, .g-recaptcha, #px-captcha, " +
  "[id^='cf-chl-widget-'], " +
  "iframe[src*='turnstile'], iframe[src*='challenges.cloudflare.com'], " +
  "iframe[src*='recaptcha'], iframe[src*='hcaptcha']";

function getManualVerificationChallengeSelector() {
  return new Promise(resolve => {
    chrome.storage.local.get(["manualVerificationChallengeSelector"], d => {
      const custom = (d.manualVerificationChallengeSelector || "").trim();
      resolve(custom || MANUAL_VERIFICATION_CHALLENGE_SELECTOR_DEFAULT);
    });
  });
}

// presetPoint：候選元件輪流提醒迴圈（見 monitorManualVerification）已經用
// locateAllTargetElements 拿到全部候選、要指定「這次提醒哪一個」時傳進來，
// 跳過重新查一次 DOM；沒傳就跟舊行為一樣，自己查第一個符合條件的元素。
// thresholdOverrides：{ domRegionMinScore, logoMinScore } 之一或兩者，同一輪
// 驗證重試多次仍失敗時，monitorManualVerification 會逐次調低這兩個門檻傳進來，
// 讓 native host 對原本卡在門檻邊緣的候選放寬標準再試一次。
// clearDebugFolder：只有每次驗證流程「第一次嘗試的第一個候選」才會傳 true，
// 讓 native host 在畫提醒標記前先清空 checkbox 定位除錯資料夾，確保裡面的圖
// 都是這次驗證流程留下的（見 python_write_love.py 的 clear_debug_dir）。
// 回傳 Promise，resolve 時機是 native host 的 ack 回來（或送不出去/丟例外）
// 為止——呼叫端 await 這個 Promise 就能確保「這個候選處理完才換下一個」，
// 不會讓好幾個 native host 進程同時搶滑鼠、疊出好幾個愛心視窗。
function triggerVerificationHeart(contextLabel, tabId, presetPoint = null, thresholdOverrides = null, clearDebugFolder = false) {
  return (async () => {
    let point = presetPoint;
    if (!point && tabId != null) {
      try {
        const selector = await getManualVerificationChallengeSelector();
        point = await locateTargetElement(tabId, selector, {
          minWidth: 40,
          minHeight: 40,
          excludeSelector: ".grecaptcha-badge"
        });
      } catch (e) {
        addThreadLog("Locate verification challenge element failed", { error: e.message });
      }
    }

    if (point) {
      addLog(`已捕捉到目標元素：${point.matched}，座標 x=${point.x.toFixed(1)}, y=${point.y.toFixed(1)}`, "ok");
      // 除錯用：定位準確後這行連同 location_target.js 裡的 _debug* 欄位可以一起拿掉。
      addLog(
        `　debug: dpr=${point._debugDpr} rawRect=${JSON.stringify(point._debugRawRect)} ` +
        `rawInner=${JSON.stringify(point._debugRawInner)} windowInfo=${JSON.stringify(point._debugWindowInfo)}`,
        "info"
      );
    } else {
      addLog("未捕捉到目標元素", "warn");
    }

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(
          NATIVE_HEART_HOST,
          {
            cmd: "draw_heart",
            contextLabel: contextLabel || "",
            ts: Date.now(),
            ...(point ? {
              x: point.x, y: point.y,
              left: point.left, top: point.top, width: point.width, height: point.height,
              matchedSelector: point.matched
            } : {}),
            ...(thresholdOverrides || {}),
            ...(clearDebugFolder ? { clearDebugFolder: true } : {})
          },
          (response) => {
            const err = chrome.runtime.lastError;
            if (err) {
              addThreadLog("Native heart trigger unavailable (host not installed?)", { error: err.message });
              resolve();
              return;
            }
            if (response && response.ok) {
              const patternNote = response.moved && response.pattern ? `（軌跡：${response.pattern}）` : "";
              addLog((response.moved ? "已成功移動至該座標，畫愛心" : "未移動至該座標，畫愛心") + patternNote, response.moved ? "ok" : "warn");
              addLog(
                `　iframe：${response.iframeFound ? "✅ 已知範圍" : "❌ 未知"}　checkbox：${response.checkboxFound ? "✅ 已比對到" : "❌ 沒比對到"}`,
                response.checkboxFound ? "ok" : "warn"
              );
            }
            resolve();
          }
        );
      } catch (e) {
        addThreadLog("Native heart trigger threw", { error: e.message });
        resolve();
      }
    });
  })();
}

// 實際把一筆驗證請求顯示出來：切到前景分頁、開通知、送 VERIFY_REQUIRED、啟動自動偵測。
// 由 requestManualVerificationPause（沒有其他驗證在等待時）或 finishManualVerification
// （佇列裡還有下一筆時）呼叫，兩者都確保同一時間只有一筆驗證在畫面上顯示。
async function activateVerificationEntry(entry) {
  G.verifyPending = true;
  G.verifyPendingUrl = entry.url;
  G.verifyPreserveTab = entry.preserveTab;
  G.verifyRestartEpoch = (G.verifyEpoch || 0) + 1;
  const queueNote = G.verifyQueue.length ? `（另有 ${G.verifyQueue.length} 筆排隊中）` : "";
  addLog("⚠ 偵測到人機驗證（" + (entry.contextLabel || entry.url) + "），暫停派發新任務，請到開啟的分頁完成驗證。" + queueNote, "bot");
  addThreadLog("Manual verification pause requested", {
    url: entry.url, contextLabel: entry.contextLabel, tabId: entry.tabId,
    preserveTab: entry.preserveTab, queueRemaining: G.verifyQueue.length
  });
  // 畫愛心提醒真人的第一次呼叫，現在完全交給 monitorManualVerification 的三次
  // 嘗試協定（見該函式開頭說明）——它會先等頁面上的驗證 iframe 有時間載入渲染
  // 出 checkbox，才開始找候選、提醒，不在這裡搶先呼叫一次容易撲空的版本。

  let tab = null;
  try {
    if (entry.tabId != null) {
      tab = await chrome.tabs.update(entry.tabId, { active: true });
    } else {
      tab = await chrome.tabs.create({ url: entry.url, active: true });
      entry.tabId = tab.id;
    }
    G.verifyPendingTabId = tab.id;
    if (tab.windowId != null) {
      // 立刻把該分頁所在視窗切到最前景，避免多筆下載同時進行時使用者找不到驗證分頁
      chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
    }
  } catch {}

  try {
    chrome.notifications.create("manual-verify", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "PubMed 下載器：需要人機驗證",
      message: "請到剛開啟的分頁完成驗證。通過後會自動偵測並繼續下載；也可到擴充功能面板按「我已完成驗證」。",
      priority: 2,
    });
  } catch {}

  chrome.runtime.sendMessage({ action: "VERIFY_REQUIRED", url: entry.url, queueRemaining: G.verifyQueue.length }).catch(() => {});
  monitorManualVerification(tab?.id ?? entry.tabId ?? null, entry.contextLabel || "");
}

// 宣告需要人工驗證：暫停派發、開前景分頁（或沿用 existingTabId 的分頁）、
// 通知使用者，並啟動自動偵測。force=true 時不受 manualVerifyPause 開關限制
// （verify_test.js 的模擬測試用）。
// preserveExistingTab=true：existingTabId 是 worker 的常駐背景分頁（tab pool 的一員），
// 驗證結束後不能被關掉（否則該 worker 之後所有操作都會對著一個已關閉的 tabId 失敗）。
// 只有「特地為了這次驗證開的用完即丟分頁」（LWW 中轉彈窗、測試靶場分頁）才該在
// finishManualVerification 裡自動關閉，其餘一律保留、由呼叫端自行決定何時清理/導回 about:blank。
//
// 若同時有多筆驗證出現（多個 worker 同時撞到驗證頁），不會互相蓋過去或被漏掉：
// 目前沒有驗證在顯示時才會立刻切到前景，否則加入 G.verifyQueue 排隊，
// 等目前這筆結束後由 finishManualVerification 依序顯示下一筆，直到全部處理完才恢復派發。
async function requestManualVerificationPause(url, contextLabel = "", existingTabId = null, force = false, preserveExistingTab = false) {
  if ((!G.manualVerifyPause && !force) || G.stopped) return false;

  // 同一分頁已經在顯示中，或已經排在佇列裡：不要重複加入
  if (existingTabId != null) {
    if (G.verifyPendingTabId === existingTabId) return true;
    if ((G.verifyQueue || []).some(e => e.tabId === existingTabId)) return true;
  }

  const entry = {
    url,
    contextLabel,
    tabId: existingTabId,
    preserveTab: !!(existingTabId != null && preserveExistingTab),
  };

  if (!G.verifyPending) {
    await activateVerificationEntry(entry);
  } else {
    G.verifyQueue.push(entry);
    addLog("⚠ 又偵測到一筆人機驗證（" + (contextLabel || url) + "），已加入佇列（目前排隊 " + G.verifyQueue.length + " 筆），會在目前這筆完成後自動顯示。", "bot");
    addThreadLog("Manual verification queued", { url, contextLabel, existingTabId, queueLength: G.verifyQueue.length });
  }
  return true;
}

// 背景等待驗證分頁完成，同時主動提醒真人去點 checkbox。三段式協定：
//
//   Phase A（先等）：驗證挑戰元件（reCAPTCHA/Turnstile/hCaptcha）幾乎都是非同步
//     載入，跳出來後通常會先轉圈圈讀取個幾秒才真的渲染出 checkbox。太早去抓
//     DOM 只會抓到還沒撐開的空殼，或誤把尺寸固定的佔位元件當成候選，所以先
//     整整等 VERIFY_INITIAL_LOAD_WAIT_MS，讓畫面穩定下來再開始。
//
//   Phase B（判斷是否真的需要驗證）：等完立刻檢查一次，如果驗證根本沒真的
//     出現過（例如純文字判斷誤判、或分頁還是 about:blank），直接判定
//     no-challenge 結束，不浪費任何嘗試次數。
//
//   Phase C（最多 VERIFY_MAX_ATTEMPTS 次嘗試）：每次嘗試都重新查一次全部候選
//     驗證元件（DOM 可能中途才渲染出新的候選），依序處理——每個候選的外框傳給
//     native host，在框內比對 checkbox、移動滑鼠、畫愛心，等上一個完全結束
//     （收到 ack）才換下一個，避免好幾個 native host 進程同時搶滑鼠、疊出多個
//     愛心視窗。全部候選都提醒過一次後，等 VERIFY_POST_CYCLE_WAIT_MS，檢查
//     驗證是否已經通過：通過就結束；沒通過、還有嘗試次數就調低比對門檻
//     （VERIFY_ATTEMPT_THRESHOLDS）進入下一次——原本卡在門檻邊緣、實際上是對的
//     候選，降低門檻後有機會被接受。
//
// VERIFY_MAX_ATTEMPTS 次都沒過 → 判定逾時結束。逾時不代表放棄整個下載流程：
// 只是先把這筆驗證結束、解除全域暫停，讓其他佇列項目能繼續跑；這一篇本身會依
// 既有的「驗證期間失敗不定案」機制自動重跑最多 2 次（shouldRestartAfterVerify），
// 照樣有機會之後補上，2 次都不行才真的標記下載失敗、繼續處理下一篇。
const VERIFY_MAX_ATTEMPTS = 3;
const VERIFY_INITIAL_LOAD_WAIT_MS = 5000;
const VERIFY_POST_CYCLE_WAIT_MS = 5000;
const VERIFY_ATTEMPT_THRESHOLDS = [
  { domRegionMinScore: 0.3, logoMinScore: 0.7 },
  { domRegionMinScore: 0.2, logoMinScore: 0.6 },
  { domRegionMinScore: 0.1, logoMinScore: 0.5 },
];

async function monitorManualVerification(tabId, contextLabel = "") {
  if (tabId == null) {
    // 開分頁失敗：沒有分頁可查，只能被動等使用者在 popup 按「我已完成驗證」
    while (G.verifyPending && !G.stopped) await sleep(2500);
    return;
  }

  await sleep(VERIFY_INITIAL_LOAD_WAIT_MS);
  if (!G.verifyPending || G.stopped) return;

  let sawChallenge = false;
  // 只有整個驗證流程「第一次嘗試的第一個候選」才會是 true，讓 native host
  // 那次呼叫先清空 checkbox 定位除錯資料夾（見 triggerVerificationHeart 的
  // clearDebugFolder 參數），之後同一輪流程的每個候選都疊加存進同一個資料夾。
  let isFirstCandidateCall = true;

  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    if (!G.verifyPending || G.stopped) return;

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      // 使用者自己把驗證分頁關了：視為已處理完，繼續跑
      finishManualVerification("tab-closed");
      return;
    }
    if (tab.status === "loading") await sleep(1500);

    const showingBefore = await tabShowsManualVerification(tabId);
    if (showingBefore === false) {
      // 曾看到驗證頁、現在消失了 → 使用者這時候剛好通過了；
      // 從沒看到過 → 本來就不需要驗證（例如文字誤判）
      finishManualVerification(sawChallenge ? "auto-detected" : "no-challenge");
      return;
    }
    sawChallenge = true;

    let candidates = [];
    try {
      const selector = await getManualVerificationChallengeSelector();
      candidates = await locateAllTargetElements(tabId, selector, {
        minWidth: 40,
        minHeight: 40,
        excludeSelector: ".grecaptcha-badge"
      });
    } catch (e) {
      addThreadLog("Locate all verification challenge elements failed", { error: e.message });
    }

    const thresholds = VERIFY_ATTEMPT_THRESHOLDS[attempt];
    addLog(
      `⚠ 第 ${attempt + 1}/${VERIFY_MAX_ATTEMPTS} 次嘗試提醒真人完成驗證` +
      (candidates.length
        ? `（偵測到 ${candidates.length} 個候選元件，依序提醒）`
        : "（未偵測到候選元件，交給 native host 自行搜尋）"),
      "bot"
    );

    if (candidates.length === 0) {
      await triggerVerificationHeart(contextLabel, tabId, null, thresholds, isFirstCandidateCall);
      isFirstCandidateCall = false;
    } else {
      for (const candidate of candidates) {
        if (!G.verifyPending || G.stopped) return;
        await triggerVerificationHeart(contextLabel, tabId, candidate, thresholds, isFirstCandidateCall);
        isFirstCandidateCall = false;
      }
    }

    if (!G.verifyPending || G.stopped) return;
    await sleep(VERIFY_POST_CYCLE_WAIT_MS);
    if (!G.verifyPending || G.stopped) return;

    const showingAfter = await tabShowsManualVerification(tabId).catch(() => null);
    if (showingAfter === false) {
      finishManualVerification("auto-detected");
      return;
    }
  }

  finishManualVerification("timeout");
}

// 結束目前顯示中的這一筆驗證。若佇列裡還有排隊中的下一筆，立刻依序顯示它
// （worker 派發持續維持暫停）；全部處理完才真正恢復派發、通知 popup。
function finishManualVerification(how) {
  if (!G.verifyPending) return;
  G.verifyEpoch = (G.verifyEpoch || 0) + 1;
  const tabId = G.verifyPendingTabId;
  const preserveTab = G.verifyPreserveTab;
  G.verifyPendingTabId = null;
  G.verifyPreserveTab = false;
  G.verifyPendingUrl = "";
  // worker 的常駐分頁不能關；用完即丟的驗證/中轉分頁才關閉
  if (tabId != null && !preserveTab) chrome.tabs.remove(tabId).catch(() => {});
  try { chrome.notifications.clear("manual-verify"); } catch {}
  const label = how === "user" ? "使用者確認"
              : how === "tab-closed" ? "驗證分頁已關閉"
              : how === "no-challenge" ? "未出現驗證頁"
              : how === "timeout" ? "等待逾時（視為失敗，將依重試機制自動重跑）"
              : "自動偵測通過";
  if (how === "timeout") {
    addLog(`⚠ 一筆人機驗證逾時（已嘗試 ${VERIFY_MAX_ATTEMPTS} 次提醒仍未通過），先結束等待、繼續處理其他項目。`, "warn");
  } else {
    addLog("✅ 一筆人機驗證結束（" + label + "）。", "ok");
  }
  addThreadLog("Manual verification finished", { how, epoch: G.verifyEpoch, queueRemaining: (G.verifyQueue || []).length });

  if ((G.verifyQueue || []).length > 0) {
    const next = G.verifyQueue.shift();
    addLog("➡ 依序處理排隊中的下一筆人機驗證（還剩 " + G.verifyQueue.length + " 筆）…", "bot");
    activateVerificationEntry(next);
    return;
  }

  G.verifyPending = false;
  addLog("✅ 人機驗證全部處理完畢，繼續下載。", "ok");
  chrome.runtime.sendMessage({ action: "VERIFY_OK" }).catch(() => {});
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

function sanitizeDownloadFolder(folder) {
  const cleaned = String(folder || "PubMed_PDFs")
    .replace(/\\/g, "/")
    .split("/")
    .map(part => part.replace(/[?:*"<>|]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
  return cleaned || "PubMed_PDFs";
}

// 清理後標題可能撞名（不同 PMID、不同原始標題，但清理特殊字元/截斷後變成同一個
// 檔名）。以前直接覆蓋會讓後面幾篇的 PDF 悄悄取代前一篇，Excel 卻都記著「下載成功」。
// 用「folder+檔名(小寫)」當 key，依 rowIndex 排隊認領：第一個認領到的維持原檔名，
// 之後撞名的依序加上 " (2)"、" (3)"…；同一 rowIndex 重跑（重試）沿用原本認領的檔名。
function claimDownloadFilename(item, folder, ext = ".pdf") {
  const dir = sanitizeDownloadFolder(folder);
  const baseTitle = item.safeTitle || ("PMID_" + (item.pmid || "unknown"));
  const baseKey = (dir + "/" + baseTitle + ext).toLowerCase();
  G.filenameClaims = G.filenameClaims || {};
  let claims = G.filenameClaims[baseKey];
  if (!claims) { claims = []; G.filenameClaims[baseKey] = claims; }
  const mine = claims.find(c => c.rowIndex === item.rowIndex);
  if (mine) return { finalName: mine.finalName, duplicate: mine.duplicate };
  const suffix = claims.length;
  const finalName = suffix === 0 ? baseTitle : `${baseTitle} (${suffix + 1})`;
  const duplicate = suffix > 0;
  claims.push({ rowIndex: item.rowIndex, finalName, duplicate });
  return { finalName, duplicate };
}

// 本地資料夾模式專用命名：序號前綴（item.seqLabel，由 popup.js 依「這篇論文在整份
// Excel 全部列中的固定順位」算好、補零到跟總篇數同寬）讓檔名在整份 Excel 裡天生
// 唯一，不需要 claimDownloadFilename() 那套撞名後綴，核對時也能直接從檔名反推
// 「這是第幾篇、標題是什麼」，不必依賴任何持久化的檔名對照表。
function localSuccessFilename(item) {
  return item.seqLabel + "_" + item.safeTitle;
}
function localFailureFilename(item, status) {
  return item.seqLabel + "_" + status + "_" + item.safeTitle;
}

function getBatchFolderForIndex(idx) {
  const base = sanitizeDownloadFolder(G.downloadFolder || "PubMed_PDFs");
  if (G.testMode) return base + "/" + TEST_FOLDER_NAME;
  const size = Math.max(0, parseInt(G.batchSize || 0, 10) || 0);
  if (!size) return base;
  const start = Math.floor(idx / size) * size + 1;
  const end = Math.min(start + size - 1, G.total || start + size - 1);
  return base + "/第" + start + "-" + end + "篇";
}

// 把一個 stageResult({ok, detail}) 轉成一行「XX: 成功/失敗/未執行（說明）」文字。
// null/undefined（該階段根本沒跑到，被前面某個失敗擋住）一律顯示「未執行」。
function renderStageLine(label, stage) {
  if (!stage || stage.ok == null) {
    return label + ": 未執行" + (stage?.detail ? "（" + stage.detail + "）" : "（前面步驟已中止或跳過）");
  }
  return label + ": " + (stage.ok ? "成功" : "失敗") + (stage.detail ? "（" + stage.detail + "）" : "");
}

// 中文論文查詢流程（CNKI）分段報告：進入中國知網 / 以 DOI 找到目標論文 / 目標論文下載
function renderChineseFailureSection(chinese) {
  const lines = ["──────── 中文論文查詢流程（CNKI）────────"];
  lines.push(renderStageLine("進入中國知網", chinese?.enteredPortal));
  lines.push(renderStageLine("以 DOI 找到目標論文", chinese?.doiFound));
  lines.push(renderStageLine("目標論文下載", chinese?.downloadSucceeded));
  if (chinese?.otherReason) lines.push("其他失敗原因: " + chinese.otherReason);
  return lines;
}

// PubMed 搜尋流程分段報告：進入 PubMed 網頁 / 找到目標論文 / 是否有 Full Text 連結，
// 再逐一列出每個 Full Text 連結是否找到合乎目標的 PDF。
function renderPubmedFailureSection(pubmed, isFallback) {
  const lines = [
    "──────── PubMed 搜尋流程" + (isFallback ? "（中文查詢流程未取得 PDF 後的 fallback）" : "") + " ────────"
  ];
  lines.push(renderStageLine("進入 PubMed 網頁", pubmed?.entered));
  lines.push(renderStageLine("以 Title/PMID 找到目標論文", pubmed?.articleFound));

  const ftl = pubmed?.fullTextLinks;
  if (!ftl || ftl.ok == null) {
    lines.push("該目標論文是否存在 Full Text 連結: 未執行（前面步驟已中止）");
  } else if (ftl.ok) {
    lines.push("該目標論文是否存在 Full Text 連結: 成功，" + (ftl.detail || ""));
    (ftl.list || []).forEach((l, i) => lines.push("  [" + (i + 1) + "] " + l.label + " — " + l.url));
  } else {
    lines.push("該目標論文是否存在 Full Text 連結: 失敗（無可用的 Full Text 連結）");
  }

  const attempts = pubmed?.linkAttempts || [];
  if (attempts.length) {
    lines.push("");
    lines.push("──── 各 Full Text 連結嘗試明細 ────");
    attempts.forEach((a, i) => {
      lines.push("[" + (i + 1) + "] " + a.label + "（" + a.url + "）");
      lines.push("    該連結內是否找到合乎目標之 PDF: " +
        (a.pdfFound?.ok ? "成功" : "失敗") +
        (a.pdfFound?.detail ? "（" + a.pdfFound.detail + "）" : ""));
    });
  }
  return lines;
}

function failureNoteSafeTitle(item) {
  const pmid = item.pmid || "no-pmid";
  const rawTitle = item.safeTitle || item.title || ("PMID_" + pmid) || "untitled";
  return sanitizeDownloadFolder(rawTitle).replace(/\//g, " ").substring(0, 120) || ("PMID_" + pmid);
}

// 這篇之前失敗過（下載失敗檔案/*.txt 已寫入），這次重試成功了：
// 舊的失敗筆記不會自動消失（createFailureNote 只在失敗時呼叫，不會反向清除），
// 放著不管會讓人誤以為「明明下載成功卻還是判定失敗」，所以成功時主動找出、刪掉同篇舊筆記
function removeStaleFailureNote(item, folder) {
  const safeTitle = failureNoteSafeTitle(item);
  const escaped = safeTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new Promise(resolve => {
    chrome.downloads.search({ filenameRegex: "下載失敗檔案[\\\\/]" + escaped + "\\.txt$" }, items => {
      if (chrome.runtime.lastError || !items?.length) { resolve(); return; }
      let pending = items.length;
      const done = () => { if (--pending <= 0) resolve(); };
      items.forEach(it => {
        chrome.downloads.removeFile(it.id, () => {
          void chrome.runtime.lastError;
          chrome.downloads.erase({ id: it.id }, () => { void chrome.runtime.lastError; done(); });
        });
      });
    });
  });
}

async function createFailureNote(item, status, folder, reason = "", fullTextLinks = [], linkAttempts = [], pdfDownloadAttempts = [], procLog = [], report = null) {
  const pmid = item.pmid || "no-pmid";
  const safeTitle = failureNoteSafeTitle(item);
  const reasonText = reason || "缺少詳細失敗原因。";
  const isChinese = report ? !!report.isChineseTitle : isBracketedChineseTitle(item);

  const sections = [];
  if (isChinese) {
    sections.push(...renderChineseFailureSection(report?.chinese));
    sections.push("");
  }
  sections.push(...renderPubmedFailureSection(report?.pubmed, isChinese));

  // 備援：極少數情況下（例如 report 沒能正常產生）才會用到這段原始文字紀錄，
  // 正常情況下上面的分段報告已經完整涵蓋這裡的內容，不會重複顯示。
  const legacySection = (!report && linkAttempts?.length)
    ? ["", "──────── 連結嘗試紀錄（備援，未取得分段報告）────────",
       linkAttempts.map((a, i) => "  " + (i + 1) + ". " + a).join("\n")]
    : [];

  const downloadAttemptsSection = pdfDownloadAttempts?.length
    ? ["", "──────── PDF 下載嘗試明細（找到連結後的實際下載結果）────────",
       pdfDownloadAttempts.map((a, i) => "  " + (i + 1) + ". " + a).join("\n")]
    : [];

  const procSection = procLog?.length
    ? ["", "──────── 處理過程紀錄（本篇，含 preflight/預熱/下載細節）────────", procLog.join("\n")]
    : [];

  const body = [
    "錯誤論文Title: " + (item.title || ""),
    "PMID / id: " + pmid,
    "Excel row: " + (item.rowIndex || ""),
    "失敗期刊類型: " + (isChinese ? "中文" : "非中文"),
    "下載狀況: " + status,
    "失敗原因: " + reasonText,
    "Time: " + new Date().toISOString(),
    "",
    ...sections,
    ...legacySection,
    ...downloadAttemptsSection,
    ...procSection
  ].join("\n");

  // 這篇失敗筆記的完整內容留一份進 debugRun：這個 txt 之後若這篇改天重跑成功，
  // 會被 removeStaleFailureNote() 自動清掉，磁碟上就再也找不到當初失敗的細節；
  // debugRun 這份不受那個清理邏輯影響，寫進本次 debug log 後就是永久紀錄。
  if (G.debugRun) {
    G.debugRun.failureNotes.push({ time: Date.now(), rowIndex: item.rowIndex, pmid, status, body });
  }

  // 本地資料夾模式：STATUS_FAIL/STATUS_RETRY 的字串本來就跟「下載失敗」「下次重試」
  // 這兩個子資料夾同名，直接拿 status 當資料夾名稱用，寫檔完全繞過 chrome.downloads。
  const localCfg = await getLocalFolderConfig();
  if (localCfg.enabled) {
    const localFolderName = G.testMode
      ? TEST_FOLDER_NAME
      : ((status === STATUS_FAIL || status === STATUS_RETRY) ? status : STATUS_FAIL);
    // 本地資料夾模式的檔名要用序號前綴（見 localFailureFilename），才能在核對時直接
    // 從檔名反推對到 Excel 哪一列；item.seqLabel 缺失時（理論上不會發生）退回舊式
    // 純標題命名，至少不會整篇寫檔失敗。
    const localStem = item.seqLabel ? localFailureFilename(item, localFolderName) : safeTitle;
    try {
      await fmRequest("write_bytes", {
        root: localCfg.root,
        relPath: localFolderName + "/" + localStem + ".txt",
        dataB64: bufferToBase64(new TextEncoder().encode(body)),
      });
      addThreadLog("Failure note written via local folder mode", { rowIndex: item.rowIndex, pmid, folder: localFolderName });
      return true;
    } catch (e) {
      if (!localCfg.allowFallback) {
        addLog("失敗記錄寫入本地資料夾失敗：" + (e?.message || e) + "（未開啟「失敗退回 Chrome 下載」進階設定）", "fail");
        addThreadLog("Local mode failure note write failed, fallback disabled", { error: e?.message || String(e) });
        return false;
      }
      addLog("失敗記錄寫入本地資料夾失敗：" + (e?.message || e) + "，退回一般下載流程", "fail");
      addThreadLog("Local mode failure note write failed, falling back", { error: e?.message || String(e) });
    }
  }

  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(body);
  return new Promise(resolve => {
    const filename = sanitizeDownloadFolder(folder) + "/下載失敗檔案/" + safeTitle + ".txt";
    registerPendingDownloadFilename(url, filename);
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
    if (value.printPmc) return value.pdfUrl || ("pmc-print:" + (value.printUrl || value.sourceUrl || value.url || ""));
    return normalizePdfUrlValue(value.pdfUrl || value.url || value.href);
  }
  return null;
}

function isPmcPrintCandidate(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.printPmc) return true;
  return !!(entry.pdfUrl && typeof entry.pdfUrl === "object" && entry.pdfUrl.printPmc);
}

function isSupplementPdfUrl(url) {
  const lower = String(url || "").toLowerCase();
  return /(?:^|[._/-])supp(?:lement)?\d*(?:[._/-]|$)|supplement|appendix|protocol|trial protocol|eappendix|coi\d*.*supp|\/articles\/instance\/[^/]+\/bin\/|-[se]\d{2,4}\.pdf(?:$|[?#])/.test(lower);
}

function normalizePdfCandidates(result, fallbackPdfUrl = null) {
  const raw = Array.isArray(result?.pdfCandidates) ? result.pdfCandidates : [];
  const candidates = [];
  const seen = new Set();
  const add = (entry) => {
    if (isPmcPrintCandidate(entry)) {
      const src = entry.printPmc ? entry : entry.pdfUrl;
      const printUrl = src.printUrl || src.sourceUrl || src.url || entry.sourceUrl || "";
      const key = src.pdfUrl || ("pmc-print:" + printUrl);
      if (!printUrl || seen.has(key)) return;
      seen.add(key);
      candidates.push({
        pdfUrl: key,
        printPmc: true,
        printUrl,
        label: entry?.label || src.label || "PMC 頁面列印成 PDF",
        sourceUrl: entry?.sourceUrl || src.sourceUrl || printUrl,
        fullTextIndex: entry?.fullTextIndex || candidates.length + 1
      });
      return;
    }
    const pdfUrl = normalizePdfUrlValue(entry);
    if (isSupplementPdfUrl(pdfUrl)) return;
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
  // 每個 /doi/ 類候選再展開 pdfdirect / pdf / epdf 變體，
  // 單一格式失敗（如 pdfdirect 404 或 pdf 是 viewer 頁）時下載迴圈能輪流嘗試
  for (const c of [...candidates]) {
    if (c.printPmc) continue;
    for (const variant of buildPdfCandidatesFromUrl(c.pdfUrl)) {
      add({ pdfUrl: variant, label: (c.label || "PDF") + "（URL 變體）", sourceUrl: c.sourceUrl });
    }
  }
  return candidates;
}

// 下載前預檢：抓 URL 開頭數 KB，確認回應真的是 PDF。
// 回傳 true=確定是 PDF、false=確定不是（HTML/錯誤頁）、null=無法判定（照常嘗試下載）
// 選填 diag 物件：填入 { status, contentType, verdict, reason, snippet } 供 debug 用。
async function preflightPdfCheck(url, diag = null) {
  const setDiag = o => { if (diag) Object.assign(diag, o); };
  const ctrl = new AbortController();
  // 慢速站台（如 SciELO）回應可能拖很久；預檢逾時就放行給下載流程自己處理
  const preflightTimer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, {
      credentials: "include",
      headers: { "Range": "bytes=0-2047" },
      signal: ctrl.signal,
    });
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    setDiag({ status: resp.status, contentType: ct });
    if (!resp.ok) {
      let snippet = "";
      try {
        const reader = resp.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          try { reader.cancel(); } catch {}
          if (value?.length) {
            snippet = new TextDecoder("utf-8").decode(value.slice(0, 2048)).replace(/\s+/g, " ").trim();
          }
        } else {
          try { resp.body?.cancel(); } catch {}
        }
      } catch {
        try { resp.body?.cancel(); } catch {}
      }
      const lowerSnippet = snippet.toLowerCase();
      const unauthorized = resp.status === 403 ||
        lowerSnippet.includes("not authorized") ||
        lowerSnippet.includes("not authorised") ||
        lowerSnippet.includes("access forbidden");
      const manualVerification = isManualVerificationText(lowerSnippet);
      setDiag({
        verdict: false,
        reason: manualVerification
          ? "需要人工驗證：出版社/ScienceDirect 回傳 Security verification / Cloudflare 驗證頁"
          : unauthorized
            ? "HTTP 403 / Access forbidden（出版社或機構授權拒絕）"
            : "HTTP " + resp.status,
        snippet: snippet.slice(0, 200),
        unauthorized,
        manualVerification,
      });
      return false;
    }
    if (ct.includes("application/pdf")) {
      try { resp.body?.cancel(); } catch {}
      setDiag({ verdict: true, reason: "content-type=pdf" });
      return true;
    }
    const reader = resp.body?.getReader();
    if (!reader) {
      const v = ct.includes("text/html") ? false : null;
      setDiag({ verdict: v, reason: "無回應主體；content-type=" + (ct || "?") });
      return v;
    }
    const { value } = await reader.read();
    try { reader.cancel(); } catch {}
    if (!value || !value.length) { setDiag({ verdict: null, reason: "回應主體為空" }); return null; }
    const head = String.fromCharCode(...value.slice(0, 1024));
    setDiag({ snippet: head.slice(0, 200).replace(/\s+/g, " ").trim() });
    if (head.includes("%PDF")) { setDiag({ verdict: true, reason: "%PDF 檔頭" }); return true; }
    const lower = head.toLowerCase();
    if (lower.includes("<!doctype") || lower.includes("<html")) {
      const manualVerification = isManualVerificationText(lower);
      setDiag({
        verdict: false,
        reason: manualVerification
          ? "需要人工驗證：出版社/ScienceDirect 回傳 Security verification / Cloudflare 驗證頁"
          : "回應是 HTML",
        manualVerification,
      });
      return false;
    }
    setDiag({ verdict: null, reason: "開頭非 PDF 也非 HTML" });
    return null;
  } catch (e) {
    // 預檢請求本身失敗或逾時（網路等因素）：無法判定，仍交給下載流程嘗試
    setDiag({ verdict: null, reason: "fetch 失敗：" + (e?.name || e?.message || "未知") });
    return null;
  } finally {
    clearTimeout(preflightTimer);
  }
}

function isManualVerificationText(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("security verification") ||
         lower.includes("request verification") ||
         lower.includes("verify you are human") ||
         lower.includes("verify you are a human") ||
         lower.includes("checking your browser before accessing") ||
         lower.includes("just a moment") ||
         lower.includes("cf-browser-verification") ||
         lower.includes("cf-chl-bypass") ||
         lower.includes("cf-turnstile") ||
         lower.includes("ray id") ||
         lower.includes("驗證您是人類");
}

// 給處理過程紀錄用的時間戳：[HH:MM:SS]
function traceStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] `;
}

// 把 preflight 的 diag 物件整理成一行可讀字串
function formatPreflightDiag(diag) {
  const verdict = diag.verdict === true ? "是PDF" : diag.verdict === false ? "非PDF" : "無法判定";
  let s = `${verdict}（HTTP ${diag.status ?? "?"}, ${diag.contentType || "?"}${diag.reason ? ", " + diag.reason : ""}）`;
  if (diag.snippet) s += `\n      內容開頭: ${diag.snippet}`;
  return s;
}

// 這些站台的 PDF 網址受反爬蟲挑戰保護，直接抓只會拿到挑戰頁：
// - PMC：cloudpmc-viewer 的工作量證明（POW，"Preparing to download..."）
// - ScienceDirect / Elsevier：craft/challenge 驗證頁（pdfft 連結）
// - ScienceDirect assets：View PDF 轉出的 signed main.pdf 仍可能先回 security verification
// 這類 URL 要先在真實分頁裡跑一次 JS 把挑戰解開、cookie 設好，同一個 URL 才會回真 PDF。
function urlNeedsChallengeWarmup(url) {
  const u = (url || "").toLowerCase();
  return (
    u.includes("pmc.ncbi.nlm.nih.gov") || u.includes("pmc-ncbi-nlm-nih-gov") ||
    u.includes("sciencedirect.com")    || u.includes("sciencedirect-com")    ||
    u.includes("pdf.sciencedirectassets.com") ||
    u.includes("pdfft")
  );
}

// Ovid（www-ovid-com...）的 /pdf/... 網址：實測過三種發request的方式——
// service worker 的 fetch()、chrome.downloads.download() 直接發過去——全部只拿
// 到跟 /fulltext/ 共用的 Next.js App 骨架 HTML（HTTP 200, text/html），連下載完
// 成後的假檔 MIME 檢查都抓到、刪掉判定失敗。但真人在瀏覽器裡直接開新分頁導航
// 這個網址，會馬上變成 Chrome 內建 PDF 檢視頁，代表這個網址本身就是真 PDF——
// 研判伺服器是在檢查 Referer／Sec-Fetch-Dest 這類「這是不是瀏覽器整頁導航」的
// 表頭，這些表頭是瀏覽器自動夾帶、extension 程式碼（不管 fetch 或 downloads API）
// 都無法覆寫或偽造。所以這類網域必須改用「讓分頁自己真的導航過去，直接從
// chrome.debugger 的 Network 網域截下瀏覽器這次導航實際收到的回應內容」這條路
// （見 downloadInlinePdfViaTabNavigation），而不是重新自己發一次請求。
function urlHasUnreliableFetchPreflight(url) {
  const u = (url || "").toLowerCase();
  return u.includes("-ovid-com.") || /(?:^|\.|-)ovid\.com/.test(u);
}

// 讓分頁真的整頁導航到 pdfUrl（跟你手動測試一樣，落地是 Chrome 內建 PDF 檢視
// 器），再用 CDP 的 Page.printToPDF 把「這個分頁目前顯示的內容」直接輸出成 PDF
// bytes。原本想用 Network 網域攔截真正的回應內容，但實測 30 秒內完全等不到
// type="Document" 且 mimeType 含 pdf 的回應——研判 Chrome 內建 PDF 檢視器是用
// 另一個獨立的 guest view／子 frame 顯示 PDF 內容，不在這個 tabId 主 frame 的
// Network 事件流裡，攔不到。改用 Page.printToPDF 這條路：它是 Chrome 對「目前
// 分頁在顯示什麼」直接動作（不管是 HTML 還是內建 PDF 檢視器），對著已經顯示 PDF
// 的分頁列印，Chrome 會原樣輸出那份 PDF，不會重新對外發送請求，自然不會被同一
// 個只認真人整頁導航的關卡擋下來。這條路跟 printPmcPageToPdf()（PMC 文章列印）
// 用的是同一套 debugger 機制，屬於本專案已經驗證過的做法。
async function downloadInlinePdfViaTabNavigation(tabId, pdfUrl, safeTitle, folder = "PubMed_PDFs", trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };
  if (!chrome.debugger) {
    G.lastPdfFailureReason = "PDF 擷取失敗：extension 尚未取得 debugger 權限，請重新載入擴充功能後再試。URL: " + pdfUrl;
    rec("結果：無 chrome.debugger 權限");
    return false;
  }

  rec("擷取：分頁真實導航至 PDF 網址（繞過 fetch/downloads API 對非導航請求的限制）");
  addThreadLog("Ovid inline-PDF capture: navigating tab", { pdfUrl });
  await navigateAndWaitStable(tabId, pdfUrl, 3000, 25000);
  // 落地變成 Chrome 內建 PDF 檢視器後，內部渲染還要再一點時間才會真的就緒，
  // 太早呼叫 Page.printToPDF 偶爾會拿到空白或不完整的內容。
  await sleep(1500);

  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target, "1.3");
    attached = true;
    await debuggerSendCommand(target, "Page.enable", {});
    const result = await debuggerSendCommand(target, "Page.printToPDF", { printBackground: true });
    if (!result?.data) {
      rec("結果：Chrome 沒有回傳 PDF 資料，判定失敗");
      G.lastPdfFailureReason = "PDF 擷取失敗：分頁導航後 Chrome 內建 PDF 檢視器沒有回傳內容。URL: " + pdfUrl;
      return false;
    }
    const ok = await downloadBase64Pdf(result.data, safeTitle, folder, trace);
    if (ok) {
      rec("結果：下載成功（內容取自分頁真實導航後的內建 PDF 檢視器）");
      addThreadLog("Ovid inline-PDF capture: download complete", { pdfUrl });
    }
    return ok;
  } catch (e) {
    rec("結果：擷取過程發生例外（" + (e?.message || e) + "）");
    G.lastPdfFailureReason = "PDF 擷取過程發生例外：" + (e?.message || e) + "。URL: " + pdfUrl;
    return false;
  } finally {
    if (attached) { try { await debuggerDetach(target); } catch {} }
  }
}

// 把分頁導到 PDF 網址，讓分頁自己的 JS 解開反爬蟲挑戰並設好 cookie。
// 判斷是否過關的信號直接沿用 preflightPdfCheck：一旦挑戰通過、cookie 進了瀏覽器的
// cookie jar，同一個 URL 的 fetch 就會開始回真 PDF（head 出現 %PDF）→ 回傳 true。
// 這比去猜各家 cookie 名稱更穩，對 PMC POW 與 ScienceDirect challenge 通用。
async function warmUpAntiBotChallenge(tabId, pdfUrl, trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };
  // 決定要在分頁裡打開哪個網址來「觸發並通過」反爬蟲挑戰。
  // ScienceDirect 的 pdfft 是下載端點，直接開它分頁無法自行過 challenge（實測 warmup
  // 從不 cleared）。正常流程是先看「文章頁」讓 challenge 在那通過、設好 clearance cookie，
  // 之後同一個 pdfft 才給檔。故 ScienceDirect 改導到文章頁（去掉 /pdfft... 之後的部分）。
  // PMC 的 POW 直接開 pdf 網址即可解，維持不變。
  let warmUrl = pdfUrl;
  const sdArticle = pdfUrl.match(/^(https?:\/\/[^/]+\/science\/article\/pii\/[^/?#]+)\/pdfft/i);
  if (sdArticle) warmUrl = sdArticle[1];
  rec("  預熱導頁至：" + warmUrl);
  try {
    await navigateTab(tabId, warmUrl, 2000);
  } catch {
    rec("  預熱導頁失敗（分頁可能已關閉）");
    return false;
  }
  const landedTab = await chrome.tabs.get(tabId).catch(() => null);
  rec("  導頁後分頁停在：" + (landedTab?.url || "?"));
  // POW（difficulty 4）通常數秒可解，慢站的 challenge 可能更久；輪詢至多 45 秒
  const deadline = Date.now() + 45000;
  const diag = {};
  while (Date.now() < deadline) {
    const check = await preflightPdfCheck(pdfUrl, diag);
    if (check === true) { rec("  預熱後預檢：已回傳真 PDF"); return true; }
    if (diag.manualVerification) {
      if (G.manualVerifyPause && !G.stopped) {
        // 暫停整批任務、開前景分頁等使用者手動通過驗證；
        // 本篇先以失敗收場，驗證完成後 worker 迴圈會自動從頭重跑此篇
        // （重跑會拿到全新的簽名 PDF URL，舊的 5 分鐘就過期了）
        rec("  偵測到需要人工驗證的頁面，已開啟驗證分頁等待使用者完成，通過後自動重試此篇。");
        addThreadLog("Manual verification required; pausing for user", { pdfUrl });
        // tabId 這裡已經導航到 warmUrl（上面的 navigateTab）並正顯示著挑戰畫面，
        // 沿用同一個分頁，不要另開一個沒導航過的新分頁（會看不到挑戰內容）；
        // 這是 worker 的常駐分頁，驗證結束後不能被關掉
        await requestManualVerificationPause(warmUrl, "ScienceDirect / 出版社驗證頁", tabId, false, true);
        G.lastPdfFailureReason = "需要人工驗證：已暫停等待使用者完成驗證，通過後自動重試。URL: " + pdfUrl;
        return false;
      }
      G.lastPdfFailureReason = "需要人工驗證：ScienceDirect / Cloudflare 驗證頁阻擋自動下載；請稍後手動驗證後重試。URL: " + pdfUrl;
      rec("  偵測到需要人工驗證的頁面，保留為下次重試，不繼續等待。");
      addThreadLog("Manual verification required; keeping item retryable", { pdfUrl });
      return false;
    }
    await sleep(1500);
  }
  rec("  預熱逾時；最後一次預檢：" + formatPreflightDiag(diag));
  return false;
}

// 在 LWW 文章頁上用站方的正規途徑觸發 PDF 下載：
// 點文章工具列的「Download」按鈕展開下拉，再點下拉裡的「PDF」按鈕
// （data-config 帶 PDFDownloadInit 事件），站方 JS 會開新分頁載入 downloadpdf.aspx
// 並在數秒後觸發真正的下載。回傳 { clicked, reason }。
async function tryClickLwwPdfButton(tabId, trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!/journals[.-]lww[.-]com|wolterskluwer/i.test(tab?.url || "")) {
      return { clicked: false, reason: "worker 分頁目前不在 LWW 文章頁" };
    }
    let openedDropdown = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: dropdownAlreadyOpened => {
          const visible = el => {
            if (!el) return false;
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          // 模擬完整的滑鼠點擊序列：部分站方 handler 掛在 pointer/mouse 事件上，
          // 先補齊前置事件，最後只發「一次」click（el.click()）——
          // 千萬不能 dispatch click 又呼叫 el.click()，對開關型按鈕等於點兩下、開了又關
          const realClick = el => {
            const opts = { bubbles: true, cancelable: true, composed: true, view: window };
            try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch {}
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch {}
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.click();
          };
          // 下拉裡的 PDF 按鈕已可見 → 直接點它
          const pdfBtn = Array.from(document.querySelectorAll("button.ejp-article-tools__dropdown-list-button"))
            .find(b => visible(b) &&
              (/\bpdf\b/i.test(b.textContent || "") || /PDFDownloadInit/.test(b.getAttribute("data-config") || "")));
          if (pdfBtn) { realClick(pdfBtn); return "pdf-clicked"; }
          // 已點過 Download 就只等下拉出現，不再點（重複點會把下拉又收起來）
          if (dropdownAlreadyOpened) return "waiting";
          const dlBtn = Array.from(document.querySelectorAll("button.ejp-article-tools__list-button"))
            .find(b => visible(b) && /download/i.test(b.textContent || ""));
          if (dlBtn) { realClick(dlBtn); return "download-clicked"; }
          return "not-found";
        },
        args: [openedDropdown]
      });
      const state = r?.[0]?.result || "not-found";
      if (state === "pdf-clicked") {
        rec("  已點擊下拉中的 PDF 按鈕");
        addThreadLog("LWW: dropdown PDF button clicked", {});
        return { clicked: true, reason: "" };
      }
      if (state === "download-clicked" && !openedDropdown) {
        openedDropdown = true;
        rec("  已點擊 Download 工具列按鈕，等待下拉出現 PDF 按鈕");
        addThreadLog("LWW: Download toolbar button clicked; waiting for dropdown", {});
      }
      if (state === "not-found" && !openedDropdown) {
        return { clicked: false, reason: "文章頁上找不到 Download 工具列按鈕" };
      }
      await sleep(400);
    }
    // 下拉在時限內沒有以「可見」狀態出現：按鈕就算隱藏，handler 通常也照樣動作，
    // 放寬可見性限制直接點一次再放棄
    if (openedDropdown) {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const pdfBtn = Array.from(document.querySelectorAll("button.ejp-article-tools__dropdown-list-button"))
            .find(b => /\bpdf\b/i.test(b.textContent || "") || /PDFDownloadInit/.test(b.getAttribute("data-config") || ""));
          if (!pdfBtn) return false;
          const opts = { bubbles: true, cancelable: true, composed: true, view: window };
          try { pdfBtn.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch {}
          pdfBtn.dispatchEvent(new MouseEvent("mousedown", opts));
          try { pdfBtn.dispatchEvent(new PointerEvent("pointerup", opts)); } catch {}
          pdfBtn.dispatchEvent(new MouseEvent("mouseup", opts));
          pdfBtn.click();
          return true;
        }
      }).catch(() => null);
      if (r?.[0]?.result) {
        rec("  下拉未以可見狀態出現，已改直接點擊（隱藏的）PDF 按鈕");
        addThreadLog("LWW: dropdown never became visible; clicked hidden PDF button", {});
        return { clicked: true, reason: "" };
      }
    }
    return { clicked: false, reason: openedDropdown ? "點了 Download 但 PDF 按鈕未出現" : "找不到可點的按鈕" };
  } catch (e) {
    return { clicked: false, reason: e?.message || String(e) };
  }
}

// 在文章頁的 JS 環境用 window.open 開啟中轉頁：和站方 handler 收到 PDFDownloadInit
// 後做的事相同，開出的分頁帶 referrer 與 opener（直接 tabs.update 導航就是缺這個
// 才不會觸發下載）。window.open 無使用者手勢可能被彈窗攔截器擋下（回傳 null），
// 這時改用點擊 <a target=_blank>。回傳結果字串供 trace 記錄。
async function openLwwInterstitialFromArticlePage(tabId, pageUrl) {
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: url => {
      try {
        if (window.open(url, "_blank")) return "window-open";
      } catch {}
      try {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "opener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        return "anchor-click";
      } catch {}
      return "failed";
    },
    args: [pageUrl]
  }).catch(() => null);
  return r?.[0]?.result || "執行失敗";
}

// 「下載準備中」中轉頁（如 LWW 的 downloadpdf.aspx）：直接用分頁開這個網址不會
// 觸發下載（實測等滿 90 秒都沒動靜）。站方設計是要在「文章頁」點 Download → PDF
// 按鈕，由它的 JS 開新分頁載入 downloadpdf.aspx（顯示 Your download should start
// automatically...），約 10 秒後才觸發真正的 PDF 下載。做法：
// 1. worker 分頁此刻通常還停在文章頁（data-pdf-url 就是從那讀到的）：
//    直接在頁上點 Download → PDF，讓站方 JS 用正規途徑開下載分頁
// 2. 找不到按鈕（分頁已不在文章頁等）才退回直接開中轉頁的舊做法
// 3. 用 chrome.downloads.onDeterminingFilename 攔截觸發的下載，
//    改存到我們的資料夾與檔名（只認來源含 lww/wolterskluwer/downloadpdf 的下載；
//    同時間其他 worker 對同網域的下載被 domain lock 擋住，不會誤認）
// 4. 等待下載完成，並驗證內容不是 HTML 假檔
async function downloadViaPageTriggeredDownload(tabId, pageUrl, safeTitle, folder = "PubMed_PDFs", trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };
  const downloadFolder = sanitizeDownloadFolder(folder);
  const targetPath = downloadFolder + "/" + safeTitle + ".pdf";

  let adoptedId = null;
  const onDeterminingFilename = (item, suggest) => {
    // 登記過的下載（別的 worker 用 API 發起的 PDF/失敗筆記/進度 Excel）：
    // 只要本監聽器存在，Chrome 就會忽略 download() 的 filename（crbug 40706258），
    // 必須在這裡重新 suggest 回原本登記的檔名，否則會變成「下載」掉在根目錄
    const intended = getPendingDownloadFilename(item);
    if (intended) {
      suggest({ filename: intended, conflictAction: "overwrite" });
      return;
    }
    const src = [item.url, item.finalUrl, item.referrer].filter(Boolean).join(" ");
    if (adoptedId == null && /lww|wolterskluwer|downloadpdf/i.test(src)) {
      adoptedId = item.id;
      suggest({ filename: targetPath, conflictAction: "overwrite" });
    } else {
      suggest(); // 其他未知來源的下載維持 Chrome 決定的檔名
    }
  };

  // 點 PDF 按鈕後站方會開新分頁（downloadpdf.aspx）；記住它，監看與收尾都在這個分頁
  let popupTabId = null;
  const onTabCreated = t => {
    if (popupTabId == null && t.openerTabId === tabId) popupTabId = t.id;
  };

  chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
  chrome.tabs.onCreated.addListener(onTabCreated);
  try {
    const startTab = await chrome.tabs.get(tabId).catch(() => null);
    const articleUrl = startTab?.url || "";

    // 觸發順序：文章頁按鈕點擊 → 文章頁 window.open（帶 referrer/opener）→ 直接導航
    const onLwwArticlePage = /journals[.-]lww[.-]com|wolterskluwer/i.test(articleUrl);
    let usedClickPath = false;   // 走了文章頁觸發路徑（按鈕或 window.open）
    let windowOpenTried = false;
    const clickResult = await tryClickLwwPdfButton(tabId, trace);
    if (clickResult.clicked) {
      usedClickPath = true;
      rec("中轉下載頁：已在文章頁點擊 Download → PDF 按鈕，等待站方分頁觸發下載（約 10-20 秒）");
      addThreadLog("Interstitial download: clicked article-page Download → PDF button", { pageUrl });
    } else if (onLwwArticlePage) {
      usedClickPath = true;
      windowOpenTried = true;
      rec("中轉下載頁：無法用按鈕觸發（" + clickResult.reason + "），改由文章頁 window.open 開啟中轉頁（帶 referrer/opener）");
      addThreadLog("Interstitial download: button path failed; using window.open from article page", { pageUrl, reason: clickResult.reason });
      rec("中轉下載頁：window.open 結果＝" + await openLwwInterstitialFromArticlePage(tabId, pageUrl));
    } else {
      rec("中轉下載頁：無法用文章頁觸發（" + clickResult.reason + "），改直接開中轉頁");
      addThreadLog("Interstitial download: falling back to direct navigation", { pageUrl, reason: clickResult.reason });
      await chrome.tabs.update(tabId, { url: pageUrl }).catch(() => {});
    }

    // 等頁面觸發下載。三種結局：
    // a) 頁面觸發附件下載 → onDeterminingFilename 攔截（adoptedId）
    // b) 頁面跳轉成 Chrome 內建 PDF 檢視頁 → 分頁網址就是 PDF 檔案網址，改用 API 下載
    // c) 出現真正的人機驗證 → 暫停等使用者（檢查延後到 15 秒後才開始，
    //    讓正常的 10-15 秒下載流程先有機會完成，避免搶先誤判）
    let inlinePdfUrl = null;
    let lastSeenUrl = "";
    let popupLogged = false;
    const deadline = Date.now() + 90000;
    let nextVerifyCheck = Date.now() + 15000;
    // 點了 PDF 按鈕但 8 秒內站方沒開出下載分頁（例如 handler 忽略程式化點擊）→
    // 改在文章頁的 JS 環境直接 window.open 中轉頁
    let windowOpenAt = usedClickPath && !windowOpenTried ? Date.now() + 8000 : 0;
    // 一路都沒動靜的最後手段：直接把 worker 分頁導到中轉頁再等
    let clickFallbackAt = usedClickPath ? Date.now() + 30000 : 0;
    while (adoptedId == null && Date.now() < deadline && !G.stopped) {
      await sleep(500);
      if (adoptedId != null) break;

      if (popupTabId != null && !popupLogged) {
        popupLogged = true;
        rec("中轉下載頁：站方已開啟下載分頁，等待它觸發下載");
        addThreadLog("Interstitial download: publisher popup tab detected", { popupTabId });
      }

      if (windowOpenAt && Date.now() >= windowOpenAt) {
        windowOpenAt = 0;
        if (popupTabId == null) {
          rec("中轉下載頁：點 PDF 按鈕後未見下載分頁，改由文章頁 window.open 開啟中轉頁（帶 referrer/opener）");
          addThreadLog("Interstitial download: click produced no popup; using window.open from article page", { pageUrl });
          rec("中轉下載頁：window.open 結果＝" + await openLwwInterstitialFromArticlePage(tabId, pageUrl));
        }
      }

      if (clickFallbackAt && Date.now() >= clickFallbackAt && popupTabId == null) {
        clickFallbackAt = 0;
        rec("中轉下載頁：點按鈕後 30 秒內未觸發下載，退回直接開中轉頁");
        addThreadLog("Interstitial download: click path stalled; navigating directly", { pageUrl });
        await chrome.tabs.update(tabId, { url: pageUrl }).catch(() => {});
      }

      // 監看下載分頁：有彈出分頁就看它，否則看 worker 分頁本身
      const watchTabId = popupTabId != null ? popupTabId : tabId;
      const tab = await chrome.tabs.get(watchTabId).catch(() => null);
      const curUrl = tab?.url || "";
      if (curUrl && curUrl !== lastSeenUrl) {
        lastSeenUrl = curUrl;
        if (!/downloadpdf\.aspx/i.test(curUrl) &&
            !/^(?:about:|chrome:)/i.test(curUrl) &&
            curUrl !== articleUrl) {
          const redirDiag = {};
          if (await preflightPdfCheck(curUrl, redirDiag) === true) {
            inlinePdfUrl = curUrl;
            break;
          }
        }
      }

      if (adoptedId == null && Date.now() >= nextVerifyCheck) {
        nextVerifyCheck = Date.now() + 6000;
        const showing = await tabShowsManualVerification(watchTabId);
        if (showing === true) {
          rec("中轉頁出現人機驗證，已暫停等待使用者完成，通過後自動重試此篇。");
          const paused = await requestManualVerificationPause(pageUrl, "Wolters Kluwer 下載驗證頁", popupTabId);
          if (paused) popupTabId = null; // 分頁交給驗證流程，結束時由它關閉
          G.lastPdfFailureReason = "LWW 中轉下載頁出現人機驗證；已暫停等待使用者完成後重試。URL: " + pageUrl;
          return false;
        }
      }
    }
    if (inlinePdfUrl) {
      rec("中轉頁已跳轉為 PDF 檢視頁，改用下載 API 抓同一網址");
      addThreadLog("Interstitial redirected to inline PDF; downloading via API", { pageUrl, inlinePdfUrl });
      // 交回標準下載流程（會再預檢並套用假檔檢查）；tabId 傳 null 避免再走中轉頁邏輯
      return await triggerDownload(inlinePdfUrl, safeTitle, folder, null, trace);
    }
    if (adoptedId == null) {
      rec("結果：時限內（90 秒）頁面未觸發下載，判定失敗");
      G.lastPdfFailureReason = "LWW 中轉下載頁在 90 秒內未觸發 PDF 下載。URL: " + pageUrl;
      return false;
    }
    rec("已攔截頁面觸發的下載，改存為 " + targetPath);
    addThreadLog("Page-triggered download adopted", { pageUrl, downloadId: adoptedId, targetPath });

    // 等待下載完成（大型 PDF 給 5 分鐘）
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
          return false;
        }
        rec("結果：下載成功");
        // 這個下載是頁面 JS 自己觸發、靠 Chrome 瀏覽器引擎本身完成的，沒辦法用
        // fetch() 重現，只能讓 chrome.downloads 照舊落地到 Chrome 預設下載資料夾，
        // 完成後本地資料夾模式下再用 file_manager 把這個已知絕對路徑的檔案「搬」
        // 到使用者選的專案資料夾（不是複製，Chrome 那邊的暫存檔會被搬空）。
        const localCfg = await getLocalFolderConfig();
        if (localCfg.enabled && it.filename) {
          try {
            await fmRequest("move_file", {
              sourceAbsPath: it.filename,
              root: localCfg.root,
              destRelPath: (G.testMode ? TEST_FOLDER_NAME : STATUS_SUCCESS) + "/" + safeTitle + ".pdf",
            });
            rec("已搬移至本地專案資料夾");
          } catch (e) {
            rec("搬移至本地專案資料夾失敗（" + (e?.message || e) + "），檔案仍留在 Chrome 下載資料夾");
            addThreadLog("Local mode move_file failed for LWW download", { error: e?.message || String(e), source: it.filename });
          }
        }
        return true;
      }
      if (it?.state === "interrupted") {
        rec("結果：下載中斷（" + (it.error || "?") + "）");
        return false;
      }
      await sleep(500);
    }
    chrome.downloads.cancel(adoptedId, () => { void chrome.runtime.lastError; });
    rec("結果：下載逾時（5 分鐘），已取消");
    return false;
  } finally {
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
    chrome.tabs.onCreated.removeListener(onTabCreated);
    if (popupTabId != null) chrome.tabs.remove(popupTabId).catch(() => {});
  }
}

async function triggerDownload(pdfUrl, safeTitle, folder = "PubMed_PDFs", tabId = null, trace = null) {
  pdfUrl = normalizePdfUrlValue(pdfUrl);
  if (!pdfUrl) return false;
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };

  // Wolters Kluwer / LWW 的 downloadpdf.aspx 是「準備下載中」中轉頁：
  // 直接 fetch 永遠拿到 HTML、直接開分頁也不會觸發下載，
  // 要在文章頁點 Download → PDF 按鈕讓站方 JS 觸發，再攔截它觸發的下載
  if (tabId != null && /\/oaks\.journals\/downloadpdf\.aspx/i.test(pdfUrl)) {
    return await downloadViaPageTriggeredDownload(tabId, pdfUrl, safeTitle, folder, trace);
  }

  // Ovid 的 /pdf/... 網址：實測過，fetch() 預檢跟 chrome.downloads.download() 直接
  // 發過去都只拿到跟 /fulltext/ 共用的 Next.js App 骨架 HTML（HTTP 200, text/html）
  // ——這兩種request都是「非瀏覽器整頁導航」，會被伺服器擋下來；真正的關卡研判是
  // Referer／Sec-Fetch-Dest 這類瀏覽器自動夾帶、extension 程式碼完全無法覆寫的
  // 表頭（chrome.downloads.download() 的 headers 選項也明確禁止設定這些）。
  // 但實測過：分頁真的整頁導航這個網址，Chrome 立刻用內建 PDF 檢視器正常顯示，
  // 代表唯一能拿到真檔的方法是讓分頁自己導航過去，直接從瀏覽器「這次導航實際
  // 收到的網路回應內容」裡把 PDF bytes 截下來（chrome.debugger 的 Network 網域），
  // 而不是我們自己另外再發一次請求。
  if (tabId != null && urlHasUnreliableFetchPreflight(pdfUrl)) {
    return await downloadInlinePdfViaTabNavigation(tabId, pdfUrl, safeTitle, folder, trace);
  }

  // 先驗明正身再下載：不預檢的話會把出版商的 HTML 頁面存成 .pdf/.htm 檔，
  // 卻在 Excel 記「下載成功」（假成功比失敗更難發現）
  const diag = {};
  let check = await preflightPdfCheck(pdfUrl, diag);
  rec("預檢：" + formatPreflightDiag(diag));

  // 預檢拿到的不是 PDF，但這是已知會用反爬蟲挑戰擋直接下載的站台：
  // 在真實分頁裡把挑戰解開後，同一個 URL 就能下載到真 PDF。
  if (check !== true && tabId != null && urlNeedsChallengeWarmup(pdfUrl)) {
    addThreadLog("Preflight not a PDF; attempting anti-bot warmup in tab", { pdfUrl, check });
    rec("非 PDF 且屬已知反爬蟲站台 → 嘗試分頁預熱");
    if (await warmUpAntiBotChallenge(tabId, pdfUrl, trace)) {
      addThreadLog("Anti-bot warmup cleared; PDF now served", { pdfUrl });
      rec("預熱成功，改判定為 PDF、繼續下載");
      check = true;
    } else {
      addThreadLog("Anti-bot warmup did not yield a PDF", { pdfUrl });
      rec("預熱失敗（時限內未取得真 PDF）");
    }
  }

  if (check === false) {
    // 非 warmup 站台（如 Wiley/Springer 的 Cloudflare）遇到人機驗證：一樣暫停等使用者通過。
    // warmup 站台（ScienceDirect 等）的驗證已在 warmUpAntiBotChallenge 內處理過。
    if (diag.manualVerification && G.manualVerifyPause && !G.stopped && !urlNeedsChallengeWarmup(pdfUrl)) {
      rec("偵測到人機驗證頁，已開啟驗證分頁等待使用者完成，通過後自動重試此篇。");
      // 驗證頁必須開在「真的被擋下來的那個網址」上使用者才看得到挑戰畫面：
      // 之前直接開新分頁只帶著 URL、沒有先導航，常常變成一個空白/看不到驗證的分頁。
      // 這裡改成先把本篇的 worker 分頁導到 pdfUrl（讓 Cloudflare 挑戰真的渲染出來），
      // 再沿用同一個分頁請求暫停，使用者切過去就是原本卡住的那個畫面。
      if (tabId != null) {
        await navigateTab(tabId, pdfUrl, 1200).catch(() => {});
        await requestManualVerificationPause(pdfUrl, "出版社驗證頁", tabId, false, true);
      } else {
        await requestManualVerificationPause(pdfUrl, "出版社驗證頁");
      }
    }
    addThreadLog("Preflight rejected candidate (not a PDF)", { pdfUrl });
    rec("結果：放棄此候選（確定非 PDF）");
    G.lastPdfFailureReason = "PDF 預檢失敗：" + formatPreflightDiag(diag) + "；URL: " + pdfUrl;
    return false;
  }

  // 本地資料夾模式：這裡一定是 preflightPdfCheck() 已經用 fetch() 驗證過真的是 PDF
  // 才會走到，所以直接再 fetch 一次完整內容送給 file_manager native host 寫檔，
  // 完全繞過 chrome.downloads（也就不會受限於 Chrome 預設下載資料夾）。
  const localCfg = await getLocalFolderConfig();
  if (localCfg.enabled) {
    try {
      const resp = await fetch(pdfUrl, { credentials: "include" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const buf = await resp.arrayBuffer();
      if (!looksLikePdfBytes(buf, resp.headers.get("content-type"))) {
        rec("結果：本地模式下載到的內容像是網頁，判定失敗");
        addThreadLog("Local mode download looks like HTML, not PDF", { pdfUrl });
        return false;
      }
      await fmRequest("write_bytes", {
        root: localCfg.root,
        relPath: (G.testMode ? TEST_FOLDER_NAME : STATUS_SUCCESS) + "/" + safeTitle + ".pdf",
        dataB64: bufferToBase64(buf),
      });
      rec("結果：下載成功（本地資料夾模式）");
      return true;
    } catch (e) {
      if (!localCfg.allowFallback) {
        rec("結果：本地資料夾模式寫檔失敗（" + (e?.message || e) + "），判定失敗（未開啟「失敗退回 Chrome 下載」進階設定）");
        addThreadLog("Local mode write failed, fallback disabled", { pdfUrl, error: e?.message || String(e) });
        G.lastPdfFailureReason = "本地資料夾模式寫檔失敗：" + (e?.message || e) + "。URL: " + pdfUrl;
        return false;
      }
      rec("結果：本地資料夾模式寫檔失敗（" + (e?.message || e) + "），退回一般下載流程");
      addThreadLog("Local mode write failed, falling back to chrome.downloads", { pdfUrl, error: e?.message || String(e) });
      // 不 return——讓下面既有的 chrome.downloads 流程當退路，確保裝了本地模式
      // 但 native host 暫時失效時，下載還是能成功（只是會落在 Chrome 下載資料夾）
    }
  }

  const downloadFolder = sanitizeDownloadFolder(folder);
  registerPendingDownloadFilename(pdfUrl, downloadFolder + "/" + safeTitle + ".pdf");
  return await new Promise(resolve => {
    chrome.downloads.download({
      url:      pdfUrl,
      filename: downloadFolder + "/" + safeTitle + ".pdf",
      saveAs:   false,
      conflictAction: "overwrite",
    }, downloadId => {
      if (chrome.runtime.lastError || !downloadId) {
        rec("結果：Chrome 無法啟動下載（" + (chrome.runtime.lastError?.message || "未知") + "）");
        resolve(false); return;
      }
      let timeoutId = null;
      const settle = ok => {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        chrome.downloads.onChanged.removeListener(listener);
        resolve(ok);
      };
      const listener = delta => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete") {
          // 下載後再驗一次：Chrome 若依 MIME 判定內容是網頁，會把副檔名改成 .htm
          chrome.downloads.search({ id: downloadId }, items => {
            const it = items?.[0];
            const fname = (it?.filename || "").toLowerCase();
            const mime  = (it?.mime || "").toLowerCase();
            if (mime.includes("html") || fname.endsWith(".htm") || fname.endsWith(".html")) {
              chrome.downloads.removeFile(downloadId, () => { void chrome.runtime.lastError; });
              addThreadLog("Downloaded file is a web page, not PDF; deleted and marked failed", {
                pdfUrl, filename: it?.filename || "", mime
              });
              rec("結果：下載完成但內容是網頁（mime=" + (mime || "?") + "），已刪除、判定失敗");
              settle(false);
            } else {
              rec("結果：下載成功");
              settle(true);
            }
          });
        }
        else if (delta.state?.current === "interrupted") { rec("結果：下載中斷"); settle(false); }
      };
      chrome.downloads.onChanged.addListener(listener);
      // 大型 PDF / 慢速站台（SciELO 實測光載入就要 1-2 分鐘）需要充裕時間，
      // 給 5 分鐘；逾時就取消下載，避免「Excel 記失敗但檔案其實稍後下載完成」的不一致
      timeoutId = setTimeout(() => {
        chrome.downloads.cancel(downloadId, () => { void chrome.runtime.lastError; });
        rec("結果：下載逾時（5 分鐘），已取消");
        settle(false);
      }, 300000);
    });
  });
}

async function printPmcPageToPdf(tabId, url, safeTitle, folder = "PubMed_PDFs", trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };
  if (!tabId || !url) return false;
  if (!chrome.debugger) {
    G.lastPdfFailureReason = "PMC 列印成 PDF 失敗：extension 尚未取得 debugger 權限，請重新載入擴充功能後再試。";
    rec("PMC 列印：無 debugger 權限");
    return false;
  }

  rec("PMC：找不到原生 PDF 連結，改用文章頁列印成 PDF");
  await navigateAndWaitStable(tabId, url, 3000, 25000);
  await sleep(2000);
  if (!(await isPrintablePmcArticle(tabId))) {
    G.lastPdfFailureReason = "PMC 列印成 PDF 失敗：頁面不是完整 PMC 文章，或頁面仍未載入完成。";
    rec("PMC 列印：頁面完整性檢查失敗");
    return false;
  }

  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target, "1.3");
    attached = true;
    await debuggerSendCommand(target, "Page.enable", {});
    const result = await debuggerSendCommand(target, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.35,
      marginBottom: 0.35,
      marginLeft: 0.35,
      marginRight: 0.35,
      scale: 0.9
    });
    if (!result?.data) {
      G.lastPdfFailureReason = "PMC 列印成 PDF 失敗：Chrome 沒有回傳 PDF 資料。";
      rec("PMC 列印：Chrome 沒有回傳 PDF data");
      return false;
    }
    const ok = await downloadBase64Pdf(result.data, safeTitle, folder, trace);
    if (ok) rec("PMC 列印：PDF 已儲存");
    return ok;
  } catch (e) {
    G.lastPdfFailureReason = "PMC 列印成 PDF 失敗：" + (e?.message || String(e));
    rec("PMC 列印：失敗（" + (e?.message || String(e)) + "）");
    return false;
  } finally {
    if (attached) {
      try { await debuggerDetach(target); } catch {}
    }
  }
}

function debuggerAttach(target, version) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(err));
      else resolve();
    });
  });
}

function debuggerSendCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, result => {
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(err));
      else resolve(result);
    });
  });
}

function debuggerDetach(target) {
  return new Promise(resolve => {
    chrome.debugger.detach(target, () => resolve());
  });
}

async function downloadBase64Pdf(base64, safeTitle, folder = "PubMed_PDFs", trace = null) {
  const rec = line => { if (Array.isArray(trace)) trace.push(traceStamp() + line); };

  // 本地資料夾模式：base64 bytes 已經在手上（CDP printToPDF 的結果），直接寫檔，
  // 完全跳過 chrome.downloads，不會落在 Chrome 預設下載資料夾裡。
  const localCfg = await getLocalFolderConfig();
  if (localCfg.enabled) {
    try {
      await fmRequest("write_bytes", {
        root: localCfg.root,
        relPath: (G.testMode ? TEST_FOLDER_NAME : STATUS_SUCCESS) + "/" + safeTitle + ".pdf",
        dataB64: base64,
      });
      rec("下載成功（本地資料夾模式）");
      return true;
    } catch (e) {
      if (!localCfg.allowFallback) {
        rec("本地資料夾模式寫檔失敗（" + (e?.message || e) + "），判定失敗（未開啟「失敗退回 Chrome 下載」進階設定）");
        addThreadLog("Local mode write_bytes failed in downloadBase64Pdf, fallback disabled", { error: e?.message || String(e) });
        return false;
      }
      rec("本地資料夾模式寫檔失敗（" + (e?.message || e) + "），退回一般下載流程");
      addThreadLog("Local mode write_bytes failed in downloadBase64Pdf, falling back", { error: e?.message || String(e) });
    }
  }

  const downloadFolder = sanitizeDownloadFolder(folder);
  registerPendingDownloadFilename("data:application/pdf;base64," + base64, downloadFolder + "/" + safeTitle + ".pdf");
  return new Promise(resolve => {
    chrome.downloads.download({
      url: "data:application/pdf;base64," + base64,
      filename: downloadFolder + "/" + safeTitle + ".pdf",
      saveAs: false,
      conflictAction: "overwrite",
    }, downloadId => {
      if (chrome.runtime.lastError || !downloadId) {
        rec("PMC 列印：Chrome 無法啟動下載（" + (chrome.runtime.lastError?.message || "未知") + "）");
        resolve(false);
        return;
      }
      let timeoutId = null;
      const settle = ok => {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        chrome.downloads.onChanged.removeListener(listener);
        resolve(ok);
      };
      const listener = delta => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete") {
          rec("PMC 列印：下載完成");
          settle(true);
        } else if (delta.state?.current === "interrupted") {
          rec("PMC 列印：下載中斷");
          settle(false);
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      timeoutId = setTimeout(() => {
        chrome.downloads.cancel(downloadId, () => { void chrome.runtime.lastError; });
        rec("PMC 列印：下載逾時，已取消");
        settle(false);
      }, 180000);
    });
  });
}

function navigateTab(tabId, url, extraMs = 2000) {
  return new Promise(resolve => {
    let settled = false;
    let timeoutId = null;
    // finish 只會生效一次：導航完成時必須取消 15 秒 timeout，
    // 否則延遲觸發的 autoAcceptCookieBanners 會打在之後導航到的其他頁面上亂點按鈕
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      finishNavigation(tabId, extraMs).then(resolve).catch(() => resolve());
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(finish, 15000);
    // 分頁可能已被使用者手動關閉；不能用 async executor，
    // 否則 reject 會讓這個 Promise 永遠不 settle、worker 永久卡死
    chrome.tabs.update(tabId, { url }).catch(() => finish());
  });
}

async function navigateAndWaitStable(tabId, url, minStableMs = 2000, maxWaitMs = 15000) {
  // 分頁可能已被使用者關閉，避免 reject 直接炸出去
  await chrome.tabs.update(tabId, { url }).catch(() => {});
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
