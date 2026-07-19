import "./style.css";
import { auth, db } from "./firebase.js";
import { getSharedApiKey, generateSuggestion } from "./ai.js";
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
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from "firebase/firestore";

const ENTRIES_COLLECTION = "entries";

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

// AI 成全建議對話框
const aiModal = document.getElementById("ai-modal");
const aiModalName = document.getElementById("ai-modal-name");
const aiGenerateBtn = document.getElementById("ai-generate-btn");
const aiLoading = document.getElementById("ai-loading");
const aiError = document.getElementById("ai-error");
const aiResult = document.getElementById("ai-result");
const aiResultStrategy = document.getElementById("ai-result-strategy");
const aiResultMethod = document.getElementById("ai-result-method");
const aiApplyBtn = document.getElementById("ai-apply-btn");
const aiCloseBtn = document.getElementById("ai-close-btn");

let allEntries = [];
let unsubscribeEntries = null;

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    currentUserLabel.textContent = user.email;
    subscribeEntries();
  } else {
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
    if (unsubscribeEntries) {
      unsubscribeEntries();
      unsubscribeEntries = null;
    }
    allEntries = [];
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
    entriesTbody.innerHTML = '<tr><td colspan="10" class="empty-text">尚無資料</td></tr>';
    return;
  }

  filtered.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(entry.name)}</td>
      <td>${escapeHtml(entry.department)}</td>
      <td>${escapeHtml(getBackground(entry))}</td>
      <td>${escapeHtml(entry.notes)}</td>
      <td>${escapeHtml(entry.contact)}</td>
      <td>${entry.status ? `<span class="status-badge">${escapeHtml(entry.status)}</span>` : ""}</td>
      <td>${escapeHtml(entry.strategy)}</td>
      <td>${escapeHtml(entry.method)}</td>
      <td>${renderActivitiesCell(entry.activities)}</td>
      <td class="row-actions">
        <button data-action="edit" data-id="${entry.id}" class="btn-secondary">編輯</button>
        <button data-action="activities" data-id="${entry.id}" class="btn-secondary">活動紀錄</button>
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

// 去識別化：只在把資料送給 AI 分析時遮罩姓名；系統顯示與資料庫儲存皆保留完整姓名。
// 王小明 → 王○明；王明 → 王○；歐陽小明 → 歐○○明；已含 ○ 的視為已遮罩，不重複處理。
function deidentifyName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed.includes("○")) return trimmed;
  const chars = [...trimmed];
  if (chars.length === 1) return trimmed;
  if (chars.length === 2) return chars[0] + "○";
  return chars[0] + "○".repeat(chars.length - 2) + chars[chars.length - 1];
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

// ---------- Modal open/close ----------
function openModal(entry = null) {
  entryForm.reset();
  if (entry) {
    modalTitle.textContent = "編輯名單";
    fieldId.value = entry.id;
    fieldName.value = entry.name || "";
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
  // 注意：activities 不在這裡處理，改由活動紀錄對話框獨立新增/編輯，
  // 這裡不能帶入這個欄位，否則 updateDoc 會把既有的活動紀錄整個蓋掉。
  const data = {
    name: fieldName.value.trim(),
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
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const entry = allEntries.find((en) => en.id === id);

  if (btn.dataset.action === "edit") {
    openModal(entry);
  } else if (btn.dataset.action === "activities") {
    openActivityModal(entry);
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

function openAiModal(entry) {
  aiModalEntryId = entry.id;
  aiLastSuggestion = null;
  aiModalName.textContent = entry.name || "";
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
    // 姓名、聯絡人只在送給 AI 分析時才去識別化；其餘欄位照常送出
    const suggestion = await generateSuggestion(apiKey, {
      name: deidentifyName(entry.name),
      department: entry.department,
      background: getBackground(entry),
      notes: entry.notes,
      contact: deidentifyName(entry.contact),
      status: entry.status,
      strategy: entry.strategy,
      method: entry.method,
      activities: entry.activities,
    });
    aiLastSuggestion = suggestion;
    aiResultStrategy.textContent = suggestion.strategy;
    aiResultMethod.textContent = suggestion.method;
    aiResult.classList.remove("hidden");
  } catch (err) {
    if (err?.status === 401) {
      aiError.textContent = "共用 API Key 無效或已過期，請管理員到 Firestore 的 config/ai 文件更新。";
    } else if (err?.status === 429) {
      aiError.textContent = "請求太頻繁或額度不足，請稍後再試。";
    } else {
      aiError.textContent = "產生建議失敗：" + (err?.message || err);
    }
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
