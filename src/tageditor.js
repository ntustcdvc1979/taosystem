// 標籤輸入元件：已經加上的標籤是一個個圓角框（附 × 可刪），
// 在輸入框打字時會即時搜尋「別人已經用過的標籤」，選一個就直接加進來，
// 免得同一個意思被打成好幾種寫法（需關心／要關心／需要關心…）。
//
// 用法：
//   const editor = createTagEditor(container, { suggest: () => [...所有現有標籤], placeholder });
//   editor.setTags([...]); editor.getTags();

const MAX_SUGGESTIONS = 8;

export function createTagEditor(host, { suggest = () => [], placeholder = "輸入標籤" } = {}) {
  host.classList.add("tag-editor");
  host.innerHTML = `
    <div class="tag-editor-box">
      <span class="tag-pills"></span>
      <input type="text" class="tag-editor-input" autocomplete="off" placeholder="${placeholder}" />
    </div>
    <div class="tag-suggest hidden"></div>`;

  const pills = host.querySelector(".tag-pills");
  const input = host.querySelector(".tag-editor-input");
  const suggestBox = host.querySelector(".tag-suggest");
  let tags = [];

  function renderPills() {
    pills.innerHTML = tags
      .map(
        (t, i) => `
        <span class="tag-pill">${escape(t)}<button type="button" class="tag-remove" data-index="${i}" aria-label="移除 ${escape(t)}">×</button></span>`
      )
      .join("");
  }

  function renderSuggestions() {
    // 只在輸入框有游標時才展開，避免一打開視窗就掛著一張下拉清單
    if (document.activeElement !== input) return hideSuggestions();
    const q = input.value.trim().toLowerCase();
    const used = new Set(tags.map((t) => t.toLowerCase()));
    const matches = [...new Set(suggest())]
      .filter((t) => t && !used.has(t.toLowerCase()))
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);

    if (matches.length === 0) return hideSuggestions();
    suggestBox.innerHTML = matches
      .map((t) => `<div class="tag-suggest-item" data-tag="${escape(t)}">${escape(t)}</div>`)
      .join("");
    suggestBox.classList.remove("hidden");
  }

  function hideSuggestions() {
    suggestBox.classList.add("hidden");
  }

  function addTag(value) {
    const tag = (value || "").trim();
    if (!tag) return false;
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    tags.push(tag);
    renderPills();
    return true;
  }

  pills.addEventListener("click", (e) => {
    const btn = e.target.closest(".tag-remove");
    if (!btn) return;
    tags.splice(Number(btn.dataset.index), 1);
    renderPills();
    renderSuggestions();
  });

  input.addEventListener("input", renderSuggestions);
  input.addEventListener("focus", renderSuggestions);
  input.addEventListener("blur", () => setTimeout(hideSuggestions, 0));

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // 中文選字中的 Enter 不能當成送出
    if (e.key === "Enter" || e.key === "," || e.key === "，" || e.key === "、") {
      e.preventDefault();
      if (addTag(input.value)) input.value = "";
      renderSuggestions();
    } else if (e.key === "Backspace" && input.value === "" && tags.length > 0) {
      tags.pop();
      renderPills();
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  // 用 mousedown：click 會發生在 blur 之後，那時清單已經收起來了
  suggestBox.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".tag-suggest-item");
    if (!item) return;
    e.preventDefault();
    addTag(item.dataset.tag);
    input.value = "";
    input.focus();
    renderSuggestions();
  });

  // 點空白處也當成要打字
  host.querySelector(".tag-editor-box").addEventListener("click", (e) => {
    if (e.target.closest(".tag-pill")) return;
    input.focus();
  });

  return {
    getTags: () => [...tags],
    setTags(list) {
      tags = [...new Set((list || []).map((t) => (t || "").trim()).filter(Boolean))];
      input.value = "";
      renderPills();
      hideSuggestions();
    },
    // 輸入框裡還沒按 Enter 的字也算數，免得使用者打完直接按儲存就掉了
    commitPending() {
      if (addTag(input.value)) input.value = "";
    },
    clear() {
      this.setTags([]);
    },
    focus: () => input.focus(),
  };
}

function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
