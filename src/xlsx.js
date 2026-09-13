// 只讀 .xlsx 的最小實作：把工作表讀成一格一格的字串，夠用來匯入班表。
//
// 為什麼不裝 SheetJS：我們只需要「讀第一張工作表的純文字」，而 xlsx 本身就是
// 一個 zip 裡面裝幾份 XML。瀏覽器內建 DecompressionStream("deflate-raw") 會解壓，
// 剩下的就是找出三份檔案、抓出格子。裝一個幾百 KB 的函式庫來做這件事不划算。
//
// 支援範圍：Excel／Google 試算表匯出的一般 .xlsx（壓縮方式 deflate 或不壓縮）。
// 不處理密碼保護、公式重算、日期樣式以外的格式化。

// ---------- zip ----------
// 從尾端找中央目錄，再照目錄把需要的檔案解出來。
// （中央目錄比逐段掃描本地檔頭可靠：壓縮長度、方式都在這裡寫得清清楚楚。）
async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // End of Central Directory：簽章 0x06054b50，從尾巴往回找（註解最長 65535）
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("這個檔案不是有效的 .xlsx（找不到壓縮檔目錄）");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break; // 中央目錄檔頭
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    // 本地檔頭的 extra 長度可能跟中央目錄不同，資料位置要用本地那份算
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    files.set(name, { method, dataStart, compressedSize });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    async text(name) {
      const f = files.get(name);
      if (!f) return null;
      const raw = bytes.subarray(f.dataStart, f.dataStart + f.compressedSize);
      if (f.method === 0) return new TextDecoder().decode(raw); // 沒壓縮
      if (f.method !== 8) throw new Error(`不支援的壓縮方式（${f.method}）`);
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    },
    names: () => [...files.keys()],
  };
}

// ---------- xml ----------
const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // 放最後，免得把 &amp;lt; 解兩次

// 共用字串表：<si> 底下可能被拆成好幾個 <t>（同一格有不同格式時）
function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, inner]) =>
    [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => unescapeXml(t)).join("")
  );
}

const colIndex = (ref) => {
  const letters = (ref.match(/^[A-Z]+/) || [""])[0];
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
};

// Excel 的日期是「1899/12/30 起算的天數」，這裡只在格子確實是日期時才會用到
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function parseSheet(xml, strings) {
  const rows = [];
  for (const [, attrs, body] of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number((attrs.match(/r="(\d+)"/) || [])[1] || rows.length + 1);
    const cells = [];
    // 自閉合的空格子（<c r="A1"/>）也要吃掉，不然後面的欄位會對錯位置
    for (const m of body.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = m[1];
      const inner = m[2] || "";
      const ref = (attr.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attr.match(/t="([^"]+)"/) || [])[1];
      const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = "";
      if (type === "s") value = strings[Number(raw)] ?? "";
      else if (type === "inlineStr") {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => unescapeXml(t)).join("");
      } else if (raw != null) value = unescapeXml(raw);
      if (ref) cells[colIndex(ref)] = value;
    }
    rows[rowNum - 1] = [...cells].map((c) => (c == null ? "" : String(c).trim()));
  }
  // 中間空白的列補成空陣列，呼叫端才不會踩到 undefined
  return [...rows].map((r) => r || []);
}

/**
 * 讀 .xlsx 的第一張工作表，回傳 rows（二維字串陣列）。
 * @param {File|Blob} file
 */
export async function readSheet(file) {
  const zip = await unzip(await file.arrayBuffer());
  const strings = parseSharedStrings(await zip.text("xl/sharedStrings.xml"));

  // 工作表檔名不一定是 sheet1.xml，挑第一個 worksheets/*.xml
  const sheetName =
    zip.names().find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)) ||
    zip.names().find((n) => n.startsWith("xl/worksheets/") && n.endsWith(".xml"));
  if (!sheetName) throw new Error("這個檔案裡找不到工作表");

  return parseSheet(await zip.text(sheetName), strings);
}

export { serialToDate };
