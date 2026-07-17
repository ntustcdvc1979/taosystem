import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// 設定值改從環境變數讀取，不寫死在原始碼裡（避免進 git 歷史）。
// - 本機開發：把值放在 .env.local（此檔已被 .gitignore 忽略，不會上傳）
// - GitHub 部署：把值設在 repo 的 Secrets，由 GitHub Actions 在 build 時注入
// 注意：這組值本身不是密碼，最終仍會出現在打包後的前端 JS 中；
// 真正的存取控管一律靠 Firestore 安全規則（Email 白名單）+ 登入驗證。
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
