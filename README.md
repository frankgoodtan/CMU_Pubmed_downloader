# PubMed PDF 批次下載器 v6

Chrome 擴充功能，讓 CMU（中國醫藥大學）研究人員透過 EZproxy 批次下載 PubMed 論文 PDF，省去手動逐篇下載的麻煩。

支援並行下載（1/2/3/5 篇同時跑）、多出版商（Elsevier/ScienceDirect、JAMA/Silverchair、PMC、Wiley、Springer、SciELO、SAGE、OUP 等）、本地資料夾模式（PDF／失敗筆記／進度 Excel 直接存到你自選的資料夾）、人機驗證偵測與提醒。

## 快速開始（全新電腦，什麼都沒裝也可以照做）

### 0. 前置需求
- **Google Chrome**
- **Python 3**（native host 要靠它跑；裝的時候記得勾選「Add python.exe to PATH」）
  ```
  pip install opencv-python mss numpy
  ```
  （只有「畫愛心人機驗證提醒」那個功能需要這三個套件；本地資料夾模式／debug log 那個 host 只用 Python 內建模組）

### 1. 把這個 repo 抓下來

**方式 A：網頁下載 ZIP（不用裝 git）**
1. 這個頁面右上角「Code」→「Download ZIP」
2. 解壓縮——注意通常會多一層資料夾，要點進去到**看得到 `manifest.json` 的那一層**

**方式 B：git clone**
```
git clone https://github.com/frankgoodtan/CMU_Pubmed_downloader.git
```
跑完會得到一個 `CMU_Pubmed_downloader` 資料夾，裡面直接就是 `manifest.json` 那一層。

### 2. 載入 Chrome 擴充功能
1. `chrome://extensions`
2. 打開右上角「開發人員模式」
3. 「載入未封裝項目」→ 選步驟 1 那個看得到 `manifest.json` 的資料夾

### 3. 一鍵安裝 native host
雙擊資料夾最上層的 **`一鍵安裝.bat`**：會自動從 `manifest.json` 算出擴充功能 ID（不用自己去 `chrome://extensions` 複製），並註冊好「畫愛心人機驗證提醒」跟「本地資料夾模式／debug log」這兩個 native messaging host。跑完按任意鍵關掉即可，回 `chrome://extensions` 把擴充功能重新整理一次。

不裝這步，下載/暫停/Excel 匯出等主要功能還是能動，只是人機驗證提醒、本地資料夾模式、debug log 留痕會用不了，自動退回 Chrome 內建下載資料夾。

詳細安裝步驟、疑難排解、換電腦怎麼辦，見 [`安裝說明.txt`](./安裝說明.txt) 跟 [`native_host/安裝說明.txt`](./native_host/) 資料夾裡的說明。

## 專案結構
```
├── 一鍵安裝.bat        ← 雙擊裝好全部 native host
├── 安裝說明.txt        ← 完整安裝/疑難排解說明
├── manifest.json       ← Chrome MV3 擴充功能設定（必須留在根目錄）
├── src/                ← 擴充功能核心程式碼（background/popup/平台判斷邏輯…）
├── native_host/        ← Native Messaging Host（Python）、安裝腳本、debug_log/
├── icons/
└── dev-tools/          ← 跟擴充功能執行無關的開發輔助工具
```
