"""
CMU EZproxy 登入頁語音驗證碼自動辨識用的 Native Messaging host，由 background.js
的 solveCaptchaAudioViaNativeHost() 呼叫（經 python_captcha_solver.bat 轉呼叫）。

只有「同一次執行、第二次以後需要重新登入 EZproxy」才會用到這支腳本：第一次登入
永遠是使用者自己手動輸入帳號/密碼/驗證碼，成功後帳密只存在 background.js 的
記憶體裡（G.savedEzproxyCreds，絕不寫進 chrome.storage），之後同一個 session
如果又被導回登入頁，才會呼叫這裡自動解語音驗證碼、自動重新登入，省得每次都要
使用者回來手動輸入。

為什麼挑語音、不挑圖片：這個登入頁的圖片驗證碼是花體字、筆畫相連，實測過用
OpenCV 樣板比對（跟 python_write_love.py 找 checkbox 用的技術一樣）切字準確率
只有約 66%（4 碼整組對的機率只剩不到 2 成），不夠可靠拿來自動送出。同一組驗證
碼的語音版（給視障者用、螢幕上有播放按鈕，網址是 /captcha/audio/{hashkey}.wav）
用 OpenAI Whisper 的 tiny 模型實測 15 組樣本，準確率明顯高很多（十幾組裡只有
1 組跟人眼讀圖的結果對不上，而且很可能是人眼讀花體字讀錯，不是語音辨識錯），
所以選語音這條路。

跟 python_write_love.py 一樣是「一次性 spawn、收一則訊息、回一則、結束」的
one-shot host，不是 python_file_manager.py 那種長駐 Port——重登不是熱路徑
（不是每篇論文都要跑一次，只有整批下載期間 session 又失效時才會觸發），每次
重新載入一次 Whisper tiny 模型（讀本機快取，通常一兩秒）換取行程/資源管理
簡單、不用維護長駐狀態，划算。

依賴：openai-whisper 套件（連帶裝 torch），比 python_write_love.py 用的
opencv/mss/pynput 重不少，所以獨立成這一支腳本、獨立的 native host 註冊，
不需要語音自動重登功能的使用者不會被迫裝這些。見 install_captcha_solver.ps1
的安裝說明。

Native Messaging 的 stdio 協定跟 python_write_love.py 完全一樣：4 bytes
little-endian 長度前綴 + UTF-8 JSON。
"""

import base64
import io
import json
import re
import struct
import sys
import wave


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


# 驗證碼語音檔是 8kHz、16-bit、單聲道 PCM WAV；Whisper 內建的 load_audio() 靠
# shell 出去呼叫 ffmpeg 解碼，這裡直接用標準函式庫的 wave 模組手動解碼＋用
# numpy 線性內插重取樣到 Whisper 要求的 16kHz，不需要另外裝/依賴 ffmpeg 執行檔。
def decode_wav_to_float32_16k(wav_bytes):
    import numpy as np

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sampwidth != 2:
        raise ValueError("unsupported wav sample width: " + str(sampwidth))

    data = np.frombuffer(raw, dtype="<i2")
    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)
    audio = data.astype(np.float32) / 32768.0

    if framerate != 16000:
        n_new = int(len(audio) * 16000 / framerate)
        idx = np.arange(n_new) * framerate / 16000
        audio = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    return audio


def solve_audio(audio_b64):
    import whisper

    wav_bytes = base64.b64decode(audio_b64)
    audio = decode_wav_to_float32_16k(wav_bytes)

    model = whisper.load_model("tiny")
    audio = whisper.pad_or_trim(audio)
    mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
    options = whisper.DecodingOptions(language="en", fp16=False)
    result = whisper.decode(model, mel, options)

    digits = "".join(re.findall(r"\d", result.text))
    return digits, result.text


def main():
    msg = read_message() or {}
    audio_b64 = msg.get("audioB64", "")
    if not audio_b64:
        send_message({"ok": False, "error": "缺少 audioB64"})
        return

    try:
        digits, raw_text = solve_audio(audio_b64)
    except Exception as e:
        send_message({"ok": False, "error": str(e)})
        return

    if not digits:
        send_message({"ok": False, "error": "辨識不出任何數字", "raw": raw_text})
        return

    send_message({"ok": True, "digits": digits, "raw": raw_text})


if __name__ == "__main__":
    main()
