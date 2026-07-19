"""
「本地資料夾模式」用的 Native Messaging host，由 background.js 透過
chrome.runtime.connectNative()（經 python_file_manager.bat 轉呼叫）開一條長駐
Port 溝通——跟 python_write_love.py 那種「一次性 spawn、收一則、回一則、結束」
不一樣，這支腳本會在一次批次下載期間被連續呼叫很多次（每篇一次、每次進度更新
一次、核對一次），所以主流程是 while-loop，直到 Chrome 關掉這條 Port（stdin 收到
EOF）才結束。

負責的事情只有「檔案落地」與「Excel 讀寫」，完全不碰「怎麼抓到 PDF」那些邏輯
（那些留在 background.js，本來就已經處理過各種出版社的特殊情況）：這支腳本收到
的都是已經確定要保存的 bytes，或是已經在磁碟上、只是要搬去正確位置的檔案。

Native Messaging 的 stdio 協定跟 python_write_love.py 完全一樣：4 bytes
little-endian 長度前綴 + UTF-8 JSON。read_message()/send_message() 直接照抄。

Chrome 對「host 傳回 extension」單則訊息大小有 ~1MB 上限（extension 傳給 host
的方向上限高很多，不用分片）。目前只有 find_progress_excel 讀到既有進度檔時可能
超標，用 send_bytes_chunked() 切成多則訊息送，JS 端依 id 累加、收到 done:true
才算完整。
"""

import base64
import json
import shutil
import struct
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEBUG_DIR = BASE_DIR / "file_manager_debug"

SUBFOLDERS = ["下載成功", "下載失敗", "下次重試", "進度管理"]
STATUS_FOLDERS = ["下載成功", "下載失敗", "下次重試"]
PROGRESS_SUFFIX = "_進度管理.xlsx"
ORIGINAL_SUFFIX = "_原檔.xlsx"
CHUNK_SIZE = 700_000  # base64 字元數／片，留餘裕不逼近 1MB 上限


# ============================================================
# Native Messaging stdio framing（照抄 python_write_love.py）
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


def send_bytes_chunked(req_id, data_b64, extra=None):
    extra = extra or {}
    total = len(data_b64)
    if total == 0:
        send_message({"id": req_id, "ok": True, "chunk": "", "done": True, **extra})
        return
    pos = 0
    while pos < total:
        piece = data_b64[pos:pos + CHUNK_SIZE]
        pos += CHUNK_SIZE
        done = pos >= total
        send_message({"id": req_id, "ok": True, "chunk": piece, "done": done, **extra})


# Chrome 啟動 native host 時沒有可見的 console，stderr 基本上看不到；例外改寫
# 進除錯資料夾的 log 檔，比照 python_write_love.py draw_target_marker() 的作法。
def log_error(exc):
    try:
        import traceback
        DEBUG_DIR.mkdir(exist_ok=True)
        timestamp = time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1000) % 1000:03d}"
        (DEBUG_DIR / f"ERROR_{timestamp}.txt").write_text(traceback.format_exc(), encoding="utf-8")
    except Exception:
        pass


# ============================================================
# 路徑安全檢查：所有相對路徑一律要落在 root 底下，避免 relPath 帶
# "../../" 之類的值意外寫到 root 以外的地方。
# ============================================================

def safe_join(root: Path, rel_path: str) -> Path:
    root = root.resolve()
    target = (root / rel_path).resolve()
    target.relative_to(root)  # 不在 root 底下會丟 ValueError
    return target


# ============================================================
# Command 實作
# ============================================================

def cmd_pick_folder(msg):
    import tkinter as tk
    from tkinter import filedialog

    root_win = tk.Tk()
    root_win.withdraw()
    root_win.attributes("-topmost", True)
    try:
        path = filedialog.askdirectory(title="選擇 PubMed PDF 批次下載 專案資料夾")
    finally:
        root_win.destroy()
    if not path:
        return {"ok": False, "cancelled": True}
    return {"ok": True, "path": path}


def cmd_init_root(msg):
    root = Path(msg["root"])
    root.mkdir(parents=True, exist_ok=True)
    for name in SUBFOLDERS:
        (root / name).mkdir(exist_ok=True)
    return {"ok": True}


def cmd_find_progress_excel(msg, req_id):
    root = Path(msg["root"])
    folder = root / "進度管理"
    progress_file = None
    original_file = None
    if folder.exists():
        for p in folder.iterdir():
            if not p.is_file():
                continue
            if p.name.endswith(PROGRESS_SUFFIX):
                progress_file = p
            elif p.name.endswith(ORIGINAL_SUFFIX):
                original_file = p

    if progress_file is not None:
        base = progress_file.name[: -len(PROGRESS_SUFFIX)]
        data_b64 = base64.b64encode(progress_file.read_bytes()).decode("ascii")
        send_bytes_chunked(req_id, data_b64, extra={
            "found": True, "base": base, "hasOriginal": original_file is not None,
        })
        return

    if original_file is not None:
        base = original_file.name[: -len(ORIGINAL_SUFFIX)]
        send_message({"id": req_id, "ok": True, "found": False, "hasOriginal": True, "base": base})
        return

    send_message({"id": req_id, "ok": True, "found": False, "hasOriginal": False})


def cmd_write_bytes(msg):
    root = Path(msg["root"])
    data = base64.b64decode(msg["dataB64"])
    target = safe_join(root, msg["relPath"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {"ok": True}


def cmd_delete_paths(msg):
    root = Path(msg["root"])
    for rel in msg.get("relPaths", []):
        try:
            p = safe_join(root, rel)
            if p.is_file():
                p.unlink()
        except Exception:
            pass  # 找不到/已經刪過都不算錯誤，核對流程本來就會重複清同一批殘留
    return {"ok": True}


def cmd_move_file(msg):
    root = Path(msg["root"])
    source = Path(msg["sourceAbsPath"])
    dest = safe_join(root, msg["destRelPath"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(dest))
    return {"ok": True}


def cmd_list_status_folders(msg):
    root = Path(msg["root"])
    result = {}
    for name in STATUS_FOLDERS:
        folder = root / name
        items = []
        if folder.exists():
            for p in folder.iterdir():
                if p.is_file():
                    items.append({"title": p.stem, "mtime": p.stat().st_mtime})
        result[name] = items
    return {"ok": True, "folders": result}


# find_progress_excel 自己控制回覆（可能要分片送出多則訊息），其餘 command
# 回傳一個小 dict，由主迴圈統一包成 {id, ...} 送出。
COMMANDS = {
    "pick_folder": cmd_pick_folder,
    "init_root": cmd_init_root,
    "find_progress_excel": cmd_find_progress_excel,
    "write_bytes": cmd_write_bytes,
    "delete_paths": cmd_delete_paths,
    "move_file": cmd_move_file,
    "list_status_folders": cmd_list_status_folders,
}
SELF_RESPONDING = {"find_progress_excel"}


def main():
    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if msg is None:
            break  # Chrome 關掉了這條 Port（stdin EOF），照協定直接結束行程

        req_id = msg.get("id")
        cmd = msg.get("cmd")
        handler = COMMANDS.get(cmd)
        try:
            if handler is None:
                send_message({"id": req_id, "ok": False, "error": "未知指令：" + str(cmd)})
                continue
            if cmd in SELF_RESPONDING:
                handler(msg, req_id)
            else:
                result = handler(msg) or {"ok": True}
                send_message({"id": req_id, **result})
        except Exception as e:
            log_error(e)
            try:
                send_message({"id": req_id, "ok": False, "error": str(e)})
            except Exception:
                break


if __name__ == "__main__":
    main()
