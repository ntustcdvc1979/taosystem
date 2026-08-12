// 後台維護腳本：幫所有道務單位的名單補上 roleRank，並重建綁定用的姓名索引。
//
// 用 Firebase Admin SDK 直接連 Firestore，**繞過安全規則**，所以：
//   - 一次補完所有單位，不受身分階梯限制（網頁端做不到這件事）
//   - 服務帳戶金鑰是真正的密鑰，絕對不能進 git（.gitignore 已擋 serviceAccount*.json）
//
// 準備：
//   1. Firebase Console → 專案設定 → 服務帳戶 → 產生新的私密金鑰，存成 serviceAccount.json
//   2. npm install
//
// 執行：
//   npm run backfill -- --dry-run     先看看會改什麼，不寫入
//   npm run backfill                  真的寫入
//   npm run backfill -- --unit=ntust  只處理某一個單位
//   npm run backfill -- --key=C:\路徑\serviceAccount.json
//
// 補什麼：
//   units/{unitId}/entries/{id}      沒有 roleRank 的補成 0（非組員）
//   units/{unitId}/rosterIndex/{id}  依名單重建（姓名、系級、身分）

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name) => args.includes(`--${name}`);

const dryRun = has("dry-run");
const onlyUnit = flag("unit");
const keyPath = flag("key") || process.env.GOOGLE_APPLICATION_CREDENTIALS || "serviceAccount.json";

let credential;
try {
  credential = cert(JSON.parse(readFileSync(keyPath, "utf8")));
} catch (err) {
  console.error(`讀不到服務帳戶金鑰：${keyPath}`);
  console.error("到 Firebase Console → 專案設定 → 服務帳戶 → 產生新的私密金鑰，存成 serviceAccount.json。");
  console.error(`（原始錯誤：${err.message}）`);
  process.exit(1);
}

initializeApp({ credential });
const db = getFirestore();

// Firestore 一次最多 500 個操作，留點餘裕
const BATCH_LIMIT = 400;

async function backfillUnit(unitId) {
  const entriesRef = db.collection("units").doc(unitId).collection("entries");
  const indexRef = db.collection("units").doc(unitId).collection("rosterIndex");

  const [entries, index] = await Promise.all([entriesRef.get(), indexRef.get()]);
  const indexed = new Map(index.docs.map((d) => [d.id, d.data()]));

  let needRank = 0;
  let needIndex = 0;
  let batch = db.batch();
  let pending = 0;

  const flush = async () => {
    if (pending === 0) return;
    if (!dryRun) await batch.commit();
    batch = db.batch();
    pending = 0;
  };

  for (const doc of entries.docs) {
    const data = doc.data();
    const rank = typeof data.roleRank === "number" ? data.roleRank : 0;

    if (typeof data.roleRank !== "number") {
      needRank += 1;
      batch.update(doc.ref, { roleRank: 0 });
      pending += 1;
    }

    // 索引不存在、或姓名／系級／身分跟名單對不起來就重寫
    const current = indexed.get(doc.id);
    const wanted = {
      name: data.name || "",
      department: data.department || "",
      gender: data.gender || "",
      roleRank: rank,
    };
    const stale =
      !current ||
      current.name !== wanted.name ||
      current.department !== wanted.department ||
      current.gender !== wanted.gender ||
      current.roleRank !== wanted.roleRank;
    if (stale) {
      needIndex += 1;
      batch.set(indexRef.doc(doc.id), wanted);
      pending += 1;
    }

    if (pending >= BATCH_LIMIT) await flush();
  }

  // 名單已經刪掉、索引卻還留著的孤兒，一起清掉
  let orphans = 0;
  const entryIds = new Set(entries.docs.map((d) => d.id));
  for (const doc of index.docs) {
    if (entryIds.has(doc.id)) continue;
    orphans += 1;
    batch.delete(doc.ref);
    pending += 1;
    if (pending >= BATCH_LIMIT) await flush();
  }

  await flush();
  return { total: entries.size, needRank, needIndex, orphans };
}

async function main() {
  const units = onlyUnit
    ? [onlyUnit]
    : (await db.collection("units").get()).docs.map((d) => d.id);

  if (units.length === 0) {
    console.log("找不到任何道務單位（units 集合是空的）。");
    return;
  }

  console.log(dryRun ? "== 試跑（不會寫入）==" : "== 開始補齊 ==");
  let grand = { total: 0, needRank: 0, needIndex: 0, orphans: 0 };

  for (const unitId of units) {
    try {
      const r = await backfillUnit(unitId);
      grand = {
        total: grand.total + r.total,
        needRank: grand.needRank + r.needRank,
        needIndex: grand.needIndex + r.needIndex,
        orphans: grand.orphans + r.orphans,
      };
      console.log(
        `${unitId}：名單 ${r.total} 筆，補身分 ${r.needRank}，寫索引 ${r.needIndex}，清孤兒索引 ${r.orphans}`
      );
    } catch (err) {
      console.error(`${unitId}：失敗 —`, err.message);
    }
  }

  console.log(
    `\n合計：名單 ${grand.total} 筆，補身分 ${grand.needRank}，寫索引 ${grand.needIndex}，清孤兒索引 ${grand.orphans}`
  );
  if (dryRun) console.log("（這是試跑，什麼都沒改。拿掉 --dry-run 才會真的寫入。）");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
