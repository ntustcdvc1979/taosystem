import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";

// 共用的 DeepSeek API Key 存在 Firestore 的 config/ai 文件（欄位 deepseekApiKey），
// 由 Firestore 安全規則的 Email 白名單保護：只有登入且在白名單內的人讀得到。
// Key 不寫在程式碼、不進 git、也不會出現在部署後的公開 JS 裡。
let cachedKey = null;

export async function getSharedApiKey() {
  if (cachedKey) return cachedKey;
  const snap = await getDoc(doc(db, "config", "ai"));
  const key = snap.exists() ? (snap.data().deepseekApiKey || "").trim() : "";
  if (key) cachedKey = key;
  return key;
}

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

const DOMAIN_CONTEXT = `你是一位資深的一貫道校園成全前賢，熟悉如何依照每個人的背景、興趣與目前的成全狀況，規劃下一步的成全策略。

成全狀況的進程依序為：未求道 → 已求道 → 法會畢 → 新民班畢 → 至善班畢 → 行德班畢 → 崇德班畢 → 人才培訓班畢 → 講培班畢 → 講師。

原則：
- 從對方的背景與活動反應找切入點，不要泛泛而談。
- 尊重對方的步調，避免給人壓力；若過去反應冷淡，策略應以維繫關係為主。
- 建議的下一步要銜接目前的成全狀況（例如已求道者，下一步通常是研究班或法會）。
- 用臺灣慣用的繁體中文書寫。`;

async function callDeepSeek(apiKey, messages, jsonMode = false) {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const err = new Error(`DeepSeek API 錯誤（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// 將對象資料整理成給模型看的文字（呼叫端需先完成去識別化）
function formatPerson(person) {
  const activityLines = (person.activities || [])
    .map((a) => `- ${a.date ? a.date + " " : ""}${a.activity}：${a.reaction || "（未記錄反應）"}`)
    .join("\n");

  return `姓名（已去識別化）：${person.name || "（未填）"}
系級：${person.department || "（未填）"}
背景：${person.background || "（未填）"}
備註：${person.notes || "（未填）"}
聯絡人（已去識別化）：${person.contact || "（未填）"}
目前成全狀況：${person.status || "（未填）"}
目前策略：${person.strategy || "（尚無）"}
目前做法：${person.method || "（尚無）"}
活動紀錄：
${activityLines || "（尚無活動紀錄）"}`;
}

/**
 * 針對單一對象產生成全建議。回傳 { strategy, method }。
 * @param {string} apiKey - 從 Firestore config/ai 取得的共用 DeepSeek API Key
 * @param {object} person - 已去識別化的對象資料
 * @param {string} guidance - 使用者提供的方向（例如一句話的成全策略大方向），可為空
 */
export async function generateSuggestion(apiKey, person, guidance = "") {
  const system = `${DOMAIN_CONTEXT}

使用者會提供一位成全對象的資料（姓名、聯絡人已去識別化），可能附上他希望的策略方向。請提出：
1. strategy：一句話的成全策略大方向，例如「讓他喜歡來上新民班」。若使用者已提供方向，以他的方向為主軸，幫他修飾得更精準。
2. method：2-4 點可實際執行的做法，具體到可以直接照著做，例如邀約的話術方向、適合搭配的活動、由誰出面、頻率等，以換行分隔。

請以 JSON 格式輸出，只含兩個欄位：{"strategy": "...", "method": "..."}`;

  const user = `請為以下成全對象規劃策略與具體做法：

${formatPerson(person)}${guidance ? `\n\n我希望的策略方向：${guidance}` : ""}`;

  const content = await callDeepSeek(
    apiKey,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    true
  );
  return JSON.parse(content);
}

/**
 * 全名單 AI Agent 聊天。回傳 assistant 的回覆文字。
 * @param {string} apiKey - 共用 DeepSeek API Key
 * @param {object[]} roster - 已去識別化的全部名單
 * @param {{role: string, content: string}[]} history - 聊天歷史（含最新一則 user 訊息）
 */
export async function chatWithAgent(apiKey, roster, history) {
  const rosterText = roster
    .map((p, i) => `【第 ${i + 1} 位】\n${formatPerson(p)}`)
    .join("\n\n");

  const system = `${DOMAIN_CONTEXT}

以下是目前的成全名單（共 ${roster.length} 位，姓名與聯絡人已去識別化）：

${rosterText || "（目前名單是空的）"}

使用者是負責成全的同修，會向你詢問名單相關的建議（例如：誰適合邀約參加法會、某位對象下一步怎麼做、整體優先順序等）。請根據名單內容給出具體、可執行的建議；回答保持精簡，不要長篇大論。`;

  const content = await callDeepSeek(apiKey, [
    { role: "system", content: system },
    ...history,
  ]);
  return content;
}
