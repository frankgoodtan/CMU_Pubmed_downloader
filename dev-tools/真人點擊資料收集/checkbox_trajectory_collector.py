"""
Local 100-checkbox trajectory collector.

Run:
    python checkbox_trajectory_collector.py

It opens a local page with one ordinary checkbox at a time. You click 100
checkboxes manually. The page records mouse movement, click timing, isTrusted,
target position, and browser/screen environment data, then saves a JSON file in
./mouse_recording/.

This is for local UI/event learning only. Do not use it for CAPTCHA,
Turnstile, reCAPTCHA, hCaptcha, login challenges, payments, voting, or other
access-control flows.
"""

import json
import os
import ctypes
import ctypes.wintypes
import random
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = "127.0.0.1"
PORT = 8766
USER32 = ctypes.windll.user32 if sys.platform == "win32" else None


HTML_PAGE = r"""<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>checkbox-100次測試收集</title>
  <style>
    :root {
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1b1f24;
      --muted: #606975;
      --line: #d8dde5;
      --accent: #0f766e;
      --target: #0f766e;
      --code: #f0f3f6;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
    }

    main {
      width: 100vw;
      min-height: 100vh;
      margin: 0;
      padding: 14px;
    }

    h1 { margin: 0 0 8px; font-size: 26px; }
    p { margin: 0 0 12px; color: var(--muted); }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 330px;
      gap: 16px;
      align-items: start;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-width: 0;
    }

    #stage {
      position: relative;
      height: calc(100vh - 118px);
      min-height: 680px;
      border: 1px dashed #94a3b8;
      border-radius: 8px;
      background:
        linear-gradient(#eef2f7 1px, transparent 1px),
        linear-gradient(90deg, #eef2f7 1px, transparent 1px),
        #fbfcfe;
      background-size: 40px 40px;
      overflow: hidden;
      user-select: none;
    }

    .target {
      position: absolute;
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      transform: translate(-50%, -50%);
    }

    .target input {
      width: 24px;
      height: 24px;
      accent-color: var(--target);
      cursor: pointer;
    }

    button {
      appearance: none;
      border: 1px solid #0b5f59;
      border-radius: 6px;
      padding: 10px 14px;
      margin: 0 8px 10px 0;
      background: var(--accent);
      color: white;
      font-weight: 700;
      cursor: pointer;
    }

    button.secondary {
      color: #0f172a;
      background: #eef2f7;
      border-color: #cbd5e1;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      margin-top: 8px;
    }

    th,
    td {
      padding: 8px 6px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      width: 130px;
      color: var(--muted);
      font-weight: 650;
    }

    pre,
    code {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      background: var(--code);
      border-radius: 6px;
    }

    code { padding: 2px 5px; }

    pre {
      min-height: 160px;
      overflow: auto;
      padding: 12px;
      margin: 12px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
    }

    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      #stage { height: 720px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>checkbox-100次測試收集</h1>
    <p>本頁一次顯示一個 checkbox，位置會隨機變化，請依序手動點擊，共 100 次。頁面會記錄你的滑鼠移動軌跡、點擊時間與環境資訊，完成後自動存檔於 mouse_recording 資料夾。</p>

    <section class="layout">
      <article class="panel">
        <div id="stage">
          <div id="target" class="target" hidden>
            <input id="targetCheckbox" type="checkbox" aria-label="target checkbox">
          </div>
        </div>
      </article>

      <aside class="panel">
        <button id="startBtn" type="button">開始收集</button>
        <button id="finishBtn" class="secondary" type="button" disabled>提前結束並存檔</button>
        <table>
          <tbody id="stats"></tbody>
        </table>
        <pre id="log">尚未開始</pre>
      </aside>
    </section>
  </main>

  <script>
    const TOTAL_TARGETS = 100;
    const stage = document.querySelector("#stage");
    const target = document.querySelector("#target");
    const checkbox = document.querySelector("#targetCheckbox");
    const startBtn = document.querySelector("#startBtn");
    const finishBtn = document.querySelector("#finishBtn");
    const logEl = document.querySelector("#log");
    const statsEl = document.querySelector("#stats");

    let running = false;
    let startedAt = 0;
    let currentIndex = 0;
    let currentTarget = null;
    let currentTrace = [];
    let trials = [];
    let sessionId = "";
    let lastMoveAt = 0;
    let lastClickAt = 0;
    let resettingCursor = false;
    let viewportScreenOffset = null;
    let currentStartPoint = null;

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function setRows(rows) {
      statsEl.innerHTML = rows.map(([label, value]) => (
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`
      )).join("");
    }

    function now() {
      return performance.now();
    }

    function collectEnvironment() {
      return {
        userAgent: navigator.userAgent,
        languages: navigator.languages,
        language: navigator.language,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory || null,
        webdriver: navigator.webdriver,
        maxTouchPoints: navigator.maxTouchPoints,
        pluginsLength: navigator.plugins ? navigator.plugins.length : null,
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
          pixelDepth: screen.pixelDepth,
        },
        viewport: {
          innerWidth,
          innerHeight,
          devicePixelRatio,
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        url: location.href,
      };
    }

    function buildSession() {
      return {
        version: 1,
        kind: "local-checkbox-trajectory-collector",
        sessionId,
        createdAt: new Date().toISOString(),
        totalTargets: TOTAL_TARGETS,
        environment: collectEnvironment(),
        summary: buildSummary(),
        trials,
      };
    }

    function average(values) {
      const valid = values.filter(value => Number.isFinite(value));
      return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
    }

    function buildSummary() {
      const analyses = trials.map(trial => trial.analysis).filter(analysis => analysis && analysis.ok);
      return {
        completedTrials: trials.length,
        analyzedTrials: analyses.length,
        averageDurationMs: Math.round(average(analyses.map(analysis => analysis.durationMs)) * 10) / 10,
        averageTotalDistancePx: Math.round(average(analyses.map(analysis => analysis.totalDistancePx)) * 10) / 10,
        averageStraightnessRatio: Math.round(average(analyses.map(analysis => analysis.straightnessRatio)) * 1000) / 1000,
        averageSpeedPxPerMs: Math.round(average(analyses.map(analysis => analysis.averageSpeedPxPerMs)) * 10000) / 10000,
        averageP95SpeedPxPerMs: Math.round(average(analyses.map(analysis => analysis.p95SpeedPxPerMs)) * 10000) / 10000,
        averagePauseRatio: Math.round(average(analyses.map(analysis => analysis.pauseRatio)) * 1000) / 1000,
        averageAngleChangeDeg: Math.round(average(analyses.map(analysis => analysis.averageAngleChangeDeg)) * 100) / 100,
        averageP95AngleChangeDeg: Math.round(average(analyses.map(analysis => analysis.p95AngleChangeDeg)) * 100) / 100,
        averageClickOffsetFromTargetCenterPx: Math.round(average(analyses.map(analysis => analysis.clickOffsetFromTargetCenterPx)) * 10) / 10,
      };
    }

    function updateStats() {
      const elapsed = running ? Math.round(now() - startedAt) : 0;
      const last = trials.at(-1);
      setRows([
        ["完成次數", `${trials.length} / ${TOTAL_TARGETS}`],
        ["目前第幾個", running ? currentIndex + 1 : "-"],
        ["已記錄軌跡點", currentTrace.length],
        ["經過時間", running ? `${elapsed} ms` : "-"],
        ["最後 isTrusted", last ? last.click.isTrusted : "-"],
        ["最後反應時間", last ? `${Math.round(last.timing.reactionMs)} ms` : "-"],
        ["最後軌跡點數", last ? last.trace.length : "-"],
      ]);
    }

    function log(lines) {
      logEl.textContent = Array.isArray(lines) ? lines.join("\n") : lines;
    }

    function percentile(values, pct) {
      if (!values.length) return 0;
      const ordered = [...values].sort((a, b) => a - b);
      const index = (ordered.length - 1) * pct;
      const low = Math.floor(index);
      const high = Math.ceil(index);
      if (low === high) return ordered[index];
      return ordered[low] * (high - index) + ordered[high] * (index - low);
    }

    function angleDelta(a, b) {
      let diff = Math.abs(a - b);
      while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
      return diff;
    }

    function analyzeTrace(trace, targetData, clickData) {
      const moves = trace.filter(point => point.type === "mousemove");
      if (moves.length < 2) {
        return {
          ok: false,
          reason: "not enough movement samples"
        };
      }

      const intervals = [];
      const distances = [];
      const speeds = [];
      const headings = [];
      const angleChanges = [];
      let pauses = 0;

      for (let index = 1; index < moves.length; index += 1) {
        const previous = moves[index - 1];
        const current = moves[index];
        const dt = Math.max(0.001, current.t - previous.t);
        const dx = current.stageX - previous.stageX;
        const dy = current.stageY - previous.stageY;
        const distance = Math.hypot(dx, dy);
        const speed = distance / dt;

        intervals.push(dt);
        distances.push(distance);
        speeds.push(speed);

        if (distance < 0.35) {
          pauses += 1;
        } else {
          headings.push(Math.atan2(dy, dx));
        }
      }

      for (let index = 1; index < headings.length; index += 1) {
        angleChanges.push(angleDelta(headings[index - 1], headings[index]));
      }

      const first = moves[0];
      const last = moves[moves.length - 1];
      const duration = Math.max(0.001, last.t - first.t);
      const totalDistance = distances.reduce((sum, value) => sum + value, 0);
      const displacement = Math.hypot(last.stageX - first.stageX, last.stageY - first.stageY);
      const clickOffset = Math.hypot(clickData.stageX - targetData.x, clickData.stageY - targetData.y);

      return {
        ok: true,
        samples: moves.length,
        durationMs: Math.round(duration * 10) / 10,
        totalDistancePx: Math.round(totalDistance * 10) / 10,
        displacementPx: Math.round(displacement * 10) / 10,
        straightnessRatio: totalDistance ? Math.round((displacement / totalDistance) * 1000) / 1000 : 0,
        averageIntervalMs: Math.round((intervals.reduce((sum, value) => sum + value, 0) / intervals.length) * 100) / 100,
        p95IntervalMs: Math.round(percentile(intervals, 0.95) * 100) / 100,
        averageSpeedPxPerMs: Math.round((speeds.reduce((sum, value) => sum + value, 0) / speeds.length) * 10000) / 10000,
        peakSpeedPxPerMs: Math.round(Math.max(...speeds) * 10000) / 10000,
        p95SpeedPxPerMs: Math.round(percentile(speeds, 0.95) * 10000) / 10000,
        pauseRatio: Math.round((pauses / Math.max(1, distances.length)) * 1000) / 1000,
        averageAngleChangeDeg: angleChanges.length
          ? Math.round((angleChanges.reduce((sum, value) => sum + value, 0) / angleChanges.length) * 180 / Math.PI * 100) / 100
          : 0,
        p95AngleChangeDeg: Math.round(percentile(angleChanges, 0.95) * 180 / Math.PI * 100) / 100,
        clickOffsetFromTargetCenterPx: Math.round(clickOffset * 10) / 10,
      };
    }

    function getFixedCheckboxPosition() {
      const rect = stage.getBoundingClientRect();
      const x = rect.width * 0.25;
      const y = rect.height * 0.25;
      return { x, y, stageWidth: rect.width, stageHeight: rect.height };
    }

    function chooseRandomStartPosition() {
      const rect = stage.getBoundingClientRect();
      const margin = 56;
      const targetData = currentTarget || getFixedCheckboxPosition();
      let candidate = null;

      for (let attempt = 0; attempt < 80; attempt += 1) {
        const x = margin + Math.random() * Math.max(1, rect.width - margin * 2);
        const y = margin + Math.random() * Math.max(1, rect.height - margin * 2);
        const distance = Math.hypot(x - targetData.x, y - targetData.y);
        if (distance > Math.min(rect.width, rect.height) * 0.28) {
          candidate = { x, y };
          break;
        }
      }

      return candidate || { x: rect.width * 0.72, y: rect.height * 0.68 };
    }

    function stagePointToScreen(point) {
      const rect = stage.getBoundingClientRect();
      const viewportScreenX = viewportScreenOffset?.x ?? (window.screenX + (outerWidth - innerWidth));
      const viewportScreenY = viewportScreenOffset?.y ?? (window.screenY + (outerHeight - innerHeight));
      return {
        x: viewportScreenX + rect.left + point.x,
        y: viewportScreenY + rect.top + point.y,
        stageX: point.x,
        stageY: point.y
      };
    }

    function placeTarget() {
      currentTarget = getFixedCheckboxPosition();
      target.style.left = `${currentTarget.x}px`;
      target.style.top = `${currentTarget.y}px`;
      checkbox.checked = false;
      target.hidden = false;
      currentTrace = [];
      lastMoveAt = 0;
      lastClickAt = 0;
      updateStats();
      log(`第 ${currentIndex + 1} / ${TOTAL_TARGETS} 個，請點擊畫面上正在顯示的 checkbox`);
    }

    async function moveCursorToRandomStart() {
      resettingCursor = true;
      const start = chooseRandomStartPosition();
      const screenPoint = stagePointToScreen(start);
      currentStartPoint = {
        stageX: Math.round(start.x * 1000) / 1000,
        stageY: Math.round(start.y * 1000) / 1000,
        screenX: Math.round(screenPoint.x * 1000) / 1000,
        screenY: Math.round(screenPoint.y * 1000) / 1000
      };
      log([
        `第 ${currentIndex + 1} / ${TOTAL_TARGETS} 個，準備隨機起始點`,
        `正在將游標移動到 stage ${Math.round(start.x)}, ${Math.round(start.y)}`
      ]);

      try {
        await fetch("/move-cursor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x: screenPoint.x,
            y: screenPoint.y,
            stageX: screenPoint.stageX,
            stageY: screenPoint.stageY
          })
        });
      } catch (error) {
        log([
          "移動游標失敗，請手動將滑鼠移到起始位置後再點擊 checkbox",
          `${error.name}: ${error.message}`
        ]);
      }

      await new Promise(resolve => setTimeout(resolve, 220));
      resettingCursor = false;
      placeTarget();
    }

    function recordPointer(event, eventType) {
      if (!running || !currentTarget || resettingCursor) return;

      const t = now() - startedAt;
      const stageRect = stage.getBoundingClientRect();
      currentTrace.push({
        t: Math.round(t * 1000) / 1000,
        type: eventType,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        stageX: Math.round((event.clientX - stageRect.left) * 1000) / 1000,
        stageY: Math.round((event.clientY - stageRect.top) * 1000) / 1000,
        buttons: event.buttons,
        isTrusted: event.isTrusted,
      });
    }

    function handleMove(event) {
      if (!running || resettingCursor) return;
      const t = now();
      if (t - lastMoveAt < 8) return;
      lastMoveAt = t;
      recordPointer(event, "mousemove");
      updateStats();
    }

    async function completeTrial(event) {
      if (!running || !currentTarget) return;

      const t = now() - startedAt;
      const clickGap = lastClickAt ? t - lastClickAt : null;
      lastClickAt = t;
      viewportScreenOffset = {
        x: event.screenX - event.clientX,
        y: event.screenY - event.clientY
      };

      const stageRect = stage.getBoundingClientRect();
      const click = {
        t: Math.round(t * 1000) / 1000,
        isTrusted: event.isTrusted,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        stageX: Math.round((event.clientX - stageRect.left) * 1000) / 1000,
        stageY: Math.round((event.clientY - stageRect.top) * 1000) / 1000,
      };

      const firstTraceTime = currentTrace.length ? currentTrace[0].t : t;
      const trial = {
        index: currentIndex,
        startPoint: currentStartPoint,
        target: currentTarget,
        click,
        timing: {
          reactionMs: click.t - firstTraceTime,
          sinceSessionStartMs: click.t,
          sincePreviousClickMs: clickGap,
        },
        trace: currentTrace,
      };
      trial.analysis = analyzeTrace(trial.trace, trial.target, trial.click);

      trials.push(trial);
      currentIndex += 1;

      if (currentIndex >= TOTAL_TARGETS) {
        finishAndSave();
        return;
      }

      await autosaveDraft();
      currentTrace = [];
      await moveCursorToRandomStart();
    }

    async function finishAndSave() {
      running = false;
      target.hidden = true;
      startBtn.disabled = false;
      finishBtn.disabled = true;
      updateStats();

      const payload = buildSession();
      log("Saving final JSON and SVG...");

      try {
        const response = await fetch("/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        log([
          data.ok ? "Final save completed." : "Final save failed.",
          JSON.stringify(data, null, 2),
        ]);
      } catch (error) {
        log([
          "Final save failed.",
          `${error.name}: ${error.message}`,
        ]);
      }
    }

    async function autosaveDraft() {
      const payload = buildSession();
      payload.autosave = true;

      try {
        const response = await fetch("/autosave", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (data.ok) {
          log([
            `Draft saved after trial ${trials.length}.`,
            `draft: ${data.file}`,
          ]);
        }
      } catch (error) {
        log([
          "Draft save failed. Keep this browser page open if you need to retry.",
          `${error.name}: ${error.message}`,
        ]);
      }
    }

    function startCollection() {
      running = true;
      startedAt = now();
      currentIndex = 0;
      currentTarget = null;
      currentTrace = [];
      trials = [];
      sessionId = `checkbox_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      startBtn.disabled = true;
      finishBtn.disabled = false;
      placeTarget();
      moveCursorToRandomStart();
    }

    stage.addEventListener("mousemove", handleMove);
    stage.addEventListener("mousedown", event => recordPointer(event, "mousedown"));
    stage.addEventListener("mouseup", event => recordPointer(event, "mouseup"));
    checkbox.addEventListener("click", completeTrial);
    startBtn.addEventListener("click", startCollection);
    finishBtn.addEventListener("click", finishAndSave);

    updateStats();
    fetch("/health")
      .then(response => response.json())
      .then(data => log(["本機伺服器已連線", JSON.stringify(data, null, 2)]))
      .catch(error => log(["本機伺服器尚未連線", error.message]));
  </script>
</body>
</html>
"""


def svg_escape(value):
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def get_stage_size(payload):
    for trial in payload.get("trials", []):
        target = trial.get("target", {})
        width = target.get("stageWidth")
        height = target.get("stageHeight")
        if width and height:
            return float(width), float(height)
    return 1000.0, 700.0


def make_polyline_points(trace):
    points = []
    for point in trace:
        if point.get("type") != "mousemove":
            continue
        if "stageX" not in point or "stageY" not in point:
            continue
        points.append(f"{float(point['stageX']):.1f},{float(point['stageY']):.1f}")
    return " ".join(points)


def build_trajectory_svg(payload):
    stage_width, stage_height = get_stage_size(payload)
    margin = 80
    width = stage_width + margin * 2
    height = stage_height + margin * 2 + 92
    trials = payload.get("trials", [])
    summary = payload.get("summary", {})

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}">',
        "<style>",
        "  .bg { fill: #f8fafc; }",
        "  .stage { fill: #ffffff; stroke: #94a3b8; stroke-dasharray: 8 8; }",
        "  .grid { stroke: #e5e7eb; stroke-width: 1; }",
        "  .path { fill: none; stroke: #0f766e; stroke-width: 1.35; stroke-opacity: 0.18; stroke-linecap: round; stroke-linejoin: round; }",
        "  .path:nth-of-type(4n) { stroke: #2563eb; }",
        "  .path:nth-of-type(5n) { stroke: #b45309; }",
        "  .target { fill: none; stroke: #dc2626; stroke-width: 1.2; stroke-opacity: 0.55; }",
        "  .click { fill: #dc2626; fill-opacity: 0.55; }",
        "  .start { fill: #16a34a; fill-opacity: 0.42; }",
        "  .text { font-family: Segoe UI, Arial, sans-serif; fill: #1f2937; font-size: 14px; }",
        "  .muted { fill: #64748b; font-size: 12px; }",
        "</style>",
        '<rect class="bg" x="0" y="0" width="100%" height="100%"/>',
        f'<text class="text" x="{margin}" y="30">100 Checkbox 點擊軌跡視覺化</text>',
        f'<text class="muted" x="{margin}" y="52">session: {svg_escape(payload.get("sessionId", ""))}</text>',
        f'<text class="muted" x="{margin}" y="70">completed: {len(trials)} / {payload.get("totalTargets", "")}, avg straightness: {summary.get("averageStraightnessRatio", "-")}, avg speed px/ms: {summary.get("averageSpeedPxPerMs", "-")}</text>',
        f'<g transform="translate({margin},{margin + 32})">',
        f'<rect class="stage" x="0" y="0" width="{stage_width:.1f}" height="{stage_height:.1f}" rx="8"/>',
    ]

    grid_step = 80
    x = grid_step
    while x < stage_width:
        lines.append(f'<line class="grid" x1="{x:.1f}" y1="0" x2="{x:.1f}" y2="{stage_height:.1f}"/>')
        x += grid_step
    y = grid_step
    while y < stage_height:
        lines.append(f'<line class="grid" x1="0" y1="{y:.1f}" x2="{stage_width:.1f}" y2="{y:.1f}"/>')
        y += grid_step

    for trial in trials:
        points = make_polyline_points(trial.get("trace", []))
        if points:
            lines.append(f'<polyline class="path" points="{points}"/>')

    for trial in trials:
        target = trial.get("target", {})
        click = trial.get("click", {})
        trace = [point for point in trial.get("trace", []) if point.get("type") == "mousemove"]
        if trace:
            first = trace[0]
            lines.append(f'<circle class="start" cx="{float(first.get("stageX", 0)):.1f}" cy="{float(first.get("stageY", 0)):.1f}" r="2.4"/>')
        if "x" in target and "y" in target:
            lines.append(f'<rect class="target" x="{float(target["x"]) - 12:.1f}" y="{float(target["y"]) - 12:.1f}" width="24" height="24" rx="3"/>')
        if "stageX" in click and "stageY" in click:
            lines.append(f'<circle class="click" cx="{float(click["stageX"]):.1f}" cy="{float(click["stageY"]):.1f}" r="3.2"/>')

    lines.extend([
        "</g>",
        f'<text class="muted" x="{margin}" y="{height - 40:.1f}">圖例：綠點=起點，紅框=checkbox 中心，紅點=實際點擊位置，線條=滑鼠移動軌跡</text>',
        "</svg>",
    ])
    return "\n".join(lines)


def clamp(value, low, high):
    return max(low, min(high, value))


def move_mouse_to(x, y):
    if sys.platform != "win32" or USER32 is None:
        raise RuntimeError("Moving the mouse is only supported on Windows.")

    screen_width = USER32.GetSystemMetrics(0)
    screen_height = USER32.GetSystemMetrics(1)
    x = clamp(float(x), 0, screen_width - 1)
    y = clamp(float(y), 0, screen_height - 1)
    USER32.SetCursorPos(int(x), int(y))
    return x, y


class CollectorHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", "/checkbox_trajectory_collector.html"):
            self.send_html(HTML_PAGE)
            return

        if self.path == "/health":
            self.send_json({"ok": True, "message": "Checkbox trajectory collector is running."})
            return

        self.send_json({"ok": False, "error": "not found"}, status=404)

    def do_POST(self):
        if self.path == "/move-cursor":
            self.handle_move_cursor()
            return

        if self.path == "/autosave":
            self.handle_autosave()
            return

        if self.path != "/save":
            self.send_json({"ok": False, "error": "not found"}, status=404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            paths = self.save_payload(payload)
            self.send_json({
                "ok": True,
                "jsonFile": paths["json"],
                "svgFile": paths["svg"],
                "trials": len(payload.get("trials", [])),
            })
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)

    def handle_autosave(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            path = self.save_draft(payload)
            self.send_json({
                "ok": True,
                "file": path,
                "trials": len(payload.get("trials", [])),
            })
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)

    def handle_move_cursor(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            x, y = move_mouse_to(payload["x"], payload["y"])
            self.send_json({
                "ok": True,
                "x": round(x, 1),
                "y": round(y, 1),
                "stageX": payload.get("stageX"),
                "stageY": payload.get("stageY"),
            })
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)

    def save_payload(self, payload):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        output_dir = os.path.join(base_dir, "mouse_recording")
        os.makedirs(output_dir, exist_ok=True)

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_session = "".join(ch for ch in payload.get("sessionId", "session") if ch.isalnum() or ch in "_-")
        json_path = os.path.join(output_dir, f"{stamp}_{safe_session}_checkbox_100.json")
        svg_path = os.path.join(output_dir, f"{stamp}_{safe_session}_checkbox_100_paths.svg")

        with open(json_path, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)

        with open(svg_path, "w", encoding="utf-8") as file:
            file.write(build_trajectory_svg(payload))

        return {"json": json_path, "svg": svg_path}

    def save_draft(self, payload):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        output_dir = os.path.join(base_dir, "mouse_recording")
        os.makedirs(output_dir, exist_ok=True)

        safe_session = "".join(ch for ch in payload.get("sessionId", "session") if ch.isalnum() or ch in "_-")
        path = os.path.join(output_dir, f"{safe_session}_draft_checkbox.json")

        with open(path, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)

        return path

    def send_html(self, html, status=200):
        encoded = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def send_json(self, data, status=200):
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format_text, *args):
        print(f"[checkbox_collector] {format_text % args}")


def open_browser_later(url):
    time.sleep(0.8)
    webbrowser.open(url)


def main():
    url = f"http://{HOST}:{PORT}/checkbox_trajectory_collector.html"
    server = ThreadingHTTPServer((HOST, PORT), CollectorHandler)
    threading.Thread(target=open_browser_later, args=(url,), daemon=True).start()

    print(f"Checkbox trajectory collector running at {url}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
