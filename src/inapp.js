// 在 LINE、Facebook、Instagram 等 App 的內建瀏覽器裡，Google 登入會被 Google 擋下
// （disallowed_useragent），所以一偵測到就想辦法把使用者導到真正的瀏覽器。
// LINE 支援在網址加 openExternalBrowser=1 直接開系統瀏覽器；其他 App 沒有這種參數，
// Android 可以試 intent://，都不行就顯示提示條，讓使用者自己開（附複製連結按鈕）。

const ua = navigator.userAgent || "";
const isLine = /\bLine\//i.test(ua);
const isFacebook = /FBAN|FBAV|FB_IAB/i.test(ua);
const isInstagram = /Instagram/i.test(ua);
const isAndroid = /Android/i.test(ua);
const TRIED_KEY = "openExternalTried";

export function handleInAppBrowser() {
  if (!isLine && !isFacebook && !isInstagram) return;

  if (isLine) {
    const url = new URL(location.href);
    if (url.searchParams.get("openExternalBrowser") !== "1") {
      url.searchParams.set("openExternalBrowser", "1");
      location.replace(url.toString());
      return;
    }
  } else if (isAndroid && !sessionStorage.getItem(TRIED_KEY)) {
    // Android 的 intent:// 會交給系統挑瀏覽器；失敗也不會有事，就繼續顯示提示
    sessionStorage.setItem(TRIED_KEY, "1");
    location.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=${location.protocol.replace(":", "")};end`;
  }

  showNotice();
}

function showNotice() {
  const app = isLine ? "LINE" : isFacebook ? "Facebook" : "Instagram";
  const how = isLine
    ? "請點右上角的「⋯」→「用其他應用程式開啟」"
    : "請點右上角的「⋯」→「在瀏覽器中開啟」";

  const bar = document.createElement("div");
  bar.className = "inapp-notice";
  bar.innerHTML = `
    <span>在 ${app} 內建瀏覽器沒辦法用 Google 登入，${how}。</span>
    <button type="button" class="btn-secondary btn-small">複製連結</button>`;

  const btn = bar.querySelector("button");
  btn.addEventListener("click", async () => {
    const link = location.href.replace(/[?&]openExternalBrowser=1/, "");
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = "已複製";
    } catch {
      btn.textContent = link;
    }
  });

  document.body.prepend(bar);
}
