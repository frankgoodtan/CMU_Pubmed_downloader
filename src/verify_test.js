/**
 * 人機驗證流程的模擬測試（Debug 用，獨立檔案方便維護）。
 *
 * 用途：不必真的撞到出版社的驗證頁，也能測試「偵測到人機驗證」當下的完整行為
 * （開新分頁、切到最前景、通知、popup 顯示等待區、佇列排隊、完成後繼續，以及
 * triggerVerificationHeart 對挑戰元件的定位）。由 popup 的「🧪 測試人機驗證流程」
 * 按鈕觸發（background.js 的 TEST_VERIFY 訊息）。
 *
 * 做法：開靶場頁面（模擬各種挑戰元件，見 element_test.html 開頭說明），等它載入
 * 完成後，走與正式流程完全相同的 requestManualVerificationPause 佇列機制
 * （force=true，不受「遇驗證時暫停」開關限制）。若當下真的有其他驗證在等待，
 * 這筆測試也會照樣排隊，剛好可以順便驗證多筆同時出現時的排隊行為。
 *
 * 靶場頁面是真實的 https:// 網址（GitHub Pages：
 * https://frankgoodtan.github.io/verift_element_test/），不是包在擴充功能裡的
 * chrome-extension:// 頁面——因為 chrome.scripting.executeScript 沒辦法注入
 * chrome-extension:// 頁面（Chrome 的硬性限制），改用真實 https 網址就能走
 * locateTargetElement 原本、跟真實驗證頁完全相同的 executeScript 注入路徑。
 *
 * 依賴 background.js 已宣告好的全域：G、addLog、requestManualVerificationPause。
 */
function waitForTabComplete(tabId, timeoutMs = 5000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

const ELEMENT_TEST_PAGE_URL = "https://frankgoodtan.github.io/verift_element_test/";

async function runManualVerificationTest() {
  addLog("🧪 開始模擬人機驗證流程（測試用，未連到真正的驗證頁）…", "info");
  const tab = await chrome.tabs.create({ url: ELEMENT_TEST_PAGE_URL, active: true }).catch(() => null);
  if (!tab) {
    addLog("🧪 測試失敗：無法開啟測試頁面。", "warn");
    return;
  }
  // 頁面載入完成前就去定位元件會撲空（DOM 都還沒跑完），
  // 所以要等 tab 狀態變 complete 再繼續，跟正式流程「挑戰元件早就在畫面上」的
  // 情境不同，這裡是新開分頁測試才需要多這一步。
  await waitForTabComplete(tab.id);
  await requestManualVerificationPause(
    ELEMENT_TEST_PAGE_URL,
    "🧪 人機驗證模擬測試（element_test 靶場頁，非真實驗證頁）",
    tab.id,
    /* force */ true,
    /* preserveExistingTab */ false
  );
}
