# 成全名單管理

多人共用的名單管理網頁，前端部署在 GitHub Pages，資料存在 Firebase（Firestore），登入用 Firebase Authentication 限制只有指定人員能存取。

## 欄位

姓名、系級、背景（自由文字描述，例如：熱音社社員、大四家教、系排球隊）、備註、聯絡人、成全狀況（固定選項：未求道／已求道／法會畢／新民班畢／至善班畢／行德班畢／崇德班畢／人才培訓班畢／講培班畢／講師／未確定）、策略、做法。

另外每個人可以獨立新增/編輯「活動紀錄」（活動名稱、日期、反應），透過表格中每列的「活動紀錄」按鈕開啟，與新增/編輯名單的表單分開管理。

## 去識別化（僅用於 AI 分析）

系統內的顯示與資料庫儲存都保留**完整姓名**；只有在把資料送給 AI 分析時，姓名才會自動遮罩：王小明 → 王○明、王明 → 王○、歐陽小明 → 歐○○明。Anthropic API 收到的資料不含完整姓名。

自行留意：**備註、背景等自由文字欄位不會自動處理**，若不希望某些資訊送給 AI，請勿寫在這些欄位，或送出前先修改。

## AI 成全建議

表格每列有「AI 建議」按鈕：會把該對象（姓名遮罩後）的背景、系級、成全狀況、目前策略/做法與活動紀錄送給 Claude（Anthropic API），產生建議的「策略」與「具體做法」，滿意的話可一鍵套用回該對象的欄位。

### 設定共用 API Key（管理員做一次）

所有白名單成員共用一把 Anthropic API Key，存在 **Firestore 的 `config/ai` 文件**，由安全規則的 Email 白名單保護——只有登入且在白名單內的人讀得到，使用者不需要各自輸入。

1. 到 [console.anthropic.com](https://console.anthropic.com/) 建立 API Key（每次產生建議約耗費數美分；建議在 Console 設定每月用量上限）。
2. 到 Firebase Console →「Firestore Database」→「資料」→ 新增集合：
   - 集合 ID：`config`
   - 文件 ID：`ai`
   - 欄位：`anthropicApiKey`（字串），值填入你的 API Key
3. 確認 Firestore 規則已更新為本專案最新的 [firestore.rules](firestore.rules)（含 `config` 集合的讀取限制）並發布。

> ⚠️ **不要**把 Anthropic API Key 放進 `.env`、GitHub Secrets 或任何會被 build 進前端的變數——`VITE_*` 環境變數會直接寫進部署後的公開 JS 檔，任何人不用登入就能取走這把 Key。存在 Firestore 由白名單保護，是純前端架構下唯一不會公開 Key 的做法（Firebase 那組設定值可公開，性質不同）。
>
> 換 Key 或停用：直接到 Firebase Console 修改/刪除 `config/ai` 文件即可，不用重新部署（使用者重新整理頁面後生效）。

## 一、建立 Firebase 專案（一次性設定）

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立新專案。
2. 左側選單「Authentication」→「Sign-in method」→ 啟用 **Google** 這個登入方式。
3. 左側選單「Firestore Database」→「建立資料庫」→ 選正式環境模式、選一個離你近的地區（如 asia-east1）。
4. Firestore 建好後，到「規則(Rules)」分頁，把內容換成本專案的 [firestore.rules](firestore.rules)，然後發布。
   （設定白名單方式見下方第二節）
5. 左側選單「專案設定」→「一般」→ 拉到最下面「你的應用程式」→ 新增一個「網頁」應用程式 → 複製產生的 `firebaseConfig` 物件。
6. 設定值**不寫在原始碼裡**，改用環境變數（見下方「設定 Firebase 金鑰」）。
7. **授權網域**：部署到 GitHub Pages 後，回到「Authentication」→「Settings」→「Authorized domains」，把你的 Pages 網域（例如 `ntustcdvc1979.github.io`）加進去，Google 登入彈窗才不會被擋。

### 設定 Firebase 金鑰（環境變數）

`firebaseConfig` 的值改由環境變數提供，程式碼裡不再寫死（[src/firebase.js](src/firebase.js) 讀 `import.meta.env.VITE_FIREBASE_*`）。

**本機開發**：複製 [.env.example](.env.example) 為 `.env.local`，填入你的實際值。`.env.local` 已被 git 忽略，不會上傳。

```bash
cp .env.example .env.local   # 然後編輯 .env.local 填入實際值
```

**GitHub 部署**：到 repo → Settings → Secrets and variables → Actions → New repository secret，逐一新增下面 6 個 secret（名稱要一模一樣）：

| Secret 名稱 | 值 |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | apiKey |
| `VITE_FIREBASE_AUTH_DOMAIN` | authDomain |
| `VITE_FIREBASE_PROJECT_ID` | projectId |
| `VITE_FIREBASE_STORAGE_BUCKET` | storageBucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | messagingSenderId |
| `VITE_FIREBASE_APP_ID` | appId |

GitHub Actions build 時會自動把這些 secret 注入（見 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)）。

> ⚠️ 注意：Firebase 的 Web `apiKey` **不是密碼**，它最終仍會出現在部署後的前端 JS 中，任何人都看得到，這是靜態網站的正常情況。用環境變數只是讓「原始碼乾淨、不觸發 GitHub 掃描警告」。真正的存取防護請看下面的「安全性」一節。

## 二、用 Google 帳號登入 + 白名單（重要！）

本系統改用 **Google 帳號登入**。要特別注意：Google 登入預設會讓**任何一個 Google 帳號都能通過驗證**，所以「誰能看到資料」完全由 [firestore.rules](firestore.rules) 裡的 Email 白名單決定。

要授權某個人使用：

1. 打開 [firestore.rules](firestore.rules)，找到 `isAllowed()` 裡的 Email 陣列。
2. 把對方的 **Google 帳號 Email** 加進去（用逗號分隔），例如：
   ```
   request.auth.token.email in [
     'damoncho510@gmail.com',
     'someone@gmail.com',
     'another@gmail.com'
   ]
   ```
3. 到 Firebase Console 的 Firestore「規則」分頁，貼上更新後的內容並**發布**。

不在白名單裡的 Google 帳號，登入後會馬上被系統彈回登入畫面並顯示「沒有存取權限」，看不到任何資料。要移除某人，把他的 Email 從白名單刪掉再重新發布即可。

## 三、本機開發

```bash
npm install
npm run dev
```

瀏覽器打開終端機顯示的網址（通常是 http://localhost:5173）即可看到網頁。

## 四、部署到 GitHub Pages

1. 建一個新的 GitHub repository，把這個資料夾 push 上去：
   ```bash
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin <你的repo網址>
   git push -u origin main
   ```
2. 到 GitHub repository 的「Settings」→「Pages」，「Build and deployment」的 Source 選擇 **GitHub Actions**。
3. push 到 `main` 分支時，會自動觸發 `.github/workflows/deploy.yml`，build 完自動部署，完成後網址會顯示在 Pages 設定頁裡。

## 安全性與隱私

這份名單包含他人的姓名、系級、聯絡方式、以及對他們的「策略/做法」等敏感內容。

### Firebase apiKey 為什麼公開沒關係

Firebase 的 Web `apiKey` 只是用來**識別專案**，不授予任何資料權限，公開在前端是 Google 官方認可的正常做法。因為本專案是純靜態網站，這把 key 一定會出現在部署後的 JS 裡，藏不住也不需要藏。真正的存取控管靠下面三層：

1. **Firestore 安全規則（最重要）**：[firestore.rules](firestore.rules) 用 Email 白名單，只有清單內的 Google 帳號能讀寫，其他人（包含拿到 apiKey 的陌生人）一律被擋。
2. **Google 登入**：必須先用 Google 帳號登入才會有 `request.auth`。
3. **（建議加強）API key 限制**：到 [Google Cloud Console 憑證頁](https://console.cloud.google.com/apis/credentials) → 找到 Firebase 自動建立的 Browser key → 「應用程式限制」設 HTTP 參照網址，只允許 `ntustcdvc1979.github.io/*` 與 `localhost`；「API 限制」只勾用得到的 API。這樣就算別人複製你的 apiKey 也很難從別的網站濫用。
4. **（進階選項）App Check**：若想更嚴格地確保只有你的網站能呼叫 Firebase，可啟用 Firebase App Check（搭配 reCAPTCHA）。

### 白名單管理

- **只把需要用的人的 Google Email 加進白名單**；要移除某人，把他的 Email 從白名單刪掉並重新發布規則即可。
- 白名單靠 Google 帳號 Email，請確認打的是對方真正的 Google 帳號 Email。
- 不要把資料截圖或匯出後任意外傳。
