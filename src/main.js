import "./style.css";
import { auth, db } from "./firebase.js";
import { getSharedApiKey, generateSuggestion, chatWithAgent } from "./ai.js";
import {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from "firebase/firestore";

const ENTRIES_COLLECTION = "entries";
const CHAT_COLLECTION = "chatHistories"; // 每位使用者一份，文件 ID = 使用者 uid

// ---------- DOM refs ----------
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const googleLoginBtn = document.getElementById("google-login-btn");
const loginError = document.getElementById("login-error");
const currentUserLabel = document.getElementById("current-user");
const logoutBtn = document.getElementById("logout-btn");

const searchInput = document.getElementById("search-input");
const filterStatus = document.getElementById("filter-status");
const addEntryBtn = document.getElementById("add-entry-btn");
const entriesTbody = document.getElementById("entries-tbody");

const entryModal = document.getElementById("entry-modal");
const entryForm = document.getElementById("entry-form");
const modalTitle = document.getElementById("modal-title");
const cancelBtn = document.getElementById("cancel-btn");

const fieldId = document.getElementById("entry-id");
const fieldName = document.getElementById("field-name");
const fieldGender = document.getElementById("field-gender");
const fieldDepartment = document.getElementById("field-department");
const fieldBackground = document.getElementById("field-background");
const fieldNotes = document.getElementById("field-notes");
const fieldContact = document.getElementById("field-contact");
const fieldStatus = document.getElementById("field-status");
const fieldStrategy = document.getElementById("field-strategy");
const fieldMethod = document.getElementById("field-method");

// 活動紀錄對話框（每個人獨立管理）
const activityModal = document.getElementById("activity-modal");
const activityModalName = document.getElementById("activity-modal-name");
const activitiesList = document.getElementById("activities-list");
const activitiesEmptyHint = document.getElementById("activities-empty-hint");
const newActName = document.getElementById("new-act-name");
const newActDate = document.getElementById("new-act-date");
const newActReaction = document.getElementById("new-act-reaction");
const addActivityBtn = document.getElementById("add-activity-btn");
const activityCloseBtn = document.getElementById("activity-close-btn");

// 聊天成全紀錄對話框（每個人獨立管理）
const talkModal = document.getElementById("talk-modal");
const talkModalName = document.getElementById("talk-modal-name");
const talksList = document.getElementById("talks-list");
const talksEmptyHint = document.getElementById("talks-empty-hint");
const newTalkDate = document.getElementById("new-talk-date");
const newTalkContent = document.getElementById("new-talk-content");
const addTalkBtn = document.getElementById("add-talk-btn");
const talkCloseBtn = document.getElementById("talk-close-btn");

// AI 成全建議對話框
const aiModal = document.getElementById("ai-modal");
const aiModalName = document.getElementById("ai-modal-name");
const aiGuidance = document.getElementById("ai-guidance");
const aiGenerateBtn = document.getElementById("ai-generate-btn");
const aiLoading = document.getElementById("ai-loading");
const aiError = document.getElementById("ai-error");
const aiResult = document.getElementById("ai-result");
const aiResultStrategy = document.getElementById("ai-result-strategy");
const aiResultMethod = document.getElementById("ai-result-method");
const aiApplyBtn = document.getElementById("ai-apply-btn");
const aiCloseBtn = document.getElementById("ai-close-btn");

// AI Agent 聊天室
const chatFab = document.getElementById("chat-fab");
const chatPanel = document.getElementById("chat-panel");
const chatMessages = document.getElementById("chat-messages");
const chatError = document.getElementById("chat-error");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatClearBtn = document.getElementById("chat-clear-btn");
const chatCloseBtn = document.getElementById("chat-close-btn");

let allEntries = [];
let unsubscribeEntries = null;

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    currentUserLabel.textContent = user.email;
    chatFab.classList.remove("hidden");
    subscribeEntries();
    loadChatHistory();
  } else {
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
    chatFab.classList.add("hidden");
    chatPanel.classList.add("hidden");
    if (unsubscribeEntries) {
      unsubscribeEntries();
      unsubscribeEntries = null;
    }
    allEntries = [];
    chatHistory = [];
  }
});

const googleProvider = new GoogleAuthProvider();

googleLoginBtn.addEventListener("click", async () => {
  loginError.textContent = "";
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user") return;
    if (err.code === "permission-denied") {
      loginError.textContent = "此 Google 帳號沒有存取權限，請聯絡管理員。";
    } else {
      loginError.textContent = "登入失敗：" + err.message;
    }
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

// ---------- Firestore subscription ----------
function subscribeEntries() {
  const q = query(collection(db, ENTRIES_COLLECTION), orderBy("createdAt", "desc"));
  unsubscribeEntries = onSnapshot(
    q,
    (snapshot) => {
      allEntries = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTable();
      refreshOpenActivityModal();
      refreshOpenTalkModal();
    },
    (err) => {
      // 通常是這個 Google 帳號不在白名單內，被 Firestore 規則擋下
      if (err.code === "permission-denied") {
        loginError.textContent =
          "此 Google 帳號沒有存取權限，請聯絡管理員將你的 Email 加入白名單。";
        signOut(auth);
      } else {
        console.error(err);
      }
    }
  );
}

// ---------- Render ----------
function renderTable() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const statusVal = filterStatus.value;

  const filtered = allEntries.filter((entry) => {
    if (statusVal && entry.status !== statusVal) return false;
    if (searchTerm) {
      const haystack = [entry.name, entry.department, getBackground(entry), entry.contact]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  entriesTbody.innerHTML = "";

  if (filtered.length === 0) {
    entriesTbody.innerHTML = '<tr><td colspan="12" class="empty-text">尚無資料</td></tr>';
    return;
  }

  // 長文字欄位包進可收合容器：預設只顯示前幾行，點一下展開/收合
  const clamp = (html) =>
    html ? `<div class="cell-clamp" title="點一下展開／收合">${html}</div>` : "";

  filtered.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(entry.name)}</td>
      <td>${escapeHtml(entry.gender)}</td>
      <td>${escapeHtml(entry.department)}</td>
      <td>${clamp(escapeHtml(getBackground(entry)))}</td>
      <td>${clamp(escapeHtml(entry.notes))}</td>
      <td>${escapeHtml(entry.contact)}</td>
      <td>${entry.status ? `<span class="status-badge">${escapeHtml(entry.status)}</span>` : ""}</td>
      <td>${clamp(escapeHtml(entry.strategy))}</td>
      <td>${clamp(escapeHtml(entry.method))}</td>
      <td>${clamp(renderActivitiesCell(entry.activities))}</td>
      <td>${clamp(renderTalksCell(entry.talks))}</td>
      <td class="row-actions">
        <button data-action="edit" data-id="${entry.id}" class="btn-secondary">編輯</button>
        <button data-action="activities" data-id="${entry.id}" class="btn-secondary">活動紀錄</button>
        <button data-action="talks" data-id="${entry.id}" class="btn-secondary">聊天紀錄</button>
        <button data-action="ai" data-id="${entry.id}" class="btn-secondary">AI 建議</button>
        <button data-action="delete" data-id="${entry.id}" class="btn-danger">刪除</button>
      </td>
    `;
    entriesTbody.appendChild(tr);
  });
}

// 相容舊資料：以前欄位叫 channel，現在叫 background
function getBackground(entry) {
  return entry.background ?? entry.channel ?? "";
}

// ===== 去識別化：可還原的代號對應 =====
// 送給 AI 前，把名單上出現的姓名/聯絡人換成中性代號（代號1、代號2…），完全看不出是誰；
// AI 回覆後，再依同一份對照表把代號換回真名顯示。系統畫面與資料庫永遠保留真名。
//
// buildNameMap 依目前名單建立兩份對照表：
//   forward：真名/簡稱 → 代號（送 AI 前用，同一人的各種寫法都對到同一個代號）
//   reverse：代號 → 完整姓名（AI 回覆後還原用，一律還原成完整姓名）
// 背景、備註等自由文字裡提到名單上的人時，也會靠這份對照表一併換成代號。
function buildNameMap() {
  const forward = new Map();
  const reverse = new Map();
  let counter = 0;

  const register = (raw) => {
    const full = (raw || "").trim();
    if (!full || forward.has(full)) return;
    counter += 1;
    const pseudo = `代號${counter}`;
    forward.set(full, pseudo);
    reverse.set(pseudo, full); // 還原時用完整姓名

    // 含分隔符號的視為多人欄位（例：「張三、李四」），不推導簡稱，交給下面逐一拆開處理
    if (/[、,，/／;；\s]/.test(full)) return;

    // 簡稱：背景常只寫名字不寫姓（王小明 → 小明、歐陽小明 → 小明），
    // 三個字以上才推導，兩個字的名字去掉姓只剩一個字，會誤蓋到一般用字。
    const chars = [...full];
    if (chars.length >= 3) {
      const given = chars.slice(-2).join("");
      if (!forward.has(given)) forward.set(given, pseudo);
    }
  };

  // 一個欄位可能寫了多個名字（例：聯絡人「張三、李四」），整串與拆開的每個名字都要建立對應
  const registerField = (raw) => {
    const value = (raw || "").trim();
    if (!value) return;
    register(value);
    value
      .split(/[、,，/／;；\s]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && part !== value)
      .forEach(register);
  };

  allEntries.forEach((entry) => {
    registerField(entry.name);
    registerField(entry.contact);
  });
  return { forward, reverse };
}

// 真名 → 代號。先換較長的名字，避免「王」誤蓋到「王小明」的一部分。
function maskNames(text, forward) {
  if (!text) return text;
  const pairs = [...forward.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = text;
  for (const [real, pseudo] of pairs) result = result.split(real).join(pseudo);
  return result;
}

// 代號 → 完整姓名。先換較長的代號（代號12 先於 代號1），避免前綴誤蓋。
function unmaskNames(text, reverse) {
  if (!text) return text;
  const pairs = [...reverse.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = text;
  for (const [pseudo, real] of pairs) result = result.split(pseudo).join(real);
  return result;
}

// 把單一對象的所有文字欄位做代號替換（送 AI 前用）
function maskEntry(entry, forward) {
  return {
    name: maskNames(entry.name, forward),
    gender: entry.gender,
    department: maskNames(entry.department, forward),
    background: maskNames(getBackground(entry), forward),
    notes: maskNames(entry.notes, forward),
    contact: maskNames(entry.contact, forward),
    status: entry.status,
    strategy: maskNames(entry.strategy, forward),
    method: maskNames(entry.method, forward),
    activities: (entry.activities || []).map((a) => ({
      ...a,
      activity: maskNames(a.activity, forward),
      reaction: maskNames(a.reaction, forward),
    })),
    talks: (entry.talks || []).map((t) => ({
      ...t,
      content: maskNames(t.content, forward),
    })),
  };
}

// 表格內顯示活動紀錄：每筆一行，「活動：反應」
function renderActivitiesCell(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return "";
  return activities
    .map((a) => {
      const act = escapeHtml(a.activity);
      const reaction = escapeHtml(a.reaction);
      const date = a.date ? `<span class="act-date">${escapeHtml(a.date)}</span> ` : "";
      const body = reaction ? `${act}：${reaction}` : act;
      return `<div class="act-item">${date}${body}</div>`;
    })
    .join("");
}

// 表格內顯示聊天成全紀錄：每筆一行，「日期 內容」
function renderTalksCell(talks) {
  if (!Array.isArray(talks) || talks.length === 0) return "";
  return talks
    .map((t) => {
      const date = t.date ? `<span class="act-date">${escapeHtml(t.date)}</span> ` : "";
      return `<div class="act-item">${date}${escapeHtml(t.content)}</div>`;
    })
    .join("");
}

function escapeHtml(value) {
  if (!value) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

searchInput.addEventListener("input", renderTable);
filterStatus.addEventListener("change", renderTable);

// ---------- 活動紀錄對話框（每個人獨立新增/編輯，與新增名單表單分開） ----------
let activityModalEntryId = null;
let activityModalActivities = [];

function openActivityModal(entry) {
  activityModalEntryId = entry.id;
  activityModalActivities = (entry.activities || []).map((a) => ({ ...a }));
  activityModalName.textContent = entry.name || "";
  newActName.value = "";
  newActDate.value = "";
  newActReaction.value = "";
  renderActivityModalList();
  activityModal.classList.remove("hidden");
}

function closeActivityModal() {
  activityModal.classList.add("hidden");
  activityModalEntryId = null;
}

// 若目前開著某人的活動紀錄視窗，其他人（或自己另一分頁）更新資料時，同步刷新畫面
function refreshOpenActivityModal() {
  if (!activityModalEntryId) return;
  const entry = allEntries.find((en) => en.id === activityModalEntryId);
  if (!entry) return;
  activityModalActivities = (entry.activities || []).map((a) => ({ ...a }));
  renderActivityModalList();
}

function renderActivityModalList() {
  activitiesList.innerHTML = "";
  activitiesEmptyHint.classList.toggle("hidden", activityModalActivities.length > 0);

  activityModalActivities.forEach((a, index) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <input type="text" class="act-field-name" placeholder="活動名稱" />
      <input type="text" class="act-field-date" placeholder="日期(選填)" />
      <input type="text" class="act-field-reaction" placeholder="反應 / 回饋" />
      <button type="button" class="btn-secondary btn-small act-save">儲存</button>
      <button type="button" class="btn-danger btn-small act-delete">刪除</button>
    `;
    row.querySelector(".act-field-name").value = a.activity || "";
    row.querySelector(".act-field-date").value = a.date || "";
    row.querySelector(".act-field-reaction").value = a.reaction || "";
    activitiesList.appendChild(row);
  });
}

async function persistActivities() {
  try {
    await updateDoc(doc(db, ENTRIES_COLLECTION, activityModalEntryId), {
      activities: activityModalActivities,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    alert("儲存活動紀錄失敗：" + err.message);
  }
}

activitiesList.addEventListener("click", async (e) => {
  const row = e.target.closest(".activity-row");
  if (!row) return;
  const index = Number(row.dataset.index);

  if (e.target.closest(".act-save")) {
    activityModalActivities[index] = {
      activity: row.querySelector(".act-field-name").value.trim(),
      date: row.querySelector(".act-field-date").value.trim(),
      reaction: row.querySelector(".act-field-reaction").value.trim(),
    };
    await persistActivities();
  } else if (e.target.closest(".act-delete")) {
    activityModalActivities.splice(index, 1);
    renderActivityModalList();
    await persistActivities();
  }
});

addActivityBtn.addEventListener("click", async () => {
  const activity = newActName.value.trim();
  if (!activity) {
    newActName.focus();
    return;
  }
  activityModalActivities.push({
    activity,
    date: newActDate.value.trim(),
    reaction: newActReaction.value.trim(),
  });
  newActName.value = "";
  newActDate.value = "";
  newActReaction.value = "";
  renderActivityModalList();
  await persistActivities();
});

activityCloseBtn.addEventListener("click", closeActivityModal);
activityModal.addEventListener("click", (e) => {
  if (e.target === activityModal) closeActivityModal();
});

// ---------- 聊天成全紀錄對話框（每個人獨立新增/編輯） ----------
let talkModalEntryId = null;
let talkModalTalks = [];

function openTalkModal(entry) {
  talkModalEntryId = entry.id;
  talkModalTalks = (entry.talks || []).map((t) => ({ ...t }));
  talkModalName.textContent = entry.name || "";
  newTalkDate.value = "";
  newTalkContent.value = "";
  renderTalkModalList();
  talkModal.classList.remove("hidden");
}

function closeTalkModal() {
  talkModal.classList.add("hidden");
  talkModalEntryId = null;
}

// 其他人（或自己另一分頁）更新資料時，同步刷新開著的視窗
function refreshOpenTalkModal() {
  if (!talkModalEntryId) return;
  const entry = allEntries.find((en) => en.id === talkModalEntryId);
  if (!entry) return;
  talkModalTalks = (entry.talks || []).map((t) => ({ ...t }));
  renderTalkModalList();
}

function renderTalkModalList() {
  talksList.innerHTML = "";
  talksEmptyHint.classList.toggle("hidden", talkModalTalks.length > 0);

  talkModalTalks.forEach((t, index) => {
    const row = document.createElement("div");
    row.className = "talk-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <input type="text" class="talk-field-date" placeholder="日期" />
      <input type="text" class="talk-field-content" placeholder="聊了什麼、對方的反應" />
      <button type="button" class="btn-secondary btn-small talk-save">儲存</button>
      <button type="button" class="btn-danger btn-small talk-delete">刪除</button>
    `;
    row.querySelector(".talk-field-date").value = t.date || "";
    row.querySelector(".talk-field-content").value = t.content || "";
    talksList.appendChild(row);
  });
}

async function persistTalks() {
  try {
    await updateDoc(doc(db, ENTRIES_COLLECTION, talkModalEntryId), {
      talks: talkModalTalks,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    alert("儲存聊天紀錄失敗：" + err.message);
  }
}

talksList.addEventListener("click", async (e) => {
  const row = e.target.closest(".talk-row");
  if (!row) return;
  const index = Number(row.dataset.index);

  if (e.target.closest(".talk-save")) {
    talkModalTalks[index] = {
      date: row.querySelector(".talk-field-date").value.trim(),
      content: row.querySelector(".talk-field-content").value.trim(),
    };
    await persistTalks();
  } else if (e.target.closest(".talk-delete")) {
    talkModalTalks.splice(index, 1);
    renderTalkModalList();
    await persistTalks();
  }
});

addTalkBtn.addEventListener("click", async () => {
  const content = newTalkContent.value.trim();
  if (!content) {
    newTalkContent.focus();
    return;
  }
  talkModalTalks.push({ date: newTalkDate.value.trim(), content });
  newTalkDate.value = "";
  newTalkContent.value = "";
  renderTalkModalList();
  await persistTalks();
});

talkCloseBtn.addEventListener("click", closeTalkModal);
talkModal.addEventListener("click", (e) => {
  if (e.target === talkModal) closeTalkModal();
});

// ---------- Modal open/close ----------
function openModal(entry = null) {
  entryForm.reset();
  if (entry) {
    modalTitle.textContent = "編輯名單";
    fieldId.value = entry.id;
    fieldName.value = entry.name || "";
    fieldGender.value = entry.gender || "";
    fieldDepartment.value = entry.department || "";
    fieldBackground.value = getBackground(entry);
    fieldNotes.value = entry.notes || "";
    fieldContact.value = entry.contact || "";
    fieldStatus.value = entry.status || "";
    fieldStrategy.value = entry.strategy || "";
    fieldMethod.value = entry.method || "";
  } else {
    modalTitle.textContent = "新增名單";
    fieldId.value = "";
  }
  entryModal.classList.remove("hidden");
  fieldName.focus();
}

function closeModal() {
  entryModal.classList.add("hidden");
}

addEntryBtn.addEventListener("click", () => openModal());
cancelBtn.addEventListener("click", closeModal);
entryModal.addEventListener("click", (e) => {
  if (e.target === entryModal) closeModal();
});

// ---------- Create / Update / Delete ----------
entryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  // 注意：activities / talks 不在這裡處理，改由各自的對話框獨立新增/編輯，
  // 這裡不能帶入這些欄位，否則 updateDoc 會把既有紀錄整個蓋掉。
  const data = {
    name: fieldName.value.trim(),
    gender: fieldGender.value,
    department: fieldDepartment.value.trim(),
    background: fieldBackground.value.trim(),
    notes: fieldNotes.value.trim(),
    contact: fieldContact.value.trim(),
    status: fieldStatus.value,
    strategy: fieldStrategy.value.trim(),
    method: fieldMethod.value.trim(),
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.email || null,
  };

  const id = fieldId.value;
  try {
    if (id) {
      await updateDoc(doc(db, ENTRIES_COLLECTION, id), data);
    } else {
      await addDoc(collection(db, ENTRIES_COLLECTION), {
        ...data,
        activities: [],
        talks: [],
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser?.email || null,
      });
    }
    closeModal();
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
});

entriesTbody.addEventListener("click", async (e) => {
  // 點長文字儲存格：展開/收合
  const clampEl = e.target.closest(".cell-clamp");
  if (clampEl) {
    clampEl.classList.toggle("expanded");
    return;
  }

  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const entry = allEntries.find((en) => en.id === id);

  if (btn.dataset.action === "edit") {
    openModal(entry);
  } else if (btn.dataset.action === "activities") {
    openActivityModal(entry);
  } else if (btn.dataset.action === "talks") {
    openTalkModal(entry);
  } else if (btn.dataset.action === "ai") {
    openAiModal(entry);
  } else if (btn.dataset.action === "delete") {
    if (confirm(`確定要刪除「${entry.name}」的資料嗎？此動作無法復原。`)) {
      try {
        await deleteDoc(doc(db, ENTRIES_COLLECTION, id));
      } catch (err) {
        alert("刪除失敗：" + err.message);
      }
    }
  }
});

// ---------- AI 成全建議 ----------
let aiModalEntryId = null;
let aiLastSuggestion = null;

function aiErrorMessage(err, prefix) {
  if (err?.status === 401) {
    return "共用 API Key 無效或已過期，請管理員到 Firestore 的 config/ai 文件更新 anthropicApiKey。";
  }
  if (err?.status === 400 && /credit|balance/i.test(err?.message || "")) {
    return "Anthropic 帳戶額度不足，請管理員到 console.anthropic.com 儲值。";
  }
  if (err?.status === 429) {
    return "請求太頻繁或額度不足，請稍後再試。";
  }
  return `${prefix}：` + (err?.message || err);
}

function openAiModal(entry) {
  aiModalEntryId = entry.id;
  aiLastSuggestion = null;
  aiModalName.textContent = entry.name || "";
  aiGuidance.value = entry.strategy || ""; // 預設帶入目前的一句話策略方向，可自行修改
  aiError.textContent = "";
  aiResult.classList.add("hidden");
  aiLoading.classList.add("hidden");
  aiGenerateBtn.disabled = false;
  aiModal.classList.remove("hidden");
}

function closeAiModal() {
  aiModal.classList.add("hidden");
  aiModalEntryId = null;
}

aiGenerateBtn.addEventListener("click", async () => {
  const entry = allEntries.find((en) => en.id === aiModalEntryId);
  if (!entry) return;

  aiError.textContent = "";
  aiResult.classList.add("hidden");
  aiLoading.classList.remove("hidden");
  aiGenerateBtn.disabled = true;

  try {
    // 共用 Key 存在 Firestore config/ai，由白名單規則保護
    const apiKey = await getSharedApiKey();
    if (!apiKey) {
      throw new Error(
        "尚未設定共用 API Key。請管理員到 Firebase Console 的 Firestore 建立 config 集合下的 ai 文件，欄位 anthropicApiKey 填入 Key（詳見 README）。"
      );
    }
    // 送 AI 前把姓名/聯絡人（含背景、備註等欄位裡提到的名單成員）換成代號；AI 回覆後再換回真名
    const { forward, reverse } = buildNameMap();
    const suggestion = await generateSuggestion(
      apiKey,
      maskEntry(entry, forward),
      maskNames(aiGuidance.value.trim(), forward)
    );
    aiLastSuggestion = {
      strategy: unmaskNames(suggestion.strategy, reverse),
      method: unmaskNames(suggestion.method, reverse),
    };
    aiResultStrategy.textContent = aiLastSuggestion.strategy;
    aiResultMethod.textContent = aiLastSuggestion.method;
    aiResult.classList.remove("hidden");
  } catch (err) {
    aiError.textContent = aiErrorMessage(err, "產生建議失敗");
  } finally {
    aiLoading.classList.add("hidden");
    aiGenerateBtn.disabled = false;
  }
});

aiApplyBtn.addEventListener("click", async () => {
  if (!aiLastSuggestion || !aiModalEntryId) return;
  try {
    await updateDoc(doc(db, ENTRIES_COLLECTION, aiModalEntryId), {
      strategy: aiLastSuggestion.strategy,
      method: aiLastSuggestion.method,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
    closeAiModal();
  } catch (err) {
    aiError.textContent = "套用失敗：" + err.message;
  }
});

aiCloseBtn.addEventListener("click", closeAiModal);
aiModal.addEventListener("click", (e) => {
  if (e.target === aiModal) closeAiModal();
});

// ---------- AI Agent 聊天室（可看到整份去識別化名單） ----------
// 對話紀錄存在 Firestore 的 chatHistories/{uid}，每位使用者一份、只有本人讀得到，
// 重新整理或換裝置都還在。內容以真名保存（與名單同等級的資料，受同一份白名單規則保護）。
let chatHistory = [];
let chatBusy = false;

async function loadChatHistory() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const snap = await getDoc(doc(db, CHAT_COLLECTION, uid));
    chatHistory = snap.exists() ? snap.data().messages || [] : [];
  } catch (err) {
    console.error(err);
    chatHistory = [];
  }
  renderChat();
}

async function saveChatHistory() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await setDoc(doc(db, CHAT_COLLECTION, uid), {
      messages: chatHistory,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    console.error(err);
  }
}

function renderChat() {
  chatMessages.innerHTML =
    '<div class="chat-msg chat-msg-assistant">你好！我能看到整份成全名單，可以問我：誰適合邀約參加法會、某位對象下一步怎麼做、整體的優先順序建議等等。</div>';
  chatHistory.forEach((m) => {
    const div = document.createElement("div");
    div.className = m.role === "user" ? "chat-msg chat-msg-user" : "chat-msg chat-msg-assistant";
    div.textContent = m.content;
    chatMessages.appendChild(div);
  });
  if (chatBusy) {
    const typing = document.createElement("div");
    typing.className = "chat-msg chat-msg-assistant chat-typing";
    typing.textContent = "思考中...";
    chatMessages.appendChild(typing);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChatMessage() {
  const raw = chatInput.value.trim();
  if (!raw || chatBusy) return;

  chatError.textContent = "";
  // 聊天紀錄以「真名」保存並顯示；送 API 時才整份換成代號，AI 回覆再換回真名。
  chatHistory.push({ role: "user", content: raw });
  chatInput.value = "";
  chatBusy = true;
  chatSendBtn.disabled = true;
  renderChat();

  try {
    const apiKey = await getSharedApiKey();
    if (!apiKey) {
      throw new Error(
        "尚未設定共用 API Key。請管理員到 Firebase Console 的 Firestore 建立 config 集合下的 ai 文件，欄位 anthropicApiKey 填入 Key（詳見 README）。"
      );
    }
    const { forward, reverse } = buildNameMap();
    const roster = allEntries.map((entry) => maskEntry(entry, forward));
    const apiHistory = chatHistory.map((m) => ({
      role: m.role,
      content: maskNames(m.content, forward),
    }));
    const reply = await chatWithAgent(apiKey, roster, apiHistory);
    chatHistory.push({ role: "assistant", content: unmaskNames(reply, reverse) });
    await saveChatHistory();
  } catch (err) {
    chatHistory.pop(); // 失敗時移除剛送出的訊息，讓使用者修正後重送
    chatInput.value = raw;
    chatError.textContent = aiErrorMessage(err, "傳送失敗");
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    renderChat();
    chatInput.focus();
  }
}

chatFab.addEventListener("click", () => {
  chatPanel.classList.toggle("hidden");
  if (!chatPanel.classList.contains("hidden")) chatInput.focus();
});
chatCloseBtn.addEventListener("click", () => chatPanel.classList.add("hidden"));
chatClearBtn.addEventListener("click", async () => {
  chatHistory = [];
  chatError.textContent = "";
  renderChat();
  await saveChatHistory();
});
chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) sendChatMessage();
});
