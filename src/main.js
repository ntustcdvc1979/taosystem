import "./style.css";
import { handleInAppBrowser } from "./inapp.js";
import { createTagEditor } from "./tageditor.js";
import { auth, db } from "./firebase.js";
import {
  getSharedApiKey,
  generateSuggestion,
  chatWithAgent,
  suggestInvitees,
  assessHeat,
} from "./ai.js";
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
  where,
  orderBy,
} from "firebase/firestore";

// 從 LINE 等 App 內建瀏覽器點進來的話，先想辦法轉到系統瀏覽器（Google 登入不接受內建瀏覽器）
handleInAppBrowser();

// 資料一律放在自己道務單位底下（units/{unitId}/…），路徑本身就是隔離邊界：
// 查詢天然只看得到自己單位的資料，不會出現「規則擋得住但查詢整批失敗」的問題。
const ENTRIES_COLLECTION = "entries";
const PERSONAL_COLLECTION = "personalEntries"; // 個人名單，只有建立者本人看得到
const CHAT_COLLECTION = "chatHistories"; // 每位使用者一份，文件 ID = 使用者 uid
const EVENTS_COLLECTION = "events"; // 近期活動（名稱、日期、類型）
const LINKS_COLLECTION = "memberLinks"; // 帳號 ↔ 名單對應

let myUnitId = null;
let myUnitName = "";
let myEntryId = null; // 這支帳號綁定到名單中的哪一位
let iAmLeader = false; // 道務組組長，可以增減本單位的使用者

// units/{unitId}/{name} 的集合參考
function unitCol(name) {
  return collection(db, "units", myUnitId, name);
}
function unitDoc(name, id) {
  return doc(db, "units", myUnitId, name, id);
}

// ---------- DOM refs ----------
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const googleLoginBtn = document.getElementById("google-login-btn");
const loginError = document.getElementById("login-error");
const currentUserLabel = document.getElementById("current-user");
const logoutBtn = document.getElementById("logout-btn");

const searchInput = document.getElementById("search-input");
const filterStatus = document.getElementById("filter-status");
const filterScope = document.getElementById("filter-scope");
const unitNameLabel = document.getElementById("unit-name");
const bindMeBtn = document.getElementById("bind-me-btn");

// 趨勢分析
const trendBtn = document.getElementById("trend-btn");
const trendModal = document.getElementById("trend-modal");
const trendCloseBtn = document.getElementById("trend-close-btn");
const trendRange = document.getElementById("trend-range");
const trendStep = document.getElementById("trend-step");
const trendCharts = document.getElementById("trend-charts");
const trendTagFilterList = document.getElementById("trend-tag-filter");
const trendDetail = document.getElementById("trend-detail");
const trendDetailTitle = document.getElementById("trend-detail-title");
const trendDetailClose = document.getElementById("trend-detail-close");
const trendDetailList = document.getElementById("trend-detail-list");
const trendDetailStatus = document.getElementById("trend-detail-status");
const trendSelectAll = document.getElementById("trend-select-all");
const trendSelectNone = document.getElementById("trend-select-none");
const trendTagInput = createTagEditor(document.getElementById("trend-tag-input"), {
  suggest: () => knownTags(),
  placeholder: "要加上的標籤，例：需關心",
});
const trendTagBtn = document.getElementById("trend-tag-btn");

// 使用者管理（只有道務組組長看得到）
const membersBtn = document.getElementById("members-btn");
const membersModal = document.getElementById("members-modal");
const membersCloseBtn = document.getElementById("members-close-btn");
const membersUnitName = document.getElementById("members-unit-name");
const membersList = document.getElementById("members-list");
const membersStatus = document.getElementById("members-status");
const newMemberEmail = document.getElementById("new-member-email");
const addMemberBtn = document.getElementById("add-member-btn");

// 綁定自己的對話框
const bindModal = document.getElementById("bind-modal");
const bindSearch = document.getElementById("bind-search");
const bindResults = document.getElementById("bind-results");
const bindStatus = document.getElementById("bind-status");
const bindCloseBtn = document.getElementById("bind-close-btn");
const toggleViewBtn = document.getElementById("toggle-view-btn");
const aiHeatBtn = document.getElementById("ai-heat-btn");
aiHeatBtn.classList.remove("hidden"); // 預設就是熱度模式
const tagFilterBtn = document.getElementById("tag-filter-btn");
const tagFilterPanel = document.getElementById("tag-filter-panel");
const tagFilterList = document.getElementById("tag-filter-list");
const tagFilterAll = document.getElementById("tag-filter-all");

// 成全熱度對話框
const heatModal = document.getElementById("heat-modal");
const heatModalName = document.getElementById("heat-modal-name");
const heatModalCurrent = document.getElementById("heat-modal-current");
const heatOptions = document.getElementById("heat-options");
const heatModalReason = document.getElementById("heat-modal-reason");
const heatAiOneBtn = document.getElementById("heat-ai-one-btn");
const heatModalStatus = document.getElementById("heat-modal-status");
const heatCloseBtn = document.getElementById("heat-close-btn");

// 近兩週活動提醒
const upcomingNotice = document.getElementById("upcoming-notice");
const noticeList = document.getElementById("notice-list");
const noticeDismissBtn = document.getElementById("notice-dismiss");
const NOTICE_DISMISS_KEY = "taosystem_notice_dismissed";
const addEntryBtn = document.getElementById("add-entry-btn");
const entriesList = document.getElementById("entries-list");

// 預設隱藏的標籤（例：內部幹部身分不宜隨手就看到）。如需增減，直接編輯這個陣列。
// 標籤篩選：沒有打勾的標籤，帶有該標籤的對象整張卡片就不顯示。
// 預設只有「團內幹部」沒打勾；使用者調過之後記在這台裝置上。
const DEFAULT_HIDDEN_TAGS = ["團內幹部"];
const HIDDEN_TAGS_KEY = "hiddenTags";
let hiddenTags = loadHiddenTags();

function loadHiddenTags() {
  try {
    const raw = localStorage.getItem(HIDDEN_TAGS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // 存壞了就當作沒設定過
  }
  return new Set(DEFAULT_HIDDEN_TAGS);
}

function saveHiddenTags() {
  try {
    localStorage.setItem(HIDDEN_TAGS_KEY, JSON.stringify([...hiddenTags]));
  } catch {
    // 無痕模式之類寫不進去就算了，只是這次不會記住
  }
}

// 卡片上每種紀錄顯示幾筆（其餘以「還有 N 筆」帶過）
const RECORD_PREVIEW_COUNT = 2;

// 名單檢視模式："heat"（成全熱度・參與度，預設）／"detail"（詳細卡片）
let viewMode = "heat";

const entryModal = document.getElementById("entry-modal");
const entryForm = document.getElementById("entry-form");
const modalTitle = document.getElementById("modal-title");
const cancelBtn = document.getElementById("cancel-btn");

const fieldId = document.getElementById("entry-id");
const fieldScope = document.getElementById("field-scope");
const scopeHint = document.getElementById("scope-hint");
const fieldName = document.getElementById("field-name");
const fieldGender = document.getElementById("field-gender");
const fieldDepartment = document.getElementById("field-department");
// 名單編輯的標籤欄：圓角標籤 + 打字搜尋既有標籤
const fieldTags = createTagEditor(document.getElementById("field-tags"), {
  suggest: () => knownTags(),
  placeholder: "輸入標籤，例：需關心",
});
const fieldBackground = document.getElementById("field-background");
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

// 聯絡紀錄對話框（每個人獨立管理）
const talkModal = document.getElementById("talk-modal");
const talkModalName = document.getElementById("talk-modal-name");
const talksList = document.getElementById("talks-list");
const talksEmptyHint = document.getElementById("talks-empty-hint");
const newTalkDate = document.getElementById("new-talk-date");
const newTalkContent = document.getElementById("new-talk-content");
const addTalkBtn = document.getElementById("add-talk-btn");
const talkCloseBtn = document.getElementById("talk-close-btn");

// 活動管理對話框（月曆檢視）
const eventsModal = document.getElementById("events-modal");
const eventsManageBtn = document.getElementById("events-manage-btn");
const calendarEl = document.getElementById("calendar");
const calTitle = document.getElementById("cal-title");
const calPrevBtn = document.getElementById("cal-prev");
const calNextBtn = document.getElementById("cal-next");
const calTodayBtn = document.getElementById("cal-today");
const eventFormMode = document.getElementById("event-form-mode");
const newEventDate = document.getElementById("new-event-date");
const newEventEndDate = document.getElementById("new-event-end-date");
const eventMultiday = document.getElementById("event-multiday");
const newEventName = document.getElementById("new-event-name");
const newEventType = document.getElementById("new-event-type");
const addEventBtn = document.getElementById("add-event-btn");
const saveEventBtn = document.getElementById("save-event-btn");
const deleteEventBtn = document.getElementById("delete-event-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const eventsCloseBtn = document.getElementById("events-close-x");

// 活動邀約名單
const inviteSection = document.getElementById("invite-section");
const inviteSummary = document.getElementById("invite-summary");
const inviteBoard = document.getElementById("invite-board");
const inviteSuggestions = document.getElementById("invite-suggestions");
const newInvitePerson = document.getElementById("new-invite-person");
const newInviteStatus = document.getElementById("new-invite-status");
const addInviteBtn = document.getElementById("add-invite-btn");
const aiInviteBtn = document.getElementById("ai-invite-btn");
const inviteAiStatus = document.getElementById("invite-ai-status");
const inviteNoteEditor = document.getElementById("invite-note-editor");
const inviteNoteName = document.getElementById("invite-note-name");
const inviteNoteText = document.getElementById("invite-note-text");
const inviteNoteSave = document.getElementById("invite-note-save");
const inviteNoteCancel = document.getElementById("invite-note-cancel");

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
const aiResultActivity = document.getElementById("ai-result-activity");
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

// 名單分兩個集合：團隊名單大家共管，個人名單只有本人看得到。
// 兩邊各自訂閱後合併成 allEntries，每筆會帶 _scope / _col 以便寫回正確的集合。
let allEntries = [];
let teamEntries = [];
let myPersonalEntries = [];
let unsubscribeEntries = null;
let unsubscribePersonal = null;
let allEvents = [];
let unsubscribeEventsSub = null;
let teamName = "團隊";

// ---------- Auth ----------
onAuthStateChanged(auth, async (user) => {
  if (user) {
    updateUserLabel();
    // 先確認這支帳號屬於哪個道務單位；沒設定就不讓進去（資料路徑也組不出來）
    const ok = await loadMyUnit();
    if (!ok) {
      await signOut(auth);
      return;
    }
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    chatFab.classList.remove("hidden");
    subscribeEntries();
    subscribeEvents();
    loadMyLink();
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
    if (unsubscribePersonal) {
      unsubscribePersonal();
      unsubscribePersonal = null;
    }
    if (unsubscribeEventsSub) {
      unsubscribeEventsSub();
      unsubscribeEventsSub = null;
    }
    if (unsubscribeMembers) {
      unsubscribeMembers();
      unsubscribeMembers = null;
    }
    iAmLeader = false;
    membersBtn.classList.add("hidden");
    membersModal.classList.add("hidden");
    allEntries = [];
    teamEntries = [];
    myPersonalEntries = [];
    allEvents = [];
    chatHistory = [];
  }
});

// ---------- 帳號歸屬的道務單位 ----------
// memberEmails/{gmail} 與 units/{unitId} 都只能由管理員在 Firebase Console 設定，
// 網頁只讀不寫。用 Gmail 當文件 ID，管理員不必先請對方登入一次來取得 UID。
async function loadMyUnit() {
  const email = auth.currentUser?.email;
  if (!auth.currentUser) return false;
  try {
    const memberSnap = email ? await getDoc(doc(db, "memberEmails", email)) : null;
    const unitId = memberSnap?.exists() ? memberSnap.data().unitId || null : null;
    if (!unitId) {
      loginError.textContent =
        "這個帳號還沒指派道務單位，請聯絡管理員在 Firebase 設定後再登入。";
      return false;
    }
    myUnitId = unitId;

    const unitSnap = await getDoc(doc(db, "units", myUnitId));
    myUnitName = (unitSnap.exists() ? unitSnap.data().name : "") || myUnitId;
    teamName = myUnitName;
    // 道務組組長寫在單位資料裡，只有 Console 改得動；組長才看得到「使用者管理」
    const leaders = (unitSnap.exists() ? unitSnap.data().leaderEmails : null) || [];
    iAmLeader = leaders.some((e) => (e || "").toLowerCase() === (email || "").toLowerCase());
  } catch (err) {
    loginError.textContent = "讀取帳號歸屬失敗：" + err.message;
    return false;
  }
  applyUnitName();
  membersBtn.classList.toggle("hidden", !iAmLeader);
  return true;
}

function applyUnitName() {
  unitNameLabel.textContent = myUnitName;
  unitNameLabel.classList.remove("hidden");
  filterScope.options[1].textContent = `${teamName}名單`;
  fieldScope.options[0].textContent = `${teamName}名單（同單位幹部都看得到）`;
}

// ---------- 帳號綁定到名單中的自己 ----------
async function loadMyLink() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const snap = await getDoc(unitDoc(LINKS_COLLECTION, uid));
    myEntryId = snap.exists() ? snap.data().entryId || null : null;
  } catch (err) {
    console.error(err);
    myEntryId = null;
  }
  refreshBindPrompt();
}

// 我自己在名單上的那一筆（沒綁定或那筆被刪掉了就是 undefined）
function myEntry() {
  return allEntries.find((en) => en.id === myEntryId);
}

// 我自己在名單上的名字（沒綁定就用 Email）
function myDisplayName() {
  return myEntry()?.name || auth.currentUser?.email || "";
}

// 綁定後工具列顯示「名字（gmail）」，讓人一眼看出自己是誰
function updateUserLabel() {
  const email = auth.currentUser?.email || "";
  const name = myEntry()?.name;
  currentUserLabel.textContent = name ? `${name}（${email}）` : email;
}

function refreshBindPrompt() {
  const bound = !!myEntryId && allEntries.some((en) => en.id === myEntryId);
  bindMeBtn.classList.toggle("hidden", bound);
  bindMeBtn.textContent = myEntryId && !bound ? "重新綁定我的資料" : "綁定我的資料";
  updateUserLabel();
}

function renderBindResults() {
  const q = bindSearch.value.trim().toLowerCase();
  const matches = teamEntries
    .filter((en) => !q || (en.name || "").toLowerCase().includes(q))
    .slice(0, 10);
  bindResults.innerHTML = matches.length
    ? matches
        .map(
          (en) =>
            `<button type="button" class="bind-result" data-id="${en.id}">${escapeHtml(en.name)}${
              en.department ? `<span class="suggestion-meta">${escapeHtml(en.department)}</span>` : ""
            }</button>`
        )
        .join("")
    : `<p class="hint-text">${q ? `找不到「${escapeHtml(bindSearch.value.trim())}」` : "團隊名單目前是空的"}</p>`;
}

bindSearch.addEventListener("input", renderBindResults);

bindResults.addEventListener("click", async (e) => {
  const btn = e.target.closest(".bind-result");
  if (!btn) return;
  const uid = auth.currentUser?.uid;
  try {
    await setDoc(unitDoc(LINKS_COLLECTION, uid), {
      entryId: btn.dataset.id,
      email: auth.currentUser?.email || null,
      linkedAt: serverTimestamp(),
    });
    myEntryId = btn.dataset.id;
    bindStatus.textContent = `已綁定為「${allEntries.find((en) => en.id === myEntryId)?.name || ""}」。`;
    refreshBindPrompt();
    renderEntries();
  } catch (err) {
    bindStatus.textContent = "綁定失敗：" + err.message;
  }
});

bindMeBtn.addEventListener("click", () => {
  bindSearch.value = "";
  bindStatus.textContent = "";
  renderBindResults();
  bindModal.classList.remove("hidden");
  bindSearch.focus();
});
bindCloseBtn.addEventListener("click", () => bindModal.classList.add("hidden"));
bindModal.addEventListener("click", (e) => {
  if (e.target === bindModal) bindModal.classList.add("hidden");
});

// ---------- 使用者管理（道務組組長） ----------
// 組長可以增減 memberEmails 裡屬於自己單位的 Email。安全規則同樣只認組長，
// 所以就算有人自己叫出按鈕也寫不進去；組長身分只能從 Console 的 units 指定。
let unsubscribeMembers = null;
let unitMembers = [];

function openMembersModal() {
  membersUnitName.textContent = myUnitName;
  membersStatus.textContent = "";
  newMemberEmail.value = "";
  membersModal.classList.remove("hidden");
  subscribeMembers();
}

function closeMembersModal() {
  membersModal.classList.add("hidden");
  if (unsubscribeMembers) {
    unsubscribeMembers();
    unsubscribeMembers = null;
  }
}

function subscribeMembers() {
  if (unsubscribeMembers) unsubscribeMembers();
  unsubscribeMembers = onSnapshot(
    query(collection(db, "memberEmails"), where("unitId", "==", myUnitId)),
    (snapshot) => {
      unitMembers = snapshot.docs.map((d) => ({ email: d.id, ...d.data() }));
      unitMembers.sort((a, b) => a.email.localeCompare(b.email));
      renderMembers();
    },
    (err) => {
      membersStatus.textContent = "讀取失敗：" + err.message;
    }
  );
}

function renderMembers() {
  const me = (auth.currentUser?.email || "").toLowerCase();
  if (unitMembers.length === 0) {
    membersList.innerHTML = `<p class="hint-text">目前沒有任何使用者。</p>`;
    return;
  }
  membersList.innerHTML = unitMembers
    .map((m) => {
      const isMe = m.email.toLowerCase() === me;
      return `
        <div class="member-row">
          <span class="member-email">${escapeHtml(m.email)}${isMe ? '<span class="member-self">你</span>' : ""}</span>
          ${
            isMe
              ? `<span class="hint-text">不能移除自己</span>`
              : `<button type="button" class="btn-danger btn-small" data-email="${escapeHtml(m.email)}">移除</button>`
          }
        </div>`;
    })
    .join("");
}

async function addMember() {
  const email = newMemberEmail.value.trim().toLowerCase();
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    membersStatus.textContent = "請填寫完整的 Email。";
    return;
  }
  if (unitMembers.some((m) => m.email.toLowerCase() === email)) {
    membersStatus.textContent = "這個 Email 已經在名單裡了。";
    return;
  }
  addMemberBtn.disabled = true;
  try {
    await setDoc(doc(db, "memberEmails", email), {
      unitId: myUnitId,
      addedBy: auth.currentUser?.email || null,
      addedAt: serverTimestamp(),
    });
    newMemberEmail.value = "";
    membersStatus.textContent = `已加入 ${email}，他用這個 Google 帳號登入就進得來。`;
  } catch (err) {
    membersStatus.textContent =
      err.code === "permission-denied"
        ? "沒有權限。可能這個 Email 已經屬於別的道務單位。"
        : "加入失敗：" + err.message;
  } finally {
    addMemberBtn.disabled = false;
  }
}

membersBtn.addEventListener("click", openMembersModal);
membersCloseBtn.addEventListener("click", closeMembersModal);
membersModal.addEventListener("click", (e) => {
  if (e.target === membersModal) closeMembersModal();
});
addMemberBtn.addEventListener("click", addMember);
newMemberEmail.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addMember();
  }
});

membersList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-email]");
  if (!btn) return;
  const email = btn.dataset.email;
  if (!confirm(`把 ${email} 移出「${myUnitName}」嗎？\n\n他之後就登不進來了（已建立的名單資料不受影響）。`)) {
    return;
  }
  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "memberEmails", email));
    membersStatus.textContent = `已移除 ${email}。`;
  } catch (err) {
    membersStatus.textContent = "移除失敗：" + err.message;
    btn.disabled = false;
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
// 合併團隊與個人名單。預設依建立時間新到舊；手動排序過（有 order 欄位）就依 order。
function mergeEntries() {
  allEntries = [...teamEntries, ...myPersonalEntries].sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    if (ao != null && bo != null) return ao - bo;
    if (ao != null) return -1;
    if (bo != null) return 1;
    return (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);
  });
  renderEntries();
  refreshOpenActivityModal();
  refreshOpenTalkModal();
  refreshBindPrompt();
  renderTagFilter(); // 新標籤要出現在篩選清單，按鈕上的隱藏數也要跟著更新
  if (heatModalEntryId) renderHeatModal();
}

function subscribeEntries() {
  // 團隊名單：同一個道務單位的成員都看得到
  unsubscribeEntries = onSnapshot(
    unitCol(ENTRIES_COLLECTION),
    (snapshot) => {
      teamEntries = snapshot.docs.map((d) => ({
        id: d.id,
        _scope: "team",
        _col: ENTRIES_COLLECTION,
        ...d.data(),
      }));
      mergeEntries();
    },
    (err) => {
      // 通常是這個 Google 帳號還沒被指派道務單位，被 Firestore 規則擋下
      if (err.code === "permission-denied") {
        loginError.textContent =
          "此 Google 帳號沒有存取權限，請聯絡管理員在 Firebase 設定你所屬的道務單位。";
        signOut(auth);
      } else {
        console.error(err);
      }
    }
  );

  // 個人名單：只查自己的（規則也只允許讀自己的，查詢條件必須一致才不會被整批拒絕）
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  unsubscribePersonal = onSnapshot(
    query(unitCol(PERSONAL_COLLECTION), where("ownerUid", "==", uid)),
    (snapshot) => {
      myPersonalEntries = snapshot.docs.map((d) => ({
        id: d.id,
        _scope: "personal",
        _col: PERSONAL_COLLECTION,
        ...d.data(),
      }));
      mergeEntries();
    },
    (err) => {
      if (err.code !== "permission-denied") console.error(err);
    }
  );
}

// 找出某筆名單該寫回哪個集合（團隊 / 個人）
function entryRef(entryOrId) {
  const entry =
    typeof entryOrId === "string" ? allEntries.find((e) => e.id === entryOrId) : entryOrId;
  if (!entry) return null;
  return unitDoc(entry._col || ENTRIES_COLLECTION, entry.id);
}

function subscribeEvents() {
  const q = query(unitCol(EVENTS_COLLECTION), orderBy("date"));
  unsubscribeEventsSub = onSnapshot(
    q,
    (snapshot) => {
      allEvents = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderCalendar();
      refreshOpenInviteList();
      renderUpcomingNotice();
      renderEntries(); // 參與度會用到活動資料
    },
    (err) => {
      if (err.code !== "permission-denied") console.error(err);
    }
  );
}

// 今天（含）以後的活動，依日期排序（date 為 YYYY-MM-DD，字串比較即可）
function upcomingEvents() {
  const today = new Date().toISOString().slice(0, 10);
  return allEvents.filter((ev) => (ev.endDate || ev.date || "") >= today);
}

// ---------- 近兩週活動提醒 ----------
const NOTICE_DAYS = 14;

function renderUpcomingNotice() {
  if (localStorage.getItem(NOTICE_DISMISS_KEY) === ymd(new Date())) {
    upcomingNotice.classList.add("hidden");
    return;
  }

  const soon = allEvents
    .filter((ev) => {
      const d = daysSince(ev.date);
      return d !== null && d <= 0 && -d <= NOTICE_DAYS; // 今天到 14 天後
    })
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  if (soon.length === 0) {
    upcomingNotice.classList.add("hidden");
    return;
  }

  noticeList.innerHTML = soon
    .map((ev) => {
      const left = -daysSince(ev.date);
      const when = left === 0 ? "今天" : left === 1 ? "明天" : `${left} 天後`;
      const invites = ev.invites || [];
      const ok = invites.filter((i) => i.status === "已回覆可以").length;
      const pending = invites.filter(
        (i) => i.status === "預定邀約" || i.status === "已邀約待回覆" || i.status === "回覆不確定"
      ).length;
      const summary = invites.length
        ? `已邀約 ${invites.length} 人（${ok} 人可以${pending ? `、${pending} 人待確認` : ""}）`
        : "尚未邀約任何人";
      return `
        <div class="notice-item">
          <div class="notice-item-info">
            <span class="notice-when">${when}</span>
            <span class="notice-name">${escapeHtml(ev.name)}</span>
            <span class="notice-type">${escapeHtml(ev.type || "")}</span>
            <span class="notice-summary${invites.length ? "" : " notice-warn"}">${summary}</span>
          </div>
          <button type="button" class="btn-primary btn-small" data-notice-event="${ev.id}">安排邀約</button>
        </div>`;
    })
    .join("");
  upcomingNotice.classList.remove("hidden");
}

// 點「安排邀約」：直接開活動管理並進入該活動的編輯（下面就是邀約看板與 AI 建議邀約）
noticeList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-notice-event]");
  if (!btn) return;
  const ev = allEvents.find((x) => x.id === btn.dataset.noticeEvent);
  if (!ev) return;
  resetEventForm();
  calCursor = firstOfMonth(new Date(ev.date + "T00:00:00"));
  renderCalendar();
  eventsModal.classList.remove("hidden");
  startEditEvent(ev);
});

noticeDismissBtn.addEventListener("click", () => {
  localStorage.setItem(NOTICE_DISMISS_KEY, ymd(new Date()));
  upcomingNotice.classList.add("hidden");
});

// 對象只要有任何一個預設隱藏的標籤（例：團內幹部），整張卡片就不顯示（除非開關開啟）
function hasHiddenTag(entry) {
  return (entry.tags || []).some((t) => hiddenTags.has(t));
}

// 目前名單上出現過的所有標籤，常用的排前面（標籤輸入框的搜尋來源）
function knownTags() {
  const counts = new Map();
  allEntries.forEach((en) =>
    (en.tags || []).forEach((t) => {
      const tag = (t || "").trim();
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
    })
  );
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

// ---------- 參與度與成全熱度（簡覽模式用） ----------
// 兩個指標都由既有紀錄推算，不另外儲存，所以永遠跟著資料自動更新。

// asOf 讓同一套指標可以回推到過去某一天（趨勢分析用），不給就是今天。
function daysSince(dateStr, asOf = null) {
  if (!dateStr) return null;
  const then = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor(((asOf || new Date()) - then) / 86400000);
}

// 近一個月「辦過的活動」清單：活動管理登錄的活動，加上大家在活動紀錄裡寫到、
// 但沒登錄在活動管理的活動（例如臨時的聚會）。以活動名稱辨識，避免同一場算兩次。
function recentActivityPool(asOf = null) {
  const inWindow = (dateStr) => {
    const d = daysSince(dateStr, asOf);
    return d !== null && d >= 0 && d <= 30;
  };
  const pool = new Map(); // 名稱 → { name, event }

  allEvents.forEach((ev) => {
    if (!inWindow(ev.date)) return;
    const key = (ev.name || "").trim();
    if (key) pool.set(key, { name: key, event: ev });
  });

  allEntries.forEach((en) => {
    (en.activities || []).forEach((a) => {
      const key = (a.activity || "").trim();
      if (!key || !inWindow(a.date) || pool.has(key)) return;
      pool.set(key, { name: key, event: null });
    });
  });

  return [...pool.values()];
}

// 參與度：近一個月辦過的活動裡，這個人出席了幾成
function participation(entry, asOf = null) {
  const pool = recentActivityPool(asOf);
  if (pool.length === 0) {
    return { level: null, label: "—", text: "近一個月沒有活動" };
  }

  const myActivityNames = new Set(
    (entry.activities || [])
      .filter((a) => {
        const d = daysSince(a.date, asOf);
        return d !== null && d >= 0 && d <= 30;
      })
      .map((a) => (a.activity || "").trim())
      .filter(Boolean)
  );

  const attended = pool.filter((item) => {
    // 自己的活動紀錄裡有這場
    if (myActivityNames.has(item.name)) return true;
    // 或在活動管理的邀約名單中回覆可以
    return (item.event?.invites || []).some(
      (i) => i.entryId === entry.id && i.status === "已回覆可以"
    );
  }).length;

  const ratio = attended / pool.length;
  const text = `近一個月 ${pool.length} 場中出席 ${attended} 場`;
  if (ratio >= 0.6) return { level: 3, label: "高", text };
  if (ratio >= 0.3) return { level: 2, label: "中", text };
  if (ratio > 0) return { level: 1, label: "低", text };
  return { level: 0, label: "無", text };
}

// 互動度：近兩週 14 天裡，有幾天跟他有互動（聯絡紀錄或活動紀錄）。
// 同一天多筆只算一天，避免一次補登很多筆就衝高。
const INTERACTION_DAYS = 14;
const INTERACTION_HIGH_DAYS = 4; // 約每週 2 次以上
const INTERACTION_MID_DAYS = 2; // 約每週 1 次
const INTERACTION_RULE =
  `近兩週（${INTERACTION_DAYS} 天）有互動的天數：` +
  `${INTERACTION_HIGH_DAYS} 天以上＝高、` +
  `${INTERACTION_MID_DAYS}–${INTERACTION_HIGH_DAYS - 1} 天＝中、1 天＝低、0 天＝無。` +
  `同一天多筆只算一天。`;

function interaction(entry, asOf = null) {
  const days = new Set(
    [...(entry.activities || []), ...(entry.talks || [])]
      .map((r) => r.date)
      .filter((d) => {
        const n = daysSince(d, asOf);
        return n !== null && n >= 0 && n < INTERACTION_DAYS;
      })
  );
  const count = days.size;
  const text = `近兩週有 ${count} 天互動\n${INTERACTION_RULE}`;
  if (count >= INTERACTION_HIGH_DAYS) return { level: 3, label: "高", text };
  if (count >= INTERACTION_MID_DAYS) return { level: 2, label: "中", text };
  if (count > 0) return { level: 1, label: "低", text };
  return { level: 0, label: "無", text };
}

// ---------- 成全熱度 ----------
// 基準值來自 AI 評估或手動設定（存在 entry.heat），代表「談話內容顯示他離下一階段有多近」；
// 顯示值再依「多久沒聯絡」衰減：每過一週降一級，提醒該再關心了。
const HEAT_LABELS = ["冷", "涼", "溫", "熱"];
const HEAT_DECAY_DAYS = 7;

// 最近一次互動（活動紀錄或聯絡紀錄）距今幾天
function lastTouchDays(entry, asOf = null) {
  const dates = [...(entry.activities || []), ...(entry.talks || [])]
    .map((r) => r.date)
    .filter(Boolean)
    .filter((d) => {
      const n = daysSince(d, asOf);
      return n !== null && n >= 0; // 回推時不看那一天之後才發生的紀錄
    })
    .sort();
  if (dates.length === 0) return null;
  return daysSince(dates[dates.length - 1], asOf);
}

function heat(entry, asOf = null) {
  const h = entry.heat || {};
  let base = typeof h.level === "number" ? h.level : 0;
  const days = lastTouchDays(entry, asOf);
  // 回推過去某一天時，若那時候還沒有任何紀錄，就不能套用之後才評出來的熱度
  if (asOf && days === null) {
    const hasAnyRecord = [...(entry.activities || []), ...(entry.talks || [])].some((r) => r.date);
    if (hasAnyRecord) base = 0;
  }
  const weeks = days === null ? 0 : Math.floor(days / HEAT_DECAY_DAYS);
  const level = Math.max(0, base - weeks);
  return {
    level,
    base,
    days,
    weeks,
    label: HEAT_LABELS[level],
    reason: h.reason || "",
    source: h.source || "",
    assessed: typeof h.level === "number",
    decayed: weeks > 0 && base > level,
  };
}

// ---------- Render（卡片式名單） ----------
function renderEntries() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const statusVal = filterStatus.value;
  // 只有在沒有搜尋/篩選時才能拖曳排序（否則只看到部分卡片，排序會錯亂）
  const canReorder = !searchTerm && !statusVal && !filterScope.value;

  const scopeVal = filterScope.value;

  const filtered = allEntries.filter((entry) => {
    if (scopeVal && (entry._scope || "team") !== scopeVal) return false;
    if (hasHiddenTag(entry)) return false;
    if (statusVal && entry.status !== statusVal) return false;
    if (searchTerm) {
      const haystack = [
        entry.name,
        entry.department,
        getBackground(entry),
        entry.contact,
        (entry.tags || []).join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  entriesList.innerHTML = "";
  entriesList.classList.toggle("compact-mode", viewMode === "heat");

  if (filtered.length === 0) {
    entriesList.innerHTML = '<p class="empty-text">尚無資料</p>';
    return;
  }

  if (viewMode === "heat") {
    renderHeatList(filtered);
    return;
  }

  // 長文字欄位包進可收合容器：預設只顯示前幾行，點一下展開/收合
  const field = (label, html) =>
    html
      ? `<div class="card-field"><span class="field-label">${label}</span><div class="cell-clamp" title="點一下展開／收合">${html}</div></div>`
      : "";

  const tagsHtml = (tags) =>
    Array.isArray(tags) && tags.length
      ? `<div class="card-tags">${tags
          .map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`)
          .join("")}</div>`
      : "";

  // 紀錄類欄位：直接顯示最近幾筆（新到舊），其餘用「還有 N 筆」帶過。
  // 比整段收合直觀——一眼就看到最新動態，完整歷程點按鈕開紀錄視窗看。
  const recordField = (label, records, itemHtml) => {
    const list = sortByDateDesc(records);
    if (list.length === 0) return "";
    const shown = list.slice(0, RECORD_PREVIEW_COUNT).map(itemHtml).join("");
    const rest = list.length - RECORD_PREVIEW_COUNT;
    const more = rest > 0 ? `<div class="record-more">還有 ${rest} 筆…</div>` : "";
    return `<div class="card-field"><span class="field-label">${label}</span>${shown}${more}</div>`;
  };

  filtered.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "person-card" + (canReorder ? " draggable" : "");
    card.dataset.id = entry.id;
    if (canReorder) card.draggable = true;
    card.innerHTML = `
      <div class="person-card-header">
        <span class="person-name">${escapeHtml(entry.name)}</span>
        ${entry._scope === "personal" ? `<span class="scope-badge">個人</span>` : ""}
        ${entry.gender ? `<span class="gender-badge ${entry.gender === "坤" ? "gender-kun" : "gender-qian"}">${escapeHtml(entry.gender)}</span>` : ""}
        ${entry.department ? `<span class="person-meta">${escapeHtml(entry.department)}</span>` : ""}
        ${entry.status ? `<span class="status-badge">${escapeHtml(entry.status)}</span>` : ""}
      </div>
      ${tagsHtml(entry.tags)}
      ${entry.contact ? `<div class="person-meta">聯絡人：${escapeHtml(entry.contact)}</div>` : ""}
      ${entry.recommendedActivity ? `<div class="card-recommend"><span class="field-label">推薦活動</span>${escapeHtml(entry.recommendedActivity)}</div>` : ""}
      ${field("背景", escapeHtml(getBackground(entry)))}
      ${field("策略", escapeHtml(entry.strategy))}
      ${field("做法", escapeHtml(entry.method))}
      ${recordField("活動紀錄", entry.activities, activityItemHtml)}
      ${recordField("聯絡紀錄", entry.talks, talkItemHtml)}
      <div class="row-actions card-actions">
        <button data-action="edit" data-id="${entry.id}" class="btn-secondary">編輯</button>
        <button data-action="activities" data-id="${entry.id}" class="btn-secondary">活動紀錄</button>
        <button data-action="talks" data-id="${entry.id}" class="btn-secondary">聯絡紀錄</button>
        <button data-action="ai" data-id="${entry.id}" class="btn-secondary">AI 建議</button>
        ${entry._scope === "personal" ? `<button data-action="to-team" data-id="${entry.id}" class="btn-secondary">轉為${escapeHtml(teamName)}名單</button>` : ""}
        <button data-action="delete" data-id="${entry.id}" class="btn-danger">刪除</button>
      </div>
    `;
    entriesList.appendChild(card);
  });
}

// ---------- 熱度：手動調整 / AI 評估 ----------
let heatModalEntryId = null;

async function saveHeat(entryId, level, reason, source) {
  try {
    await updateDoc(entryRef(entryId), {
      heat: { level, reason: reason || "", source, assessedAt: ymd(new Date()) },
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    alert("儲存熱度失敗：" + err.message);
  }
}

function openHeatModal(entry) {
  heatModalEntryId = entry.id;
  heatModalName.textContent = entry.name || "";
  heatModalStatus.textContent = "";
  renderHeatModal();
  heatModal.classList.remove("hidden");
}

function renderHeatModal() {
  const entry = allEntries.find((en) => en.id === heatModalEntryId);
  if (!entry) return;
  const h = heat(entry);

  heatModalCurrent.innerHTML =
    `目前顯示：<span class="metric heat-${h.level}">${h.label}</span>` +
    (h.decayed
      ? `（評估為 ${HEAT_LABELS[h.base]}，已 ${h.days} 天沒聯絡而降級）`
      : h.assessed
        ? ""
        : "（尚未評估）");

  heatOptions.innerHTML = HEAT_LABELS.map(
    (label, l) =>
      `<button type="button" class="metric heat-${l} heat-option${l === h.base ? " selected" : ""}" data-level="${l}">${label}</button>`
  ).join("");

  heatModalReason.textContent = h.reason
    ? `評語（${h.source === "manual" ? "手動" : "AI"}）：${h.reason}`
    : "";
}

heatOptions.addEventListener("click", async (e) => {
  const btn = e.target.closest(".heat-option");
  if (!btn || !heatModalEntryId) return;
  await saveHeat(heatModalEntryId, Number(btn.dataset.level), "手動設定", "manual");
  heatModalStatus.textContent = "已更新熱度。";
});

heatCloseBtn.addEventListener("click", () => {
  heatModal.classList.add("hidden");
  heatModalEntryId = null;
});
heatModal.addEventListener("click", (e) => {
  if (e.target === heatModal) heatCloseBtn.click();
});

// 用 AI 依「活動紀錄／聯絡紀錄的內容」評估熱度；entries 為要評估的對象
async function runHeatAssessment(entries, statusEl, btn) {
  if (entries.length === 0) {
    statusEl.textContent = "沒有需要評估的對象。";
    return;
  }
  statusEl.textContent = `AI 評估中（${entries.length} 位），請稍候...`;
  if (btn) btn.disabled = true;
  try {
    const apiKey = await getSharedApiKey();
    if (!apiKey) {
      throw new Error(
        "尚未設定共用 API Key。請管理員到 Firebase Console 的 Firestore 建立 config 集合下的 ai 文件，欄位 anthropicApiKey 填入 Key（詳見 README）。"
      );
    }
    const { forward, reverse } = buildNameMap();
    const roster = entries.map((en, i) => ({ ref: i + 1, ...maskEntry(en, forward) }));
    const result = await assessHeat(apiKey, roster);

    let updated = 0;
    for (const a of result.assessments || []) {
      const target = entries[a.ref - 1];
      if (!target) continue;
      await saveHeat(target.id, a.level, unmaskNames(a.reason || "", reverse), "ai");
      updated += 1;
    }
    statusEl.textContent = updated
      ? `AI 已評估 ${updated} 位的熱度。`
      : "AI 沒有回傳可用的評估結果。";
  } catch (err) {
    statusEl.textContent = aiErrorMessage(err, "AI 評估失敗");
  } finally {
    if (btn) btn.disabled = false;
  }
}

aiHeatBtn.addEventListener("click", async () => {
  // 只評估目前看得到的人（被標籤篩選藏起來的不評估）
  const visible = allEntries.filter((en) => !hasHiddenTag(en));
  if (visible.length === 0) {
    alert("目前沒有可以評估的對象。");
    return;
  }
  // 會把每個人的紀錄都送去給 AI，跑起來要一點時間也要花錢，先問過再說
  if (
    !confirm(
      `要用 AI 重新評估這 ${visible.length} 位的成全熱度嗎？\n\n` +
        "系統會把他們的活動紀錄與聯絡紀錄（去識別化後）送給 AI 判斷，人數多的話要等一下子。\n" +
        "已經手動設定過熱度的人也會被重新評估。"
    )
  ) {
    return;
  }
  // 沒有獨立的狀態列，就借按鈕本身顯示進度，結束後再恢復原本文字
  const statusEl = {
    set textContent(v) {
      aiHeatBtn.textContent = v;
    },
  };
  await runHeatAssessment(visible, statusEl, aiHeatBtn);
  setTimeout(() => {
    aiHeatBtn.textContent = "AI 評估熱度";
  }, 4000);
});

heatAiOneBtn.addEventListener("click", async () => {
  const entry = allEntries.find((en) => en.id === heatModalEntryId);
  if (!entry) return;
  await runHeatAssessment([entry], heatModalStatus, heatAiOneBtn);
  renderHeatModal();
});

// ---------- 熱度模式：一人一張小卡，用顏色呈現熱度與參與度（手機也好按） ----------
function renderHeatList(entries) {
  const legend = `
    <div class="compact-legend">
      <span>成全熱度（談話離下一階段多近，每週沒聯絡降一級）：</span>
      ${HEAT_LABELS.map((label, l) => `<span class="metric heat-${l}">${label}</span>`).join("")}
      <span class="legend-sep">參與度（近一個月活動出席比例）：</span>
      ${["無", "低", "中", "高"]
        .map((label, l) => `<span class="metric part-${l}">${label}</span>`)
        .join("")}
      <span class="legend-sep" title="${escapeHtml(INTERACTION_RULE)}">互動度（近兩週有互動的天數）：</span>
      ${[
        { label: "無", rule: "0 天" },
        { label: "低", rule: "1 天" },
        { label: "中", rule: `${INTERACTION_MID_DAYS}–${INTERACTION_HIGH_DAYS - 1} 天` },
        { label: "高", rule: `${INTERACTION_HIGH_DAYS} 天以上` },
      ]
        .map(
          (x, l) =>
            `<span class="metric act-${l}">${x.label}</span><span class="legend-rule">${x.rule}</span>`
        )
        .join("")}
    </div>`;

  const cards = entries
    .map((entry) => {
      const p = participation(entry);
      const x = interaction(entry);
      const h = heat(entry);
      const lastTouch =
        h.days === null ? "尚無紀錄" : h.days === 0 ? "今天" : `${h.days} 天前`;
      const partClass = p.level === null ? "part-na" : `part-${p.level}`;
      const note = h.decayed
        ? `已 ${h.days} 天沒聯絡，熱度自 ${HEAT_LABELS[h.base]} 降為 ${h.label}`
        : h.reason || (h.assessed ? "" : "尚未評估熱度");
      return `
        <div class="heat-card" data-id="${entry.id}">
          <div class="heat-card-main">
            <span class="metric heat-${h.level} heat-badge">${h.label}</span>
            <div class="heat-card-info">
              <div class="heat-card-name">
                ${escapeHtml(entry.name)}
                ${entry._scope === "personal" ? `<span class="scope-badge">個人</span>` : ""}
                ${
                  entry.gender
                    ? `<span class="gender-badge ${entry.gender === "坤" ? "gender-kun" : "gender-qian"}">${escapeHtml(entry.gender)}</span>`
                    : ""
                }
              </div>
              <div class="heat-card-meta">
                ${entry.status ? `<span>${escapeHtml(entry.status)}</span>` : ""}
                <span class="metric ${partClass}" title="${escapeHtml(p.text)}">參與 ${p.label}</span>
                <span class="metric act-${x.level}" title="${escapeHtml(x.text)}">互動 ${x.label}</span>
                <span>${lastTouch}</span>
              </div>
            </div>
          </div>
          ${note ? `<div class="heat-card-note">${escapeHtml(note)}</div>` : ""}
          <div class="heat-card-actions">
            <button data-action="activities" data-id="${entry.id}" class="btn-secondary">活動紀錄</button>
            <button data-action="talks" data-id="${entry.id}" class="btn-secondary">聯絡紀錄</button>
            <button data-action="heat" data-id="${entry.id}" class="btn-secondary">熱度</button>
            <button data-action="edit" data-id="${entry.id}" class="btn-secondary">編輯</button>
          </div>
        </div>`;
    })
    .join("");

  entriesList.innerHTML = legend + `<div class="heat-list">${cards}</div>`;
}

// 個人名單轉為團隊名單：沿用同一個文件 ID 搬到 entries 集合，
// 這樣活動邀約名單裡記的 entryId 才不會失效。
async function transferToTeam(entry) {
  const { id, _scope, _col, ownerUid, ...data } = entry;
  try {
    await setDoc(unitDoc(ENTRIES_COLLECTION, id), {
      ...data,
      transferredBy: auth.currentUser?.email || null,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
    await deleteDoc(unitDoc(PERSONAL_COLLECTION, id));
  } catch (err) {
    alert("轉移失敗：" + err.message);
  }
}

// ---------- 拖曳排序（僅在未搜尋/未篩選時可用） ----------
let dragId = null;

entriesList.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".person-card");
  if (!card || !card.draggable) return;
  dragId = card.dataset.id;
  card.classList.add("dragging");
});

entriesList.addEventListener("dragend", async (e) => {
  const card = e.target.closest(".person-card");
  card?.classList.remove("dragging");
  if (!dragId) return;
  dragId = null;
  await persistOrderFromDom();
});

entriesList.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const target = e.target.closest(".person-card");
  const dragging = entriesList.querySelector(".person-card.dragging");
  if (!target || !dragging || target === dragging) return;
  e.preventDefault();
  const box = target.getBoundingClientRect();
  // 同一列用左右中線判斷、跨列用上下中線
  const sameRow = e.clientY >= box.top && e.clientY <= box.bottom;
  const before = sameRow
    ? e.clientX < box.left + box.width / 2
    : e.clientY < box.top + box.height / 2;
  entriesList.insertBefore(dragging, before ? target : target.nextSibling);
});

// 依目前 DOM 卡片順序，把 order 寫回有變動的名單
async function persistOrderFromDom() {
  const ids = [...entriesList.querySelectorAll(".person-card")].map((c) => c.dataset.id);
  const updates = [];
  ids.forEach((id, index) => {
    const entry = allEntries.find((en) => en.id === id);
    if (entry && entry.order !== index) {
      updates.push(updateDoc(entryRef(id), { order: index }));
    }
  });
  try {
    await Promise.all(updates);
  } catch (err) {
    alert("排序儲存失敗：" + err.message);
  }
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
    tags: (entry.tags || []).map((t) => maskNames(t, forward)),
    background: maskNames(getBackground(entry), forward),
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

// 近期活動送 AI 前也做代號替換（活動名稱可能提到名單上的人）
function maskedUpcomingEvents(forward) {
  return upcomingEvents().map((ev) => ({
    name: maskNames(ev.name, forward),
    date: ev.date,
    endDate: ev.endDate,
    type: ev.type,
    // 邀約名單也用代號，AI 才知道誰已答應/婉拒，不會重複推薦
    invites: (ev.invites || [])
      .map((inv) => ({
        name: maskNames(entryName(inv.entryId), forward),
        status: inv.status,
        note: maskNames(inv.note || "", forward),
      }))
      .filter((inv) => inv.name),
  }));
}

// 紀錄一律新到舊排序；沒填日期的排最後（無從判斷時間，放後面比較不會誤導）
function sortByDateDesc(records) {
  return [...(records || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// 單筆活動紀錄：「日期 活動：反應」
function activityItemHtml(a) {
  const act = escapeHtml(a.activity);
  const reaction = escapeHtml(a.reaction);
  const date = a.date ? `<span class="act-date">${escapeHtml(a.date)}</span> ` : "";
  const body = reaction ? `${act}：${reaction}` : act;
  return `<div class="act-item">${date}${body}</div>`;
}

// 單筆聯絡紀錄：「日期 內容」
function talkItemHtml(t) {
  const date = t.date ? `<span class="act-date">${escapeHtml(t.date)}</span> ` : "";
  return `<div class="act-item">${date}${escapeHtml(t.content)}</div>`;
}

function escapeHtml(value) {
  if (!value) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

searchInput.addEventListener("input", renderEntries);
filterStatus.addEventListener("change", renderEntries);
filterScope.addEventListener("change", renderEntries);

toggleViewBtn.addEventListener("click", () => {
  viewMode = viewMode === "detail" ? "heat" : "detail";
  toggleViewBtn.textContent = viewMode === "heat" ? "切換詳細模式" : "切換熱度模式";
  aiHeatBtn.classList.toggle("hidden", viewMode !== "heat");
  renderEntries();
});

// ---------- 標籤篩選 ----------
function renderTagFilter() {
  const tags = [...new Set([...knownTags(), ...hiddenTags])];
  tagFilterList.innerHTML =
    tags.length === 0
      ? `<p class="hint-text">名單上還沒有任何標籤。</p>`
      : tags
          .map(
            (t) => `
        <label class="tag-filter-item">
          <input type="checkbox" value="${escapeHtml(t)}" ${hiddenTags.has(t) ? "" : "checked"} />
          ${escapeHtml(t)}
        </label>`
          )
          .join("");
}

function closeTagFilter() {
  tagFilterPanel.classList.add("hidden");
  tagFilterBtn.classList.remove("is-open");
  tagFilterBtn.setAttribute("aria-expanded", "false");
}

tagFilterBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = tagFilterPanel.classList.toggle("hidden") === false;
  tagFilterBtn.classList.toggle("is-open", open);
  tagFilterBtn.setAttribute("aria-expanded", String(open));
  if (open) renderTagFilter();
});

// 下拉選單：點到別的地方或按 Esc 就收起來
document.addEventListener("click", (e) => {
  if (tagFilterPanel.classList.contains("hidden")) return;
  if (e.target.closest(".tag-filter-wrap")) return;
  closeTagFilter();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTagFilter();
});

tagFilterList.addEventListener("change", (e) => {
  const box = e.target.closest("input[type=checkbox]");
  if (!box) return;
  if (box.checked) hiddenTags.delete(box.value);
  else hiddenTags.add(box.value);
  saveHiddenTags();
  renderTagFilter();
  renderEntries();
});

tagFilterAll.addEventListener("click", () => {
  hiddenTags.clear();
  saveHiddenTags();
  renderTagFilter();
  renderEntries();
});

// ---------- 活動紀錄對話框（每個人獨立新增/編輯，與新增名單表單分開） ----------
let activityModalEntryId = null;
let activityModalActivities = [];

function openActivityModal(entry) {
  activityModalEntryId = entry.id;
  activityModalActivities = sortByDateDesc(entry.activities).map((a) => ({ ...a }));
  activityModalName.textContent = entry.name || "";
  newActName.value = "";
  newActDate.value = ymd(new Date()); // 預設今天，避免沒填日期而排到最後
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
  activityModalActivities = sortByDateDesc(entry.activities).map((a) => ({ ...a }));
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
      <input type="date" class="act-field-date" />
      <textarea class="act-field-reaction" rows="2" placeholder="反應 / 回饋"></textarea>
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
    await updateDoc(entryRef(activityModalEntryId), {
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
      date: row.querySelector(".act-field-date").value,
      reaction: row.querySelector(".act-field-reaction").value.trim(),
    };
    // 日期可能被改過，重新排序讓它移到正確位置
    activityModalActivities = sortByDateDesc(activityModalActivities);
    renderActivityModalList();
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
    date: newActDate.value,
    reaction: newActReaction.value.trim(),
  });
  activityModalActivities = sortByDateDesc(activityModalActivities);
  newActName.value = "";
  newActDate.value = ymd(new Date());
  newActReaction.value = "";
  renderActivityModalList();
  await persistActivities();
});

activityCloseBtn.addEventListener("click", closeActivityModal);
activityModal.addEventListener("click", (e) => {
  if (e.target === activityModal) closeActivityModal();
});

// ---------- 聯絡紀錄對話框（每個人獨立新增/編輯） ----------
let talkModalEntryId = null;
let talkModalTalks = [];

function openTalkModal(entry) {
  talkModalEntryId = entry.id;
  talkModalTalks = sortByDateDesc(entry.talks).map((t) => ({ ...t }));
  talkModalName.textContent = entry.name || "";
  newTalkDate.value = ymd(new Date()); // 預設今天，避免沒填日期而排到最後
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
  talkModalTalks = sortByDateDesc(entry.talks).map((t) => ({ ...t }));
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
      <input type="date" class="talk-field-date" />
      <textarea class="talk-field-content" rows="2" placeholder="聊了什麼、對方的反應"></textarea>
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
    await updateDoc(entryRef(talkModalEntryId), {
      talks: talkModalTalks,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    alert("儲存聯絡紀錄失敗：" + err.message);
  }
}

talksList.addEventListener("click", async (e) => {
  const row = e.target.closest(".talk-row");
  if (!row) return;
  const index = Number(row.dataset.index);

  if (e.target.closest(".talk-save")) {
    talkModalTalks[index] = {
      date: row.querySelector(".talk-field-date").value,
      content: row.querySelector(".talk-field-content").value.trim(),
    };
    // 日期可能被改過，重新排序讓它移到正確位置
    talkModalTalks = sortByDateDesc(talkModalTalks);
    renderTalkModalList();
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
  talkModalTalks.push({ date: newTalkDate.value, content });
  talkModalTalks = sortByDateDesc(talkModalTalks);
  newTalkDate.value = ymd(new Date());
  newTalkContent.value = "";
  renderTalkModalList();
  await persistTalks();
});

talkCloseBtn.addEventListener("click", closeTalkModal);
talkModal.addEventListener("click", (e) => {
  if (e.target === talkModal) closeTalkModal();
});

// ---------- 趨勢分析 ----------
// 三個指標都是從紀錄推算出來的，所以可以把「今天」換成過去某一天重算一次，
// 不需要另外存歷史資料；補登舊紀錄之後，過去的趨勢也會跟著修正。
const TREND_METRICS = [
  {
    key: "heat",
    title: "成全熱度",
    labels: HEAT_LABELS, // 冷 涼 溫 熱
    compute: (entry, asOf) => heat(entry, asOf).level,
  },
  {
    key: "act",
    title: "互動度",
    labels: ["無", "低", "中", "高"],
    compute: (entry, asOf) => interaction(entry, asOf).level,
  },
  {
    key: "part",
    title: "參與度",
    labels: ["無", "低", "中", "高"],
    compute: (entry, asOf) => participation(entry, asOf).level,
  },
];

let trendSnapshots = []; // [{ date, label, buckets: { heat: [[id...] x4], act: …, part: … } }]
let trendSelection = null; // { metricKey, level, index }

// 趨勢分析自己的標籤篩選：不選＝全部，選了就只統計帶有其中任一標籤的人
let trendTagFilter = new Set();

function trendEntries() {
  // 有指定標籤時就以它為準（包含被工具列藏起來的標籤，例如想單獨看團內幹部）；
  // 沒指定才套用工具列的標籤篩選。
  if (trendTagFilter.size > 0) {
    return allEntries.filter((en) => (en.tags || []).some((t) => trendTagFilter.has(t)));
  }
  return allEntries.filter((en) => !hasHiddenTag(en));
}

function renderTrendTagFilter() {
  // 名單上用過的標籤全部列出來（含工具列藏起來的），這裡才看得到有哪些可以分析
  const all = [...new Set([...knownTags(), ...trendTagFilter])];
  trendTagFilterList.innerHTML =
    all.length === 0
      ? `<p class="hint-text">名單上還沒有人被貼標籤；在名單編輯的「標籤」欄加上之後就會出現在這裡。</p>`
      : all
          .map(
            (t) => `
        <button type="button" class="tag-toggle${trendTagFilter.has(t) ? " is-on" : ""}"
          data-tag="${escapeHtml(t)}" aria-pressed="${trendTagFilter.has(t)}">${escapeHtml(t)}</button>`
          )
          .join("") +
        (trendTagFilter.size > 0
          ? `<button type="button" class="btn-link-plain" data-clear="1">清除</button>`
          : "");
}

function buildTrendData() {
  const weeks = Number(trendRange.value);
  const step = Number(trendStep.value);
  const entries = trendEntries();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const snapshots = [];
  for (let daysBack = weeks * 7; daysBack >= 0; daysBack -= step) {
    const asOf = new Date(today.getTime() - daysBack * 86400000);
    const buckets = {};
    TREND_METRICS.forEach((m) => {
      buckets[m.key] = [[], [], [], []];
      entries.forEach((en) => {
        const level = m.compute(en, asOf);
        // 參與度在「那一個月完全沒有活動」時是 null，歸到「無」那一格
        buckets[m.key][level === null ? 0 : level].push(en.id);
      });
    });
    snapshots.push({
      date: asOf,
      label: `${asOf.getMonth() + 1}/${asOf.getDate()}`,
      buckets,
    });
  }
  trendSnapshots = snapshots;
}

function renderTrendCharts() {
  buildTrendData();
  const total = trendEntries().length;
  if (total === 0) {
    trendCharts.innerHTML = `<p class="hint-text">沒有符合的對象，可以調整上面的「只看標籤」。</p>`;
    return;
  }
  trendCharts.innerHTML = TREND_METRICS.map((m) => renderTrendChart(m, total)).join("");
  highlightTrendSelection();
}

function renderTrendChart(metric, total) {
  const n = trendSnapshots.length;
  const W = 720;
  const H = 200;
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / n;
  const barW = Math.max(6, Math.min(38, slot * 0.68));
  // y 軸最高就是總人數（堆疊起來一定等於總人數），刻度取 0 / 一半 / 全部
  const yOf = (count) => padT + plotH - (count / total) * plotH;

  const grid = [0, Math.round(total / 2), total]
    .map(
      (v) => `
        <line x1="${padL}" y1="${yOf(v)}" x2="${W - padR}" y2="${yOf(v)}" class="trend-grid" />
        <text x="${padL - 6}" y="${yOf(v) + 4}" class="trend-axis" text-anchor="end">${v}</text>`
    )
    .join("");

  const bars = trendSnapshots
    .map((snap, i) => {
      const x = padL + slot * i + (slot - barW) / 2;
      let y = padT + plotH;
      // 由下往上堆：無/冷 在最下面
      return metric.labels
        .map((label, level) => {
          const count = snap.buckets[metric.key][level].length;
          if (count === 0) return "";
          const h = (count / total) * plotH;
          y -= h;
          return `<rect class="trend-bar bar-${metric.key}-${level}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
            data-metric="${metric.key}" data-level="${level}" data-index="${i}"
            role="button" tabindex="0"><title>${snap.label} ${label} ${count} 人</title></rect>`;
        })
        .join("");
    })
    .join("");

  // x 軸標籤太多會擠在一起，超過 9 個就隔一個標一次
  const everyOther = n > 9 ? 2 : 1;
  const xLabels = trendSnapshots
    .map((snap, i) =>
      i % everyOther === 0
        ? `<text x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 8}" class="trend-axis" text-anchor="middle">${snap.label}</text>`
        : ""
    )
    .join("");

  const legend = metric.labels
    .map(
      (label, level) =>
        `<button type="button" class="trend-legend-item" data-metric="${metric.key}" data-level="${level}" data-index="${n - 1}">
           <span class="trend-swatch bar-${metric.key}-${level}"></span>${label}
         </button>`
    )
    .join("");

  return `
    <div class="trend-chart" data-metric="${metric.key}">
      <div class="trend-chart-head">
        <span class="field-label">${metric.title}</span>
        <span class="hint-text">y 軸＝人數（共 ${total} 人）</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="none">
        ${grid}${bars}${xLabels}
      </svg>
      <div class="trend-legend">${legend}</div>
    </div>`;
}

function highlightTrendSelection() {
  trendCharts.querySelectorAll(".trend-bar").forEach((rect) => {
    const on =
      trendSelection &&
      rect.dataset.metric === trendSelection.metricKey &&
      Number(rect.dataset.level) === trendSelection.level &&
      Number(rect.dataset.index) === trendSelection.index;
    rect.classList.toggle("is-selected", !!on);
  });
}

function selectTrendBucket(metricKey, level, index) {
  const snap = trendSnapshots[index];
  const metric = TREND_METRICS.find((m) => m.key === metricKey);
  if (!snap || !metric) return;
  trendSelection = { metricKey, level, index };
  highlightTrendSelection();
  trendDetailStatus.textContent = "";

  const ids = snap.buckets[metricKey][level];
  const dateText = `${snap.date.getFullYear()}/${snap.date.getMonth() + 1}/${snap.date.getDate()}`;
  trendDetailTitle.textContent = `${metric.title}「${metric.labels[level]}」 · ${dateText} · ${ids.length} 人`;
  trendDetail.classList.remove("hidden");

  if (ids.length === 0) {
    trendDetailList.innerHTML = `<p class="hint-text">這個時間點沒有人在這一級。</p>`;
    return;
  }
  trendDetailList.innerHTML = ids
    .map((id) => {
      const en = allEntries.find((e) => e.id === id);
      if (!en) return "";
      const dept = en.department ? `<span class="hint-text">${escapeHtml(en.department)}</span>` : "";
      const tags = (en.tags || [])
        .map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`)
        .join("");
      return `
        <label class="trend-person">
          <input type="checkbox" value="${id}" checked />
          <span class="trend-person-name">${escapeHtml(en.name)}</span>
          ${dept}
          <span class="trend-person-tags">${tags}</span>
        </label>`;
    })
    .join("");
}

// 幫選起來的人加上標籤（可以一次加好幾個；已經有的就跳過）
async function addTagToSelected() {
  trendTagInput.commitPending();
  const newTags = trendTagInput.getTags();
  if (newTags.length === 0) {
    trendDetailStatus.textContent = "請先填要加上的標籤。";
    return;
  }
  const ids = [...trendDetailList.querySelectorAll("input[type=checkbox]:checked")].map(
    (c) => c.value
  );
  if (ids.length === 0) {
    trendDetailStatus.textContent = "沒有勾選任何人。";
    return;
  }
  trendTagBtn.disabled = true;
  trendDetailStatus.textContent = "處理中...";
  let updated = 0;
  let skipped = 0;
  const failures = [];
  for (const id of ids) {
    const entry = allEntries.find((e) => e.id === id);
    const ref = entryRef(entry);
    if (!entry || !ref) continue;
    const tags = entry.tags || [];
    const toAdd = newTags.filter(
      (t) => !tags.some((existing) => existing.toLowerCase() === t.toLowerCase())
    );
    if (toAdd.length === 0) {
      skipped += 1;
      continue;
    }
    try {
      await updateDoc(ref, { tags: [...tags, ...toAdd] });
      updated += 1;
    } catch (err) {
      failures.push(`${entry.name}：${err.code || err.message}`);
    }
  }
  const label = newTags.map((t) => `「${t}」`).join("");
  const parts = [`已幫 ${updated} 人加上${label}`];
  if (skipped > 0) parts.push(`${skipped} 人本來就有`);
  if (failures.length > 0) parts.push(`${failures.length} 人失敗（${failures[0]}）`);
  trendTagBtn.disabled = false;
  trendTagInput.clear();
  // 重畫一次名單，剛加上的標籤才會出現在每個人旁邊（狀態訊息要留在最後設）
  if (trendSelection) {
    selectTrendBucket(trendSelection.metricKey, trendSelection.level, trendSelection.index);
  }
  trendDetailStatus.textContent = parts.join("，") + "。";
}

function openTrendModal() {
  trendSelection = null;
  trendDetail.classList.add("hidden");
  renderTrendTagFilter();
  renderTrendCharts();
  trendModal.classList.remove("hidden");
}

trendTagFilterList.addEventListener("click", (e) => {
  const clear = e.target.closest("[data-clear]");
  const chip = e.target.closest(".tag-toggle");
  if (!clear && !chip) return;
  if (clear) trendTagFilter.clear();
  else if (trendTagFilter.has(chip.dataset.tag)) trendTagFilter.delete(chip.dataset.tag);
  else trendTagFilter.add(chip.dataset.tag);
  trendSelection = null;
  trendDetail.classList.add("hidden");
  renderTrendTagFilter();
  renderTrendCharts();
});

trendBtn.addEventListener("click", openTrendModal);
trendCloseBtn.addEventListener("click", () => trendModal.classList.add("hidden"));
trendModal.addEventListener("click", (e) => {
  if (e.target === trendModal) trendModal.classList.add("hidden");
});
[trendRange, trendStep].forEach((sel) =>
  sel.addEventListener("change", () => {
    trendSelection = null;
    trendDetail.classList.add("hidden");
    renderTrendCharts();
  })
);

trendCharts.addEventListener("click", (e) => {
  const target = e.target.closest(".trend-bar, .trend-legend-item");
  if (!target) return;
  selectTrendBucket(
    target.dataset.metric,
    Number(target.dataset.level),
    Number(target.dataset.index)
  );
});
trendCharts.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const target = e.target.closest(".trend-bar");
  if (!target) return;
  e.preventDefault();
  selectTrendBucket(
    target.dataset.metric,
    Number(target.dataset.level),
    Number(target.dataset.index)
  );
});

trendDetailClose.addEventListener("click", () => {
  trendDetail.classList.add("hidden");
  trendSelection = null;
  highlightTrendSelection();
});
trendSelectAll.addEventListener("click", () => {
  trendDetailList.querySelectorAll("input[type=checkbox]").forEach((c) => (c.checked = true));
});
trendSelectNone.addEventListener("click", () => {
  trendDetailList.querySelectorAll("input[type=checkbox]").forEach((c) => (c.checked = false));
});
trendTagBtn.addEventListener("click", addTagToSelected);

// ---------- Modal open/close ----------
function openModal(entry = null) {
  entryForm.reset();
  if (entry) {
    modalTitle.textContent = "編輯名單";
    fieldId.value = entry.id;
    // 既有資料的歸屬只能透過「轉為團隊名單」變更，這裡鎖起來避免誤改
    fieldScope.value = entry._scope || "team";
    fieldScope.disabled = true;
    scopeHint.textContent =
      entry._scope === "personal"
        ? "這是你的個人名單，其他人看不到。要分享請用卡片上的「轉為團隊名單」。"
        : `這筆已在${teamName}名單，所有幹部都看得到。`;
    fieldName.value = entry.name || "";
    fieldGender.value = entry.gender || "";
    fieldDepartment.value = entry.department || "";
    fieldTags.setTags(entry.tags || []);
    fieldBackground.value = getBackground(entry);
    fieldContact.readOnly = false;
    fieldContact.value = entry.contact || "";
    teamContactDraft = fieldContact.value;
    fieldStatus.value = entry.status || "";
    fieldStrategy.value = entry.strategy || "";
    fieldMethod.value = entry.method || "";
  } else {
    modalTitle.textContent = "新增名單";
    fieldId.value = "";
    fieldScope.disabled = false;
    fieldScope.value = "team";
    scopeHint.textContent = "個人名單只有你自己看得到，之後可以再轉為團隊名單。";
    fieldContact.readOnly = false;
    teamContactDraft = "";
    fieldTags.clear(); // form.reset() 清不到自訂的標籤欄
  }
  applyScopeToContactField();
  entryModal.classList.remove("hidden");
  fieldName.focus();
}

// 個人名單的聯絡人一定是自己：欄位照樣顯示，但填好自己的名字並鎖成唯讀
let teamContactDraft = "";

function applyScopeToContactField() {
  const personal = fieldScope.value === "personal";
  if (personal) {
    if (!fieldContact.readOnly) teamContactDraft = fieldContact.value;
    fieldContact.value = myDisplayName();
  } else if (fieldContact.readOnly) {
    fieldContact.value = teamContactDraft;
  }
  fieldContact.readOnly = personal;
  fieldContact.classList.toggle("readonly-input", personal);
  fieldContact.placeholder = personal ? "" : "負責這位的人";
}

fieldScope.addEventListener("change", applyScopeToContactField);

function closeModal() {
  entryModal.classList.add("hidden");
}

addEntryBtn.addEventListener("click", () => openModal());
cancelBtn.addEventListener("click", closeModal);
// 右上角的 × 等同取消
document.getElementById("cancel-x").addEventListener("click", closeModal);
entryModal.addEventListener("click", (e) => {
  if (e.target === entryModal) closeModal();
});

// ---------- Create / Update / Delete ----------
entryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  fieldTags.commitPending(); // 打了字卻沒按 Enter 的標籤也算數
  // 注意：activities / talks 不在這裡處理，改由各自的對話框獨立新增/編輯，
  // 這裡不能帶入這些欄位，否則 updateDoc 會把既有紀錄整個蓋掉。
  const data = {
    name: fieldName.value.trim(),
    gender: fieldGender.value,
    department: fieldDepartment.value.trim(),
    tags: fieldTags.getTags(),
    background: fieldBackground.value.trim(),
    // 個人名單的聯絡人固定是自己
    contact: fieldScope.value === "personal" ? myDisplayName() : fieldContact.value.trim(),
    status: fieldStatus.value,
    strategy: fieldStrategy.value.trim(),
    method: fieldMethod.value.trim(),
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.email || null,
  };

  const id = fieldId.value;
  try {
    if (id) {
      // 編輯時不動歸屬（要換歸屬請用卡片上的「轉為團隊名單」）
      await updateDoc(entryRef(id), data);
    } else {
      const personal = fieldScope.value === "personal";
      await addDoc(unitCol(personal ? PERSONAL_COLLECTION : ENTRIES_COLLECTION), {
        ...data,
        ...(personal ? { ownerUid: auth.currentUser?.uid || null } : {}),
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

entriesList.addEventListener("click", async (e) => {
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
  } else if (btn.dataset.action === "heat") {
    openHeatModal(entry);
  } else if (btn.dataset.action === "to-team") {
    if (
      confirm(
        `確定把「${entry.name}」轉為${teamName}名單嗎？轉移後所有幹部都看得到這筆資料（含紀錄與備註），且無法從網頁上轉回個人名單。`
      )
    ) {
      await transferToTeam(entry);
    }
  } else if (btn.dataset.action === "delete") {
    if (confirm(`確定要刪除「${entry.name}」的資料嗎？此動作無法復原。`)) {
      try {
        await deleteDoc(entryRef(entry));
      } catch (err) {
        alert("刪除失敗：" + err.message);
      }
    }
  }
});

// ---------- 活動管理（月曆檢視） ----------
const EVENT_TYPES = ["廣結善緣", "獻供", "求道", "成全", "法會", "幹訓"];

// 單日活動只出現一個日期選擇；勾了「多日活動」才顯示結束日期
function applyMultidayToggle() {
  const multi = eventMultiday.checked;
  newEventEndDate.classList.toggle("hidden", !multi);
  if (!multi) newEventEndDate.value = "";
  else if (!newEventEndDate.value) newEventEndDate.value = newEventDate.value;
}

eventMultiday.addEventListener("change", applyMultidayToggle);
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const INVITE_STATUSES = [
  "預定邀約",
  "已邀約待回覆",
  "回覆不確定",
  "已回覆可以",
  "已回覆不行",
];

let calCursor = firstOfMonth(new Date()); // 目前顯示的月份（該月 1 號）
let editingEventId = null;
let editingEventInvites = []; // [{ entryId, status }]

function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// 本機日期 → YYYY-MM-DD（避免 toISOString 的時區位移）
function ymd(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// 該日期字串當天有哪些活動（涵蓋多日活動的每一天）
function eventsOnDay(dayStr) {
  return allEvents.filter((ev) => {
    const start = ev.date || "";
    const end = ev.endDate || ev.date || "";
    return start && dayStr >= start && dayStr <= end;
  });
}

function renderCalendar() {
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  calTitle.textContent = `${year} 年 ${month + 1} 月`;

  const firstWeekday = new Date(year, month, 1).getDay(); // 0=日
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = ymd(new Date());

  // 補滿完整週：第一格從當月 1 號往前推到週日，總格數湊成 7 的倍數
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - firstWeekday);

  let html = WEEKDAYS.map((w) => `<div class="cal-weekday">${w}</div>`).join("");

  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const dayStr = ymd(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const chips = eventsOnDay(dayStr)
      .map(
        (ev) =>
          `<div class="cal-event type-${escapeHtml(ev.type)}" data-id="${ev.id}" title="${escapeHtml(ev.name)}（${escapeHtml(ev.type)}）">${escapeHtml(ev.name)}</div>`
      )
      .join("");
    const cls =
      "cal-cell" +
      (inMonth ? "" : " cal-other-month") +
      (dayStr === todayStr ? " cal-today" : "");
    html += `
      <div class="${cls}" data-day="${dayStr}">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${chips}
      </div>`;
  }

  calendarEl.innerHTML = html;
}

// 進入編輯模式：把某活動載入表單（含邀約名單）
function startEditEvent(ev) {
  editingEventId = ev.id;
  editingEventInvites = (ev.invites || []).map((i) => ({ ...i }));
  newEventDate.value = ev.date || "";
  newEventEndDate.value = ev.endDate || "";
  eventMultiday.checked = !!ev.endDate && ev.endDate !== ev.date;
  applyMultidayToggle();
  newEventName.value = ev.name || "";
  newEventType.value = ev.type || EVENT_TYPES[0];
  eventFormMode.textContent = "編輯活動";
  addEventBtn.classList.add("hidden");
  saveEventBtn.classList.remove("hidden");
  deleteEventBtn.classList.remove("hidden");
  cancelEditBtn.classList.remove("hidden");
  inviteSection.classList.remove("hidden"); // 邀約名單只在編輯既有活動時有意義
  newInvitePerson.value = "";
  inviteAiStatus.textContent = "";
  closeInviteNoteEditor();
  renderInviteList();
  newEventName.focus();
}

// 回到新增模式
function resetEventForm() {
  editingEventId = null;
  editingEventInvites = [];
  newEventDate.value = "";
  newEventEndDate.value = "";
  eventMultiday.checked = false;
  applyMultidayToggle();
  newEventName.value = "";
  newEventType.value = EVENT_TYPES[0];
  eventFormMode.textContent = "新增活動";
  addEventBtn.classList.remove("hidden");
  saveEventBtn.classList.add("hidden");
  deleteEventBtn.classList.add("hidden");
  cancelEditBtn.classList.add("hidden");
  inviteSection.classList.add("hidden");
  newInvitePerson.value = "";
  inviteAiStatus.textContent = "";
  closeInviteNoteEditor();
}

// ---------- 活動邀約名單 ----------
function entryName(entryId) {
  return allEntries.find((en) => en.id === entryId)?.name || "";
}

// 其他人（或自己另一分頁）改了同一個活動時，同步刷新開著的邀約名單
function refreshOpenInviteList() {
  if (!editingEventId) return;
  const ev = allEvents.find((x) => x.id === editingEventId);
  if (!ev) return;
  editingEventInvites = (ev.invites || []).map((i) => ({ ...i }));
  renderInviteList();
}

function renderInviteList() {
  // 摘要：各狀態各幾人
  const counts = INVITE_STATUSES.map(
    (s) => `${s} ${editingEventInvites.filter((i) => i.status === s).length}`
  ).join("／");
  inviteSummary.textContent = editingEventInvites.length ? `（${counts}）` : "";

  // 四個狀態各一框，可把人拖到別框改狀態
  inviteBoard.innerHTML = INVITE_STATUSES.map((status) => {
    const members = editingEventInvites.filter((i) => i.status === status);
    const chips = members
      .map((inv) => {
        const name = entryName(inv.entryId);
        const note = (inv.note || "").trim();
        return `
          <div class="invite-chip" draggable="true" data-entry-id="${inv.entryId}">
            <div class="invite-chip-top">
              <span class="invite-chip-name ${name ? "" : "invite-missing"}" title="點一下編輯備註">${escapeHtml(name || "（對象已刪除）")}</span>
              <button type="button" class="invite-remove" title="移除">×</button>
            </div>
            ${note ? `<div class="invite-chip-note" title="${escapeHtml(note)}">${escapeHtml(note)}</div>` : ""}
          </div>`;
      })
      .join("");
    return `
      <div class="invite-col" data-status="${status}">
        <div class="invite-col-head">${status}<span class="invite-col-count">${members.length}</span></div>
        <div class="invite-col-body">${chips || '<div class="invite-col-empty">拖曳名字到這裡</div>'}</div>
      </div>`;
  }).join("");

  // 清單只在使用者正在輸入時才需要更新；沒點進輸入框就不要自己跳出來
  if (document.activeElement === newInvitePerson) renderInviteSuggestions();
}

// 自己做的搜尋清單（不用 <datalist>：中文 IME 輸入時它常常不篩選，等於不能搜尋）
function renderInviteSuggestions() {
  // 只有點進輸入框時才顯示，避免一開啟活動就掛著一張下拉清單
  if (document.activeElement !== newInvitePerson) {
    hideInviteSuggestions();
    return;
  }

  const q = newInvitePerson.value.trim().toLowerCase();
  const invited = new Set(editingEventInvites.map((i) => i.entryId));
  const matches = allEntries
    .filter((en) => !invited.has(en.id))
    .filter((en) => {
      if (!q) return true;
      return [en.name, en.department, getBackground(en)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    })
    .slice(0, 8);

  if (matches.length === 0) {
    inviteSuggestions.innerHTML = q
      ? `<div class="invite-suggestion-empty">找不到「${escapeHtml(newInvitePerson.value.trim())}」</div>`
      : "";
    inviteSuggestions.classList.toggle("hidden", !q);
    return;
  }

  inviteSuggestions.innerHTML = matches
    .map(
      (en) =>
        `<div class="invite-suggestion" data-id="${en.id}">${escapeHtml(en.name)}${
          en.department ? `<span class="suggestion-meta">${escapeHtml(en.department)}</span>` : ""
        }</div>`
    )
    .join("");
  inviteSuggestions.classList.remove("hidden");
}

function hideInviteSuggestions() {
  inviteSuggestions.classList.add("hidden");
}

async function addInviteByEntryId(entryId) {
  if (!entryId || editingEventInvites.some((i) => i.entryId === entryId)) return;
  editingEventInvites.push({ entryId, status: newInviteStatus.value });
  newInvitePerson.value = "";
  inviteAiStatus.textContent = "";
  renderInviteList();
  hideInviteSuggestions();
  await persistInvites();
}

newInvitePerson.addEventListener("input", renderInviteSuggestions);
newInvitePerson.addEventListener("focus", renderInviteSuggestions);
newInvitePerson.addEventListener("blur", () => setTimeout(hideInviteSuggestions, 150));

// 用 mousedown：click 之前 input 會先 blur，會把清單關掉而點不到
inviteSuggestions.addEventListener("mousedown", async (e) => {
  const item = e.target.closest(".invite-suggestion");
  if (!item) return;
  e.preventDefault();
  await addInviteByEntryId(item.dataset.id);
});

async function persistInvites() {
  if (!editingEventId) return;
  try {
    await updateDoc(unitDoc(EVENTS_COLLECTION, editingEventId), {
      invites: editingEventInvites,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    alert("儲存邀約名單失敗：" + err.message);
  }
}

addInviteBtn.addEventListener("click", async () => {
  const typed = newInvitePerson.value.trim();
  if (!typed) {
    newInvitePerson.focus();
    return;
  }
  const invited = new Set(editingEventInvites.map((i) => i.entryId));
  const notInvited = allEntries.filter((en) => !invited.has(en.id));
  // 先找完全相同的姓名，其次接受部分輸入（只在唯一時才自動選，避免加錯人）
  const exact = notInvited.find((en) => (en.name || "").trim() === typed);
  const partial = notInvited.filter((en) => (en.name || "").includes(typed));
  const match = exact || (partial.length === 1 ? partial[0] : null);

  if (!match) {
    if (allEntries.some((en) => (en.name || "").trim() === typed)) {
      inviteAiStatus.textContent = `「${typed}」已經在邀約名單裡了。`;
    } else if (partial.length > 1) {
      inviteAiStatus.textContent = `符合「${typed}」的有多位，請從清單中點選。`;
    } else {
      inviteAiStatus.textContent = `名單上找不到「${typed}」，請確認姓名或先新增這位對象。`;
    }
    newInvitePerson.focus();
    return;
  }
  await addInviteByEntryId(match.id);
});

// Enter 直接加入，不用移到按鈕
newInvitePerson.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    addInviteBtn.click();
  }
});

inviteBoard.addEventListener("click", async (e) => {
  const chip = e.target.closest(".invite-chip");
  if (!chip) return;

  if (e.target.closest(".invite-remove")) {
    editingEventInvites = editingEventInvites.filter((i) => i.entryId !== chip.dataset.entryId);
    closeInviteNoteEditor();
    renderInviteList();
    await persistInvites();
    return;
  }

  // 點名字：在下方的編輯區改備註（不擠在名字旁邊）
  if (e.target.closest(".invite-chip-name")) openInviteNoteEditor(chip.dataset.entryId);
});

// ---------- 邀約備註（在看板下方編輯） ----------
let noteEditingEntryId = null;

function openInviteNoteEditor(entryId) {
  const inv = editingEventInvites.find((i) => i.entryId === entryId);
  if (!inv) return;
  noteEditingEntryId = entryId;
  inviteNoteName.textContent = entryName(entryId) || "（對象已刪除）";
  inviteNoteText.value = inv.note || "";
  inviteNoteEditor.classList.remove("hidden");
  inviteNoteText.focus();
}

function closeInviteNoteEditor() {
  noteEditingEntryId = null;
  inviteNoteEditor.classList.add("hidden");
  inviteNoteText.value = "";
}

inviteNoteSave.addEventListener("click", async () => {
  if (!noteEditingEntryId) return;
  const inv = editingEventInvites.find((i) => i.entryId === noteEditingEntryId);
  if (inv) inv.note = inviteNoteText.value.trim();
  closeInviteNoteEditor();
  renderInviteList();
  await persistInvites();
});

inviteNoteCancel.addEventListener("click", closeInviteNoteEditor);

// ---------- 邀約名單：拖到別框改變狀態 ----------
let dragInviteEntryId = null;

inviteBoard.addEventListener("dragstart", (e) => {
  const chip = e.target.closest(".invite-chip");
  if (!chip) return;
  dragInviteEntryId = chip.dataset.entryId;
  chip.classList.add("dragging");
});

inviteBoard.addEventListener("dragend", (e) => {
  e.target.closest(".invite-chip")?.classList.remove("dragging");
  inviteBoard.querySelectorAll(".invite-col").forEach((c) => c.classList.remove("drop-target"));
  dragInviteEntryId = null;
});

inviteBoard.addEventListener("dragover", (e) => {
  if (!dragInviteEntryId) return;
  const col = e.target.closest(".invite-col");
  if (!col) return;
  e.preventDefault(); // 允許放下
  inviteBoard.querySelectorAll(".invite-col").forEach((c) => c.classList.toggle("drop-target", c === col));
});

inviteBoard.addEventListener("drop", async (e) => {
  const col = e.target.closest(".invite-col");
  if (!col || !dragInviteEntryId) return;
  e.preventDefault();
  const inv = editingEventInvites.find((i) => i.entryId === dragInviteEntryId);
  dragInviteEntryId = null;
  if (!inv || inv.status === col.dataset.status) {
    renderInviteList();
    return;
  }
  inv.status = col.dataset.status;
  renderInviteList();
  await persistInvites();
});

// ---------- AI 建議邀約：挑出適合這個活動的對象，加進「預定邀約」 ----------
aiInviteBtn.addEventListener("click", async () => {
  const ev = allEvents.find((x) => x.id === editingEventId);
  if (!ev) return;

  inviteAiStatus.textContent = "AI 分析中，請稍候...";
  aiInviteBtn.disabled = true;
  try {
    const apiKey = await getSharedApiKey();
    if (!apiKey) {
      throw new Error(
        "尚未設定共用 API Key。請管理員到 Firebase Console 的 Firestore 建立 config 集合下的 ai 文件，欄位 anthropicApiKey 填入 Key（詳見 README）。"
      );
    }
    // 只把「還沒加進邀約名單」的人送給 AI；用 ref 對應回來，避免同名混淆
    const invited = new Set(editingEventInvites.map((i) => i.entryId));
    const candidates = allEntries.filter((en) => !invited.has(en.id));
    if (candidates.length === 0) {
      inviteAiStatus.textContent = "名單上的人都已經在邀約名單裡了。";
      return;
    }
    const { forward } = buildNameMap();
    const roster = candidates.map((en, i) => ({ ref: i + 1, ...maskEntry(en, forward) }));
    const result = await suggestInvitees(
      apiKey,
      {
        name: maskNames(ev.name, forward),
        date: ev.date,
        endDate: ev.endDate,
        type: ev.type,
      },
      roster
    );

    const added = [];
    (result.invitees || []).forEach((s) => {
      const cand = candidates[s.ref - 1];
      if (!cand || editingEventInvites.some((i) => i.entryId === cand.id)) return;
      editingEventInvites.push({ entryId: cand.id, status: "預定邀約" });
      added.push(`${cand.name}（${s.reason}）`);
    });

    if (added.length === 0) {
      inviteAiStatus.textContent = "AI 認為目前名單中沒有特別適合這個活動的對象。";
      return;
    }
    renderInviteList();
    await persistInvites();
    inviteAiStatus.textContent = `已加入預定邀約：${added.join("、")}`;
  } catch (err) {
    inviteAiStatus.textContent = aiErrorMessage(err, "AI 建議失敗");
  } finally {
    aiInviteBtn.disabled = false;
  }
});

// 點月曆：點活動→編輯；點空白日期格→帶入該天為開始日期，方便新增
calendarEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".cal-event");
  if (chip) {
    const ev = allEvents.find((x) => x.id === chip.dataset.id);
    if (ev) startEditEvent(ev);
    return;
  }
  const cell = e.target.closest(".cal-cell[data-day]");
  if (cell && !editingEventId) {
    newEventDate.value = cell.dataset.day;
    newEventName.focus();
  }
});

function validEventInput() {
  const name = newEventName.value.trim();
  const date = newEventDate.value;
  const endDate = newEventEndDate.value;
  if (!name || !date) {
    (!date ? newEventDate : newEventName).focus();
    return null;
  }
  if (endDate && endDate < date) {
    alert("結束日期不能早於開始日期。");
    newEventEndDate.focus();
    return null;
  }
  return { name, date, endDate, type: newEventType.value };
}

addEventBtn.addEventListener("click", async () => {
  const data = validEventInput();
  if (!data) return;
  try {
    await addDoc(unitCol(EVENTS_COLLECTION), {
      ...data,
      invites: [],
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.email || null,
    });
    resetEventForm();
  } catch (err) {
    alert("新增活動失敗：" + err.message);
  }
});

saveEventBtn.addEventListener("click", async () => {
  if (!editingEventId) return;
  const data = validEventInput();
  if (!data) return;
  try {
    await updateDoc(unitDoc(EVENTS_COLLECTION, editingEventId), {
      ...data,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
    resetEventForm();
  } catch (err) {
    alert("儲存活動失敗：" + err.message);
  }
});

deleteEventBtn.addEventListener("click", async () => {
  if (!editingEventId) return;
  if (!confirm(`確定刪除活動「${newEventName.value.trim()}」？`)) return;
  try {
    await deleteDoc(unitDoc(EVENTS_COLLECTION, editingEventId));
    resetEventForm();
  } catch (err) {
    alert("刪除活動失敗：" + err.message);
  }
});

cancelEditBtn.addEventListener("click", resetEventForm);

calPrevBtn.addEventListener("click", () => {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
  renderCalendar();
});
calNextBtn.addEventListener("click", () => {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
  renderCalendar();
});
calTodayBtn.addEventListener("click", () => {
  calCursor = firstOfMonth(new Date());
  renderCalendar();
});

eventsManageBtn.addEventListener("click", () => {
  resetEventForm();
  calCursor = firstOfMonth(new Date());
  renderCalendar();
  eventsModal.classList.remove("hidden");
});
eventsCloseBtn.addEventListener("click", () => eventsModal.classList.add("hidden"));
eventsModal.addEventListener("click", (e) => {
  if (e.target === eventsModal) eventsModal.classList.add("hidden");
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
    // 共用 Key 存在 Firestore config/ai，由安全規則保護
    const apiKey = await getSharedApiKey();
    if (!apiKey) {
      throw new Error(
        "尚未設定共用 API Key。請管理員到 Firebase Console 的 Firestore 建立 config 集合下的 ai 文件，欄位 anthropicApiKey 填入 Key（詳見 README）。"
      );
    }
    // 送 AI 前把姓名/聯絡人（含背景等欄位裡提到的名單成員）換成代號；AI 回覆後再換回真名
    const { forward, reverse } = buildNameMap();
    const suggestion = await generateSuggestion(
      apiKey,
      maskEntry(entry, forward),
      maskNames(aiGuidance.value.trim(), forward),
      maskedUpcomingEvents(forward)
    );
    aiLastSuggestion = {
      strategy: unmaskNames(suggestion.strategy, reverse),
      method: unmaskNames(suggestion.method, reverse),
      recommendedActivity: unmaskNames(suggestion.recommendedActivity || "", reverse),
    };
    aiResultStrategy.textContent = aiLastSuggestion.strategy;
    aiResultMethod.textContent = aiLastSuggestion.method;
    aiResultActivity.textContent = aiLastSuggestion.recommendedActivity || "（近期無合適活動）";
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
    await updateDoc(entryRef(aiModalEntryId), {
      strategy: aiLastSuggestion.strategy,
      method: aiLastSuggestion.method,
      recommendedActivity: aiLastSuggestion.recommendedActivity || "",
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
// 對話紀錄存在 units/{unitId}/chatHistories/{uid}，每位使用者一份、只有本人讀得到，
// 重新整理或換裝置都還在。內容以真名保存（與名單同等級的資料，受同一份安全規則保護）。
let chatHistory = [];
let chatBusy = false;

async function loadChatHistory() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const snap = await getDoc(unitDoc(CHAT_COLLECTION, uid));
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
    await setDoc(unitDoc(CHAT_COLLECTION, uid), {
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
    const reply = await chatWithAgent(apiKey, roster, apiHistory, maskedUpcomingEvents(forward));
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
