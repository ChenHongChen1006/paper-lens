# PaperLens（文獻工作台）

一個個人用的學術論文閱讀工具。核心理念不是單純叫 AI 摘要論文，而是：

> Claude 提出重點 → 必須附原文 quote → 網站在本機重新核對這段 quote 是否真的存在於 PDF 擷取出的文字中 → 明確告訴你核對結果。

純前端網站（React + Vite + JavaScript），沒有後端伺服器，資料全部存在瀏覽器的 IndexedDB。Claude API key 只存在你自己的瀏覽器裡，由你自己輸入，直接從瀏覽器呼叫 Claude API。

## 線上使用

PaperLens： https://chenhongchen1006.github.io/paper-lens/

## 功能

- 上傳單篇或多篇 PDF，在瀏覽器內用 [pdf.js](https://mozilla.github.io/pdf.js/) 逐頁擷取文字並保留頁碼
- 自動把擷取出的文字重建成段落，並給每個段落一個穩定 ID（例如 `p3-s12`），做為後續 AI 引用與核對的依據
- 自動偵測「參考文獻」區塊並在分析時排除；若參考文獻後又出現「附錄」，附錄之後的內容會重新納入分析範圍
- 偵測可能是「掃描 PDF」的檔案，並提供以 Claude 圖片辨識（vision OCR）建立可搜尋文字的選項（會額外使用 API 用量，執行前會先提醒）
- 五種分析面向：速覽、方法論、數據細節、可復現性、弱點與延伸，皆可個別或一鍵批次執行
- 每個分析重點都附「原文依據」，並在瀏覽器本機重新比對該引用是否真的存在於論文原文（三種結果：原文已核對 / 部分符合 / 找不到原文），不盲信 AI 回報的頁碼
- 自訂提問（例如「為什麼作者沒有用 CoDel 當 baseline？」），一樣走同樣的原文核對流程
- 跨篇比較（2-10 篇已分析論文）：整理共識、矛盾、研究缺口，並驗證每個引用來源是否真的存在
- 匯出 Markdown（複製或下載）、匯出/匯入 JSON 備份、用量統計（tokens）

## 開始使用

需求：Node.js 18 或以上（本專案的套件版本固定在與 Node 18 相容的版本）。

```bash
npm install
npm run dev
```

開啟終端機顯示的網址（預設 http://localhost:5173/）即可使用。

### 設定 Claude API key

1. 進入「設定」頁
2. 貼上你的 Claude API key（從 [Anthropic Console](https://console.anthropic.com/) 取得）
3. 選擇模型（預設 Claude Sonnet 5，也可以選 Haiku 4.5 / Opus 5 / 自訂 model ID）
4. 按「測試 API 連線」確認可以正常使用

沒有 API key 也可以正常上傳、解析 PDF，只有在執行 AI 分析（分析面向、自訂提問、OCR、跨篇比較）時才需要。

## 資料存在哪裡

所有論文、擷取文字、分析結果、提問紀錄、比較結果，都存在瀏覽器的 **IndexedDB**（透過 [Dexie](https://dexie.org/)），不會傳到任何第三方伺服器 —— 分析請求本身除外：那是你的瀏覽器直接呼叫 Anthropic 的 Claude API。

清除瀏覽器資料（或使用無痕模式）會連同這些資料一起清除，請善用「設定」頁的備份功能。

## API key 的安全限制

**請務必閱讀**：這是一個「自帶 API key」（BYO API key）的純前端工具。

- API key 只會存在你目前使用的瀏覽器（IndexedDB），不會寫入程式碼、不會出現在 GitHub 儲存庫、也不會包含在備份檔裡
- 但因為這是純前端網站，頁面上執行的 JavaScript（包含瀏覽器擴充功能等）理論上能夠存取並使用這把 key
- 我們**不會**宣稱「API key 絕對安全」——請只在你信任的裝置、瀏覽器與網路環境下使用，不要在公用電腦上長期保留 key

## 部署到 GitHub Pages

`.github/workflows/deploy.yml` 已經設定好：push 到 `main` 分支時會自動 `npm ci && npm test && npm run build`，並把 `dist/` 部署到 GitHub Pages。

1. 在 GitHub repository 設定裡，把 Pages 的來源設為 "GitHub Actions"
2. push 到 `main` 分支，等待 Actions 跑完
3. 網站會部署在 https://chenhongchen1006.github.io/paper-lens/

`vite.config.js` 使用 `base: './'`（相對路徑），所以不需要在程式裡寫死使用者名稱或 repo 名稱，部署在網域根目錄或子路徑都可以正常載入資源。路由使用 `HashRouter`，避免 GitHub Pages 的 SPA 404 問題。

## 備份與還原

「設定」頁可以下載/匯入 JSON 備份。備份內容包含：論文的擷取文字、段落、分析結果、提問紀錄、比較結果、研究背景設定。

備份**不包含**：

- Claude API key（安全考量，永遠不會被匯出）
- PDF 原始檔（避免備份檔過大；匯入備份後，若要繼續使用「在 PDF 開啟此頁」等功能，需要重新上傳對應的 PDF）

匯入備份時，相同 ID 的資料會被覆蓋（`put` 語意）；來源不明或格式不符的檔案會在匯入前被檔案格式驗證擋下。

## 掃描 PDF 與 OCR

判斷一份 PDF 是否為「掃描檔」時，不只看第一頁（第一頁常常是封面），而是看全部頁面擷取字數的中位數。若判定為掃描 PDF：

- 會顯示提示，並提供「開始辨識」按鈕，不會未經同意就自動呼叫 API
- 辨識方式：把每一頁 render 成一張解析度受限的 JPEG，透過 Claude 圖片辨識（vision）逐頁轉錄文字，這會依頁數額外使用 API 用量
- OCR 完成後的引用核對，是「對 OCR 文字核對」，介面上會明確標示「此論文為掃描 PDF，引用核對以 OCR 文字為準」
- 個別頁面辨識失敗可以單獨重試，不會讓整篇論文的資料損毀

## 已知限制（MVP）

以下是目前版本已知、刻意不過度工程化的限制：

- **段落重建是 heuristic**：依據 PDF 文字項目的幾何位置（行距、縮排）判斷段落邊界，不是完美的排版還原；行尾斷字（hyphenation）的還原也是 heuristic，極少數情況可能誤刪合法的連字號
- **參考文獻 / 附錄偵測是 heuristic**：以標題文字 pattern ＋ 文件後半部位置 ＋ 後續內容的 citation 特徵判斷，可能誤判；可以在「解析資訊」分頁手動取消排除
- **段落不跨頁**：每個 segment 只屬於一頁，若一個段落被硬生生從某頁尾延續到下一頁開頭，會被拆成兩個 segment（頁碼仍然各自正確）
- **OCR 為逐頁循序處理**，頁數多的掃描 PDF 會需要較長時間，且會依頁數使用較多 API 額度
- **部分符合（fuzzy match）的原文核對**採用「保留詞語相對順序」的相似度演算法，是合理但非學術等級的近似匹配，極端改寫的句子可能被誤判為「找不到原文」
- **跨篇比較目前依據「已完成的分析結果」**，而不是重新讀取論文全文；尚未分析的面向不會被納入比較
- 目前沒有自動幫論文取更漂亮的標題（沒有 PDF metadata 時，直接用檔名當標題），避免額外呼叫 API
- 手機版可以完成主要操作流程（上傳、閱讀、分析、提問、設定），但沒有為手機做完整的 PDF 閱讀器體驗

## 開發

```bash
npm run dev      # 開發伺服器
npm test         # 執行 Vitest 測試（純函式 + 真實 pdf.js 抽取流程的整合測試）
npm run build    # production build 到 dist/
npm run preview  # 本機預覽 build 後的網站
```

程式架構、開發規則請見 [CLAUDE.md](./CLAUDE.md)。開發進度與待辦事項請見 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。
