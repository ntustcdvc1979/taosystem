import { defineConfig } from "vite";

// 使用相對路徑，這樣不論部署在 GitHub Pages 的哪個子路徑下都能正確載入資源
export default defineConfig({
  base: "./",
});
