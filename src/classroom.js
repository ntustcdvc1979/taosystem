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
  getDocs,
  onSnapshot,
  query,
  where,
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
// 新增／編輯視窗裡正在編的「班別＋身分」清單（一個人可以有好幾組）
let roleRows = [];

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
      reconcileProfiles();
      ctx.onLessonsChanged?.();
    },
    (err) => {
      if (err.code !== "permission-denied") console.error(err);
    }
  );

  unsubCourses = onSnapshot(
    col(COURSES),
    (snap) => {
      // 依日期由舊到新：課程是照著上下去的，順著看才對得上進度
      courses = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
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
// 一個人可以同時在好幾個班、而且每個班的身分未必一樣（新民的班員、至善的護班人員）。
// 舊資料只有單一的 classGroup／memberType，讀的時候一律轉成同一種形狀。
export function entryRoles(entry) {
  const roles = Array.isArray(entry?.roles)
    ? entry.roles.filter((r) => r && r.group)
    : [];
  if (roles.length) return roles.map((r) => ({ group: r.group, type: r.type || MEMBER_TYPES[0] }));
  return [{ group: entry?.classGroup || "", type: entry?.memberType || MEMBER_TYPES[0] }];
}

function roleLabel(role) {
  return `${role.group || "未分班"}・${role.type || MEMBER_TYPES[0]}`;
}

// 名單排序用：他最前面的那個班在班別清單裡的位置
function firstGroupOrder(entry) {
  return Math.min(
    ...entryRoles(entry).map((r) => {
      const i = CLASS_GROUPS.indexOf(r.group);
      return i < 0 ? CLASS_GROUPS.length : i;
    })
  );
}

function visibleClassEntries() {
  const q = $("class-search").value.trim().toLowerCase();
  const group = $("class-filter-group").value;
  const type = $("class-filter-type").value;
  return classEntries
    .filter((en) =>
      // 挑某個班別＝該班的班員與護班人員都算；兩個條件一起用時要同一組角色同時符合
      entryRoles(en).some((r) => (!group || r.group === group) && (!type || r.type === type))
    )
    .filter((en) => {
      if (!q) return true;
      return [en.name, en.department, en.linkedName, en.note, ...entryRoles(en).map(roleLabel)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    })
    .sort(
      (a, b) => firstGroupOrder(a) - firstGroupOrder(b) || (a.name || "").localeCompare(b.name || "")
    );
}

// 每一筆上課紀錄記在哪一班、以什麼身分（舊紀錄沒有就用名單上的第一個角色頂著）
function lessonRole(entry, lesson) {
  if (lesson?.group || lesson?.type) {
    return { group: lesson.group || "", type: lesson.type || MEMBER_TYPES[0] };
  }
  return entryRoles(entry)[0];
}

// 這個人最近一次上課紀錄的摘要
function lastLessonText(entry) {
  const lessons = [...(entry.lessons || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (lessons.length === 0) return "尚無上課紀錄";
  const l = lessons[0];
  const role = lessonRole(entry, l);
  const bits = [l.date, l.course].filter(Boolean);
  if (role.type === "護班人員") {
    if (l.attend) bits.push(l.attend);
    if (l.duties) bits.push(l.duties);
  } else {
    if (l.attend) bits.push(l.attend);
    if (l.tookNotes) bits.push("有筆記");
    if (l.asked) bits.push("有提問");
  }
  return bits.join("・");
}

function roleBadges(entry, highlightGroup) {
  return entryRoles(entry)
    .map((r) => {
      const hit = highlightGroup && r.group === highlightGroup ? " is-match" : "";
      return `<span class="class-badge role-badge type-${r.type === "護班人員" ? "hu" : "ban"}${hit}">
        <span class="role-group">${esc(r.group || "未分班")}</span>${esc(r.type || MEMBER_TYPES[0])}</span>`;
    })
    .join("");
}

function renderClassList() {
  const list = $("class-list");
  if (!list) return;
  const entries = visibleClassEntries();
  const group = $("class-filter-group").value;
  const count = $("class-count");
  if (count) {
    count.textContent = classEntries.length
      ? `${entries.length} / ${classEntries.length} 人`
      : "";
  }
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
          ${roleBadges(en, group)}
          ${en.gender ? `<span class="gender-badge ${en.gender === "坤" ? "gender-kun" : "gender-qian"}">${esc(en.gender)}</span>` : ""}
        </div>
        <div class="class-card-meta">
          ${en.department ? `<span>${esc(en.department)}</span>` : ""}
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
  $("class-modal-title").textContent = entry ? "編輯名單" : "新增名單";
  $("class-field-name").value = entry?.name || "";
  $("class-field-gender").value = entry?.gender || "";
  $("class-field-department").value = entry?.department || "";
  // 目前工具列選著哪個班，新增時就先帶那個班
  const preset = $("class-filter-group").value;
  roleRows = entry
    ? entryRoles(entry).map((r) => ({ ...r }))
    : [{ group: preset || CLASS_GROUPS[0], type: MEMBER_TYPES[0] }];
  renderRoleRows();
  $("class-field-note").value = entry?.note || "";
  linkedPick = { id: entry?.linkedEntryId || "", name: entry?.linkedName || "" };
  hideNameSuggest();
  renderLinkedPick();
  $("class-delete-btn").classList.toggle("hidden", !entry);
  $("class-modal").classList.remove("hidden");
  $("class-field-name").focus();
}

// 「班別＋身分」一組一列，可以再加、也可以移除（至少留一列）
function renderRoleRows() {
  $("class-roles").innerHTML = roleRows
    .map(
      (r, i) => `
      <div class="class-role-row" data-i="${i}">
        <select class="class-role-group" aria-label="班別">
          ${CLASS_GROUPS.map(
            (g) => `<option value="${esc(g)}" ${g === r.group ? "selected" : ""}>${esc(g)}</option>`
          ).join("")}
        </select>
        <select class="class-role-type" aria-label="身分">
          ${MEMBER_TYPES.map(
            (t) => `<option value="${esc(t)}" ${t === r.type ? "selected" : ""}>${esc(t)}</option>`
          ).join("")}
        </select>
        <button type="button" class="btn-secondary btn-small class-role-del"
          ${roleRows.length === 1 ? "disabled" : ""} aria-label="移除這個班別">✕</button>
      </div>`
    )
    .join("");
}

function readRoleRows() {
  const rows = [...$("class-roles").querySelectorAll(".class-role-row")].map((row) => ({
    group: row.querySelector(".class-role-group").value,
    type: row.querySelector(".class-role-type").value,
  }));
  // 同一個班只留一筆，避免重複
  const seen = new Set();
  return rows.filter((r) => {
    if (!r.group || seen.has(r.group)) return false;
    seen.add(r.group);
    return true;
  });
}

function renderLinkedPick() {
  $("class-linked-current").innerHTML = linkedPick.id
    ? `<span class="linked-badge">已對應道務名單：<strong>${esc(linkedPick.name)}</strong></span>
       <button type="button" class="btn-link-plain" id="class-link-clear">取消對應</button>`
    : "";
}

// 打姓名時直接查道務名單：選到同一位就帶入性別、系級，並記住兩邊是同一個人
function renderNameSuggest() {
  const box = $("class-name-suggest");
  if (document.activeElement !== $("class-field-name")) return hideNameSuggest();
  const q = $("class-field-name").value.trim().toLowerCase();
  if (!q) return hideNameSuggest();
  const matches = ctx
    .daoNames()
    .filter((p) => (p.name || "").toLowerCase().includes(q))
    .filter((p) => p.id !== linkedPick.id)
    .slice(0, 6);
  if (matches.length === 0) return hideNameSuggest();
  box.innerHTML = matches
    .map(
      (p) =>
        `<div class="invite-suggestion" data-link-id="${esc(p.id)}" data-link-name="${esc(p.name || "")}"
           data-link-dept="${esc(p.department || "")}" data-link-gender="${esc(p.gender || "")}">
           ${esc(p.name)}<span class="suggestion-meta">道務名單${p.department ? `・${esc(p.department)}` : ""}</span>
         </div>`
    )
    .join("");
  box.classList.remove("hidden");
}

function hideNameSuggest() {
  $("class-name-suggest").classList.add("hidden");
}

function pickDaoPerson(el) {
  linkedPick = { id: el.dataset.linkId, name: el.dataset.linkName };
  $("class-field-name").value = el.dataset.linkName;
  // 只在還沒填的欄位帶入，不覆蓋使用者自己打的
  if (el.dataset.linkGender && !$("class-field-gender").value) {
    $("class-field-gender").value = el.dataset.linkGender;
  }
  if (el.dataset.linkDept && !$("class-field-department").value.trim()) {
    $("class-field-department").value = el.dataset.linkDept;
  }
  hideNameSuggest();
  renderLinkedPick();
}

async function saveClassEntry() {
  const name = $("class-field-name").value.trim();
  if (!name) {
    $("class-field-name").focus();
    return;
  }
  const roles = readRoleRows();
  if (roles.length === 0) {
    alert("至少要有一個班別。");
    return;
  }
  const gender = $("class-field-gender").value;
  const department = $("class-field-department").value.trim();
  const data = {
    name,
    gender,
    department,
    roles,
    // 第一個角色也照舊寫進 classGroup／memberType，舊版本讀得懂
    classGroup: roles[0].group,
    memberType: roles[0].type,
    linkedEntryId: linkedPick.id || null,
    linkedName: linkedPick.name || "",
    // 記下這次跟道務名單對齊時的樣子，之後才分得出是哪一邊改的
    daoProfile: linkedPick.id ? { gender, department } : null,
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
    if (linkedPick.id) await pushProfileToDao(linkedPick.id, { gender, department });
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
}

// ---------- 性別／系級兩邊同步 ----------
// 關聯到道務名單的人，性別與系級是同一份資料：改班務這邊就推回道務那邊。
// 姓名索引（rosterIndex）同單位都寫得進去，道務名單本身則要有道務權限，
// 沒有的話只更新索引，並老實跟使用者說道務那邊沒改到。
async function pushProfileToDao(daoEntryId, { gender, department }) {
  const local = ctx.daoNames().find((p) => p.id === daoEntryId);
  if (local && (local.gender || "") === (gender || "") && (local.department || "") === (department || "")) {
    return; // 本來就一樣，不用寫
  }
  try {
    await setDoc(
      doc(db, "units", ctx.unitId(), "rosterIndex", daoEntryId),
      { gender: gender || "", department: department || "" },
      { merge: true }
    );
    if (local) {
      local.gender = gender || "";
      local.department = department || "";
    }
  } catch (err) {
    if (err.code !== "permission-denied") console.error("同步姓名索引失敗", err);
  }
  try {
    await updateDoc(doc(db, "units", ctx.unitId(), "entries", daoEntryId), {
      gender: gender || "",
      department: department || "",
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });
  } catch (err) {
    if (err.code === "permission-denied") {
      alert(
        "班務名單已儲存。\n\n" +
          "但性別／系級沒能同步到道務名單——你看不到道務系統的那一筆（沒有道務權限，或那一位跟你同階以上）。\n" +
          "請有權限的人到道務名單改一次，或直接由他那邊改，班務這邊會自動跟上。"
      );
    } else {
      console.error("同步道務名單失敗", err);
    }
  }
}

// 道務那邊改了性別／系級 → 關聯到他的班務名單跟著改。
// 由 main.js 在存完道務名單之後呼叫；沒有班務權限就寫不進去，靜靜略過，
// 之後班務那邊自己會從姓名索引補回來（reconcileProfiles）。
export async function syncProfileFromDao(daoEntryId, { gender, department }) {
  if (!ctx?.unitId?.()) return;
  try {
    const snap = await getDocs(query(col(ENTRIES), where("linkedEntryId", "==", daoEntryId)));
    await Promise.all(
      snap.docs.map((d) =>
        updateDoc(d.ref, {
          gender: gender || "",
          department: department || "",
          daoProfile: { gender: gender || "", department: department || "" },
        })
      )
    );
  } catch (err) {
    if (err.code !== "permission-denied") console.error("同步班務名單失敗", err);
  }
}

// 這一筆班務名單要不要跟著道務改？
// 只有在「道務那邊自從上次對齊之後改過」才跟著改，
// 這樣班務自己剛改、還沒推回道務的內容不會被蓋掉。回傳 null 代表不用動。
export function profilePatch(entry, person) {
  if (!person) return null;
  const seen = entry.daoProfile || {};
  const aligned = { gender: person.gender || "", department: person.department || "" };
  const patch = {};
  for (const field of ["gender", "department"]) {
    if (aligned[field] === (seen[field] || "")) continue; // 道務那邊沒動過
    if ((entry[field] || "") !== aligned[field]) patch[field] = aligned[field];
  }
  const alreadyAligned =
    (seen.gender || "") === aligned.gender && (seen.department || "") === aligned.department;
  if (Object.keys(patch).length === 0 && alreadyAligned) return null;
  return { ...patch, daoProfile: aligned };
}

// 補救用：班務名單載入時，比對姓名索引裡的性別／系級。
// 道務那邊改完可能寫不進班務名單（那個人沒有班務權限），這裡補上。
async function reconcileProfiles() {
  const dao = ctx?.daoNames?.() || [];
  if (dao.length === 0) return;
  const jobs = [];
  for (const en of classEntries) {
    if (!en.linkedEntryId) continue;
    const patch = profilePatch(en, dao.find((p) => p.id === en.linkedEntryId));
    if (patch) jobs.push(updateDoc(ref(ENTRIES, en.id), patch));
  }
  if (jobs.length === 0) return;
  try {
    await Promise.all(jobs);
  } catch (err) {
    if (err.code !== "permission-denied") console.error("對齊道務資料失敗", err);
  }
}

// 道務名單重新載入之後（切到班務、或剛存完道務名單）叫一次
export function refreshDaoNames() {
  if (!unsubEntries) return;
  reconcileProfiles();
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
// 同一個班別在不同佛堂各自開課（「崇慧新民」＝崇慧佛院的新民班），
// 所以課程的身分是「佛堂＋班別」，清單也照這個分組。
function courseVenue(course) {
  return (course?.venue || "").trim() || "未填佛堂";
}
function courseGroupKey(course) {
  return `${courseVenue(course)}｜${course?.classGroup || "未分班"}`;
}
function courseLabel(course) {
  return [courseVenue(course), course?.classGroup, course?.name].filter(Boolean).join("・");
}

// 這個人只看得到自己那幾班的課：新民班的班員不該看到至善班的課
function coursesFor(entry) {
  const groups = new Set(entryRoles(entry).map((r) => r.group));
  return courses.filter((c) => groups.has(c.classGroup));
}

// 已經記過的課不用再記一次（舊紀錄沒有 courseId，就比對課名＋日期）
function isLessonLogged(lessons, course) {
  return lessons.some((l) =>
    l.courseId
      ? l.courseId === course.id
      : (l.course || "") === (course.name || "") && (l.date || "") === (course.date || "")
  );
}

function coursesToLog(entry) {
  // 紀錄視窗開著的那一位用畫面上這份，剛存的那一筆才會馬上從清單消失
  const lessons = entry.id === lessonEntryId ? lessonRows : entry.lessons || [];
  return coursesFor(entry).filter((c) => !isLessonLogged(lessons, c));
}

function renderCourseOptions() {
  const sel = $("lesson-course");
  if (!sel) return;
  const entry = classEntries.find((e) => e.id === lessonEntryId);
  const mine = entry ? coursesToLog(entry) : [];
  const keep = sel.value;
  const hasAny = entry ? coursesFor(entry).length > 0 : false;
  sel.innerHTML = mine.length
    ? `<option value="">請選擇課程</option>` +
      mine
        .map(
          (c) =>
            `<option value="${esc(c.id)}">${esc(c.date || "未定日期")}・${esc(courseLabel(c))}</option>`
        )
        .join("")
    : `<option value="">${hasAny ? "（他那幾班的課都記過了）" : "（他的班別還沒有登錄課程）"}</option>`;
  if (keep && mine.some((c) => c.id === keep)) sel.value = keep;
}

// 已經展開的「佛堂｜班別」；預設全部展開，收合狀態記在這裡
let collapsedCourseGroups = new Set();

function renderCourseList() {
  const list = $("course-list");
  if (!list) return;
  renderVenueSuggestions();
  if (courses.length === 0) {
    list.innerHTML = `<p class="hint-text">還沒有課程。填上面的欄位按「新增課程」。</p>`;
    return;
  }
  // 佛堂＋班別分組，組內日期新到舊
  const groups = new Map();
  for (const c of courses) {
    const key = courseGroupKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) =>
      a[0].split("｜")[0].localeCompare(b[0].split("｜")[0], "zh-Hant") ||
      CLASS_GROUPS.indexOf(a[1][0].classGroup) - CLASS_GROUPS.indexOf(b[1][0].classGroup)
  );

  list.innerHTML = sorted
    .map(([key, rows]) => {
      const [venue, group] = key.split("｜");
      const open = !collapsedCourseGroups.has(key);
      const latest = rows.map((c) => c.date || "").sort().at(-1) || "";
      return `
      <div class="course-group ${open ? "is-open" : ""}">
        <button type="button" class="course-group-head" data-course-group="${esc(key)}"
          aria-expanded="${open}">
          <span class="course-group-caret">${open ? "▾" : "▸"}</span>
          <span class="course-group-venue">${esc(venue)}</span>
          <span class="class-badge">${esc(group)}</span>
          <span class="course-group-meta">${rows.length} 堂${latest ? `・最近 ${esc(latest)}` : ""}</span>
        </button>
        <div class="course-group-body" ${open ? "" : "hidden"}>
          ${rows
            .map(
              (c) => `
            <div class="course-row ${c.id === editingCourseId ? "is-editing" : ""}" data-id="${esc(c.id)}">
              <div class="course-info">
                <span class="course-date">${esc(c.date || "未定")}</span>
                <span class="course-name">${esc(c.name)}</span>
              </div>
              <div class="course-actions">
                <button type="button" class="btn-secondary btn-small" data-course-edit="${esc(c.id)}">編輯</button>
                <button type="button" class="btn-danger btn-small" data-course-del="${esc(c.id)}">刪除</button>
              </div>
            </div>`
            )
            .join("")}
        </div>
      </div>`;
    })
    .join("");
}

// 已經用過的佛堂列出來給人點，不用每次重打
function renderVenueSuggestions() {
  const box = $("course-venue-recent");
  if (!box) return;
  const venues = [...new Set(courses.map((c) => (c.venue || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-Hant")
  );
  box.innerHTML = venues.length
    ? `已用過：` +
      venues
        .map((v) => `<button type="button" class="venue-chip" data-venue="${esc(v)}">${esc(v)}</button>`)
        .join("")
    : "";
}

function resetCourseForm() {
  editingCourseId = null;
  $("course-date").value = today();
  $("course-name").value = "";
  $("course-group").value = CLASS_GROUPS[0];
  applyCourseFormMode();
}

// 新增與儲存分開：編輯中才出現「儲存變更」與「取消編輯」
function applyCourseFormMode() {
  const editing = !!editingCourseId;
  const course = editing ? courses.find((c) => c.id === editingCourseId) : null;
  $("course-add-btn").classList.toggle("hidden", editing);
  $("course-update-btn").classList.toggle("hidden", !editing);
  $("course-cancel-btn").classList.toggle("hidden", !editing);
  const hint = $("course-editing-hint");
  hint.classList.toggle("hidden", !editing);
  hint.textContent = editing ? `正在編輯：${courseLabel(course) || "這一堂"}` : "";
}

function readCourseForm() {
  const venue = $("course-venue").value.trim();
  const name = $("course-name").value.trim();
  const date = $("course-date").value;
  if (!venue || !name || !date) {
    (!venue ? $("course-venue") : !name ? $("course-name") : $("course-date")).focus();
    alert("佛堂、課程名稱與日期都要填。");
    return null;
  }
  return {
    venue,
    name,
    date,
    classGroup: $("course-group").value,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.email || null,
  };
}

async function addCourse() {
  const data = readCourseForm();
  if (!data) return;
  try {
    await addDoc(col(COURSES), {
      ...data,
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.email || null,
    });
    // 佛堂與班別留著，接著登錄同一班的下一堂會比較快
    editingCourseId = null;
    $("course-name").value = "";
    applyCourseFormMode();
    $("course-name").focus();
  } catch (err) {
    alert("新增失敗：" + err.message);
  }
}

async function updateCourse() {
  if (!editingCourseId) return;
  const data = readCourseForm();
  if (!data) return;
  try {
    await updateDoc(ref(COURSES, editingCourseId), data);
    resetCourseForm();
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
}

// ---------- 上課紀錄 ----------
function openLessonModal(entry) {
  lessonEntryId = entry.id;
  lessonRows = [...(entry.lessons || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const roles = entryRoles(entry);
  $("lesson-modal-name").textContent = `${entry.name}（${roles.map(roleLabel).join("、")}）`;
  $("lesson-course").value = "";
  renderCourseOptions(); // 只列他自己那幾班的課
  $("lesson-attend").value = ATTEND_OPTIONS[0];
  $("lesson-notes").checked = false;
  $("lesson-asked").checked = false;
  $("lesson-interaction").value = "";
  $("lesson-duties").value = "";
  $("lesson-comment").value = "";
  applyLessonRole();
  renderLessonRows();
  $("lesson-modal").classList.remove("hidden");
}

// 挑了哪一堂課，就決定了日期、班別與身分——不用再各選一次
function selectedCourse() {
  return courses.find((c) => c.id === $("lesson-course").value) || null;
}

// 這一筆紀錄算他在哪一班的什麼身分：由課程的班別決定
function currentLessonRole() {
  const entry = classEntries.find((e) => e.id === lessonEntryId);
  if (!entry) return null;
  const roles = entryRoles(entry);
  const course = selectedCourse();
  return roles.find((r) => r.group === course?.classGroup) || null;
}

// 班員記學習狀況、護班人員記承擔狀況，欄位不一樣
function applyLessonFields(memberType) {
  const isHu = memberType === "護班人員";
  $("lesson-ban-fields").classList.toggle("hidden", isHu);
  $("lesson-hu-fields").classList.toggle("hidden", !isHu);
}

// 課程換了就把「以什麼身分紀錄」與日期一起帶出來
function applyLessonRole() {
  const role = currentLessonRole();
  const course = selectedCourse();
  const label = $("lesson-role-label");
  label.textContent = course
    ? `${course.date || "未定日期"}・以「${roleLabel(role || { group: course.classGroup, type: MEMBER_TYPES[0] })}」紀錄`
    : "選了課程就會帶入日期與身分";
  label.classList.toggle("is-set", !!course);
  applyLessonFields(role?.type);
}

function renderLessonRows() {
  const entry = classEntries.find((e) => e.id === lessonEntryId);
  const multi = entry ? entryRoles(entry).length > 1 : false;
  $("lesson-list").innerHTML = lessonRows.length
    ? lessonRows
        .map((l, i) => {
          const role = lessonRole(entry, l);
          const isHu = role.type === "護班人員";
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
          const courseText = [l.venue, l.course].filter(Boolean).join("・");
          return `
          <div class="lesson-row">
            <div class="lesson-row-head">
              <span class="lesson-date">${esc(l.date || "未填日期")}</span>
              <span class="lesson-course">${esc(courseText)}</span>
              ${multi ? `<span class="lesson-role">${esc(roleLabel(role))}</span>` : ""}
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
  renderCourseOptions(); // 剛記完的那堂課要從清單消失
  renderLessonRows();
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
  // 日期跟著課程走，所以一定要挑一堂課
  const course = selectedCourse();
  if (!course) {
    alert(
      coursesToLog(entry).length
        ? "請先選一堂課，日期會跟著課程帶入。"
        : coursesFor(entry).length
          ? "他那幾班的課都已經記過了，要改就改下面既有的那幾筆。"
          : "他的班別還沒有登錄課程，請先到「課程管理」新增。"
    );
    $("lesson-course").focus();
    return;
  }
  const role = currentLessonRole() || entryRoles(entry)[0];
  const isHu = role.type === "護班人員";
  const row = {
    date: course.date || today(),
    courseId: course.id,
    course: course.name || "",
    venue: (course.venue || "").trim(),
    group: role.group || course.classGroup || "",
    type: role.type || MEMBER_TYPES[0],
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
    $("lesson-course").value = "";
    renderCourseOptions(); // 記過的課從清單拿掉
    applyLessonRole();
    renderLessonRows();
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
  $("class-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveClassEntry();
  });
  $("class-delete-btn").addEventListener("click", deleteClassEntry);
  $("class-cancel-btn").addEventListener("click", () => $("class-modal").classList.add("hidden"));
  $("class-close-x").addEventListener("click", () => $("class-modal").classList.add("hidden"));
  $("class-modal").addEventListener("click", (e) => {
    if (e.target === $("class-modal")) $("class-modal").classList.add("hidden");
  });
  // 班別＋身分：可以再加一組、也可以移除
  $("class-role-add").addEventListener("click", () => {
    const used = new Set(readRoleRows().map((r) => r.group));
    const next = CLASS_GROUPS.find((g) => !used.has(g));
    if (!next) return; // 每個班都加過了
    roleRows = [...readRoleRows(), { group: next, type: MEMBER_TYPES[0] }];
    renderRoleRows();
  });
  $("class-roles").addEventListener("click", (e) => {
    const del = e.target.closest(".class-role-del");
    if (!del) return;
    const i = Number(del.closest(".class-role-row").dataset.i);
    roleRows = readRoleRows().filter((_, idx) => idx !== i);
    if (roleRows.length === 0) roleRows = [{ group: CLASS_GROUPS[0], type: MEMBER_TYPES[0] }];
    renderRoleRows();
  });

  // 姓名打一打就查道務名單
  $("class-field-name").addEventListener("input", renderNameSuggest);
  $("class-field-name").addEventListener("focus", renderNameSuggest);
  $("class-field-name").addEventListener("blur", () => setTimeout(hideNameSuggest, 0));
  // 用 mousedown：click 之前 input 會先 blur，清單已經收起來就點不到
  $("class-name-suggest").addEventListener("mousedown", (e) => {
    const item = e.target.closest("[data-link-id]");
    if (!item) return;
    e.preventDefault();
    pickDaoPerson(item);
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
  // 新增與儲存分開，不會按錯把新課程覆蓋掉正在編輯的那一堂
  $("course-add-btn").addEventListener("click", addCourse);
  $("course-update-btn").addEventListener("click", updateCourse);
  $("course-cancel-btn").addEventListener("click", resetCourseForm);
  // 用過的佛堂點一下就填進去
  $("course-venue-recent").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-venue]");
    if (!chip) return;
    $("course-venue").value = chip.dataset.venue;
    $("course-name").focus();
  });
  $("course-list").addEventListener("click", async (e) => {
    // 佛堂＋班別的分組可以收合
    const head = e.target.closest("[data-course-group]");
    if (head) {
      const key = head.dataset.courseGroup;
      if (collapsedCourseGroups.has(key)) collapsedCourseGroups.delete(key);
      else collapsedCourseGroups.add(key);
      renderCourseList();
      return;
    }
    const edit = e.target.closest("[data-course-edit]");
    if (edit) {
      const c = courses.find((x) => x.id === edit.dataset.courseEdit);
      if (!c) return;
      editingCourseId = c.id;
      $("course-venue").value = c.venue || "";
      $("course-date").value = c.date || "";
      $("course-name").value = c.name || "";
      $("course-group").value = c.classGroup || CLASS_GROUPS[0];
      applyCourseFormMode();
      renderCourseList();
      $("course-name").focus();
      return;
    }
    const del = e.target.closest("[data-course-del]");
    if (!del) return;
    const c = courses.find((x) => x.id === del.dataset.courseDel);
    if (
      !c ||
      !confirm(
        `確定要刪除課程「${courseLabel(c)}」（${c.date || "未定"}）嗎？\n\n已經寫進個人上課紀錄的內容不受影響。`
      )
    ) {
      return;
    }
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
  $("lesson-course").addEventListener("change", applyLessonRole);
  $("lesson-add-btn").addEventListener("click", addLesson);
  $("lesson-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-lesson-del]");
    if (!btn) return;
    const entry = classEntries.find((x) => x.id === lessonEntryId);
    if (!entry || !confirm("確定要刪除這筆上課紀錄嗎？")) return;
    lessonRows.splice(Number(btn.dataset.lessonDel), 1);
    try {
      await saveLessons();
      renderLessonRows();
    } catch (err) {
      alert("刪除失敗：" + err.message);
    }
  });
}

// 給道務那邊查「這個人在班務系統的班別」用
export function classInfoFor(daoEntryId) {
  return classEntries.find((c) => c.linkedEntryId === daoEntryId) || null;
}

// 有來上課也是一次見面：道務那邊算「距離上次互動多久」時要一起看。
// 只認真的到場的（準時／遲到）——請假、缺席那天並沒有見到人。
const ATTENDED = new Set(["準時", "遲到"]);

export function classTouchDates(daoEntryId) {
  if (!daoEntryId) return [];
  return classEntries
    .filter((c) => c.linkedEntryId === daoEntryId)
    .flatMap((c) => c.lessons || [])
    .filter((l) => l.date && ATTENDED.has(l.attend))
    .map((l) => l.date);
}


