"""
偵測到人機驗證時，由 background.js 透過 Chrome Native Messaging 呼叫這支腳本
（經 python_write_love.bat 轉呼叫）。

啟動後自己找 checkbox 座標，不盲目相信 background.js 傳來的東西：
  1. 對螢幕做多尺度樣板比對，算出目標元件的螢幕絕對座標。background.js 一次
     驗證可能同時抓到好幾個候選元件（reCAPTCHA/Turnstile/hCaptcha/px-captcha/
     challenge-form 都可能同時出現），每個候選各自呼叫一次這支腳本，所以這裡
     分兩種模式：
     A) 有帶 dom_region（這次要看哪個候選的外框，background.js 用 DOM 量出來）：
        全程只在這個候選的範圍內找，找不到就回報這個候選沒中，絕對不會跑去
        比對到畫面上其他候選的東西（不然會把提醒錯誤地指到別的候選上）：
          a) 先在這個外框（外加一點容錯邊界）裡面比對 common_checkbox 樣板
             ——checkbox 通常在跨網域 iframe 裡，DOM 端本來就看不到它，只
             看得到外框，所以還是要靠樣板比對才能定出 checkbox 本身座標。
          b) 沒中就退而在同一個範圍內找 logo（Cloudflare／reCAPTCHA／hCaptcha
             圖示，locale 無關）當備援，找到再鎖定附近小範圍比對 checkbox。
     B) 沒有 dom_region（background.js 完全沒抓到候選，只能盲找）：
          a) 三家 logo 樣板對整個螢幕搜尋，先大概定位。
          b) 鎖定 logo 附近一小塊範圍比對 checkbox 精確座標。
          c) 都沒中才用 common_checkbox 樣板對整個螢幕搜尋，當最後手段
             （準度天生較差，容易跟其他空白 UI 誤判）。
     兩種模式都找不到就當作沒有目標（x/y 為 None）。上面這一整套比對外面包了
     一層重試（locate_target_with_retry）：驗證挑戰元件跳出來後通常會先轉圈圈
     讀取幾秒才真的渲染出 checkbox，一偵測到就馬上掃很容易撲空，所以找不到就
     等 1 秒再試一次，最多重試到約 5 秒的時間預算用完才真的放棄。
  2. 有找到座標的話，用真人錄製軌跡（優先）或內建合成移動模式（fallback）
     把 OS 滑鼠移過去（只移動，不點擊——這支工具是提醒真人來手動處理
     驗證，不是自動幫真人點掉）。
  3. 用一個蓋住整個虛擬桌面、背景透明的視窗直接疊加在真實畫面上：藍色半透明
     填色標出 DOM 量到的驗證元件外框、紅色半透明填色標出比對到的 checkbox
     精確範圍、黃色小圓點標出滑鼠實際移動去的目標點，文字寫上這個候選是哪個
     DOM 選擇器、比對是靠哪一層成功的。疊在真實畫面上才能直接比對「框對了
     沒有」，不用自己在心裡換算獨立視窗對應到螢幕哪裡。畫完幾秒後自動關閉。
  4. 視窗真的關閉後才回 ack。background.js 的候選輪流迴圈是 await 這個 ack
     才換下一個候選——如果 ack 提早送出（提醒視窗還開著），下一個候選的
     螢幕掃描很可能會撞上這個還沒關掉的視窗，把比對結果帶偏，所以故意讓
     chrome.runtime.sendNativeMessage 的 callback 等到畫完才觸發。
沒找到目標時，跳過移動，提醒視窗退回螢幕預設置中位置，不畫方框/準心。

Chrome Native Messaging 的 stdio 協定：訊息前面帶 4 bytes little-endian 長度，
後面接 UTF-8 JSON。background.js 傳來的 payload 如果帶 left/top/width/height，
只當作「去哪裡找 checkbox」的範圍提示，實際座標還是自己比對樣板決定，不是
直接照抄 payload 裡的值。
"""

import ctypes
import ctypes.wintypes
import glob
import json
import math
import os
import random
import re
import struct
import sys
import time
from pathlib import Path

import cv2
import mss
import numpy as np


USER32 = ctypes.windll.user32 if sys.platform == "win32" else None


# ============================================================
# 區塊 0／4：螢幕樣板比對（自己掃描找目標座標）
# 啟動後第一件事：對整個虛擬桌面做多尺度模板匹配。兩層樣板見下方
# locate_target() 的說明。這樣 native host 不必依賴呼叫端
# （background.js 用 DOM 算出的座標）就能自己定位要提醒的目標。
# ============================================================


def enable_windows_dpi_awareness() -> None:
    """避免 Windows 125%／150% 顯示縮放造成螢幕擷取座標跟滑鼠移動座標對不齊。"""
    if sys.platform != "win32":
        return

    try:
        # Windows 10/11：Per-monitor DPI aware
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def capture_virtual_desktop():
    """
    擷取所有螢幕組成的虛擬桌面。

    回傳：
        screen_bgr：OpenCV BGR 影像
        monitor：包含 left、top、width、height
    """
    with mss.MSS() as sct:
        # monitors[0] 是所有螢幕合併後的虛擬桌面。
        monitor = sct.monitors[0]
        screenshot = np.array(sct.grab(monitor))

    # MSS 回傳 BGRA，轉成 BGR。
    screen_bgr = cv2.cvtColor(screenshot, cv2.COLOR_BGRA2BGR)
    return screen_bgr, monitor


def find_best_match(screen_bgr, template_bgr, min_scale=0.85, max_scale=1.15, scale_steps=13):
    """
    進行多尺度模板匹配，回傳整個畫面中最相似的位置。
    永遠回傳「最接近」的候選結果（不設門檻），由呼叫端自行判斷分數。
    """
    screen_gray = cv2.cvtColor(screen_bgr, cv2.COLOR_BGR2GRAY)
    template_gray_original = cv2.cvtColor(template_bgr, cv2.COLOR_BGR2GRAY)

    best = None
    scales = np.linspace(min_scale, max_scale, scale_steps)

    for scale in scales:
        width = max(1, round(template_gray_original.shape[1] * scale))
        height = max(1, round(template_gray_original.shape[0] * scale))

        if width > screen_gray.shape[1] or height > screen_gray.shape[0]:
            continue

        interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
        template_gray = cv2.resize(
            template_gray_original,
            (width, height),
            interpolation=interpolation,
        )

        result = cv2.matchTemplate(screen_gray, template_gray, cv2.TM_CCOEFF_NORMED)
        _, score, _, top_left = cv2.minMaxLoc(result)

        if best is None or score > best["score"]:
            best = {
                "score": float(score),
                "top_left_local": top_left,
                "width": width,
                "height": height,
                "scale": float(scale),
            }

    return best


def imread_unicode(path):
    # cv2.imread() 在 Windows 上遇到非 ASCII 路徑會直接讀取失敗（回傳 None），
    # 這個專案資料夾路徑本身就含中文，所以一定要繞道用 np.fromfile + cv2.imdecode。
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))

# ============================================================
# checkbox 定位除錯截圖：每個候選在畫提醒標記「之前」（真實畫面，沒有疊圖）跟
# 「顯示中」（疊了藍色 iframe 框／紅色 checkbox 框，MARKER_DISPLAY_MS 顯示期間
# 拍的）各存一張，檔名帶候選名稱＋時間戳記，方便事後一次看完整輪的定位結果，
# 不用再靠猜時間點手動截圖比對。background.js 每次驗證一開始（第一次嘗試的第
# 一個候選）會在 payload 帶 clearDebugFolder=true，那次呼叫會先清空這個資料夾，
# 確保裡面的圖都是「這次」驗證流程留下的，不會混到上一次的殘留檔案。
DEBUG_DIR = BASE_DIR / "checkbox定位debug"


def clear_debug_dir():
    DEBUG_DIR.mkdir(exist_ok=True)
    for item in DEBUG_DIR.iterdir():
        if item.is_file():
            try:
                item.unlink()
            except OSError:
                pass


def sanitize_debug_label(label):
    label = label or "unknown"
    return re.sub(r"[^A-Za-z0-9_\-.]+", "_", label).strip("_") or "unknown"


def save_debug_screenshot(screen_bgr, label, suffix):
    # cv2.imwrite() 跟 cv2.imread() 一樣，在 Windows 上遇到非 ASCII 路徑會直接
    # 寫入失敗（這個除錯資料夾本身、跟外層專案資料夾都含中文）——一樣繞道用
    # cv2.imencode 編碼成 bytes，再用 Python 原生的檔案寫入（不會有這個限制）。
    DEBUG_DIR.mkdir(exist_ok=True)
    timestamp = time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1000) % 1000:03d}"
    filename = f"{sanitize_debug_label(label)}_{timestamp}_{suffix}.png"
    try:
        ok, buffer = cv2.imencode(".png", screen_bgr)
        if ok:
            (DEBUG_DIR / filename).write_bytes(buffer.tobytes())
    except Exception:
        pass


# 第一層：三家廠商的 logo 圖示（只裁圖形本身，不含「我不是機器人」這類會被
# 翻譯成不同語言的文字，也不含「Privacy・Terms」）。logo 是廠商固定資產，不會
# 因為頁面語言改變，比對比含文字的整條驗證列穩定得多。checkbox_offset 是「這張
# logo 截圖的左上角」到「同一張原始截圖裡 checkbox 中心」的像素向量，量測自
# Clouflare_verify_template.png / Google_rcapcha_template.png / hCaptcha_template.jpg
# 這三張完整驗證列原圖。比對到 logo 之後，用這個向量（乘上比對到的縮放比例）
# 大概推算 checkbox 可能在哪，再用第二層去那附近精確搜尋。
VENDOR_LOGO_TEMPLATES = [
    {"name": "cloudflare", "file": BASE_DIR / "Clouflare_logo_template.png", "checkbox_offset": (-355, 42)},
    {"name": "recaptcha", "file": BASE_DIR / "Google_rcapcha_logo_template.png", "checkbox_offset": (-303, 37)},
    {"name": "hcaptcha", "file": BASE_DIR / "hCaptcha_logo_template.png", "checkbox_offset": (-449.5, 83.5)},
]
LOGO_MIN_SCORE = 0.7
# 第二層搜尋範圍半徑（原始樣板像素單位，實際使用時會乘上第一層比對到的縮放比例）。
CHECKBOX_SEARCH_HALF_EXTENT = 90

# 第 0 層：background.js 用 DOM 量出來的驗證元件外框（left/top/width/height，
# 螢幕絕對座標）。checkbox 通常在跨網域 iframe 裡，DOM 端本來就看不到它本身，
# 只看得到外框——所以這裡不是直接採信這個框當座標，而是把 common_checkbox
# 樣板的搜尋範圍縮小到「這個框 + 一點容錯邊界」，分數太低（DOM 算出來的框可能
# 歪掉，或裡面根本不是 checkbox 樣式的驗證元件）就當作沒找到，退到下一層。
# 容錯邊界故意夾在 [PAD_MIN, PAD_MAX] 之間、不是單純用比例：純比例對大一點的
# iframe（例如寬 300px）會放大到 75px 容錯，容易把搜尋範圍擴到 iframe 外面去，
# 誤比對到隔壁其他候選元件或無關的畫面內容。
DOM_REGION_MIN_SCORE = 0.3
DOM_REGION_PADDING_RATIO = 0.08
DOM_REGION_PAD_MIN = 10.0
DOM_REGION_PAD_MAX = 30.0

# 第三層（最後手段）：從三張完整驗證列裡各自裁出的 checkbox 方塊本身，代表三家
# 共通的「空白方形 checkbox」樣式。只有三家 logo 都找不到時才會用到——純方塊
# 特徵少，對整個螢幕搜尋容易跟其他空白 UI 誤判，但總比完全沒有座標好，用來
# 應付 px-captcha/challenge-form 這類沒建過專屬樣板的驗證元件。
COMMON_CHECKBOX_TEMPLATES = [
    BASE_DIR / "common_checkbox_template_cloudflare.png",
    BASE_DIR / "common_checkbox_template_recaptcha.png",
    BASE_DIR / "common_checkbox_template_hcaptcha.png",
]


def match_template_file(screen_bgr, template_path, min_scale=0.85, max_scale=1.15, scale_steps=13):
    template_bgr = imread_unicode(template_path)
    if template_bgr is None:
        return None
    return find_best_match(screen_bgr, template_bgr, min_scale=min_scale, max_scale=max_scale, scale_steps=scale_steps)


def locate_via_vendor_logo(screen_bgr, min_score=LOGO_MIN_SCORE):
    """回傳 (predicted_x, predicted_y, score, name, scale)；三家 logo 都比不到或
    分數不到門檻就回傳 None。這裡的座標只是「大概推算」出的 checkbox 位置，
    精確位置要交給 match_checkbox_in_region() 在附近小範圍內再搜一次。
    min_score 可由呼叫端覆寫——同一頁重試多次仍找不到時，background.js 會逐次
    調低門檻（見 monitorManualVerification 的三次嘗試協定）。"""
    best = None
    best_spec = None
    for spec in VENDOR_LOGO_TEMPLATES:
        match = match_template_file(screen_bgr, spec["file"])
        if match is None:
            continue
        if best is None or match["score"] > best["score"]:
            best = match
            best_spec = spec

    if best is None or best["score"] < min_score:
        return None

    scale = best["scale"]
    logo_left, logo_top = best["top_left_local"]
    offset_x, offset_y = best_spec["checkbox_offset"]
    predicted_x = logo_left + offset_x * scale
    predicted_y = logo_top + offset_y * scale
    return predicted_x, predicted_y, best["score"], best_spec["name"], scale


# 真人點 checkbox 幾乎不會每次都落在正中心，鼠標最終目標點加一點隨機偏移，
# 但夾在方框範圍的中間 50%（各軸 ±25%）以內，確保仍然點得到 checkbox 本身。
CHECKBOX_JITTER_RATIO = 0.25


def jitter_center(left, top, width, height, jitter_ratio=CHECKBOX_JITTER_RATIO):
    jitter_x = random.uniform(-width * jitter_ratio, width * jitter_ratio)
    jitter_y = random.uniform(-height * jitter_ratio, height * jitter_ratio)
    return left + width / 2 + jitter_x, top + height / 2 + jitter_y


def match_checkbox_in_bounds(screen_bgr, x0, y0, x1, y1):
    """只在 [x0,x1) x [y0,y1) 這個範圍內比對 common_checkbox 樣板。
    範圍小、候選少，比在整個螢幕裡搜尋準得多——這是第 0／第 2 層共用的核心。
    回傳 dict：
        target_x/target_y：滑鼠實際要移動去的點（中心點加了隨機偏移）
        box_left/box_top/box_width/box_height：比對到的 checkbox 精確範圍
            （沒加偏移的真實框，畫方框用這個，不是 target_x/y）
        score
    找不到回傳 None。"""
    height, width = screen_bgr.shape[:2]
    x0 = int(clamp(x0, 0, width))
    y0 = int(clamp(y0, 0, height))
    x1 = int(clamp(x1, 0, width))
    y1 = int(clamp(y1, 0, height))
    if x1 - x0 < 10 or y1 - y0 < 10:
        return None

    region = screen_bgr[y0:y1, x0:x1]
    best = None
    for template_path in COMMON_CHECKBOX_TEMPLATES:
        match = match_template_file(region, template_path)
        if match is None:
            continue
        if best is None or match["score"] > best["score"]:
            best = match

    if best is None:
        return None

    local_left, local_top = best["top_left_local"]
    box_left = x0 + local_left
    box_top = y0 + local_top
    box_width = best["width"]
    box_height = best["height"]
    target_x, target_y = jitter_center(box_left, box_top, box_width, box_height)
    return {
        "target_x": target_x,
        "target_y": target_y,
        "box_left": box_left,
        "box_top": box_top,
        "box_width": box_width,
        "box_height": box_height,
        "score": best["score"],
    }


def match_checkbox_in_region(screen_bgr, center_x, center_y, half_extent):
    """只在 (center_x, center_y) 附近一小塊範圍內比對 common_checkbox 樣板。"""
    return match_checkbox_in_bounds(
        screen_bgr,
        center_x - half_extent,
        center_y - half_extent,
        center_x + half_extent,
        center_y + half_extent,
    )


def padded_region_bounds(region, padding_ratio=DOM_REGION_PADDING_RATIO):
    """region：dict，帶 left/top/width/height。回傳 (x0, y0, x1, y1)——外加一點
    容錯邊界的範圍，格式不對或寬高不合理就回傳 None。容錯邊界夾在
    [DOM_REGION_PAD_MIN, DOM_REGION_PAD_MAX] 之間，不會因為 iframe 較大就放大
    到跑出 iframe 外面。locate_target() 對同一個候選的所有子步驟（checkbox
    直接比對、logo 備援、備援後的局部搜尋）都共用同一組 bounds，確保「這個候選
    的範圍」認定完全一致，不會有子步驟各自算出不同、互相打架的範圍。"""
    try:
        left = float(region["left"])
        top = float(region["top"])
        width = float(region["width"])
        height = float(region["height"])
    except (KeyError, TypeError, ValueError):
        return None

    if width <= 0 or height <= 0:
        return None

    pad_x = clamp(width * padding_ratio, DOM_REGION_PAD_MIN, DOM_REGION_PAD_MAX)
    pad_y = clamp(height * padding_ratio, DOM_REGION_PAD_MIN, DOM_REGION_PAD_MAX)
    return left - pad_x, top - pad_y, left + width + pad_x, top + height + pad_y


def locate_via_vendor_logo_in_bounds(screen_bgr, bounds, min_score=LOGO_MIN_SCORE):
    """跟 locate_via_vendor_logo 一樣的三家 logo 比對，但只在 bounds=(x0,y0,x1,y1)
    這個範圍內找，不是對整個螢幕搜尋。用在「已經知道是哪個候選元件、checkbox
    樣板沒中、改用 logo 當備援」的情境——這個候選找不到，就是找不到，不能因此
    跑去比對到畫面上其他候選的 logo（那是別的候選的地盤，不該搶）。"""
    height, width = screen_bgr.shape[:2]
    x0 = int(clamp(bounds[0], 0, width))
    y0 = int(clamp(bounds[1], 0, height))
    x1 = int(clamp(bounds[2], 0, width))
    y1 = int(clamp(bounds[3], 0, height))
    if x1 - x0 < 10 or y1 - y0 < 10:
        return None

    cropped = screen_bgr[y0:y1, x0:x1]
    result = locate_via_vendor_logo(cropped, min_score=min_score)
    if result is None:
        return None

    predicted_x, predicted_y, score, vendor_name, scale = result
    return x0 + predicted_x, y0 + predicted_y, score, vendor_name, scale


def locate_via_common_checkbox_templates(screen_bgr):
    """三家 logo 都沒中時的最後手段：直接拿裁出來的 checkbox 方塊對整個螢幕比對。"""
    best = None
    for template_path in COMMON_CHECKBOX_TEMPLATES:
        match = match_template_file(screen_bgr, template_path)
        if best is None or (match is not None and match["score"] > best["score"]):
            best = match

    if best is None:
        return None

    local_left, local_top = best["top_left_local"]
    target_x, target_y = jitter_center(local_left, local_top, best["width"], best["height"])
    return {
        "target_x": target_x,
        "target_y": target_y,
        "box_left": local_left,
        "box_top": local_top,
        "box_width": best["width"],
        "box_height": best["height"],
        "score": best["score"],
    }


def _finalize_match(virtual_monitor, match, source, region=None):
    """把 match_checkbox_in_bounds 系列回傳的 local 座標 dict，轉成 locate_target()
    對外統一的格式：全部換算成螢幕絕對座標，補上 source，並附上 region（如果是
    dom_region 這層命中，這裡放 background.js 量到的整個驗證元件/iframe 外框，
    給畫方框的視窗大小參考用；其他層沒有這個資訊，就是 None）。"""
    return {
        "x": virtual_monitor["left"] + match["target_x"],
        "y": virtual_monitor["top"] + match["target_y"],
        "score": match["score"],
        "source": source,
        "box_left": virtual_monitor["left"] + match["box_left"],
        "box_top": virtual_monitor["top"] + match["box_top"],
        "box_width": match["box_width"],
        "box_height": match["box_height"],
        "region": region,
    }


# 全螢幕盲搜（沒有 dom_region 候選時的 B 模式：logo 全螢幕 + common_checkbox
# 全螢幕最後手段）目前準度不夠、常常誤判，先關閉。函式本身留著沒刪，之後如果
# 要重新啟用/改善準度，把這個開關打開、把 locate_target() 裡對應的分支恢復即可。
ENABLE_BLIND_FULLSCREEN_SEARCH = False


def locate_target(dom_region=None, dom_region_min_score=DOM_REGION_MIN_SCORE, logo_min_score=LOGO_MIN_SCORE):
    """回傳 dict（見 _finalize_match）；完全找不到目標回傳 None。
    dom_region：background.js 用 DOM 量出來的「這一個候選元件」的外框（dict，帶
    left/top/width/height，螢幕絕對座標）。background.js 一次驗證可能會抓到
    好幾個候選（reCAPTCHA/Turnstile/hCaptcha/px-captcha/challenge-form 都可能
    同時出現），每個候選各自呼叫一次 native host，dom_region 就是「這一次要看
    的是哪一個」。
    dom_region_min_score / logo_min_score：第 0／第 1 層各自的採信門檻，預設
    是模組層級常數；background.js 的三次嘗試協定會逐次調低這兩個值傳進來
    （同一頁重試多次仍找不到，很可能是原本門檻卡掉了實際上還過得去的候選）。

    有給 dom_region（background.js 已經指定這次要看哪個候選）：全程只在這個
    候選的範圍（bounds，含一點容錯邊界）內找，不查其他地方——
      0) 先在 bounds 裡面比對 common_checkbox 樣板。
      1) 沒中就退而在同一個 bounds 裡找 logo 當備援，找到後鎖定附近小範圍比對
         checkbox 精確座標——這個小範圍會跟 bounds 取交集，不會跑出這個候選
         的範圍去（例如跑到隔壁候選、或 iframe 外面的東西）。
    兩層都沒中，就回報這個候選真的沒找到（可能是佔位元件、或已經驗證通過），
    回傳 None——絕對不能因為這個候選找不到，就跑去比對到畫面上其他候選的東西
    （例如把這個候選的提醒，錯誤地指到另一個候選的 checkbox 上，看起來像是
    「後面幾次位置不準」）。

    沒有 dom_region（background.js 完全沒抓到候選元件，只能盲找）：目前直接
    回傳 None，不做全螢幕搜尋（見 ENABLE_BLIND_FULLSCREEN_SEARCH）。
    """
    screen_bgr, virtual_monitor = capture_virtual_desktop()

    if dom_region is not None:
        local_region = {
            "left": dom_region.get("left", 0) - virtual_monitor["left"],
            "top": dom_region.get("top", 0) - virtual_monitor["top"],
            "width": dom_region.get("width"),
            "height": dom_region.get("height"),
        }
        bounds = padded_region_bounds(local_region)
        if bounds is None:
            # 連 bounds 都算不出來（格式不對／寬高不合理）：至少還是把 iframe
            # 範圍本身報回去，讓畫面上能標出藍色範圍，即使 checkbox 沒找到。
            return {
                "x": None, "y": None, "score": None, "source": None,
                "box_left": None, "box_top": None, "box_width": None, "box_height": None,
                "region": dom_region, "checkbox_found": False,
            }

        dom_match = match_checkbox_in_bounds(screen_bgr, *bounds)
        if dom_match is not None and dom_match["score"] >= dom_region_min_score:
            result = _finalize_match(virtual_monitor, dom_match, "dom_region", region=dom_region)
            result["checkbox_found"] = True
            return result

        logo_in_region = locate_via_vendor_logo_in_bounds(screen_bgr, bounds, min_score=logo_min_score)
        if logo_in_region is not None:
            predicted_x, predicted_y, logo_score, vendor_name, scale = logo_in_region
            half_extent = CHECKBOX_SEARCH_HALF_EXTENT * scale
            # 跟這個候選的 bounds 取交集，不讓局部搜尋窗跑出候選範圍外面。
            search_x0 = max(bounds[0], predicted_x - half_extent)
            search_y0 = max(bounds[1], predicted_y - half_extent)
            search_x1 = min(bounds[2], predicted_x + half_extent)
            search_y1 = min(bounds[3], predicted_y + half_extent)
            region_match = match_checkbox_in_bounds(screen_bgr, search_x0, search_y0, search_x1, search_y1)
            if region_match is not None:
                result = _finalize_match(virtual_monitor, region_match, vendor_name, region=dom_region)
                result["checkbox_found"] = True
                return result

        # 這個候選範圍內真的找不到 checkbox：iframe 本身還是有找到（dom_region
        # 不是 None），只是裡面沒有比對到 checkbox——回報 iframe 範圍讓畫面上
        # 至少能標出藍色範圍，checkbox_found 標 False，不去搶別的候選的地盤。
        return {
            "x": None, "y": None, "score": None, "source": None,
            "box_left": None, "box_top": None, "box_width": None, "box_height": None,
            "region": dom_region, "checkbox_found": False,
        }

    if not ENABLE_BLIND_FULLSCREEN_SEARCH:
        return None

    logo_result = locate_via_vendor_logo(screen_bgr, min_score=logo_min_score)
    if logo_result is not None:
        predicted_x, predicted_y, logo_score, vendor_name, scale = logo_result
        region_match = match_checkbox_in_region(
            screen_bgr, predicted_x, predicted_y, CHECKBOX_SEARCH_HALF_EXTENT * scale
        )
        if region_match is not None:
            return _finalize_match(virtual_monitor, region_match, vendor_name)

    fallback = locate_via_common_checkbox_templates(screen_bgr)
    if fallback is None:
        return None

    return _finalize_match(virtual_monitor, fallback, "common_fallback")


# 驗證挑戰元件跳出來後，通常會先轉圈圈讀取個幾秒才真的渲染出 checkbox（reCAPTCHA/
# Turnstile/hCaptcha 都是這樣，iframe 內容是非同步載入的）。如果一偵測到驗證就立刻
# 掃一次螢幕，很可能撲空（畫面上根本還沒有 checkbox 可比對），導致這次提醒只能把
# 愛心畫在螢幕中央、滑鼠也不會移動過去。這裡在 locate_target() 外面包一層重試：
# 找不到就等一下再試一次，直到真的找到，或等到這個總時間預算用完才放棄。
LOCATE_RETRY_TOTAL_WAIT = 5.0
LOCATE_RETRY_INTERVAL = 1.0


def locate_target_with_retry(
    dom_region=None,
    dom_region_min_score=DOM_REGION_MIN_SCORE,
    logo_min_score=LOGO_MIN_SCORE,
    total_wait=LOCATE_RETRY_TOTAL_WAIT,
    interval=LOCATE_RETRY_INTERVAL,
):
    deadline = time.time() + total_wait
    result = None
    while True:
        try:
            result = locate_target(dom_region, dom_region_min_score=dom_region_min_score, logo_min_score=logo_min_score)
        except Exception:
            result = None
        # dom_region 模式下 locate_target() 現在永遠回傳 dict（checkbox 沒找到
        # 也會回傳 iframe 範圍本身，讓畫面上至少能標出藍色範圍），所以「還沒找到
        # 真的要重試」的判斷不能只看 result 是不是 None，要看 x 有沒有值
        # （checkbox 真的比對到才會有 x/y）。
        checkbox_found = result is not None and result.get("x") is not None
        if checkbox_found or time.time() >= deadline:
            return result
        time.sleep(interval)


# ============================================================
# 區塊 1／4：OS 滑鼠移動引擎
# 只負責把滑鼠移到指定座標，不含點擊。優先重播真人錄製軌跡
# （真人點擊資料收集/mouse_recording/*_checkbox_100.json），
# 沒有錄製檔才退回下面 MOVE_PATTERNS 這組內建合成移動曲線。
# 由 main() 呼叫 smooth_move_mouse_to()，畫提醒標記之前先執行這一段。
# ============================================================


def get_mouse_position():
    point = ctypes.wintypes.POINT()
    USER32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def move_mouse_to(x, y):
    USER32.SetCursorPos(int(x), int(y))


def clamp(value, low, high):
    return max(low, min(high, value))


MOVE_PATTERNS = [
    {"name": "straight_soft", "curve": 0.00, "side": 0, "overshoot": 0.00, "pause": 0.03, "speed": 1.00},
    {"name": "straight_fast_start", "curve": 0.00, "side": 0, "overshoot": 0.00, "pause": 0.02, "speed": 0.88},
    {"name": "straight_slow_finish", "curve": 0.00, "side": 0, "overshoot": 0.00, "pause": 0.04, "speed": 1.08},
    {"name": "arc_left_small", "curve": 0.16, "side": -1, "overshoot": 0.00, "pause": 0.03, "speed": 1.00},
    {"name": "arc_right_small", "curve": 0.16, "side": 1, "overshoot": 0.00, "pause": 0.03, "speed": 1.00},
    {"name": "arc_left_wide", "curve": 0.28, "side": -1, "overshoot": 0.00, "pause": 0.04, "speed": 1.08},
    {"name": "arc_right_wide", "curve": 0.28, "side": 1, "overshoot": 0.00, "pause": 0.04, "speed": 1.08},
    {"name": "s_curve_left", "curve": 0.22, "side": -1, "swing": 1, "overshoot": 0.00, "pause": 0.03, "speed": 1.05},
    {"name": "s_curve_right", "curve": 0.22, "side": 1, "swing": 1, "overshoot": 0.00, "pause": 0.03, "speed": 1.05},
    {"name": "high_arc_left", "curve": 0.36, "side": -1, "vertical": -1, "overshoot": 0.00, "pause": 0.05, "speed": 1.12},
    {"name": "low_arc_right", "curve": 0.36, "side": 1, "vertical": 1, "overshoot": 0.00, "pause": 0.05, "speed": 1.12},
    {"name": "tiny_overshoot", "curve": 0.12, "side": 1, "overshoot": 0.035, "pause": 0.04, "speed": 1.06},
    {"name": "overshoot_pullback", "curve": 0.18, "side": -1, "overshoot": 0.060, "pause": 0.05, "speed": 1.15},
    {"name": "micro_pause_mid", "curve": 0.14, "side": 1, "overshoot": 0.00, "pause": 0.11, "speed": 1.10},
    {"name": "micro_pause_end", "curve": 0.10, "side": -1, "overshoot": 0.00, "pause": 0.09, "speed": 1.14},
    {"name": "short_steps", "curve": 0.10, "side": 1, "overshoot": 0.00, "pause": 0.02, "speed": 0.82, "step_scale": 0.72},
    {"name": "dense_steps", "curve": 0.18, "side": -1, "overshoot": 0.00, "pause": 0.03, "speed": 1.18, "step_scale": 1.32},
    {"name": "distance_heavy", "curve": 0.24, "side": 1, "overshoot": 0.025, "pause": 0.05, "speed": 1.22},
    {"name": "distance_light", "curve": 0.08, "side": -1, "overshoot": 0.00, "pause": 0.02, "speed": 0.92},
    {"name": "wandering_finish", "curve": 0.20, "side": 1, "overshoot": 0.020, "pause": 0.07, "speed": 1.20, "finish_wander": 1},
]


def ease_in_out(progress):
    return 0.5 - math.cos(progress * math.pi) / 2


def bezier_point(p0, p1, p2, p3, progress):
    one_minus = 1 - progress
    x = (
        one_minus ** 3 * p0[0]
        + 3 * one_minus ** 2 * progress * p1[0]
        + 3 * one_minus * progress ** 2 * p2[0]
        + progress ** 3 * p3[0]
    )
    y = (
        one_minus ** 3 * p0[1]
        + 3 * one_minus ** 2 * progress * p1[1]
        + 3 * one_minus * progress ** 2 * p2[1]
        + progress ** 3 * p3[1]
    )
    return x, y


def make_control_points(start_x, start_y, target_x, target_y, pattern):
    dx = target_x - start_x
    dy = target_y - start_y
    distance = max(1, math.hypot(dx, dy))
    normal_x = -dy / distance
    normal_y = dx / distance
    side = pattern.get("side", 0) or random.choice([-1, 1])
    curve = pattern.get("curve", 0) * distance * random.uniform(0.78, 1.22)
    vertical = pattern.get("vertical", 0) * min(90, distance * 0.12)

    p0 = (start_x, start_y)
    p3 = (target_x, target_y)
    p1 = (
        start_x + dx * random.uniform(0.22, 0.38) + normal_x * curve * side + random.uniform(-16, 16),
        start_y + dy * random.uniform(0.22, 0.38) + normal_y * curve * side + vertical + random.uniform(-16, 16),
    )
    p2_side = -side if pattern.get("swing") else side
    p2 = (
        start_x + dx * random.uniform(0.62, 0.82) + normal_x * curve * p2_side + random.uniform(-12, 12),
        start_y + dy * random.uniform(0.62, 0.82) + normal_y * curve * p2_side + vertical * 0.35 + random.uniform(-12, 12),
    )
    return p0, p1, p2, p3


USER_TRACE_TEMPLATES = None


def latest_checkbox_trace_file():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    pattern = os.path.join(os.path.dirname(base_dir), "真人點擊資料收集", "mouse_recording", "*_checkbox_100.json")
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def normalize_trial_trace(trial):
    trace = [point for point in trial.get("trace", []) if point.get("type") == "mousemove"]
    click = trial.get("click", {})
    if len(trace) < 8 or "stageX" not in click or "stageY" not in click:
        return None

    start = trace[0]
    end_x = float(click["stageX"])
    end_y = float(click["stageY"])
    start_x = float(start["stageX"])
    start_y = float(start["stageY"])
    dx = end_x - start_x
    dy = end_y - start_y
    distance = math.hypot(dx, dy)
    if distance < 80:
        return None

    duration_ms = max(120.0, float(click["t"]) - float(start["t"]))
    dir_x = dx / distance
    dir_y = dy / distance
    normal_x = -dir_y
    normal_y = dir_x
    points = []

    for point in trace:
        rel_x = float(point["stageX"]) - start_x
        rel_y = float(point["stageY"]) - start_y
        u = (rel_x * dir_x + rel_y * dir_y) / distance
        v = (rel_x * normal_x + rel_y * normal_y) / distance
        t = (float(point["t"]) - float(start["t"])) / duration_ms
        points.append({
            "t": clamp(t, 0, 1),
            "u": clamp(u, -0.25, 1.25),
            "v": clamp(v, -0.45, 0.45),
        })

    points.append({"t": 1.0, "u": 1.0, "v": 0.0})
    points.sort(key=lambda item: item["t"])

    return {
        "trial": trial.get("index"),
        "distance": distance,
        "durationMs": duration_ms,
        "points": points,
    }


def load_user_trace_templates():
    global USER_TRACE_TEMPLATES
    if USER_TRACE_TEMPLATES is not None:
        return USER_TRACE_TEMPLATES

    path = latest_checkbox_trace_file()
    if not path:
        USER_TRACE_TEMPLATES = []
        return USER_TRACE_TEMPLATES

    try:
        with open(path, "r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception:
        USER_TRACE_TEMPLATES = []
        return USER_TRACE_TEMPLATES

    templates = []
    for trial in data.get("trials", []):
        template = normalize_trial_trace(trial)
        if template:
            templates.append(template)

    USER_TRACE_TEMPLATES = templates
    return USER_TRACE_TEMPLATES


def replay_user_trace_template(target_x, target_y, duration=1.0):
    templates = load_user_trace_templates()
    if not templates:
        return None

    start_x, start_y = get_mouse_position()
    dx = target_x - start_x
    dy = target_y - start_y
    distance = max(1, math.hypot(dx, dy))
    dir_x = dx / distance
    dir_y = dy / distance
    normal_x = -dir_y
    normal_y = dir_x

    template = random.choice(templates)
    speed_ratio = clamp(duration / 1.0, 0.30, 1.60)
    distance_ratio = clamp(distance / max(1, template["distance"]), 0.60, 1.45)
    total_duration = (template["durationMs"] / 1000) * speed_ratio * distance_ratio * random.uniform(0.92, 1.10)
    total_duration = clamp(total_duration, 0.28, 2.20)

    previous_t = 0.0
    previous_x = start_x
    previous_y = start_y

    for index, point in enumerate(template["points"]):
        if index == 0:
            continue

        t = clamp(point["t"], previous_t, 1.0)
        x = start_x + dir_x * distance * point["u"] + normal_x * distance * point["v"]
        y = start_y + dir_y * distance * point["u"] + normal_y * distance * point["v"]

        if index >= len(template["points"]) - 2:
            settle = (index - (len(template["points"]) - 2)) / 2
            x = x * (1 - settle) + target_x * settle
            y = y * (1 - settle) + target_y * settle

        move_mouse_to(x, y)
        sleep_for = max(0.001, (t - previous_t) * total_duration)
        time.sleep(sleep_for)
        previous_t = t
        previous_x = x
        previous_y = y

    if math.hypot(previous_x - target_x, previous_y - target_y) > 1.5:
        move_mouse_to(target_x, target_y)
        time.sleep(random.uniform(0.025, 0.075))

    return f"learned_user_trace_{template['trial']}"


def smooth_move_mouse_to(target_x, target_y, duration=1.7, steps=64):
    learned_pattern = replay_user_trace_template(target_x, target_y, duration=duration)
    if learned_pattern:
        return learned_pattern

    start_x, start_y = get_mouse_position()
    pattern = random.choice(MOVE_PATTERNS)
    distance = max(1, math.hypot(target_x - start_x, target_y - start_y))
    distance_factor = clamp(distance / 620, 0.70, 1.12)
    duration = duration * pattern.get("speed", 1.0) * distance_factor * random.uniform(0.88, 1.08)
    steps = int(clamp(steps * pattern.get("step_scale", 1.0) * clamp(distance / 620, 0.76, 1.12), 12, 150))
    p0, p1, p2, p3 = make_control_points(start_x, start_y, target_x, target_y, pattern)
    weights = []
    total_weight = 0

    for step in range(steps):
        progress = step / max(1, steps - 1)
        middle_boost = 1 + 0.95 * math.sin(progress * math.pi)
        hand_variation = random.uniform(0.68, 1.42)
        micro_pause = 1.9 if random.random() < pattern.get("pause", 0.04) else 1
        weight = middle_boost * hand_variation * micro_pause
        weights.append(weight)
        total_weight += weight

    for step in range(1, steps + 1):
        progress = step / steps
        eased = ease_in_out(progress)
        x, y = bezier_point(p0, p1, p2, p3, eased)

        if pattern.get("overshoot") and progress > 0.82:
            pullback = math.sin((progress - 0.82) / 0.18 * math.pi)
            x += (target_x - start_x) * pattern["overshoot"] * pullback
            y += (target_y - start_y) * pattern["overshoot"] * pullback

        if step < steps:
            drift = 2.0 * math.sin(progress * math.pi)
            if pattern.get("finish_wander") and progress > 0.72:
                drift += 2.4 * (progress - 0.72)
            x += random.uniform(-drift, drift)
            y += random.uniform(-drift, drift)

        move_mouse_to(x, y)
        time.sleep(duration * weights[step - 1] / total_weight)

    return pattern["name"]


# ============================================================
# 區塊 2／4：Native Messaging stdio 通訊協定
# 跟移動/畫提醒標記的實際動作完全無關，純粹是跟 Chrome 收發訊息的
# 格式規則：4 bytes little-endian 長度前綴 + UTF-8 JSON。
# ============================================================


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ============================================================
# ============================================================
# ██  區塊 3／4：畫提醒標記（這支腳本真正的目的）  ██
# ============================================================
# ============================================================
# 用一個蓋住整個虛擬桌面、背景透明的 tkinter 視窗，直接疊加在真實畫面上比對，
# 不是另開一個獨立小視窗（獨立視窗要自己在心裡換算對應到螢幕哪裡，很難判斷
# 到底有沒有對齊）：
#   - 藍色半透明填色：background.js 用 DOM 量到的驗證元件／iframe 外框，
#     證明「這一塊我們真的認得是驗證元件」。
#   - 紅色半透明填色：我們自己比對出來的 checkbox 精確範圍，直接疊在畫面上
#     真正的 checkbox 上面比對，一眼就看得出框對了沒有。
#   - 黃色小圓點：滑鼠實際移動去的目標點（因為 jitter 偏移不一定在紅框正中央）。
#   - 文字標籤：這個候選是哪個 DOM 選擇器抓到的（region_label）、比對是靠
#     哪一層成功的（source_label，例如 dom_region/cloudflare/recaptcha/
#     hcaptcha/common_fallback）。
# 這裡故意不用「蓋住整個螢幕、背景透明」的疊加視窗（-transparentcolor +
# overrideredirect）——那個組合在 Chrome 用 Native Messaging 啟動這支腳本的
# 真實環境裡，疊圖始終沒有顯示出來（debug 截圖驗證過很多次，但同樣的程式碼
# 手動測試、模擬各種啟動方式都正常顯示，這個真實環境的落差一直重現不出來），
# 換成一個普通的、有邊框標題列的小視窗（不透明、不用 overrideredirect），只
# 蓋住候選元件範圍附近，犧牲「疊在真實畫面上直接比對」的方便性，換取先把
# 「畫得出來」這件事救回來——這是先前驗證過會正常顯示的做法。
MARKER_DISPLAY_MS = 3000
MARKER_PADDING = 60
MARKER_MIN_SIZE = 160
MARKER_MAX_SIZE = 900


def draw_target_marker(x=None, y=None, box=None, region=None, region_label=None, source_label=None):
    """對外的入口：實際畫圖包在 _draw_target_marker_impl 裡，這裡只負責接住任何
    例外並寫進除錯資料夾的 log 檔——Chrome 啟動 native host 時不會保留一個看得到
    的主控台，stderr 多半直接被丟掉，如果畫圖那段在真實環境裡默默丟例外（跟
    手動測試的環境不一樣、重現不出來的那種狀況），至少還有這個檔案可以回頭查。"""
    try:
        _draw_target_marker_impl(x, y, box, region, region_label, source_label)
    except Exception:
        import traceback
        try:
            DEBUG_DIR.mkdir(exist_ok=True)
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            (DEBUG_DIR / f"ERROR_{timestamp}.txt").write_text(traceback.format_exc(), encoding="utf-8")
        except Exception:
            pass


def _draw_target_marker_impl(x, y, box, region, region_label, source_label):
    debug_label = region_label or source_label or "unknown"
    save_debug_screenshot(capture_virtual_desktop()[0], debug_label, "before")

    if sys.platform != "win32":
        return

    import tkinter as tk

    if region is not None:
        width = int(clamp(region["width"] + MARKER_PADDING, MARKER_MIN_SIZE, MARKER_MAX_SIZE))
        height = int(clamp(region["height"] + MARKER_PADDING, MARKER_MIN_SIZE, MARKER_MAX_SIZE))
        window_left = region["left"] + region["width"] / 2 - width / 2
        window_top = region["top"] + region["height"] / 2 - height / 2
    elif box is not None:
        width = int(clamp(box["width"] + MARKER_PADDING, MARKER_MIN_SIZE, MARKER_MAX_SIZE))
        height = int(clamp(box["height"] + MARKER_PADDING, MARKER_MIN_SIZE, MARKER_MAX_SIZE))
        window_left = box["left"] + box["width"] / 2 - width / 2
        window_top = box["top"] + box["height"] / 2 - height / 2
    else:
        width = height = 240
        window_left = window_top = None

    root = tk.Tk()
    root.title("PubMed 下載器：偵測到人機驗證")
    root.attributes("-topmost", True)
    root.configure(bg="white")

    if window_left is not None:
        screen_width = USER32.GetSystemMetrics(0)
        screen_height = USER32.GetSystemMetrics(1)
        # 下限夾在 0，避免視窗貼近螢幕左/上邊時，geometry 字串的負數座標被
        # Tk 誤解成「從螢幕右/下邊算起」。
        start_x = int(max(0, min(window_left, screen_width - width)))
        start_y = int(max(0, min(window_top, screen_height - height)))
        root.geometry(f"{width}x{height}+{start_x}+{start_y}")
    else:
        root.geometry(f"{width}x{height}")

    # Chrome 用 Native Messaging 啟動這支腳本時，父行程的 STARTUPINFO 可能帶著
    # 「隱藏視窗」的提示；Tk 在 Windows 上顯示視窗有時會沿用這個繼承來的提示，
    # 導致視窗其實建立成功、畫面也畫了，但整個不可見。直接呼叫 Win32
    # ShowWindow／SetWindowPos 蓋過 Tk 自己的判斷，強制顯示＋置頂，多一層保險。
    root.update_idletasks()
    SW_SHOW = 5
    HWND_TOPMOST = -1
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW = 0x0002, 0x0001, 0x0040
    hwnd = root.winfo_id()
    USER32.ShowWindow(hwnd, SW_SHOW)
    USER32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)

    canvas = tk.Canvas(root, width=width, height=height, bg="white", highlightthickness=0)
    canvas.pack()

    # root.geometry() 設定的是「視窗外框」的位置，不是畫布內容真正開始的地方
    # ——外框跟標題列/邊框加起來才是整個視窗，畫布內容是被標題列往下推的。實測
    # 過：直接拿 start_x/start_y 當畫布原點下去換算，垂直方向會差了一個標題列
    # 高度（差不多 37px）、水平方向也會差邊框幾個像素。這裡改成跑完
    # update_idletasks() 之後，直接問 Tk「畫布實際的螢幕座標」在哪
    # （winfo_rootx/rooty），不管標題列多高、邊框多寬，都自動對齊。
    root.update_idletasks()
    canvas_screen_x = canvas.winfo_rootx()
    canvas_screen_y = canvas.winfo_rooty()

    def to_local(screen_x, screen_y):
        return screen_x - canvas_screen_x, screen_y - canvas_screen_y

    if region is not None:
        left, top = to_local(region["left"], region["top"])
        right, bottom = to_local(region["left"] + region["width"], region["top"] + region["height"])
        canvas.create_rectangle(left, top, right, bottom, fill="blue", outline="blue", width=2)
        if region_label:
            canvas.create_text(
                max(2, left), max(0, top - 8), anchor="sw",
                text="驗證元件：" + region_label,
                fill="blue", font=("Microsoft JhengHei", 10, "bold"),
            )

    if box is not None:
        left, top = to_local(box["left"], box["top"])
        right, bottom = to_local(box["left"] + box["width"], box["top"] + box["height"])
        canvas.create_rectangle(left, top, right, bottom, fill="red", outline="red", width=2)
        if source_label:
            canvas.create_text(
                max(2, left), bottom + 8, anchor="nw",
                text="比對來源：" + source_label,
                fill="red", font=("Microsoft JhengHei", 10, "bold"),
            )

    if x is not None and y is not None:
        cx, cy = to_local(x, y)
        r = 5
        canvas.create_oval(cx - r, cy - r, cx + r, cy + r, fill="yellow", outline="black", width=1)

    # 強制跑完一輪完整事件迴圈（不只是 idle tasks），確保方框/文字/準心這些
    # canvas 內容真的送去畫面合成，不是還排在佇列裡；update_idletasks() 只處理
    # 幾何/佈局，不保證真的畫出來。
    root.update()

    def capture_after():
        # 排在 root.destroy 前面的 after callback，趁視窗還顯示著的時候拍一張。
        # 延遲故意比 300ms 寬一點，留一點餘裕給比較慢的環境把視窗真的合成上畫面。
        save_debug_screenshot(capture_virtual_desktop()[0], debug_label, "after")

    root.after(700, capture_after)
    root.after(MARKER_DISPLAY_MS, root.destroy)
    root.mainloop()
# ============================================================
# 畫提醒標記區塊到此結束
# ============================================================


# ============================================================
# 主流程：讀訊息 →（區塊 0）掃描螢幕自己找座標 →
# （區塊 1）移動滑鼠 →（區塊 3）畫提醒標記、等視窗關閉 → 回 ack
# ============================================================
def main():
    enable_windows_dpi_awareness()
    payload = read_message() or {}

    # background.js 只在每次驗證流程「第一次嘗試的第一個候選」才會帶這個旗標，
    # 確保 checkbox 定位除錯資料夾裡的圖片都是這次驗證流程留下的，不會混到
    # 上一次的殘留檔案。
    if payload.get("clearDebugFolder"):
        clear_debug_dir()

    # background.js 如果有辦法用 DOM 量到驗證元件的外框，會帶 left/top/width/
    # height 進來（螢幕絕對座標）；這裡只當作「去哪裡找 checkbox」的範圍提示，
    # 不是直接採信——locate_target() 還是要在這個框裡自己比對樣板才算數。
    dom_region = None
    if all(key in payload for key in ("left", "top", "width", "height")):
        dom_region = {
            "left": payload["left"],
            "top": payload["top"],
            "width": payload["width"],
            "height": payload["height"],
        }

    # 同一頁重試多次仍找不到 checkbox 時，background.js 的三次嘗試協定會逐次
    # 調低這兩個門檻再傳進來；沒帶就用模組預設值。
    dom_region_min_score = payload.get("domRegionMinScore", DOM_REGION_MIN_SCORE)
    logo_min_score = payload.get("logoMinScore", LOGO_MIN_SCORE)

    x = y = None
    match_score = None
    match_source = None
    match_box = None
    match_region = None
    moved = False
    pattern_name = None

    try:
        match = locate_target_with_retry(
            dom_region,
            dom_region_min_score=dom_region_min_score,
            logo_min_score=logo_min_score,
        )
    except Exception:
        match = None

    checkbox_found = False
    if match is not None:
        # match_region 不管 checkbox 有沒有找到都先取出來——沒找到 checkbox
        # 時，畫面上至少還能標出藍色的 iframe 範圍，不是整個提醒視窗空白。
        match_region = match["region"]
        match_source = match["source"]
        checkbox_found = match.get("x") is not None

        if checkbox_found:
            x, y = match["x"], match["y"]
            match_score = match["score"]
            match_box = {
                "left": match["box_left"],
                "top": match["box_top"],
                "width": match["box_width"],
                "height": match["box_height"],
            }
            if sys.platform == "win32":
                screen_width = USER32.GetSystemMetrics(0)
                screen_height = USER32.GetSystemMetrics(1)
                x = clamp(x, 0, screen_width - 1)
                y = clamp(y, 0, screen_height - 1)
            try:
                # 只移動滑鼠、不點擊：這是提醒真人來手動處理驗證的視覺提示，
                # 不是自動幫真人點掉驗證元件。
                pattern_name = smooth_move_mouse_to(x, y)
                moved = True
                LEFT_DOWN = 0x0002
                LEFT_UP = 0x0004
                USER32.mouse_event(LEFT_DOWN, 0, 0, 0, 0)
                time.sleep(0.1)
                USER32.mouse_event(LEFT_UP, 0, 0, 0, 0)
            except Exception:
                moved = False

    # 先畫提醒標記、等視窗真的關閉，才回 ack：background.js 的候選輪流迴圈是
    # await 這個 ack 才換下一個候選，如果 ack 提早送出（提醒視窗還開著），
    # 下一個候選的螢幕掃描很可能會撞上這個還沒關掉的視窗，把比對結果帶偏。
    # matchedSelector 是 background.js 用 locateAllTargetElements 抓到這個候選
    # 時記錄的 DOM 選擇器（例如 ".g-recaptcha"、"#px-captcha"），拿來當方框
    # 旁邊的文字標籤，讓人一眼看出這次認得的是哪個驗證元件。
    draw_target_marker(
        x, y, box=match_box, region=match_region,
        region_label=payload.get("matchedSelector"),
        source_label=match_source,
    )

    send_message({
        "ok": True,
        "x": x,
        "y": y,
        "score": match_score,
        "source": match_source,
        "moved": moved,
        "pattern": pattern_name,
        # 清楚分開回報「iframe 範圍有沒有拿到」（dom_region 一開始就是
        # background.js 傳進來的，這裡一定是 iframe 已知）跟「checkbox 有沒有
        # 比對到」，方便直接從 log 判斷是哪一段出問題。
        "iframeFound": dom_region is not None,
        "checkboxFound": checkbox_found,
    })


if __name__ == "__main__":
    main()
