import Anthropic from "@anthropic-ai/sdk";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";

// 共用的 Anthropic API Key 存在 Firestore 的 config/ai 文件（欄位 anthropicApiKey），
// 由 Firestore 安全規則的 Email 白名單保護：只有登入且在白名單內的人讀得到。
// Key 不寫在程式碼、不進 git、也不會出現在部署後的公開 JS 裡。
let cachedKey = null;

export async function getSharedApiKey() {
  if (cachedKey) return cachedKey;
  const snap = await getDoc(doc(db, "config", "ai"));
  const key = snap.exists() ? (snap.data().anthropicApiKey || "").trim() : "";
  if (key) cachedKey = key;
  return key;
}

const MODEL = "claude-opus-4-8";

const DOMAIN_CONTEXT = `你是一位資深的一貫道校園成全前賢，熟悉如何依照每個人的背景、興趣與目前的成全狀況，規劃下一步的成全策略。

成全狀況的進程依序為：未求道 → 已求道 → 法會畢 → 新民班畢 → 至善班畢 → 行德班畢 → 崇德班畢 → 人才培訓班畢 → 講培班畢 → 講師。

為保護隱私，名單中每個人的姓名與聯絡人都以「代號N」（例如 代號1、代號3）表示。請在回答中一律沿用相同的代號來指稱他們，不要更換代號、不要改寫成別的說法、也不要嘗試猜測真實姓名。

原則：
- 從對方的背景、活動反應與過去聊天成全的內容找切入點，不要泛泛而談。
- 留意乾坤（乾為男眾、坤為女眾），安排陪同、邀約或家訪時符合分際。
- 尊重對方的步調，避免給人壓力；若過去反應冷淡，策略應以維繫關係為主。
- 建議的下一步要銜接目前的成全狀況（例如已求道者，下一步通常是研究班或法會）。
- 用臺灣慣用的繁體中文書寫。`;

// 將對象資料整理成給模型看的文字（呼叫端需先完成去識別化 / 代號替換）
function formatPerson(person) {
  const activityLines = (person.activities || [])
    .map((a) => `- ${a.date ? a.date + " " : ""}${a.activity}：${a.reaction || "（未記錄反應）"}`)
    .join("\n");

  const talkLines = (person.talks || [])
    .map((t) => `- ${t.date ? t.date + " " : ""}${t.content}`)
    .join("\n");

  return `姓名代號：${person.name || "（未填）"}
性別（乾/坤）：${person.gender || "（未填）"}
系級：${person.department || "（未填）"}
標籤：${(person.tags || []).join("、") || "（無）"}
背景：${person.background || "（未填）"}
聯絡人代號：${person.contact || "（未填）"}
目前成全狀況：${person.status || "（未填）"}
目前策略：${person.strategy || "（尚無）"}
目前做法：${person.method || "（尚無）"}
活動紀錄：
${activityLines || "（尚無活動紀錄）"}
聊天成全紀錄：
${talkLines || "（尚無聊天紀錄）"}`;
}

// 近期活動清單（活動管理頁維護），依日期排序
function formatEvents(events) {
  if (!events || events.length === 0) return "（近期沒有已登錄的活動）";
  return events
    .map((e) => `- ${e.date || "日期未定"}【${e.type || "未分類"}】${e.name}`)
    .join("\n");
}

function makeClient(apiKey) {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true, // 純前端網站；key 由 Firestore 白名單規則保護
  });
}

/**
 * 針對單一對象產生成全建議。回傳 { strategy, method, recommendedActivity }（可能含代號，由呼叫端還原）。
 * @param {string} apiKey - 從 Firestore config/ai 取得的共用 Anthropic API Key
 * @param {object} person - 已做代號替換的對象資料
 * @param {string} guidance - 使用者提供的方向（已做代號替換），可為空
 * @param {object[]} events - 近期活動（name/date/type），可為空陣列
 */
export async function generateSuggestion(apiKey, person, guidance = "", events = []) {
  const client = makeClient(apiKey);

  const system = `${DOMAIN_CONTEXT}

近期活動（依日期排序）：
${formatEvents(events)}

使用者會提供一位成全對象的資料，可能附上他希望的策略方向。請提出：
1. strategy：一句話的成全策略大方向，例如「讓他喜歡來上新民班」。若使用者已提供方向，以他的方向為主軸，幫他修飾得更精準。
2. method：2-4 點可實際執行的做法，具體到可以直接照著做，例如邀約的話術方向、適合搭配的活動、由誰出面、頻率等，以換行分隔。
3. recommendedActivity：從上面的近期活動中挑選最適合這位對象目前狀況的「一個」活動，填「日期 活動名稱」；若近期沒有合適的活動就填空字串。活動類型與適合對象：廣結善緣＝接觸初期、未求道或反應冷淡者，先建立關係；求道＝已建立關係、時機成熟的未求道者參加求道禮；成全求道＝已求道者深化的研究班；法會＝已求道、關係穩定者；幹訓＝較資深、班程有基礎、有心承擔的人才。做法（method）中請一併說明如何鋪陳邀約這個活動。`;

  const user = `請為以下成全對象規劃策略與具體做法：

${formatPerson(person)}${guidance ? `\n\n我希望的策略方向：${guidance}` : ""}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            strategy: { type: "string", description: "一句話的成全策略大方向" },
            method: { type: "string", description: "2-4 點具體可執行的做法，以換行分隔" },
            recommendedActivity: {
              type: "string",
              description: "從近期活動挑選的推薦活動，格式「日期 活動名稱」；無合適活動則為空字串",
            },
          },
          required: ["strategy", "method", "recommendedActivity"],
          additionalProperties: false,
        },
      },
    },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("AI 拒絕了這個請求，請調整資料內容後再試。");
  }

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return JSON.parse(text);
}

/**
 * 全名單 AI Agent 聊天。回傳 assistant 的回覆文字（可能含代號，由呼叫端還原）。
 * @param {string} apiKey - 共用 Anthropic API Key
 * @param {object[]} roster - 已做代號替換的全部名單
 * @param {{role: string, content: string}[]} history - 聊天歷史（已做代號替換，含最新一則 user 訊息）
 * @param {object[]} events - 近期活動（name/date/type），可為空陣列
 */
export async function chatWithAgent(apiKey, roster, history, events = []) {
  const client = makeClient(apiKey);

  const rosterText = roster
    .map((p, i) => `【第 ${i + 1} 位】\n${formatPerson(p)}`)
    .join("\n\n");

  const system = `${DOMAIN_CONTEXT}

以下是目前的成全名單（共 ${roster.length} 位）：

${rosterText || "（目前名單是空的）"}

近期活動（依日期排序）：
${formatEvents(events)}

使用者是負責成全的同修，會向你詢問名單相關的建議（例如：誰適合邀約參加法會、某位對象下一步怎麼做、整體優先順序等）。請根據名單內容給出具體、可執行的建議；規劃時參照近期活動——依對象目前的狀況建議適合參加哪個活動、如何鋪陳邀約（廣結善緣＝接觸初期或反應冷淡者；求道＝時機成熟的未求道者；成全求道＝已求道者的研究班；法會＝已求道、關係穩定者；幹訓＝較資深、有心承擔者）。回答保持精簡，不要長篇大論。記得一律用代號指稱名單上的人。`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system,
    messages: history,
  });

  if (response.stop_reason === "refusal") {
    throw new Error("AI 拒絕了這個請求，請換個問法再試。");
  }

  return response.content.find((b) => b.type === "text")?.text ?? "";
}
