/**
 * Discord 下載狀況通知（src/discord/discord_notifier.js）
 *
 * 獨立放在自己的資料夾，方便日後單獨修改——只負責「組訊息內容 + 呼叫
 * webhook」，完全不碰下載/平台判斷邏輯。background.js 透過
 * importScripts("discord/discord_notifier.js") 載入，共用同一個 service
 * worker 全域作用域（用到 G、addThreadLog、truncate，都是 background.js
 * 已經定義好的東西，這裡不重複定義）。
 *
 * 開關與 webhook 網址存在 chrome.storage.local：
 *   - discordEnabled：預設關閉，使用者在 popup「⚙ 進階設定 → 🔔 Discord」勾選才會送
 *   - discordWebhookUrl：使用者自己改過就存這裡；沒改過就退回下面的預設值
 *
 * 訊息時機（由 background.js 呼叫）：
 *   - 每處理完 10 篇：sendDiscordBatchUpdate() — 這 10 篇各自的狀況 + 累積進度
 *   - 全部處理完成（不論正常跑完或使用者中途停止）：sendDiscordFinalReport()
 *     — 總結統計 + 全部論文編號的精簡清單（不含標題，避免超過 Discord 單則
 *     訊息 2000 字元上限；超過安全門檻會自動拆成多則）
 */

// 使用者目前的預設 webhook。之後在 popup 改過webhook網址，
// 存進 chrome.storage.local 的 discordWebhookUrl 之後就以那個為準，
// 這裡的值只在 storage 裡從沒存過時當作起始預設。
const DISCORD_DEFAULT_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1528979504674902048/AbeCJ0A_xcAanw3Cr5kyRKVbLyImwaOPSCkvOR3lEy7oZ-MsPGNSt8d4o-5Ww3H53suZ";

// 每處理完幾篇送一次進度訊息
const DISCORD_BATCH_SIZE = 10;

// 單則訊息文字長度安全門檻——遠低於 Discord 實際的 2000 字元上限，
// 超過就自動拆成多則接續送出。
const DISCORD_MSG_SPLIT_THRESHOLD = 1000;

const DISCORD_STATUS_EMOJI = {
  "下載成功": "✅",
  "下載失敗": "❌",
  "下次重試": "🔁",
};

function getDiscordConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(["discordEnabled", "discordWebhookUrl"], d => {
      resolve({
        enabled: !!d.discordEnabled,
        webhookUrl: d.discordWebhookUrl || DISCORD_DEFAULT_WEBHOOK_URL,
      });
    });
  });
}

async function discordWebhookPost(webhookUrl, content) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      addThreadLog("Discord webhook 回應非 2xx", { status: res.status, body: bodyText.slice(0, 300) });
    }
  } catch (e) {
    // Discord 發不出去不該讓下載流程掛掉，只記一筆 threadLog 靜默略過
    addThreadLog("Discord webhook 發送失敗", { error: e?.message || String(e) });
  }
}

// 把一大段文字依 maxLen 切成多塊，優先在空白處斷開（避免把「0205✅」這種
// 論文編號切成兩半，變成兩則訊息各半段看不懂）。
function splitDiscordText(text, maxLen = DISCORD_MSG_SPLIT_THRESHOLD) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// header 一定完整放進第一則；body 太長就拆成後續幾則，各自標「（續 n/N）」
async function sendDiscordNotification(header, body = "") {
  const cfg = await getDiscordConfig();
  if (!cfg.enabled) return;

  const bodyChunks = body ? splitDiscordText(body) : [];
  const firstChunk = bodyChunks[0] || "";
  const restChunks = bodyChunks.slice(1);
  const totalMsgs = 1 + restChunks.length;

  const first = totalMsgs > 1
    ? `${header}\n（共 ${totalMsgs} 則，1/${totalMsgs}）\n${firstChunk}`
    : (firstChunk ? `${header}\n${firstChunk}` : header);
  await discordWebhookPost(cfg.webhookUrl, first);

  for (let i = 0; i < restChunks.length; i++) {
    await discordWebhookPost(cfg.webhookUrl, `（續 ${i + 2}/${totalMsgs}）\n${restChunks[i]}`);
  }
}

// 每處理完 DISCORD_BATCH_SIZE 篇呼叫一次。items 是這一批論文的
// {paperNo, pmid, title, status}。
async function sendDiscordBatchUpdate(items, doneCount, totalCount) {
  const cfg = await getDiscordConfig();
  if (!cfg.enabled) return;

  const lines = items.map(it => {
    const emoji = DISCORD_STATUS_EMOJI[it.status] || "❔";
    const no = it.paperNo != null ? String(it.paperNo).padStart(4, "0") : "????";
    return `${emoji} 第${no}篇 (PMID:${it.pmid || "無"}) ${truncate(it.title || "", 40)} → ${it.status}`;
  });
  const header = `📥 PubMed 下載進度（累積 ${doneCount}/${totalCount} 篇）`;
  await sendDiscordNotification(header, lines.join("\n"));
}

// 全部處理完成呼叫一次（不論是正常跑完，還是使用者中途按停止）。
// allItems：整個run從頭到尾每一篇的 {paperNo, status}（不含標題，控制長度用）。
async function sendDiscordFinalReport({ doneCount, totalCount, ok, fail, skip, stoppedEarly, allItems }) {
  const cfg = await getDiscordConfig();
  if (!cfg.enabled) return;

  const header =
    `🏁 PubMed 下載結束（${stoppedEarly ? "使用者中途停止" : "正常完成"}）\n` +
    `本次共處理 ${doneCount}/${totalCount} 篇：✅成功 ${ok}｜❌失敗 ${fail}｜🔁待重試 ${skip}`;

  const body = (allItems || [])
    .map(it => {
      const emoji = DISCORD_STATUS_EMOJI[it.status] || "❔";
      const no = it.paperNo != null ? String(it.paperNo).padStart(4, "0") : "????";
      return `${no}${emoji}`;
    })
    .join(" ");

  await sendDiscordNotification(header, body);
}
