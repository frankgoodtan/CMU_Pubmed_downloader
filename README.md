# PubMed PDF 批次下載器 v6

Chrome 擴充功能，讓 CMU（中國醫藥大學）研究人員透過 EZproxy 批次下載 PubMed 論文 PDF created by PBCM 38 譚皓宇 with Claude協作等 有bug回報 line 
把debug資料夾複製一份以便查看問題

支援並行下載（1/2/3/5 篇同時跑）、多出版商（Elsevier/ScienceDirect、JAMA/Silverchair、PMC、Wiley、Springer、SciELO、SAGE、OUP 等）、本地資料夾模式（PDF／失敗筆記／進度 Excel 直接存到你自選的資料夾）、人機驗證偵測與提醒。
本專案只適用window 作業系統

## 快速開始（全新電腦，什麼都沒裝也可以照做）

### 0. 前置需求
- **Google Chrome**
- **Python 3**（直接去 python 官網安裝最新版本的 python3.xx，裝的時候記得勾選「Add python.exe to PATH」）——native host 需要的 Python 套件（opencv-python / mss / numpy / openai-whisper）已經整理進 [`native_host/requirements.txt`](./native_host/requirements.txt)，下面第 3 步的一鍵安裝.bat 會自動幫你 `pip install`，不需要自己手動下指令。想手動裝的話：
  ```
  pip install -r native_host/requirements.txt
  ```
  （openai-whisper 只有「EZproxy 重登語音驗證碼自動辨識」需要，連帶會裝 torch，約幾百 MB，第一次安裝要一點時間；不裝這個套件，重新登入一律照舊跳出來手動輸入，不影響其他功能。本地資料夾模式／debug log 那個 host 只用 Python 內建模組，不需要額外套件）

### 1. 把這個 repo 抓下來

**方式 A：網頁下載 ZIP（不用裝 git）**
1. 這個頁面右上角「Code」→「Download ZIP」
2. 解壓縮——注意通常會多一層資料夾，要點進去到**看得到 `manifest.json` 的那一層**

**方式 B：git clone**
```可略，應該大部分人沒裝git 用A下載整個ZIP壓縮檔即可
git clone https://github.com/frankgoodtan/CMU_Pubmed_downloader.git
```
跑完會得到一個 `CMU_Pubmed_downloader` 資料夾，裡面直接就是 `manifest.json` 那一層。

編按:
安裝流程
總之先下載整個zip檔，1.解壓縮到桌面 2.先開啟chrome ->右上角選單(擴充功能)->載入未封裝項目->選整個資料夾 就載入成功了  3.成功安裝擴充插件後，要點一鍵安裝.bat(順序不能反，因為括重功能安裝完我才有system id可以調擴充功能使用作業系統)，總之按下去就好了，會跑出cmd小黑窗提示你安裝完成，是正常的關掉就好 大功告成。
使用方式:
這個擴充功能下載的論文是以資料夾為單位(會生成並建立讀取 下載成功/失敗/重試的資料夾，依下載狀態分類)，總之建立並選一個空資料夾當成之後下載的地方。


### 2. 載入 Chrome 擴充功能
1. `chrome://extensions`
2. 打開右上角「開發人員模式」
3. 「載入未封裝項目」→ 選步驟 1 那個看得到 `manifest.json` 的資料夾


### 3. 一鍵安裝 native host
雙擊資料夾最上層的 **`一鍵安裝.bat`**：會先自動 `pip install -r native_host/requirements.txt` 裝好全部需要的 Python 套件，再從 `manifest.json` 算出擴充功能 ID（不用自己去 `chrome://extensions` 複製），並註冊好「畫愛心人機驗證提醒」、「本地資料夾模式／debug log」、「EZproxy 重登語音驗證碼自動辨識」這三個 native messaging host。跑完按任意鍵關掉即可，回 `chrome://extensions` 把擴充功能重新整理一次。

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
