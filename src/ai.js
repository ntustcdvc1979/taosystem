import Anthropic from "@anthropic-ai/sdk";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";

// 共用的 API Key 存在 Firestore 的 config/ai 文件（欄位 anthropicApiKey），
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

const SYSTEM_PROMPT = `你是一位資深的一貫道校園成全前賢，熟悉如何依照每個人的背景、興趣與目前的成全狀況，規劃下一步的成全策略。

成全狀況的進程依序為：未求道 → 已求道 → 法會畢 → 新民班畢 → 至善班畢 → 行德班畢 → 崇德班畢 → 人才培訓班畢 → 講培班畢 → 講師。

使用者會提供一位成全對象的資料（姓名已去識別化）。請根據他的背景、目前狀況、過去參加活動的反應，提出：
1. 策略（strategy）：一句話的大方向，例如「讓他喜歡來上新民班」「先透過共同興趣建立信任感」。
2. 具體做法（method）：2-4 點可實際執行的行動，具體到可以直接照著做，例如邀約的話術方向、適合搭配的活動、由誰出面、頻率等。

原則：
- 從對方的背景與活動反應找切入點，不要泛泛而談。
- 尊重對方的步調，避免給人壓力；若過去反應冷淡，策略應以維繫關係為主。
- 建議的下一步要銜接目前的成全狀況（例如已求道者，下一步通常是研究班或法會）。
- 用臺灣慣用的繁體中文書寫。`;

/**
 * 產生成全建議。回傳 { strategy, method }。
 * @param {string} apiKey - 從 Firestore config/ai 取得的共用 API Key
 * @param {object} person - 已去識別化的對象資料
 */
export async function generateSuggestion(apiKey, person) {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true, // 純前端網站；key 由 Firestore 白名單規則保護
  });

  const activityLines = (person.activities || [])
    .map((a) => `- ${a.date ? a.date + " " : ""}${a.activity}：${a.reaction || "（未記錄反應）"}`)
    .join("\n");

  const userContent = `請為以下成全對象規劃策略與具體做法：

姓名（已去識別化）：${person.name || "（未填）"}
系級：${person.department || "（未填）"}
背景：${person.background || "（未填）"}
備註：${person.notes || "（未填）"}
目前成全狀況：${person.status || "（未填）"}
目前策略：${person.strategy || "（尚無）"}
目前做法：${person.method || "（尚無）"}
活動紀錄：
${activityLines || "（尚無活動紀錄）"}`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            strategy: {
              type: "string",
              description: "一句話的成全策略大方向",
            },
            method: {
              type: "string",
              description: "2-4 點具體可執行的做法，以換行分隔",
            },
          },
          required: ["strategy", "method"],
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
