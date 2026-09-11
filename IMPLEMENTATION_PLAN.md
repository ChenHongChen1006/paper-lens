# PaperLens 實作計畫

MVP 個人文獻閱讀工作台。純前端 React + Vite + JavaScript，IndexedDB 儲存，
瀏覽器端直接呼叫 Claude API，並在本機核對 AI 引用是否真的存在於原文。

## Phase 1 — 專案骨架
- [x] 確認 Node/npm 版本，選擇與 Node 18 相容的套件版本
- [x] package.json / vite.config.js / index.html
- [x] 目錄結構 src/{components,pages,lib,test}
- [x] Dexie schema（storage.js）
- [x] 全站 CSS、Sidebar/App 導覽骨架

## Phase 2 — PDF 上傳與文字擷取
- [x] 上傳單篇/多篇 PDF，存 Blob 到 IndexedDB
- [x] pdf.js 逐頁擷取文字（保留頁碼）
- [x] 論文列表頁（card、搜尋、刪除）

## Phase 3 — 段落重建與參考文獻偵測
- [x] 段落重建（換行、hyphenation、多餘空白處理）＋ 穩定 segment ID（pN-sM）
- [x] References / Bibliography 偵測 heuristic ＋ Appendix 後重新納入
- [x] 掃描 PDF 偵測（中位數文字量）
- [x] 解析資訊面板（頁數、字數、排除範圍、取消排除）

## Phase 4 — 設定與 Claude 連線
- [x] 設定頁：API key（password 欄位、顯示/隱藏、刪除）
- [x] 模型選擇（Sonnet 5 / Haiku 4.5 / Opus 5 / custom）
- [x] 測試 API 連線＋中文錯誤訊息轉換
- [x] 研究背景 textarea

## Phase 5 — 分析 Prompt 與 structured output
- [x] prompts.js：五大 module system/user prompt
- [x] api.js：呼叫 Claude、tool-based structured output、fallback JSON parser
- [x] usage 累加（含 cache tokens）

## Phase 6 — 本機引用核對
- [x] text.js：normalizeText / verifyQuote（exact → partial → not_found）
- [x] segment/page 範圍搜尋順序（指定 segment → 同頁 → 全文）
- [x] evidence modal，安全 highlight（無 dangerouslySetInnerHTML）
- [x] 在 PDF 開啟指定頁

## Phase 7 — 單篇論文操作
- [x] 五面向完成狀態＋「分析全部未完成面向」循序執行＋進度顯示
- [x] 自訂提問 + 歷史紀錄

## Phase 8 — 掃描 PDF OCR
- [x] Canvas render → JPEG → Claude vision 逐頁辨識
- [x] 小批次＋進度＋失敗重試
- [x] OCR 文字建立 pages/segments，UI 標示以 OCR 為準

## Phase 9 — 跨篇比較
- [x] 選 2-10 篇已分析論文、聚焦問題
- [x] consensus / contradiction / research_gap，來源 ID 本機驗證
- [x] 比較結果保存、可刪除、可追溯回原文

## Phase 10 — 匯出與備份
- [x] Markdown 匯出（複製/下載）
- [x] 備份 JSON 匯出（不含 API key / PDF Blob）／匯入驗證
- [x] Usage 統計頁面

## Phase 11 — 響應式與錯誤處理
- [x] RWD（手機可用主要流程）
- [x] Error boundary，防止整頁 crash

## Phase 13 — 解析文字檢視（debug PDF parsing / references detection）
- [x] 「解析文字」分頁：忠實顯示 IndexedDB 中的 pages/segments（不重新解析、不呼叫 Claude）
- [x] 每個 segment 顯示 ID、頁碼、原文、是否送給 Claude（文字 Badge，非純顏色）
- [x] 搜尋（case-insensitive 子字串）、狀態篩選（全部/送給 Claude/已排除）、頁碼篩選
- [x] 依頁分組 + `<details>` 收合，搜尋時自動展開第一個符合的頁面
- [x] References/Appendix 邊界的視覺提示，且邊界判斷與實際送給 Claude 的 segment 篩選共用同一個 `computeExcludedSegmentIds`／`filterSendableSegments`（見 text.js），避免兩套邏輯不一致
- [x] 補測試確認 References 排除是 segment-level（非 page-level）：同頁但在 heading 之前的正文不會被排除，Appendix 之後即使與被排除內容同頁也會重新納入

## Phase 12 — 測試、build、README、部署
- [x] Vitest 單元測試（normalizeText / verifyQuote / references detection / backup 過濾）
- [x] npm test 通過
- [x] npm run build 通過
- [x] README.md（繁體中文）
- [x] .github/workflows/deploy.yml（GitHub Pages）

---

## 最終驗收

- `npm test`：3 個測試檔、22 個測試全部通過（純函式測試 + 真的用 fake-indexeddb 跑 Dexie + 用手刻的最小合法 PDF 真的跑一次 pdfjs 抽取流程，不是 mock）
- `npm run build`：成功產生 `dist/`（含 pdf.js worker、standard fonts、cmaps 靜態資源）
- 已知限制詳見 [README.md「已知限制」](./README.md#已知限制mvp)

狀態：MVP 已完成，可用 `npm run dev` 啟動。
