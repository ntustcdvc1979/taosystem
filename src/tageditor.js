// 標籤輸入元件：已經加上的標籤是一個個圓角框（附 × 可刪），
// 在輸入框打字時會即時搜尋「別人已經用過的標籤」，選一個就直接加進來，
// 免得同一個意思被打成好幾種寫法（需關心／要關心／需要關心…）。
//
// 用法：
//   const editor = createTagEditor(container, { suggest: () => [...所有現有標籤], placeholder });
//   editor.setTags([...]); editor.getTags();

const MAX_SUGGESTIONS = 8;

// 下拉清單「選一項」的通用綁法，三個清單（標籤、活動邀約、班務對應姓名）共用。
//
// 為什麼要同時接 pointerdown 與 click：
//   - 手機點下去只會有 pointerdown／touchstart，沒有 mousedown（原本綁 mousedown 等於點不到）。
//   - 只綁 click 也不保險：中文選字送出等情況會讓清單在按下與放開之間重畫，
//     click 的目標就變成外層容器，那一下同樣落空。
//   - pointerdown 先處理掉，click 再兜底（鍵盤、輔助工具只有 click）；
//     同一次點擊用 justPicked 擋住，不會選到兩個。
export function bindPick(box, selector, onPick) {
  const itemOf = (e) => (e.target instanceof Element ? e.target.closest(selector) : null);
  let justPicked = false;

  box.addEventListener("pointerdown", (e) => {
    justPicked = false; // 上一次按下去卻沒放開（手指滑走）不要卡住下一次
    const item = itemOf(e);
    if (!item) return;
    e.preventDefault(); // 不要讓輸入框失焦
    justPicked = true;
    onPick(item);
  });

  box.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (justPicked) {
      justPicked = false; // pointerdown 已經處理過這一下了
      return;
    }
    const item = itemOf(e);
    if (item) onPick(item);
  });
}

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
    // 一打開視窗不要就掛著一張下拉清單；但清單已經開著時不管焦點在哪都要留著，
    // 不然手機上手指按下去的瞬間輸入框失焦，清單就在「點到」之前消失了。
    const open = !suggestBox.classList.contains("hidden");
    if (document.activeElement !== input && !open) return hideSuggestions();
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
  // 刻意不在 blur 收清單：手機上手指一按下去輸入框就失焦，清單若跟著收起來，
  // 那一下就落在已經消失的元素上，等於永遠選不到。改成「碰到這個元件以外才收」。
  const hideIfOutside = (e) => {
    if (!(e.target instanceof Node) || !host.contains(e.target)) hideSuggestions();
  };
  document.addEventListener("pointerdown", hideIfOutside, true);
  document.addEventListener("focusin", hideIfOutside, true);

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

  bindPick(suggestBox, ".tag-suggest-item", (item) => {
    addTag(item.dataset.tag);
    input.value = "";
    renderSuggestions();
    input.focus();
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
