import "./style.css";
import { auth, db } from "./firebase.js";
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
const filterBackground = document.getElementById("filter-background");
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
const addActivityBtn = document.getElementById("add-activity-btn");
const activitiesList = document.getElementById("activities-list");

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
      updateStatusFilterOptions();
      renderTable();
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

function updateStatusFilterOptions() {
  const current = filterStatus.value;
  const statuses = [...new Set(allEntries.map((e) => e.status).filter(Boolean))].sort();
  filterStatus.innerHTML = '<option value="">所有成全狀況</option>';
  statuses.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    filterStatus.appendChild(opt);
  });
  if (statuses.includes(current)) filterStatus.value = current;
}

// ---------- Render ----------
function renderTable() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const statusVal = filterStatus.value;
  const backgroundVal = filterBackground.value;

  const filtered = allEntries.filter((entry) => {
    if (statusVal && entry.status !== statusVal) return false;
    if (backgroundVal && getBackground(entry) !== backgroundVal) return false;
    if (searchTerm) {
      const haystack = [entry.name, entry.department, entry.contact]
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
filterBackground.addEventListener("change", renderTable);

// ---------- 活動紀錄（modal 內的動態列） ----------
function addActivityRow(activity = {}) {
  const row = document.createElement("div");
  row.className = "activity-row";
  row.innerHTML = `
    <input type="text" class="act-field-name" placeholder="活動名稱" />
    <input type="text" class="act-field-date" placeholder="日期(選填)" />
    <input type="text" class="act-field-reaction" placeholder="反應 / 回饋" />
    <button type="button" class="btn-danger btn-small act-remove">✕</button>
  `;
  row.querySelector(".act-field-name").value = activity.activity || "";
  row.querySelector(".act-field-date").value = activity.date || "";
  row.querySelector(".act-field-reaction").value = activity.reaction || "";
  activitiesList.appendChild(row);
}

function renderActivityRows(activities) {
  activitiesList.innerHTML = "";
  (activities || []).forEach((a) => addActivityRow(a));
}

function collectActivities() {
  return [...activitiesList.querySelectorAll(".activity-row")]
    .map((row) => ({
      activity: row.querySelector(".act-field-name").value.trim(),
      date: row.querySelector(".act-field-date").value.trim(),
      reaction: row.querySelector(".act-field-reaction").value.trim(),
    }))
    .filter((a) => a.activity || a.reaction);
}

addActivityBtn.addEventListener("click", () => addActivityRow());
activitiesList.addEventListener("click", (e) => {
  if (e.target.closest(".act-remove")) {
    e.target.closest(".activity-row").remove();
  }
});

// ---------- Modal open/close ----------
function openModal(entry = null) {
  entryForm.reset();
  if (entry) {
    modalTitle.textContent = "編輯名單";
    fieldId.value = entry.id;
    fieldName.value = entry.name || "";
    fieldDepartment.value = entry.department || "";
    fieldBackground.value = getBackground(entry) || "社團";
    fieldNotes.value = entry.notes || "";
    fieldContact.value = entry.contact || "";
    fieldStatus.value = entry.status || "";
    fieldStrategy.value = entry.strategy || "";
    fieldMethod.value = entry.method || "";
    renderActivityRows(entry.activities);
  } else {
    modalTitle.textContent = "新增名單";
    fieldId.value = "";
    renderActivityRows([]);
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
  const data = {
    name: fieldName.value.trim(),
    department: fieldDepartment.value.trim(),
    background: fieldBackground.value,
    notes: fieldNotes.value.trim(),
    contact: fieldContact.value.trim(),
    status: fieldStatus.value.trim(),
    strategy: fieldStrategy.value.trim(),
    method: fieldMethod.value.trim(),
    activities: collectActivities(),
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
