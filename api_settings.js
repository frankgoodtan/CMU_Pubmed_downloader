/**
 * 驗證與 API 進階設定面板（api_settings.js，只在 popup 載入）
 *
 * 負責：
 * - 「⚙ 驗證與 API 進階設定」收合面板的開關與狀態摘要
 * - 依 publisher_apis.js 的 PUBLISHER_APIS 註冊表，動態產生各出版商的憑證輸入欄位
 *   （新增出版商 API 時只要改 publisher_apis.js，這裡不用動）
 * - 憑證的載入/儲存（chrome.storage.local 的 publisherApiCreds）
 *
 * popup.js 只需要用：
 *   AdvancedSettings.getCreds()  → 目前所有出版商憑證（送給 background）
 *   AdvancedSettings.show()/hide() → 上傳後顯示、重設時隱藏
 *   AdvancedSettings.updateSummary() → 需要時重整摘要文字
 */

const AdvancedSettings = (() => {
  const row       = document.getElementById("advancedRow");
  const panel     = document.getElementById("advancedPanel");
  const toggleBtn = document.getElementById("advancedToggleBtn");
  const summary   = document.getElementById("advancedSummary");
  const fieldsHost = document.getElementById("publisherApiFields");
  const manualVerifyPauseInput = document.getElementById("manualVerifyPauseInput");
  const preVerifyInput         = document.getElementById("preVerifyInput");
  const challengeSelectorPreset = document.getElementById("challengeSelectorPreset");
  const challengeSelectorCustom = document.getElementById("challengeSelectorCustom");
  const allowChromeDownloadsFallbackInput = document.getElementById("allowChromeDownloadsFallbackInput");

  const inputs = {}; // publisherId → { fieldKey → <input> }

  function getChallengeSelector() {
    if (challengeSelectorPreset?.value === "__custom__") {
      return (challengeSelectorCustom?.value || "").trim();
    }
    return challengeSelectorPreset?.value || "";
  }

  function toggleChallengeSelectorCustomInput() {
    if (!challengeSelectorCustom) return;
    challengeSelectorCustom.style.display = challengeSelectorPreset?.value === "__custom__" ? "block" : "none";
  }

  function buildFields() {
    if (!fieldsHost) return;
    for (const pub of PUBLISHER_APIS) {
      inputs[pub.id] = {};
      for (const f of pub.fields) {
        const rowDiv = document.createElement("div");
        rowDiv.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:5px;";
        const label = document.createElement("label");
        label.style.cssText = "width:110px; font-size:12px; color:#555; flex-shrink:0;";
        label.textContent = f.label;
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = f.placeholder || "";
        input.style.cssText = "flex:1; padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:12px; font-family:inherit;";
        input.addEventListener("input", () => { save(); updateSummary(); });
        rowDiv.appendChild(label);
        rowDiv.appendChild(input);
        fieldsHost.appendChild(rowDiv);
        inputs[pub.id][f.key] = input;
      }
      if (pub.note) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:10px; color:#94a3b8; margin:2px 0 8px; line-height:1.5;";
        note.textContent = "※ " + pub.note;
        fieldsHost.appendChild(note);
      }
    }
  }

  function getCreds() {
    const creds = {};
    for (const pub of PUBLISHER_APIS) {
      creds[pub.id] = {};
      for (const f of pub.fields) {
        creds[pub.id][f.key] = (inputs[pub.id]?.[f.key]?.value || "").trim();
      }
    }
    return creds;
  }

  function save() {
    chrome.storage.local.set({
      publisherApiCreds: getCreds(),
      manualVerificationChallengeSelector: getChallengeSelector(),
      allowChromeDownloadsFallback: !!allowChromeDownloadsFallbackInput?.checked
    });
  }

  function load() {
    chrome.storage.local.get(
      ["publisherApiCreds", "elsevierApiKey", "elsevierInsttoken", "manualVerificationChallengeSelector", "allowChromeDownloadsFallback"],
      d => {
        if (allowChromeDownloadsFallbackInput) allowChromeDownloadsFallbackInput.checked = !!d.allowChromeDownloadsFallback;
        const creds = d.publisherApiCreds || {};
        // 相容舊版儲存格式（曾以 elsevierApiKey / elsevierInsttoken 各存一鍵）
        if (!creds.elsevier && (d.elsevierApiKey || d.elsevierInsttoken)) {
          creds.elsevier = { apiKey: d.elsevierApiKey || "", insttoken: d.elsevierInsttoken || "" };
        }
        for (const pub of PUBLISHER_APIS) {
          for (const f of pub.fields) {
            const v = creds?.[pub.id]?.[f.key];
            if (v && inputs[pub.id]?.[f.key]) inputs[pub.id][f.key].value = v;
          }
        }

        const savedSelector = d.manualVerificationChallengeSelector || "";
        if (challengeSelectorPreset) {
          const knownValues = Array.from(challengeSelectorPreset.options).map(o => o.value);
          if (savedSelector && !knownValues.includes(savedSelector)) {
            challengeSelectorPreset.value = "__custom__";
            if (challengeSelectorCustom) challengeSelectorCustom.value = savedSelector;
          } else {
            challengeSelectorPreset.value = savedSelector;
          }
          toggleChallengeSelectorCustomInput();
        }

        updateSummary();
      }
    );
  }

  function updateSummary() {
    if (!summary) return;
    const parts = [];
    parts.push("暫停等驗證：" + (manualVerifyPauseInput?.checked ? "開" : "關"));
    parts.push("SD 預熱：" + (preVerifyInput?.checked ? "開" : "關"));
    const configured = publisherApiConfiguredLabels(getCreds());
    parts.push("API：" + (configured.length ? configured.join("+") : "未設定"));
    parts.push("失敗退回 Chrome 下載：" + (allowChromeDownloadsFallbackInput?.checked ? "開" : "關"));
    summary.textContent = parts.join("｜");
  }

  function show() {
    if (row) row.style.display = "flex";
  }

  function hide() {
    if (row) row.style.display = "none";
    if (panel) panel.style.display = "none";
    if (toggleBtn) toggleBtn.textContent = "⚙ 驗證與 API 進階設定";
  }

  // ── init ──
  buildFields();
  load();
  if (toggleBtn && panel) {
    toggleBtn.addEventListener("click", () => {
      const open = panel.style.display !== "none";
      panel.style.display = open ? "none" : "block";
      toggleBtn.textContent = open ? "⚙ 驗證與 API 進階設定" : "⚙ 收起進階設定";
      updateSummary();
    });
  }
  [manualVerifyPauseInput, preVerifyInput].forEach(el => {
    el?.addEventListener("change", updateSummary);
  });
  allowChromeDownloadsFallbackInput?.addEventListener("change", () => { save(); updateSummary(); });
  challengeSelectorPreset?.addEventListener("change", () => {
    toggleChallengeSelectorCustomInput();
    save();
    updateSummary();
  });
  challengeSelectorCustom?.addEventListener("input", () => { save(); updateSummary(); });
  updateSummary();

  return { getCreds, show, hide, updateSummary };
})();
