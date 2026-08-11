// 班務系統：跟道務系統分開的名單與紀錄。
//
// 兩邊的差別：
//   道務：成全對象 → 活動 → 活動紀錄／聯絡紀錄 → 熱度、參與度…
//   班務：班員／護班人員 → 課程 → 上課紀錄（班員記學習狀況、護班記承擔狀況）
//
// 名單不共用，但新增班務名單時可以查道務名單並「關聯」過去，之後兩邊看得到彼此。
import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "./firebase.js";

export const CLASS_GROUPS = ["新民", "至善", "行德", "崇德", "人才儲訓", "講培", "講師"];
export const MEMBER_TYPES = ["班員", "護班人員"];
export const ATTEND_OPTIONS = ["準時", "遲到", "請假", "缺席"];

const ENTRIES = "classEntries";
const COURSES = "courses";

// 由 main.js 注入：目前單位路徑、道務名單的姓名索引等
let ctx = null;

let classEntries = [];
let courses = [];
let unsubEntries = null;
let unsubCourses = null;

// 目前開著的紀錄視窗
let lessonEntryId = null;
let lessonRows = [];
let editingClassId = null;
let editingCourseId = null;
let linkedPick = { id: "", name: "" };

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function col(name) {
  return collection(db, "units", ctx.unitId(), name);
}
function ref(name, id) {
  return doc(db, "units", ctx.unitId(), name, id);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- 訂閱 ----------
export function startClassroom(context) {
  ctx = context;
  stopClassroom();

  unsubEntries = onSnapshot(
    col(ENTRIES),
    (snap) => {
      classEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderClassList();
      if (lessonEntryId) refreshLessonModal();
    },
    (err) => {
      if (err.code !== "permission-denied") console.error(err);
    }
  );

  unsubCourses = onSnapshot(
    col(COURSES),
    (snap) => {
      courses = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      renderCourseList();
      renderCourseOptions();
      renderClassList();
    },
    (err) => {
      if (err.code !== "permission-denied") console.error(err);
    }
  );
}

export function stopClassroom() {
  if (unsubEntries) unsubEntries();
  if (unsubCourses) unsubCourses();
  unsubEntries = null;
  unsubCourses = null;
  classEntries = [];
  courses = [];
}

// ---------- 名單 ----------
function visibleClassEntries() {
  const q = $("class-search").value.trim().toLowerCase();
  const group = $("class-filter-group").value;
  const type = $("class-filter-type").value;
  return classEntries
    .filter((en) => !group || en.classGroup === group)
    .filter((en) => !type || en.memberType === type)
    .filter((en) => {
      if (!q) return true;
      return [en.name, en.department, en.linkedName, en.note]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    })
    .sort(
      (a, b) =>
        CLASS_GROUPS.indexOf(a.classGroup) - CLASS_GROUPS.indexOf(b.classGroup) ||
        (a.name || "").localeCompare(b.name || "")
    );
}

// 這個人最近一次上課紀錄的摘要
function lastLessonText(entry) {
  const lessons = [...(entry.lessons || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (lessons.length === 0) return "尚無上課紀錄";
  const l = lessons[0];
  const bits = [l.date, l.course].filter(Boolean);
  if (entry.memberType === "護班人員") {
    if (l.attend) bits.push(l.attend);
    if (l.duties) bits.push(l.duties);
  } else {
    if (l.attend) bits.push(l.attend);
    if (l.tookNotes) bits.push("有筆記");
    if (l.asked) bits.push("有提問");
  }
  return bits.join("・");
}

function renderClassList() {
  const list = $("class-list");
  if (!list) return;
  const entries = visibleClassEntries();
  if (entries.length === 0) {
    list.innerHTML = `<p class="empty-text">${classEntries.length === 0 ? "尚無班務名單" : "沒有符合條件的人"}</p>`;
    return;
  }
  list.innerHTML = entries
    .map((en) => {
      const lessons = (en.lessons || []).length;
      return `
      <div class="person-card class-card" data-id="${en.id}">
        <div class="class-card-head">
          <span class="class-name">${esc(en.name)}</span>
          <span class="class-badge group-${esc(en.classGroup || "")}">${esc(en.classGroup || "未分班")}</span>
          <span class="class-badge type-${en.memberType === "護班人員" ? "hu" : "ban"}">${esc(en.memberType || "班員")}</span>
          ${en.gender ? `<span class="gender-badge ${en.gender === "坤" ? "gender-kun" : "gender-qian"}">${esc(en.gender)}</span>` : ""}
        </div>
        <div class="class-card-meta">
          ${en.department ? `<span>${esc(en.department)}</span>` : ""}
          ${en.linkedName ? `<span class="linked-badge" title="已關聯道務名單">道務：${esc(en.linkedName)}</span>` : ""}
          <span>${lessons} 筆上課紀錄</span>
        </div>
        <div class="class-card-note">${esc(lastLessonText(en))}</div>
        ${en.note ? `<div class="class-card-note">${esc(en.note)}</div>` : ""}
        <div class="row-actions card-actions">
          <button data-class-action="lessons" data-id="${en.id}" class="btn-secondary">上課紀錄</button>
          <button data-class-action="edit" data-id="${en.id}" class="btn-secondary">編輯</button>
        </div>
      </div>`;
    })
    .join("");
}

// ---------- 新增／編輯名單 ----------
function openClassModal(entry = null) {
  editingClassId = entry?.id || null;
  $("class-modal-title").textContent = entry ? "編輯班務名單" : "新增班務名單";
  $("class-field-name").value = entry?.name || "";
  $("class-field-gender").value = entry?.gender || "";
  $("class-field-department").value = entry?.department || "";
  $("class-field-group").value = entry?.classGroup || CLASS_GROUPS[0];
  $("class-field-type").value = entry?.memberType || MEMBER_TYPES[0];
  $("class-field-note").value = entry?.note || "";
  linkedPick = { id: entry?.linkedEntryId || "", name: entry?.linkedName || "" };
  $("class-link-search").value = "";
  $("class-link-results").innerHTML = "";
  renderLinkedPick();
  $("class-delete-btn").classList.toggle("hidden", !entry);
  $("class-modal").classList.remove("hidden");
  $("class-field-name").focus();
}

function renderLinkedPick() {
  const el = $("class-linked-current");
  el.innerHTML = linkedPick.id
    ? `已關聯道務名單：<strong>${esc(linkedPick.name)}</strong>
       <button type="button" class="btn-link-plain" id="class-link-clear">取消關聯</button>`
    : `<span class="hint-text">尚未關聯道務名單（可留空）</span>`;
}

function renderLinkResults() {
  const q = $("class-link-search").value.trim().toLowerCase();
  const matches = ctx
    .daoNames()
    .filter((p) => !q || (p.name || "").toLowerCase().includes(q))
    .slice(0, 8);
  $("class-link-results").innerHTML = matches.length
    ? matches
        .map(
          (p) =>
            `<button type="button" class="bind-result" data-link-id="${esc(p.id)}" data-link-name="${esc(p.name || "")}">${esc(p.name)}${
              p.department ? `<span class="suggestion-meta">${esc(p.department)}</span>` : ""
            }</button>`
        )
        .join("")
    : `<p class="hint-text">${q ? `道務名單裡找不到「${esc($("class-link-search").value.trim())}」` : "輸入姓名搜尋道務名單"}</p>`;
}

async function saveClassEntry() {
  const name = $("class-field-name").value.trim();
  if (!name) {
    $("class-field-name").focus();
    return;
  }
  const data = {
    name,
    gender: $("class-field-gender").value,
    department: $("class-field-department").value.trim(),
    classGroup: $("class-field-group").value,
    memberType: $("class-field-type").value,
    linkedEntryId: linkedPick.id || null,
    linkedName: linkedPick.name || "",
    note: $("class-field-note").value.trim(),
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.email || null,
  };
  try {
    if (editingClassId) {
      await updateDoc(ref(ENTRIES, editingClassId), data);
    } else {
      await addDoc(col(ENTRIES), {
        ...data,
        lessons: [],
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser?.email || null,
      });
    }
    $("class-modal").classList.add("hidden");
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
}

async function deleteClassEntry() {
  const entry = classEntries.find((e) => e.id === editingClassId);
  if (!entry) return;
  const lessons = (entry.lessons || []).length;
  if (
    !confirm(
      `確定要刪除「${entry.name}」嗎？${lessons ? `\n會連同 ${lessons} 筆上課紀錄一起刪掉。` : ""}\n\n此動作無法復原。`
    )
  ) {
    return;
  }
  const typed = prompt(`再確認一次：請輸入「${entry.name}」以完成刪除。`, "");
  if (typed === null) return;
  if (typed.trim() !== entry.name.trim()) {
    alert("輸入的姓名不符，已取消刪除。");
    return;
  }
  try {
    await deleteDoc(ref(ENTRIES, entry.id));
    $("class-modal").classList.add("hidden");
  } catch (err) {
    alert("刪除失敗：" + err.message);
  }
}

// ---------- 課程 ----------
function renderCourseOptions() {
  const sel = $("lesson-course");
  if (!sel) return;
  sel.innerHTML =
    `<option value="">（未對應課程）</option>` +
    courses
      .map((c) => `<option value="${esc(c.name)}">${esc(c.date || "")} ${esc(c.name)}</option>`)
      .join("");
}

function renderCourseList() {
  const list = $("course-list");
  if (!list) return;
  list.innerHTML = courses.length
    ? courses
        .map(
          (c) => `
        <div class="course-row" data-id="${c.id}">
          <div class="course-info">
            <span class="course-date">${esc(c.date || "未定")}</span>
            <span class="course-name">${esc(c.name)}</span>
            <span class="class-badge group-${esc(c.classGroup || "")}">${esc(c.classGroup || "全班")}</span>
          </div>
          <div class="course-actions">
            <button type="button" class="btn-secondary btn-small" data-course-edit="${c.id}">編輯</button>
            <button type="button" class="btn-danger btn-small" data-course-del="${c.id}">刪除</button>
          </div>
        </div>`
        )
        .join("")
    : `<p class="hint-text">還沒有課程。</p>`;
}

function resetCourseForm() {
  editingCourseId = null;
  $("course-date").value = today();
  $("course-name").value = "";
  $("course-group").value = CLASS_GROUPS[0];
  $("course-save-btn").textContent = "新增課程";
}

async function saveCourse() {
  const name = $("course-name").value.trim();
  const date = $("course-date").value;
  if (!name || !date) {
    (!name ? $("course-name") : $("course-date")).focus();
    return;
  }
  const data = {
    name,
    date,
    classGroup: $("course-group").value,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.email || null,
  };
  try {
    if (editingCourseId) await updateDoc(ref(COURSES, editingCourseId), data);
    else
      await addDoc(col(COURSES), {
        ...data,
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser?.email || null,
      });
    resetCourseForm();
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
}

// ---------- 上課紀錄 ----------
function openLessonModal(entry) {
  lessonEntryId = entry.id;
  lessonRows = [...(entry.lessons || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("lesson-modal-name").textContent = `${entry.name}（${entry.memberType || "班員"}）`;
  $("lesson-date").value = today();
  $("lesson-course").value = "";
  $("lesson-attend").value = ATTEND_OPTIONS[0];
  $("lesson-notes").checked = false;
  $("lesson-asked").checked = false;
  $("lesson-interaction").value = "";
  $("lesson-duties").value = "";
  $("lesson-comment").value = "";
  applyLessonFields(entry.memberType);
  renderLessonRows(entry.memberType);
  $("lesson-modal").classList.remove("hidden");
}

// 班員記學習狀況、護班人員記承擔狀況，欄位不一樣
function applyLessonFields(memberType) {
  const isHu = memberType === "護班人員";
  $("lesson-ban-fields").classList.toggle("hidden", isHu);
  $("lesson-hu-fields").classList.toggle("hidden", !isHu);
}

function renderLessonRows(memberType) {
  const isHu = memberType === "護班人員";
  $("lesson-list").innerHTML = lessonRows.length
    ? lessonRows
        .map((l, i) => {
          const chips = isHu
            ? [
                l.attend ? `<span class="lesson-chip">${esc(l.attend)}</span>` : "",
                l.duties ? `<span class="lesson-chip">${esc(l.duties)}</span>` : "",
              ]
            : [
                l.attend ? `<span class="lesson-chip">${esc(l.attend)}</span>` : "",
                l.tookNotes ? `<span class="lesson-chip is-on">寫筆記</span>` : "",
                l.asked ? `<span class="lesson-chip is-on">有提問</span>` : "",
              ];
          const detail = isHu ? l.interaction : "";
          return `
          <div class="lesson-row">
            <div class="lesson-row-head">
              <span class="lesson-date">${esc(l.date || "未填日期")}</span>
              <span class="lesson-course">${esc(l.course || "")}</span>
              ${chips.join("")}
              <button type="button" class="btn-danger btn-small" data-lesson-del="${i}">刪除</button>
            </div>
            ${detail ? `<div class="lesson-detail">互動：${esc(detail)}</div>` : ""}
            ${l.comment ? `<div class="lesson-detail">${esc(l.comment)}</div>` : ""}
          </div>`;
        })
        .join("")
    : `<p class="hint-text">還沒有上課紀錄。</p>`;
}

function refreshLessonModal() {
  const entry = classEntries.find((e) => e.id === lessonEntryId);
  if (!entry) return;
  lessonRows = [...(entry.lessons || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  renderLessonRows(entry.memberType);
}

async function saveLessons() {
  if (!lessonEntryId) return;
  await updateDoc(ref(ENTRIES, lessonEntryId), {
    lessons: lessonRows,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.email || null,
  });
}

async function addLesson() {
  const entry = classEntries.find((e) => e.id === lessonEntryId);
  if (!entry) return;
  const isHu = entry.memberType === "護班人員";
  const row = {
    date: $("lesson-date").value || today(),
    course: $("lesson-course").value,
    attend: $("lesson-attend").value,
    comment: $("lesson-comment").value.trim(),
  };
  if (isHu) {
    row.interaction = $("lesson-interaction").value.trim();
    row.duties = $("lesson-duties").value.trim();
  } else {
    row.tookNotes = $("lesson-notes").checked;
    row.asked = $("lesson-asked").checked;
  }
  lessonRows = [row, ...lessonRows];
  try {
    await saveLessons();
    $("lesson-comment").value = "";
    $("lesson-interaction").value = "";
    $("lesson-duties").value = "";
    $("lesson-notes").checked = false;
    $("lesson-asked").checked = false;
    renderLessonRows(entry.memberType);
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
}

// ---------- 事件綁定（只做一次） ----------
export function initClassroom(context) {
  ctx = context;

  $("class-search").addEventListener("input", renderClassList);
  $("class-filter-group").addEventListener("change", renderClassList);
  $("class-filter-type").addEventListener("change", renderClassList);

  $("class-add-btn").addEventListener("click", () => openClassModal());
  $("class-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-class-action]");
    if (!btn) return;
    const entry = classEntries.find((x) => x.id === btn.dataset.id);
    if (!entry) return;
    if (btn.dataset.classAction === "edit") openClassModal(entry);
    else openLessonModal(entry);
  });

  // 新增／編輯名單
  $("class-save-btn").addEventListener("click", saveClassEntry);
  $("class-delete-btn").addEventListener("click", deleteClassEntry);
  $("class-cancel-btn").addEventListener("click", () => $("class-modal").classList.add("hidden"));
  $("class-close-x").addEventListener("click", () => $("class-modal").classList.add("hidden"));
  $("class-modal").addEventListener("click", (e) => {
    if (e.target === $("class-modal")) $("class-modal").classList.add("hidden");
  });
  $("class-field-type").addEventListener("change", () => {
    // 換身分時，紀錄欄位的種類也跟著換（下次開紀錄視窗才會用到）
    applyLessonFields($("class-field-type").value);
  });

  // 關聯道務名單
  $("class-link-search").addEventListener("input", renderLinkResults);
  $("class-link-search").addEventListener("focus", renderLinkResults);
  $("class-link-results").addEventListener("mousedown", (e) => {
    const btn = e.target.closest("[data-link-id]");
    if (!btn) return;
    e.preventDefault();
    linkedPick = { id: btn.dataset.linkId, name: btn.dataset.linkName };
    $("class-link-search").value = "";
    $("class-link-results").innerHTML = "";
    renderLinkedPick();
  });
  $("class-linked-current").addEventListener("click", (e) => {
    if (!e.target.closest("#class-link-clear")) return;
    linkedPick = { id: "", name: "" };
    renderLinkedPick();
  });

  // 課程
  $("course-manage-btn").addEventListener("click", () => {
    resetCourseForm();
    $("course-modal").classList.remove("hidden");
  });
  $("course-close-x").addEventListener("click", () => $("course-modal").classList.add("hidden"));
  $("course-modal").addEventListener("click", (e) => {
    if (e.target === $("course-modal")) $("course-modal").classList.add("hidden");
  });
  $("course-save-btn").addEventListener("click", saveCourse);
  $("course-list").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-course-edit]");
    if (edit) {
      const c = courses.find((x) => x.id === edit.dataset.courseEdit);
      if (!c) return;
      editingCourseId = c.id;
      $("course-date").value = c.date || "";
      $("course-name").value = c.name || "";
      $("course-group").value = c.classGroup || CLASS_GROUPS[0];
      $("course-save-btn").textContent = "儲存變更";
      return;
    }
    const del = e.target.closest("[data-course-del]");
    if (!del) return;
    const c = courses.find((x) => x.id === del.dataset.courseDel);
    if (!c || !confirm(`確定要刪除課程「${c.name}」嗎？\n\n已經寫進個人上課紀錄的內容不受影響。`)) return;
    try {
      await deleteDoc(ref(COURSES, c.id));
      if (editingCourseId === c.id) resetCourseForm();
    } catch (err) {
      alert("刪除失敗：" + err.message);
    }
  });

  // 上課紀錄
  $("lesson-close-x").addEventListener("click", () => {
    $("lesson-modal").classList.add("hidden");
    lessonEntryId = null;
  });
  $("lesson-modal").addEventListener("click", (e) => {
    if (e.target === $("lesson-modal")) $("lesson-close-x").click();
  });
  $("lesson-add-btn").addEventListener("click", addLesson);
  $("lesson-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-lesson-del]");
    if (!btn) return;
    const entry = classEntries.find((x) => x.id === lessonEntryId);
    if (!entry || !confirm("確定要刪除這筆上課紀錄嗎？")) return;
    lessonRows.splice(Number(btn.dataset.lessonDel), 1);
    try {
      await saveLessons();
      renderLessonRows(entry.memberType);
    } catch (err) {
      alert("刪除失敗：" + err.message);
    }
  });
}

// 給道務那邊查「這個人在班務系統的班別」用
export function classInfoFor(daoEntryId) {
  return classEntries.find((c) => c.linkedEntryId === daoEntryId) || null;
}

