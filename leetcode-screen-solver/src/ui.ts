import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askCodexCliAgent, askOpenClawAgent } from "./agentHandoff.js";
import { extractMarkdownSection } from "./markdown.js";
import { buildAnswerPrompt } from "./prompts.js";
import { captureScreen, listDisplays, makeRunId } from "./screen.js";
import { observeScreenshotLocally } from "./screenshotObservation.js";
import { observeTranscriptLocally } from "./localTranscript.js";
import { createEmptyState, mergeObservation } from "./state.js";
import type { AnswerHandoff, DisplayInfo, QuestionState } from "./types.js";

interface UiServerOptions {
  outDir: string;
  port: number;
  handoff: AnswerHandoff;
  intervalMs?: number;
  language?: string;
  profilePath?: string | null;
}

export interface UiServerHandle {
  url: string;
  close: () => Promise<void>;
}

interface RunSummary {
  id: string;
  updatedAt: string | null;
  title: string;
  kind: string;
  completenessScore: number;
  readyToAnswer: boolean;
  hasAnswer: boolean;
  hasHints: boolean;
}

interface RunDetail extends RunSummary {
  state: QuestionState | null;
  answerMarkdown: string;
  hintsMarkdown: string;
  turns: RunTurnDetail[];
  latestScreenshotUrl: string | null;
  screenshotUrls: string[];
  screenshotCount: number;
}

interface RunTurnDetail {
  id: string;
  kind: "original" | "followup";
  title: string;
  questionMarkdown: string;
  answerMarkdown: string;
  hintsMarkdown: string;
  hasAnswer: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RunTurnArtifact extends RunTurnDetail {
  state: QuestionState | null;
}

interface MonitorStatus {
  running: boolean;
  screenId: number | null;
  activeRunId: string | null;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  log: string[];
}

interface MonitorProcess {
  child: ChildProcessWithoutNullStreams;
  screenId: number;
  activeRunId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  log: string[];
}

interface ScreenshotRecord {
  path: string;
  updatedAt: number;
}

const HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Interview Coder</title>
    <style>
__CSS__
    </style>
  </head>
  <body>
    <main class="app-shell">
      <header class="top-bar">
        <div class="title-group">
          <p id="kindLabel" class="kind-label">No run selected</p>
          <h1 id="titleLabel">Waiting for a captured question</h1>
        </div>
        <div class="header-tools">
          <div class="status-row">
            <span id="readyLabel" class="status-pill">Not ready</span>
            <span id="completenessLabel" class="status-text">0% captured</span>
            <span id="lastUpdated" class="status-text" title="Capture timer">00:00</span>
          </div>
          <div class="tab-strip" role="tablist" aria-label="Question and answer views">
            <button id="answerTab" class="tab-button active" type="button" role="tab" aria-selected="true" aria-controls="answerPanel" title="Switch to Answer tab (A)">Answer (A)</button>
            <button id="questionTab" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="questionPanel" title="Switch to Question tab (Q)">Question (Q)</button>
          </div>
          <div class="monitor-dock">
            <button id="overlayToggle" class="overlay-toggle" type="button" aria-expanded="true" title="Capture monitor"></button>
            <div id="overlayPanel" class="overlay-panel">
              <p id="monitorStatus" class="monitor-status">Not monitoring</p>
              <label class="field">
                <span>Screen</span>
                <select id="screenSelect"></select>
              </label>
              <div class="overlay-actions">
                <button id="answerButton" class="small-button" type="button" title="Generate an answer from current captures (F)">Answer (F)</button>
                <button id="captureButton" class="small-button" type="button" title="Capture the current screen for this question (C)">Capture (C)</button>
                <button id="startMonitorButton" class="small-button" type="button" title="Reset for a new question without capturing (N)">New (N)</button>
                <button id="stopMonitorButton" class="small-button danger" type="button" title="Stop monitoring (S)">Stop (S)</button>
              </div>
              <div id="monitorMap" class="monitor-map" aria-label="Monitor layout"></div>
            </div>
          </div>
        </div>
      </header>

      <div class="content-stack">
        <section id="answerPanel" class="answer-pane" role="tabpanel" aria-labelledby="answerTab">
          <div id="answerTurnTabs" class="turn-tabs hidden" role="tablist" aria-label="Answer turns"></div>
          <div id="answerModeTabs" class="answer-mode-tabs hidden" role="tablist" aria-label="Answer walkthroughs">
            <button id="firstTryAnswerTab" class="answer-mode-button active" type="button" role="tab" aria-selected="true" aria-controls="answerView" title="Switch to First Try walkthrough (W)">First Try (W)</button>
            <button id="robustAnswerTab" class="answer-mode-button" type="button" role="tab" aria-selected="false" aria-controls="answerView" title="Switch to Robust walkthrough (E)">Robust (E)</button>
          </div>
          <div id="answerView" class="markdown answer-markdown">Solution will appear after the question is ready.</div>
          <section id="hintsSection" class="hints-section hidden">
            <h2>Hints</h2>
            <div id="hintsView" class="markdown"></div>
          </section>
        </section>

        <section id="questionPanel" class="question-pane hidden" role="tabpanel" aria-labelledby="questionTab">
          <div id="questionTurnTabs" class="turn-tabs hidden" role="tablist" aria-label="Question turns"></div>
          <div id="screenshotWrap" class="screenshot-wrap hidden">
            <p id="screenshotMeta" class="screenshot-meta"></p>
            <div id="screenshotGallery" class="screenshot-gallery" aria-live="polite" role="list"></div>
          </div>
          <div id="questionBody" class="markdown empty">Capture a screen, listen, or type the question.</div>
          <form id="questionInputForm" class="question-input" autocomplete="off">
            <textarea id="questionInput" rows="3" placeholder="Type or dictate the question"></textarea>
            <button id="listenButton" class="small-button" type="button" aria-pressed="false" title="Dictate into the text box (L)">Listen (L)</button>
            <button id="questionSubmitButton" class="small-button" type="submit" title="Send question text (Ctrl+Enter)">Send (Ctrl+Enter)</button>
          </form>
        </section>
      </div>
    </main>

    <script>
__JS__
    </script>
  </body>
</html>`;

const CSS = String.raw`:root {
  color-scheme: light;
  --bg: #f1f4f7;
  --panel: #ffffff;
  --panel-strong: #edf5f3;
  --text: #152029;
  --muted: #60707a;
  --border: #d7dee3;
  --border-strong: #bfccd4;
  --accent: #006c67;
  --accent-soft: #d9eeeb;
  --accent-line: #00a08f;
  --amber: #a85f00;
  --danger: #b42318;
  --code-bg: #10161d;
  --code-panel: #151e27;
  --code-text: #edf4f8;
  --soft-row: #f7fafb;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

html {
  height: 100%;
}

body {
  margin: 0;
  height: 100%;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

button,
input,
textarea {
  font: inherit;
}

.shell {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: 100vh;
}

.runs-pane {
  border-right: 1px solid var(--border);
  background: #ffffff;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px;
  border-bottom: 1px solid var(--border);
}

.brand h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
}

.brand p,
.toolbar,
.eyebrow,
.pane-header span {
  color: var(--muted);
  font-size: 13px;
}

.brand p {
  margin: 5px 0 0;
}

.icon-button,
.run-item {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
}

.icon-button {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  cursor: pointer;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

.monitor-panel {
  padding: 14px 12px;
  border-bottom: 1px solid var(--border);
  background: #f9fbfc;
}

.monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.monitor-header h2 {
  margin: 0;
  font-size: 15px;
  line-height: 1.2;
}

.monitor-header p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.small-button {
  height: 34px;
  min-width: 58px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.small-button.danger {
  color: var(--danger);
}

.small-button.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #ffffff;
}

.small-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.displays-list {
  display: grid;
  gap: 8px;
}

.display-button {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.display-button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.display-button strong {
  display: block;
  font-size: 13px;
  line-height: 1.25;
}

.display-button span {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.3;
}

.runs-list {
  overflow: auto;
  padding: 12px;
}

.run-item {
  display: block;
  width: 100%;
  text-align: left;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
  cursor: pointer;
}

.run-item.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.run-item strong {
  display: block;
  font-size: 14px;
  line-height: 1.3;
  margin-bottom: 6px;
}

.run-item span {
  display: block;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
}

.workspace {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.status-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 24px;
  align-items: center;
  padding: 22px 28px;
  background: var(--panel-strong);
  border-bottom: 1px solid var(--border);
}

.eyebrow {
  margin: 0 0 6px;
  text-transform: uppercase;
  letter-spacing: 0;
  font-weight: 700;
}

.status-band h2 {
  margin: 0;
  font-size: 26px;
  line-height: 1.18;
}

.meter {
  height: 12px;
  border-radius: 999px;
  background: #d3dce1;
  overflow: hidden;
}

.meter div {
  height: 100%;
  width: 0;
  background: var(--accent);
  transition: width 160ms ease;
}

.tab-strip {
  display: inline-flex;
  align-items: stretch;
  align-self: center;
  gap: 4px;
  margin: 0;
  padding: 3px;
  overflow: hidden;
  border: 1px solid #9db1bd;
  border-radius: 10px;
  background: #dfe9ef;
}

.tab-button {
  min-height: 36px;
  min-width: 106px;
  margin: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #3c4f59;
  cursor: pointer;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
}

.tab-button:hover {
  background: #eef4f7;
  color: var(--text);
}

.tab-button:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--accent-line);
  outline-offset: -2px;
}

.tab-button.active {
  background: var(--accent);
  color: #ffffff;
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.18);
}

.content-stack {
  display: block;
  margin: 0;
  padding: 0;
  margin-top: 2px;
  min-height: 0;
  flex: 1;
}

.question-pane,
.answer-pane {
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.markdown {
  overflow: auto;
  padding: 16px;
  line-height: 1.62;
  font-size: 15px;
}

.answer-pane .markdown,
.question-pane .markdown {
  flex: 1;
  min-height: 0;
}

.answer-markdown {
  padding: 0;
}

.answer-mode-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 4px;
  border-bottom: 1px solid var(--border);
  background: #f8fafb;
}

.turn-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 4px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: #f4f8f8;
}

.turn-tab-button {
  min-height: 32px;
  min-width: 112px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: #ffffff;
  color: var(--muted);
  cursor: pointer;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.turn-tab-button:hover {
  color: var(--text);
  background: #f9fbfc;
}

.turn-tab-button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.turn-tab-button.pending::after {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 7px;
  border-radius: 999px;
  background: var(--amber);
  vertical-align: 1px;
}

.answer-mode-button {
  min-height: 32px;
  min-width: 118px;
  border: 1px solid var(--border);
  border-right: 0;
  background: #ffffff;
  color: var(--muted);
  cursor: pointer;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
}

.answer-mode-button:first-child {
  border-radius: 5px 0 0 5px;
}

.answer-mode-button:last-child {
  border-right: 1px solid var(--border);
  border-radius: 0 5px 5px 0;
}

.answer-mode-button:hover {
  color: var(--text);
  background: #f4f8f8;
}

.answer-mode-button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.hints-markdown {
  flex: 0 0 auto !important;
  max-height: 220px;
  background: #fbfcf7;
  border-top: 1px solid var(--border);
}

.markdown h2 {
  margin: 24px 0 10px;
  font-size: 19px;
  line-height: 1.2;
  letter-spacing: 0;
}

.markdown h2:first-child,
.markdown h3:first-child,
.markdown p:first-child,
.markdown ul:first-child,
.markdown ol:first-child {
  margin-top: 0;
}

.markdown h3 {
  margin: 18px 0 8px;
  font-size: 16px;
  line-height: 1.25;
}

.markdown p {
  margin: 0 0 12px;
}

.markdown ul,
.markdown ol {
  margin: 0 0 14px;
  padding-left: 22px;
}

.markdown li {
  margin: 7px 0;
  padding-left: 2px;
}

.markdown strong {
  color: #111820;
  font-weight: 700;
}

.markdown code {
  background: #e7eef2;
  border-radius: 4px;
  padding: 2px 5px;
  font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  font-size: 0.9em;
}

.code-shell {
  margin: 14px 0 18px;
  border: 1px solid #263445;
  border-radius: 8px;
  overflow: hidden;
  background: var(--code-bg);
}

.code-label {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 0 14px;
  background: var(--code-panel);
  border-bottom: 1px solid #263445;
  color: #a9bac8;
  font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0;
}

.markdown pre {
  margin: 0;
  color: var(--code-text);
  padding: 16px;
  overflow: auto;
  font-size: 14px;
  line-height: 1.65;
}

.markdown pre code {
  background: transparent;
  color: inherit;
  padding: 0;
  border-radius: 0;
}

.empty {
  color: var(--muted);
}

.pane-subheader {
  margin-top: 0;
}

.answer-summary {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  margin: 0;
  padding: 4px;
  overflow-x: auto;
  scrollbar-gutter: stable;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.96);
}

.section-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--soft-row);
  color: #27343d;
  text-decoration: none;
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
}

.section-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.md-section {
  padding: 16px 18px 16px 20px;
  border-bottom: 1px solid var(--border);
  scroll-margin-top: 64px;
}

.md-section:last-child {
  border-bottom: 0;
}

.md-section h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
}

.md-section h2::before {
  content: "";
  flex: 0 0 auto;
  width: 4px;
  height: 22px;
  border-radius: 4px;
  background: var(--accent-line);
}

.md-section-say-this-first {
  background: #f7fbfa;
}

.md-section-hints {
  background: #fbfcf7;
}

.md-section-naive-first-try {
  background: #fffaf1;
}

.md-section-robust-walkthrough {
  background: #f7fbfa;
}

.md-section-robust-answer {
  background: #f7fbfa;
}

.md-section-code {
  background: #fbfcfd;
}

.answer-markdown > p,
.answer-markdown > ul,
.answer-markdown > ol,
.answer-markdown > h2,
.answer-markdown > h3,
.answer-markdown > .code-shell {
  margin-left: 22px;
  margin-right: 22px;
}

.screenshot-wrap {
  border-bottom: 1px solid var(--border);
  background: #101820;
  padding: 10px;
  flex: 0 1 56%;
  max-height: 56%;
  min-height: 190px;
  overflow: auto;
}

.screenshot-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.screenshot-item {
  margin: 0;
  background: #0d131b;
  border: 1px solid #1f2a35;
  border-radius: 6px;
  padding: 8px;
  min-width: 0;
}

.screenshot-item img {
  display: block;
  width: 100%;
  max-height: min(34vh, 360px);
  max-width: 100%;
  object-fit: contain;
  margin: 0 auto;
}

#questionBody {
  flex: 1 1 260px;
  min-height: clamp(180px, 34%, 320px);
}

.question-input {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px 86px;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
  background: #f8fafb;
}

.question-input textarea {
  width: 100%;
  min-height: 70px;
  max-height: 180px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 10px 12px;
  line-height: 1.45;
}

.question-input textarea:focus {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}

.question-input .small-button {
  align-self: stretch;
  width: 100%;
  min-width: 0;
}

.screenshot-meta {
  margin: 0 0 8px;
  color: #cdd7e0;
  font-size: 12px;
  margin-bottom: 10px;
  font-weight: 600;
}

.screenshot-item figcaption {
  color: #b8c4d1;
  font-size: 12px;
  margin: 6px 0 2px;
}

.app-shell {
  height: 100vh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  gap: 8px;
  overflow: hidden;
}

.top-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.82);
}

.title-group {
  display: none;
  min-width: 0;
  flex: 0 1 520px;
}

.kind-label {
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0;
  text-transform: uppercase;
  font-weight: 700;
}

.title-group h1 {
  margin: 0;
  font-size: 30px;
  line-height: 1.18;
  overflow-wrap: anywhere;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  justify-content: flex-end;
  width: auto;
  flex: 0 0 auto;
}

.header-tools {
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
}

.status-pill,
.status-text {
  border: 1px solid var(--border);
  background: #ffffff;
  border-radius: 6px;
  min-height: 34px;
  padding: 6px 10px;
  display: inline-flex;
  align-items: center;
  font-size: 12px;
}

.status-pill {
  font-weight: 700;
}

.status-text {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

#readyLabel,
#completenessLabel {
  display: none;
}

#lastUpdated {
  min-width: 58px;
  justify-content: center;
}

.hints-section {
  border-top: 1px solid var(--border);
  background: #fbfcf7;
}

.hints-section h2 {
  margin: 0;
  min-height: 44px;
  padding: 10px 20px;
  font-size: 16px;
  border-bottom: 1px solid var(--border);
}

.hints-section .markdown {
  max-height: 220px;
  padding-top: 14px;
}

.monitor-dock {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  margin-left: auto;
  flex: 0 0 auto;
  min-width: 640px;
  max-width: 100%;
}

.overlay-toggle {
  display: none !important;
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 6px 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.overlay-panel {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  box-shadow: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.monitor-status {
  display: none;
  grid-column: 1;
  margin: 0;
  font-size: 13px;
  line-height: 1.25;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field {
  grid-column: 1;
  display: none;
  margin-bottom: 0;
  min-width: 0;
}

.field span {
  display: none;
  margin-bottom: 0;
  font-size: 12px;
  color: var(--muted);
}

.field select {
  width: 100%;
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 0 10px;
  font-size: 13px;
}

.monitor-map {
  display: block;
  flex: 0 0 auto;
  position: relative;
  width: 320px;
  min-width: 260px;
  max-width: 360px;
  height: 38px;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: visible;
}

.monitor-map:empty {
  display: none;
}

.monitor-tile {
  position: absolute;
  min-width: 46px;
  min-height: 24px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  background: var(--soft-row);
  color: var(--text);
  padding: 0;
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.monitor-tile.primary {
  border-color: var(--accent);
}

.monitor-tile.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}

.monitor-tile.monitoring {
  box-shadow: inset 0 0 0 2px var(--accent-line);
}

.overlay-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  min-width: 0;
}

.overlay-actions .small-button {
  flex: 0 0 auto;
  min-width: 102px;
  padding: 0 12px;
  font-size: 13px;
}

.hidden {
  display: none !important;
}

@media (max-width: 1100px) {
  body {
    height: auto;
    overflow: auto;
  }

  .app-shell {
    height: auto;
    min-height: 100vh;
    overflow: visible;
    padding: 8px;
    gap: 4px;
  }

  .top-bar {
    flex-direction: column;
    gap: 10px;
    padding: 8px;
  }

  .header-tools {
    flex: 0 1 auto;
    width: 100%;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
  }

  .status-row {
    width: 100%;
    justify-content: flex-start;
  }

  .tab-strip {
    align-self: flex-start;
    width: auto;
  }

  .tab-button {
    min-width: 96px;
  }

  .answer-mode-button {
    flex: 1 1 0;
    min-width: 0;
  }

  .monitor-dock {
    align-items: flex-start;
    margin-left: 0;
    min-width: 0;
    width: 100%;
  }

  .overlay-panel {
    display: block;
    width: 100%;
  }

  .monitor-status,
  .field,
  .monitor-map,
  .overlay-actions {
    margin-top: 8px;
  }

  .field {
    width: 100%;
    max-width: 420px;
    flex: 1 1 auto;
  }

  .monitor-map {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }

  .overlay-actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    min-width: 0;
  }

  .overlay-actions .small-button {
    width: 100%;
    min-width: 0;
    padding: 0 6px;
  }

  .question-input {
    grid-template-columns: 1fr;
  }

  .question-input .small-button {
    min-height: 38px;
  }

}`;

const JS = String.raw`var state = {
  currentRunId: null,
  timer: null,
  lastRefreshAt: 0,
  capturing: false,
  currentRunReady: false,
  currentRunHasAnswer: false,
  displays: [],
  monitor: null,
  pendingScreenId: null,
  overlayOpen: false,
  answering: false,
  activeTab: 'answer',
  activeAnswerMode: 'firstTry',
  activeTurnId: null,
  currentRun: null,
  newQuestionPending: false,
  answerRequestedRunId: null,
  answerRequestedTurnId: null,
  recognition: null,
  listening: false,
  transcriptPost: Promise.resolve(),
  questionTextSubmitting: false,
};

var elements = {};
var SELECTED_SCREEN_KEY = 'interviewCoder.selectedScreenId';

function fallbackDisplayLabel(display) {
  if (!display) {
    return 'Unknown screen';
  }
  return 'Screen ' + display.id + (display.primary ? ' - primary' : '') +
    ' | ' + display.width + 'x' + display.height + ' at ' + display.x + ',' + display.y;
}

function displayOptionLabel(display) {
  return display && display.label ? display.label : fallbackDisplayLabel(display);
}

function displayShortLabel(display) {
  if (!display) {
    return '';
  }
  return display.shortLabel || ('Screen ' + display.id + (display.primary ? ' - primary' : ''));
}

function displayById(screenId) {
  return state.displays.find(function (display) {
    return String(display.id) === String(screenId);
  }) || null;
}

function screenShortLabel(screenId) {
  var display = displayById(screenId);
  return display ? displayShortLabel(display) : 'screen ' + screenId;
}

function defaultDisplayId() {
  if (!state.displays.length) {
    return '';
  }
  var primary = state.displays.find(function (display) { return display.primary; });
  return String((primary || state.displays[0]).id);
}

function displayMapText(display) {
  var position = String(display && display.relativePosition ? display.relativePosition : '').toLowerCase();
  if (display && display.primary) {
    return 'Primary';
  }
  if (position.indexOf('far left') !== -1) {
    return 'Far L';
  }
  if (position.indexOf('left') !== -1) {
    return 'Left';
  }
  if (position.indexOf('far right') !== -1) {
    return 'Far R';
  }
  if (position.indexOf('right') !== -1) {
    return 'Right';
  }
  if (position.indexOf('above') !== -1 || position.indexOf('upper') !== -1) {
    return 'Top';
  }
  if (position.indexOf('below') !== -1 || position.indexOf('lower') !== -1) {
    return 'Bottom';
  }
  return 'S' + (display ? display.id : '');
}

function selectMonitorByIndex(index) {
  if (!elements.screenSelect || elements.screenSelect.disabled) {
    return false;
  }
  if (!Number.isFinite(index) || index < 0 || index >= state.displays.length) {
    return false;
  }

  elements.screenSelect.value = String(state.displays[index].id);
  elements.screenSelect.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function renderMonitorMap() {
  if (!elements.monitorMap) {
    return;
  }

  elements.monitorMap.innerHTML = '';
  if (!state.displays.length) {
    return;
  }

  var minX = Math.min.apply(null, state.displays.map(function (display) { return display.x; }));
  var minY = Math.min.apply(null, state.displays.map(function (display) { return display.y; }));
  var maxX = Math.max.apply(null, state.displays.map(function (display) { return display.x + display.width; }));
  var maxY = Math.max.apply(null, state.displays.map(function (display) { return display.y + display.height; }));
  var virtualWidth = Math.max(1, maxX - minX);
  var virtualHeight = Math.max(1, maxY - minY);
  var mapWidth = elements.monitorMap.clientWidth || 360;
  var mapHeight = elements.monitorMap.clientHeight || 44;
  var padding = 4;
  var scale = Math.min((mapWidth - padding * 2) / virtualWidth, (mapHeight - padding * 2) / virtualHeight);
  var renderedWidth = virtualWidth * scale;
  var renderedHeight = virtualHeight * scale;
  var offsetX = (mapWidth - renderedWidth) / 2;
  var offsetY = (mapHeight - renderedHeight) / 2;
  var selectedScreen = elements.screenSelect ? String(elements.screenSelect.value || '') : '';
  var monitoringScreen = state.monitor && state.monitor.running && state.monitor.screenId
    ? String(state.monitor.screenId)
    : '';

  state.displays.forEach(function (display, index) {
    var screenId = String(display.id);
    var monitorHotkey = index < 9 ? String(index + 1) : '';
    var button = document.createElement('button');
    var width = Math.max(50, Math.floor(display.width * scale) - 1);
    var height = Math.max(28, Math.floor(display.height * scale) - 1);
    button.type = 'button';
    button.className = 'monitor-tile' +
      (display.primary ? ' primary' : '') +
      (screenId === selectedScreen ? ' active' : '') +
      (screenId === monitoringScreen ? ' monitoring' : '');
    button.style.left = Math.round(offsetX + (display.x - minX) * scale) + 'px';
    button.style.top = Math.round(offsetY + (display.y - minY) * scale) + 'px';
    button.style.width = width + 'px';
    button.style.height = height + 'px';
    button.textContent = displayMapText(display) + (monitorHotkey ? ' (' + monitorHotkey + ')' : '');
    var monitorTitle = displayOptionLabel(display) + (monitorHotkey ? ' (' + monitorHotkey + ')' : '');
    button.title = monitorTitle;
    button.setAttribute('aria-label', monitorTitle);
    button.addEventListener('click', function () {
      selectMonitorByIndex(index);
    });
    elements.monitorMap.appendChild(button);
  });
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function flushList(buffer, ordered) {
  if (buffer.length === 0) {
    return '';
  }
  var tag = ordered ? 'ol' : 'ul';
  var html = '<' + tag + '>';
  buffer.forEach(function (item) {
    html += '<li>' + renderInline(item) + '</li>';
  });
  return html + '</' + tag + '>';
}

function slugifyHeading(value, used) {
  var base = String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  var slug = base;
  var count = 2;
  while (used[slug]) {
    slug = base + '-' + count;
    count += 1;
  }
  used[slug] = true;
  return slug;
}

function renderCodeBlock(code, language) {
  var label = language || 'code';
  return '<div class="code-shell"><div class="code-label">' + escapeHtml(label) + '</div><pre><code>' +
    escapeHtml(code.join('\n')) + '</code></pre></div>';
}

function renderMarkdown(markdown, options) {
  if (!markdown || !markdown.trim()) {
    return '<p class="empty">Nothing generated yet.</p>';
  }

  options = options || {};
  var sectioned = Boolean(options.sectioned);
  var showSummary = options.summary !== false;
  var lines = markdown.replace(/\r\n/g, '\n').split('\n');
  var html = '';
  var paragraph = [];
  var list = [];
  var orderedList = [];
  var inCode = false;
  var code = [];
  var codeLanguage = '';
  var sectionOpen = false;
  var sectionHeadings = [];
  var usedSlugs = {};

  function flushParagraph() {
    if (paragraph.length) {
      html += '<p>' + renderInline(paragraph.join(' ')) + '</p>';
      paragraph = [];
    }
  }

  function flushLists() {
    html += flushList(list, false);
    html += flushList(orderedList, true);
    list = [];
    orderedList = [];
  }

  function closeSection() {
    if (sectionOpen) {
      html += '</section>';
      sectionOpen = false;
    }
  }

  function sectionClass(title) {
    return String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  }

  lines.forEach(function (line) {
    var fence = line.match(/^\`\`\`\s*([a-zA-Z0-9_-]+)?/);
    if (fence) {
      if (inCode) {
        html += renderCodeBlock(code, codeLanguage);
        code = [];
        codeLanguage = '';
        inCode = false;
      } else {
        flushParagraph();
        flushLists();
        codeLanguage = fence[1] || '';
        inCode = true;
      }
      return;
    }

    if (inCode) {
      code.push(line);
      return;
    }

    if (!line.trim()) {
      flushParagraph();
      flushLists();
      return;
    }

    var h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushParagraph();
      flushLists();
      if (sectioned) {
        closeSection();
        var sectionId = slugifyHeading(h2[1], usedSlugs);
        sectionHeadings.push({ id: sectionId, title: h2[1] });
        html += '<section id="' + sectionId + '" class="md-section md-section-' + sectionClass(h2[1]) + '">';
        sectionOpen = true;
      }
      html += '<h2>' + renderInline(h2[1]) + '</h2>';
      return;
    }

    var h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushParagraph();
      flushLists();
      html += '<h3>' + renderInline(h3[1]) + '</h3>';
      return;
    }

    var bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (orderedList.length) {
        html += flushList(orderedList, true);
        orderedList = [];
      }
      orderedList = [];
      list.push(bullet[1]);
      return;
    }

    var ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (list.length) {
        html += flushList(list, false);
        list = [];
      }
      list = [];
      orderedList.push(ordered[1]);
      return;
    }

    paragraph.push(line.trim());
  });

  if (inCode) {
    html += renderCodeBlock(code, codeLanguage);
  }
  flushParagraph();
  flushLists();
  closeSection();
  if (sectioned && showSummary && sectionHeadings.length > 2) {
    var summary = '<nav class="answer-summary" aria-label="Solution sections">';
    sectionHeadings.forEach(function (heading) {
      summary += '<a class="section-chip" href="#' + escapeHtml(heading.id) + '">' + renderInline(heading.title) + '</a>';
    });
    summary += '</nav>';
    return summary + html;
  }
  return html;
}

function normalizeAnswerHeading(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitAnswerSections(markdown) {
  var lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  var intro = [];
  var sections = [];
  var current = null;

  lines.forEach(function (line) {
    var h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      if (current) {
        sections.push(current);
      }
      current = { title: h2[1].trim(), lines: [] };
      return;
    }

    if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  });

  if (current) {
    sections.push(current);
  }

  return {
    intro: intro.join('\n').trim(),
    sections: sections,
  };
}

function sectionToMarkdown(section) {
  var body = section.lines.join('\n').trim();
  return body ? '## ' + section.title + '\n\n' + body : '## ' + section.title;
}

function answerHasWalkthroughTabs(markdown) {
  var split = splitAnswerSections(markdown);
  return split.sections.some(function (section) {
    var name = normalizeAnswerHeading(section.title);
    return name === 'naive first try' || name === 'robust walkthrough' || name === 'robust answer';
  });
}

function answerMarkdownForMode(markdown, mode) {
  var split = splitAnswerSections(markdown);
  if (!split.sections.length || !answerHasWalkthroughTabs(markdown)) {
    return markdown;
  }

  var firstTrySections = {
    'say this first': true,
    'hints': true,
    'naive first try': true,
  };
  var robustPrimarySections = {
    'robust walkthrough': true,
    'robust answer': true,
    'code': true,
    'complexity': true,
    'fix': true,
    'if asked': true,
  };
  var selected = split.sections.filter(function (section) {
    var name = normalizeAnswerHeading(section.title);
    var isFirstTrySection = Boolean(firstTrySections[name]);
    if (mode === 'robust') {
      return name === 'say this first' || (!isFirstTrySection && Boolean(robustPrimarySections[name]));
    }
    return isFirstTrySection;
  });

  if (!selected.length) {
    selected = mode === 'robust'
      ? split.sections
      : split.sections.slice(0, Math.min(3, split.sections.length));
  }

  var parts = [];
  if (mode !== 'robust' && split.intro) {
    parts.push(split.intro);
  }
  selected.forEach(function (section) {
    parts.push(sectionToMarkdown(section));
  });

  return parts.join('\n\n').trim() || markdown;
}

function renderAnswerModeButtons(showTabs) {
  if (!elements.answerModeTabs || !elements.firstTryAnswerTab || !elements.robustAnswerTab) {
    return;
  }

  elements.answerModeTabs.classList.toggle('hidden', !showTabs);
  var robustActive = state.activeAnswerMode === 'robust';
  elements.firstTryAnswerTab.classList.toggle('active', !robustActive);
  elements.firstTryAnswerTab.setAttribute('aria-selected', String(!robustActive));
  elements.robustAnswerTab.classList.toggle('active', robustActive);
  elements.robustAnswerTab.setAttribute('aria-selected', String(robustActive));
}

function clearAnswerHash() {
  if (window.location.hash && window.history && window.history.replaceState) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }
}

function scrollAnswerToTop() {
  if (elements.answerView) {
    elements.answerView.scrollTop = 0;
  }
  window.scrollTo(0, 0);
}

function runTurns(run) {
  return run && Array.isArray(run.turns) ? run.turns : [];
}

function latestTurnId(run) {
  var turns = runTurns(run);
  return turns.length ? turns[turns.length - 1].id : null;
}

function selectedTurn(run) {
  var turns = runTurns(run);
  if (!turns.length) {
    return null;
  }

  var selected = turns.find(function (turn) { return turn.id === state.activeTurnId; });
  return selected || turns[turns.length - 1];
}

function selectedAnswerMarkdown(run) {
  var turn = selectedTurn(run);
  return turn ? (turn.answerMarkdown || '') : (run && run.answerMarkdown ? run.answerMarkdown : '');
}

function selectedHintsMarkdown(run) {
  var turn = selectedTurn(run);
  return turn ? (turn.hintsMarkdown || '') : (run && run.hintsMarkdown ? run.hintsMarkdown : '');
}

function selectedTurnLabel(run) {
  var turn = selectedTurn(run);
  return turn ? turn.title : 'Question';
}

function selectedTurnReadyForAnswer(run) {
  var turn = selectedTurn(run);
  if (turn && turn.kind === 'followup') {
    return Boolean(turn.questionMarkdown && turn.questionMarkdown.trim());
  }
  return Boolean(run && run.readyToAnswer);
}

function renderTurnTabList(container, run) {
  if (!container) {
    return;
  }

  var turns = runTurns(run);
  container.innerHTML = '';
  container.classList.toggle('hidden', turns.length === 0);
  if (!turns.length) {
    return;
  }

  turns.forEach(function (turn) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'turn-tab-button' +
      (turn.id === state.activeTurnId ? ' active' : '') +
      (turn.hasAnswer ? '' : ' pending');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(turn.id === state.activeTurnId));
    button.textContent = turn.title;
    button.title = turn.hasAnswer ? turn.title : turn.title + ' needs an answer';
    button.addEventListener('click', function () {
      selectTurn(turn.id);
    });
    container.appendChild(button);
  });
}

function renderTurnTabs(run) {
  renderTurnTabList(elements.answerTurnTabs, run);
  renderTurnTabList(elements.questionTurnTabs, run);
}

function renderAnswerContent(run) {
  var answerMarkdown = selectedAnswerMarkdown(run);
  var hasAnswerMarkdown = Boolean(answerMarkdown && answerMarkdown.trim());
  if (hasAnswerMarkdown) {
    var useWalkthroughTabs = answerHasWalkthroughTabs(answerMarkdown);
    renderAnswerModeButtons(useWalkthroughTabs);
    var markdown = useWalkthroughTabs
      ? answerMarkdownForMode(answerMarkdown, state.activeAnswerMode)
      : answerMarkdown;
    elements.answerView.innerHTML = renderMarkdown(markdown, { sectioned: true, summary: false });
    return;
  }

  renderAnswerModeButtons(false);
  if (selectedTurnReadyForAnswer(run)) {
    elements.answerView.innerHTML = '<p class="empty">' + escapeHtml(selectedTurnLabel(run)) + ' is ready. Click Answer to generate a solution.</p>';
    return;
  }

  elements.answerView.innerHTML = '<p class="empty">Solution will appear after the question is ready.</p>';
}

function selectAnswerMode(mode) {
  state.activeAnswerMode = mode === 'robust' ? 'robust' : 'firstTry';
  renderAnswerModeButtons(Boolean(selectedAnswerMarkdown(state.currentRun)));
  if (state.currentRun) {
    renderAnswerContent(state.currentRun);
    clearAnswerHash();
    scrollAnswerToTop();
  }
}

function renderHintsContent(run) {
  var answerMarkdown = selectedAnswerMarkdown(run);
  var hintsMarkdown = selectedHintsMarkdown(run);
  var answerIncludesHints = /^##\s+Hints\b/im.test(answerMarkdown || '');
  var showSeparateHints = Boolean(hintsMarkdown && hintsMarkdown.trim() && !answerIncludesHints);
  elements.hintsSection.classList.toggle('hidden', !showSeparateHints);
  if (showSeparateHints) {
    elements.hintsView.innerHTML = renderMarkdown(hintsMarkdown);
  } else {
    elements.hintsView.innerHTML = '';
  }
}

function selectTurn(turnId) {
  if (state.activeTurnId !== turnId) {
    state.activeAnswerMode = 'firstTry';
  }
  state.activeTurnId = turnId || null;
  if (!state.currentRun) {
    return;
  }
  renderTurnTabs(state.currentRun);
  elements.questionBody.innerHTML = renderMarkdown(questionMarkdown(state.currentRun));
  renderAnswerContent(state.currentRun);
  renderHintsContent(state.currentRun);
  clearAnswerHash();
  scrollAnswerToTop();
}

function normalizeDisplayText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function questionMarkdown(run) {
  if (!run || !run.state || !run.state.question) {
    return '';
  }

  var turn = selectedTurn(run);
  if (turn && turn.questionMarkdown && turn.questionMarkdown.trim()) {
    return turn.questionMarkdown;
  }

  var question = run.state.question;
  var parts = [];
  if (question.prompt) {
    parts.push('## Prompt\n\n' + question.prompt);
  }
  if (question.inputOutput) {
    parts.push('## Input / Output\n\n' + question.inputOutput);
  }
  if (question.examples && question.examples.length) {
    parts.push('## Examples\n\n' + question.examples.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.constraints && question.constraints.length) {
    parts.push('## Constraints\n\n' + question.constraints.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.functionSignature) {
    parts.push('## Signature\n\n\`' + question.functionSignature + '\`');
  }
  if (question.notes && question.notes.length) {
    parts.push('## Notes\n\n' + question.notes.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.followUp && normalizeDisplayText(question.prompt).indexOf(normalizeDisplayText(question.followUp)) === -1) {
    parts.push('## Follow-up\n\n' + question.followUp);
  }
  if (run.state.transcriptText) {
    parts.push('## Transcript\n\n' + run.state.transcriptText);
  }
  if (run.state.missingInformation && run.state.missingInformation.length) {
    parts.push('## Still Missing\n\n' + run.state.missingInformation.map(function (item) { return '- ' + item; }).join('\n'));
  }
  return parts.join('\n\n');
}

function formatElapsed(ms) {
  var totalSeconds = Math.max(0, Math.floor(ms / 1000));
  var seconds = String(totalSeconds % 60).padStart(2, '0');
  var minutes = Math.floor(totalSeconds / 60) % 60;
  var hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds;
  }
  return String(minutes).padStart(2, '0') + ':' + seconds;
}

function updateElapsedTimer() {
  if (!elements.lastUpdated) {
    return;
  }

  var monitor = state.monitor;
  if (!monitor || !monitor.startedAt) {
    elements.lastUpdated.textContent = '00:00';
    elements.lastUpdated.title = 'Capture timer';
    return;
  }

  var startedAt = Date.parse(monitor.startedAt);
  if (!Number.isFinite(startedAt)) {
    elements.lastUpdated.textContent = '00:00';
    elements.lastUpdated.title = 'Capture timer';
    return;
  }

  var stoppedAt = monitor.stoppedAt ? Date.parse(monitor.stoppedAt) : NaN;
  var endAt = monitor.running || !Number.isFinite(stoppedAt) ? Date.now() : stoppedAt;
  elements.lastUpdated.textContent = formatElapsed(endAt - startedAt);
  elements.lastUpdated.title = monitor.running ? 'Capture elapsed time' : 'Last capture duration';
}

function renderDisplays() {
  if (!elements.screenSelect) {
    return;
  }

  var previousValue = elements.screenSelect.value;
  var savedValue = '';
  try {
    savedValue = localStorage.getItem(SELECTED_SCREEN_KEY) || '';
  } catch (_error) {
    savedValue = '';
  }
  var activeMonitorScreen = state.monitor && state.monitor.running && state.monitor.screenId
    ? String(state.monitor.screenId)
    : '';
  var pendingScreen = state.pendingScreenId ? String(state.pendingScreenId) : '';
  var activeScreen = previousValue || pendingScreen || savedValue || activeMonitorScreen || defaultDisplayId();
  elements.screenSelect.innerHTML = '';

  var placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose the interview monitor';
  placeholder.disabled = true;
  elements.screenSelect.appendChild(placeholder);

  if (!state.displays.length) {
    var option = document.createElement('option');
    option.textContent = 'No screens detected';
    option.value = '';
    option.disabled = true;
    elements.screenSelect.appendChild(option);
    elements.screenSelect.disabled = true;
    elements.screenSelect.value = '';
    renderMonitorMap();
    return;
  }

  state.displays.forEach(function (display) {
    var option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = displayOptionLabel(display);
    elements.screenSelect.appendChild(option);
  });

  elements.screenSelect.disabled = false;
  var hasMonitors = state.displays.length > 0;
  var requestedScreen = activeScreen && state.displays.some(function (display) { return String(display.id) === activeScreen; })
    ? activeScreen
    : null;
  if (requestedScreen) {
    elements.screenSelect.value = activeScreen;
    placeholder.hidden = true;
  } else {
    elements.screenSelect.value = '';
    placeholder.hidden = false;
  }

  if (state.monitor && state.monitor.running && state.monitor.screenId) {
    elements.screenSelect.disabled = !hasMonitors;
    placeholder.hidden = true;
  }
  try {
    localStorage.setItem(SELECTED_SCREEN_KEY, elements.screenSelect.value);
  } catch (_error) {
  }
  var selectedDisplay = displayById(elements.screenSelect.value);
  elements.screenSelect.title = selectedDisplay ? displayOptionLabel(selectedDisplay) : 'Choose the interview monitor';
  renderMonitorMap();
}

function renderMonitor() {
  var monitor = state.monitor;
  var switching = monitor && monitor.running && state.pendingScreenId && monitor.screenId !== state.pendingScreenId;
  if (switching) {
    elements.monitorStatus.textContent = 'Switching capture to ' + screenShortLabel(state.pendingScreenId) + '...';
    elements.stopMonitorButton.disabled = false;
    elements.startMonitorButton.disabled = true;
    updateElapsedTimer();
    renderDisplays();
    return;
  }

  if (monitor && monitor.running) {
    elements.monitorStatus.textContent = 'Monitoring ' + screenShortLabel(monitor.screenId) + '. Click New when the prompt changes.';
    elements.stopMonitorButton.disabled = false;
    elements.startMonitorButton.disabled = false;
  } else if (monitor && monitor.lastError) {
    elements.monitorStatus.textContent = 'Stopped: ' + monitor.lastError;
    elements.stopMonitorButton.disabled = true;
    elements.startMonitorButton.disabled = false;
  } else if (state.newQuestionPending) {
    elements.monitorStatus.textContent = 'Ready for a new question. Type, dictate, or choose a screen to capture.';
    elements.stopMonitorButton.disabled = true;
    elements.startMonitorButton.disabled = false;
  } else {
    elements.monitorStatus.textContent = elements.screenSelect.value
      ? 'Ready: click Capture to grab the selected screen'
      : 'Select a screen first';
    elements.stopMonitorButton.disabled = true;
    elements.startMonitorButton.disabled = false;
  }
  if (state.listening) {
    elements.monitorStatus.textContent = 'Dictating into the question text box...';
  }
  updateElapsedTimer();
  renderDisplays();
}

function renderRuns(runs) {
  return runs;
}

function renderRun(run) {
  if (!run) {
    state.currentRun = null;
    state.currentRunReady = false;
    state.currentRunHasAnswer = false;
    state.activeTurnId = null;
    elements.kindLabel.textContent = 'No run selected';
    elements.titleLabel.textContent = 'Waiting for a captured question';
    elements.readyLabel.textContent = 'Not ready';
    elements.completenessLabel.textContent = '0% captured';
    elements.questionBody.innerHTML = '<p class="empty">Capture a screen, listen, or type the question.</p>';
    renderTurnTabs(null);
    renderAnswerContent(null);
    elements.hintsView.innerHTML = '<p class="empty">Hints will appear when available.</p>';
    elements.hintsSection.classList.add('hidden');
    elements.screenshotWrap.classList.add('hidden');
    setScreenshotGallery(null);
    if (elements.answerButton) {
      elements.answerButton.disabled = true;
    }
    if (elements.captureButton) {
      var canCapture = resolveCaptureScreenId();
      elements.captureButton.disabled = state.capturing || !canCapture;
    }
    return;
  }

  var previousRun = state.currentRun;
  var previousAnswerMarkdown = previousRun && previousRun.id === run.id
    ? String(selectedAnswerMarkdown(previousRun) || '').trim()
    : '';

  if (!state.currentRun || state.currentRun.id !== run.id) {
    state.activeAnswerMode = 'firstTry';
    state.activeTurnId = latestTurnId(run);
  } else {
    var turns = runTurns(run);
    var hasActiveTurn = state.activeTurnId && turns.some(function (turn) { return turn.id === state.activeTurnId; });
    if (turns.length && !hasActiveTurn) {
      state.activeTurnId = latestTurnId(run);
      state.activeAnswerMode = 'firstTry';
    } else if (!turns.length) {
      state.activeTurnId = null;
    }
  }
  state.currentRun = run;
  state.currentRunReady = Boolean(run.readyToAnswer);
  state.currentRunHasAnswer = Boolean(run.hasAnswer);
  var nextAnswerMarkdown = String(selectedAnswerMarkdown(run) || '').trim();
  var answerJustFinished = Boolean(nextAnswerMarkdown) &&
    (!previousAnswerMarkdown || (state.answerRequestedRunId === run.id &&
      (!state.answerRequestedTurnId || state.answerRequestedTurnId === state.activeTurnId)));
  elements.kindLabel.textContent = run.kind;
  elements.titleLabel.textContent = run.title;
  elements.readyLabel.textContent = run.readyToAnswer ? 'Ready' : 'Capturing';
  elements.readyLabel.style.color = run.readyToAnswer ? 'var(--accent)' : 'var(--amber)';
  elements.completenessLabel.textContent = Math.round(run.completenessScore * 100) + '% captured';
  renderTurnTabs(run);
  elements.questionBody.innerHTML = renderMarkdown(questionMarkdown(run));
  renderAnswerContent(run);
  if (answerJustFinished) {
    state.answerRequestedRunId = null;
    state.answerRequestedTurnId = null;
    selectTab('answer');
    clearAnswerHash();
    scrollAnswerToTop();
  }

  renderHintsContent(run);

  setScreenshotGallery(run);

  if (elements.answerButton) {
    elements.answerButton.disabled = state.answering || state.capturing || !selectedTurnReadyForAnswer(run);
  }
  if (elements.captureButton) {
    elements.captureButton.disabled = state.capturing || !resolveCaptureScreenId();
  }
}

function setScreenshotGallery(run) {
  if (!elements.screenshotGallery || !elements.screenshotWrap || !elements.screenshotMeta) {
    return;
  }

  if (!run || !run.screenshotUrls || !run.screenshotUrls.length) {
    elements.screenshotGallery.innerHTML = '';
    elements.screenshotWrap.classList.add('hidden');
    elements.screenshotMeta.textContent = '';
    return;
  }

  var cacheToken = Date.now();
  var itemsHtml = '';
  var total = run.screenshotUrls.length;
  for (var i = 0; i < total; i++) {
    var url = run.screenshotUrls[i];
    var suffix = url.indexOf('?') >= 0 ? '&cache=' + cacheToken : '?cache=' + cacheToken;
    var label = 'Screenshot ' + (i + 1);
    itemsHtml += '<figure class="screenshot-item" role="listitem">';
    itemsHtml += '<figcaption>' + label + '</figcaption>';
    itemsHtml += '<img src="' + (url + suffix) + '" alt="' + label + '">';
    itemsHtml += '</figure>';
  }

  elements.screenshotGallery.innerHTML = itemsHtml;
  elements.screenshotWrap.classList.remove('hidden');
  elements.screenshotMeta.textContent = 'Captured ' + total + ' screenshot' + (total === 1 ? '' : 's');
}

function resolveCaptureScreenId() {
  if (state.monitor && state.monitor.running && state.monitor.screenId) {
    return state.monitor.screenId;
  }

  if (!elements.screenSelect && !state.displays.length) {
    return null;
  }

  var selectedScreenId = elements.screenSelect ? Number(elements.screenSelect.value) : NaN;
  if (Number.isFinite(selectedScreenId) && selectedScreenId > 0) {
    return selectedScreenId;
  }

  var fallbackScreenId = Number(defaultDisplayId());
  return Number.isFinite(fallbackScreenId) && fallbackScreenId > 0 ? fallbackScreenId : null;
}

function clearForNewCapture(screenId) {
  var hasScreen = Number.isFinite(Number(screenId)) && Number(screenId) > 0;
  state.currentRunId = null;
  state.currentRun = null;
  state.currentRunReady = false;
  state.currentRunHasAnswer = false;
  state.answerRequestedRunId = null;
  state.answerRequestedTurnId = null;
  state.activeTurnId = null;
  elements.kindLabel.textContent = 'New question';
  elements.titleLabel.textContent = 'Ready for a new question';
  elements.readyLabel.textContent = 'Waiting';
  elements.readyLabel.style.color = 'var(--muted)';
  elements.completenessLabel.textContent = '0% captured';
  elements.questionBody.innerHTML = hasScreen
    ? '<p class="empty">Click Capture when the prompt is visible on ' + escapeHtml(screenShortLabel(screenId)) + ', listen when the interviewer reads it aloud, or type it below.</p>'
    : '<p class="empty">Type or dictate the question below, or choose a screen and click Capture.</p>';
  renderTurnTabs(null);
  elements.answerView.innerHTML = '<p class="empty">Capture the new question before generating a solution.</p>';
  renderAnswerModeButtons(false);
  elements.hintsView.innerHTML = '<p class="empty">Hints will appear when available.</p>';
  elements.hintsSection.classList.add('hidden');
  elements.screenshotWrap.classList.add('hidden');
  setScreenshotGallery(null);
  if (elements.answerButton) {
    elements.answerButton.disabled = true;
  }
  if (elements.captureButton) {
    elements.captureButton.disabled = state.capturing || !resolveCaptureScreenId();
  }
}

async function fetchJson(url) {
  var response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}

async function postJson(url, body) {
  var response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!response.ok) {
    var errorText = await response.text();
    throw new Error(errorText || 'HTTP ' + response.status);
  }
  return response.json();
}

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function renderListenButton() {
  if (!elements.listenButton) {
    return;
  }
  elements.listenButton.textContent = state.listening ? 'Listening...' : 'Listen';
  elements.listenButton.classList.toggle('active', state.listening);
  elements.listenButton.setAttribute('aria-pressed', String(state.listening));
}

function renderQuestionInput() {
  if (!elements.questionInput || !elements.questionSubmitButton) {
    return;
  }

  var hasText = Boolean(String(elements.questionInput.value || '').trim());
  elements.questionSubmitButton.disabled = state.questionTextSubmitting || !hasText;
  elements.questionSubmitButton.textContent = state.questionTextSubmitting ? 'Sending...' : 'Send';
}

function appendQuestionInputText(text) {
  if (!elements.questionInput) {
    return;
  }

  var clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return;
  }

  var current = String(elements.questionInput.value || '').trimEnd();
  elements.questionInput.value = current ? current + ' ' + clean : clean;
  elements.questionInput.focus();
  elements.questionInput.setSelectionRange(elements.questionInput.value.length, elements.questionInput.value.length);
  renderQuestionInput();
}

function setListening(active) {
  state.listening = Boolean(active);
  renderListenButton();
}

function stopListening() {
  state.listening = false;
  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.stop();
    state.recognition = null;
  }
  renderListenButton();
}

async function postTranscript(text, source) {
  var clean = String(text || '').trim();
  if (!clean) {
    return;
  }

  var activeRunId = state.monitor && state.monitor.running && state.monitor.activeRunId ? state.monitor.activeRunId : null;
  var targetRunId = activeRunId || (state.newQuestionPending ? null : state.currentRunId);
  var isText = source === 'text' || source === 'manual';
  elements.monitorStatus.textContent = isText ? 'Sending question text...' : 'Processing voice transcript...';

  var detail = await postJson('/api/transcript', {
    text: clean,
    runId: targetRunId || undefined,
  });

  if (detail && detail.id) {
    state.currentRunId = detail.id;
    state.newQuestionPending = false;
    state.activeTurnId = latestTurnId(detail);
    state.activeAnswerMode = 'firstTry';
  }
  renderRun(detail);
  selectTab('question');
  elements.monitorStatus.textContent = detail && detail.readyToAnswer
    ? (isText ? 'Question text sent. Click Answer.' : 'Voice question is ready. Click Answer.')
    : (isText ? 'Question text sent.' : 'Captured voice transcript.');
}

function queueTranscript(text, source) {
  state.transcriptPost = state.transcriptPost
    .catch(function () {})
    .then(function () {
      return postTranscript(text, source);
    });
  return state.transcriptPost;
}

async function submitQuestionInput() {
  if (!elements.questionInput || state.questionTextSubmitting) {
    return;
  }

  var text = String(elements.questionInput.value || '').trim();
  if (!text) {
    renderQuestionInput();
    return;
  }

  state.questionTextSubmitting = true;
  renderQuestionInput();
  try {
    await queueTranscript(text, 'text');
    elements.questionInput.value = '';
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  } finally {
    state.questionTextSubmitting = false;
    renderQuestionInput();
  }
}

function startListening() {
  var Recognition = recognitionCtor();
  if (!Recognition) {
    elements.monitorStatus.textContent = 'Browser speech recognition is not available in this browser.';
    return;
  }

  stopListening();
  selectTab('question');
  if (elements.questionInput) {
    elements.questionInput.focus();
  }
  var recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = function (event) {
    var finalText = '';
    for (var index = event.resultIndex; index < event.results.length; index += 1) {
      var result = event.results[index];
      if (result.isFinal && result[0] && result[0].transcript) {
        finalText += result[0].transcript + ' ';
      }
    }

    if (finalText.trim()) {
      appendQuestionInputText(finalText);
      elements.monitorStatus.textContent = 'Dictating into the question text box...';
    }
  };

  recognition.onerror = function (event) {
    var message = event && event.error ? event.error : 'Speech recognition error';
    elements.monitorStatus.textContent = message;
    if (message === 'not-allowed' || message === 'service-not-allowed') {
      setListening(false);
    }
  };

  recognition.onend = function () {
    if (!state.listening) {
      return;
    }
    try {
      recognition.start();
    } catch (error) {
      setListening(false);
      elements.monitorStatus.textContent = error.message || String(error);
    }
  };

  state.recognition = recognition;
  setListening(true);
  try {
    recognition.start();
    elements.monitorStatus.textContent = 'Dictating into the question text box...';
  } catch (error) {
    setListening(false);
    state.recognition = null;
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

function toggleListening() {
  if (state.listening) {
    stopListening();
    elements.monitorStatus.textContent = 'Stopped listening.';
    return;
  }
  startListening();
}

async function loadMonitor() {
  var displaysData = await fetchJson('/api/displays');
  var monitorData = await fetchJson('/api/monitor/status');
  state.displays = displaysData.displays || [];
  state.monitor = monitorData;
  if (!monitorData || !monitorData.running || !monitorData.screenId || monitorData.screenId === state.pendingScreenId) {
    state.pendingScreenId = null;
  }
  renderMonitor();
}

async function startMonitor(screenId) {
  try {
    var selectedScreenId = Number(screenId || elements.screenSelect.value);
    if (!Number.isFinite(selectedScreenId) || selectedScreenId <= 0) {
      elements.monitorStatus.textContent = 'Choose a screen first.';
      if (elements.screenSelect.options.length) {
        elements.screenSelect.focus();
      }
      return;
    }
    try {
      localStorage.setItem(SELECTED_SCREEN_KEY, String(selectedScreenId));
    } catch (_error) {
    }
    state.pendingScreenId = selectedScreenId;
    state.newQuestionPending = false;
    clearForNewCapture(selectedScreenId);
    elements.monitorStatus.textContent = 'Starting new question capture on ' + screenShortLabel(selectedScreenId) + '...';
    state.monitor = await postJson('/api/monitor/start', { screenId: selectedScreenId });
    state.pendingScreenId = null;
    renderMonitor();
    loadSelectedRun();
  } catch (error) {
    state.pendingScreenId = null;
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function stopMonitor() {
  try {
    state.pendingScreenId = null;
    state.monitor = await postJson('/api/monitor/stop', {});
    renderMonitor();
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function requestAnswer() {
  if (!state.currentRunId || !selectedTurnReadyForAnswer(state.currentRun) || !elements.answerButton || state.answering || state.capturing) {
    return;
  }

  selectTab('answer');
  clearAnswerHash();
  scrollAnswerToTop();
  renderAnswerModeButtons(false);
  elements.answerView.innerHTML = '<p class="empty">Generating answer...</p>';
  state.answering = true;
  state.answerRequestedRunId = state.currentRunId;
  state.answerRequestedTurnId = state.activeTurnId;
  elements.answerButton.disabled = true;
  elements.answerButton.textContent = 'Generating answer...';
  elements.monitorStatus.textContent = 'Generating answer...';

  try {
    var url = '/api/runs/' + encodeURIComponent(state.currentRunId) + '/answer';
    await postJson(url, { turnId: state.activeTurnId || undefined });
  } catch (error) {
    state.answerRequestedRunId = null;
    state.answerRequestedTurnId = null;
    elements.monitorStatus.textContent = error.message || String(error);
  } finally {
    state.answering = false;
    if (elements.answerButton) {
      elements.answerButton.textContent = 'Answer (F)';
    }
    if (elements.captureButton) {
      elements.captureButton.disabled = state.capturing || !resolveCaptureScreenId();
    }
    if (state.currentRunId) {
      try {
        await loadSelectedRun();
      } catch (_error) {
      }
    }
  }
}

async function requestCapture() {
  if (!elements.captureButton || state.capturing) {
    return;
  }

  var selectedScreenId = resolveCaptureScreenId();
  if (!Number.isFinite(selectedScreenId) || selectedScreenId <= 0) {
    elements.monitorStatus.textContent = 'Choose a screen first.';
    if (elements.screenSelect && elements.screenSelect.value !== '') {
      elements.screenSelect.focus();
    }
    return;
  }

  state.capturing = true;
  elements.captureButton.disabled = true;
  if (elements.answerButton) {
    elements.answerButton.disabled = true;
  }
  elements.captureButton.textContent = 'Capturing...';

  try {
    var activeRunId = state.monitor && state.monitor.running && state.monitor.activeRunId ? state.monitor.activeRunId : null;
    var targetRunId = activeRunId || (state.newQuestionPending ? null : state.currentRunId);
    var targetUrl = targetRunId
      ? '/api/runs/' + encodeURIComponent(targetRunId) + '/capture'
      : '/api/capture';
    var detail = await postJson(targetUrl, { screenId: selectedScreenId, runId: targetRunId || undefined });
    if (detail && detail.id) {
      state.currentRunId = detail.id;
      state.newQuestionPending = false;
      state.activeTurnId = latestTurnId(detail);
      state.activeAnswerMode = 'firstTry';
    }
    renderRun(detail);
    if (detail && detail.id) {
      setScreenshotGallery(detail);
    }
    elements.monitorStatus.textContent = 'Captured screenshot.';
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  } finally {
    state.capturing = false;
    if (elements.captureButton) {
      elements.captureButton.textContent = 'Capture (C)';
      elements.captureButton.disabled = state.capturing || !resolveCaptureScreenId();
    }
    if (elements.answerButton) {
      elements.answerButton.disabled = state.answering || state.capturing || !selectedTurnReadyForAnswer(state.currentRun);
    }
  }
}

async function startNewQuestion(screenId) {
  try {
    var selectedScreenId = Number(screenId || elements.screenSelect.value);
    var hasScreen = Number.isFinite(selectedScreenId) && selectedScreenId > 0;
    if (hasScreen) {
      try {
        localStorage.setItem(SELECTED_SCREEN_KEY, String(selectedScreenId));
      } catch (_error) {
      }
    }

    state.pendingScreenId = hasScreen ? selectedScreenId : null;
    state.newQuestionPending = true;
    clearForNewCapture(hasScreen ? selectedScreenId : null);
    selectTab('question');
    elements.monitorStatus.textContent = hasScreen
      ? 'Ready for a new question. Click Capture when the prompt is visible.'
      : 'Ready for a new question. Type or dictate it below.';

    if (state.monitor && state.monitor.running) {
      state.monitor = await postJson('/api/monitor/stop', {});
    }

    state.pendingScreenId = null;
    renderMonitor();
  } catch (error) {
    state.pendingScreenId = null;
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function requestReset() {
  if (!state.currentRunId) {
    return;
  }

  try {
    var url = '/api/runs/' + encodeURIComponent(state.currentRunId) + '/reset';
    await postJson(url, {});
    await loadSelectedRun();
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function loadRuns() {
  var data = await fetchJson('/api/runs');
  var runs = data.runs || [];
  var activeRunId = state.monitor && state.monitor.running && state.monitor.activeRunId;
  var hasCurrentRun = state.currentRunId && runs.some(function (run) { return run.id === state.currentRunId; });
  var hasActiveRun = activeRunId && runs.some(function (run) { return run.id === activeRunId; });

  if (hasActiveRun) {
    state.newQuestionPending = false;
    state.currentRunId = activeRunId;
  } else if (state.newQuestionPending) {
    state.currentRunId = null;
  } else if (state.monitor && state.monitor.running) {
    state.currentRunId = null;
  } else if (!hasCurrentRun) {
    state.currentRunId = runs.length ? runs[0].id : null;
  }

  renderRuns(runs);
  return runs;
}

async function loadSelectedRun() {
  state.lastRefreshAt = Date.now();
  try {
    await loadMonitor();
    await loadRuns();
    if (!state.currentRunId) {
      if (state.newQuestionPending) {
        clearForNewCapture(resolveCaptureScreenId());
      } else {
        renderRun(null);
      }
      return;
    }
    var run = await fetchJson('/api/runs/' + encodeURIComponent(state.currentRunId));
    renderRun(run);
    updateElapsedTimer();
  } catch (error) {
    elements.monitorStatus.textContent = 'Disconnected';
    elements.answerView.innerHTML = '<p class="empty">UI server is not responding.</p>';
    elements.hintsView.innerHTML = '<p class="empty">UI server is not responding.</p>';
    updateElapsedTimer();
  }
}

function startTimer() {
  if (state.timer) {
    clearInterval(state.timer);
  }
  state.timer = setInterval(function () {
    updateElapsedTimer();
    if (Date.now() - state.lastRefreshAt >= 2000) {
      loadSelectedRun();
    }
  }, 1000);
}

function selectTab(tabName) {
  if (!elements.answerTab && !elements.questionTab && !elements.answerPanel && !elements.questionPanel) {
    return;
  }

  var answerActive = tabName === 'answer';
  state.activeTab = answerActive ? 'answer' : 'question';

  if (elements.answerTab) {
    elements.answerTab.classList.toggle('active', answerActive);
    elements.answerTab.setAttribute('aria-selected', String(answerActive));
  }
  if (elements.questionTab) {
    elements.questionTab.classList.toggle('active', !answerActive);
    elements.questionTab.setAttribute('aria-selected', String(!answerActive));
  }
  if (elements.answerPanel) {
    elements.answerPanel.classList.toggle('hidden', !answerActive);
  }
  if (elements.questionPanel) {
    elements.questionPanel.classList.toggle('hidden', answerActive);
  }
}

function hotkeysBlocked(event) {
  var target = event && event.target;
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  var tagName = target.tagName ? String(target.tagName).toLowerCase() : '';
  return tagName === 'input' || tagName === 'textarea';
}

function toggleOverlay(forceOpen) {
  var nextOpen = typeof forceOpen === 'boolean'
    ? forceOpen
    : elements.overlayPanel.classList.contains('hidden');
  state.overlayOpen = nextOpen;
  elements.overlayPanel.classList.toggle('hidden', !nextOpen);
  elements.overlayToggle.setAttribute('aria-expanded', String(nextOpen));
}

function boot() {
  ['lastUpdated', 'monitorStatus', 'startMonitorButton',
    'stopMonitorButton', 'screenSelect', 'kindLabel', 'titleLabel', 'completenessLabel', 'readyLabel',
    'questionBody', 'screenshotWrap', 'screenshotGallery', 'answerView', 'hintsSection', 'hintsView',
    'screenshotMeta', 'questionInputForm', 'questionInput', 'questionSubmitButton',
    'answerTab', 'questionTab', 'answerPanel', 'questionPanel',
    'answerTurnTabs', 'questionTurnTabs', 'answerModeTabs', 'firstTryAnswerTab', 'robustAnswerTab',
    'monitorMap',
    'captureButton', 'listenButton',
    'overlayToggle', 'overlayPanel', 'answerButton'].forEach(function (id) {
    elements[id] = byId(id);
  });

  if (!elements.lastUpdated || !elements.screenSelect || !elements.startMonitorButton
    || !elements.stopMonitorButton || !elements.overlayToggle || !elements.overlayPanel || !elements.answerButton
    || !elements.captureButton || !elements.listenButton || !elements.monitorStatus || !elements.answerView || !elements.hintsView
    || !elements.answerModeTabs || !elements.firstTryAnswerTab || !elements.robustAnswerTab
    || !elements.answerTurnTabs || !elements.questionTurnTabs
    || !elements.questionInputForm || !elements.questionInput || !elements.questionSubmitButton) {
    return;
  }

  elements.screenSelect.addEventListener('change', function () {
    try {
      localStorage.setItem(SELECTED_SCREEN_KEY, elements.screenSelect.value);
    } catch (_error) {
    }

    var selectedScreenId = Number(elements.screenSelect.value);
    if (!Number.isFinite(selectedScreenId) || selectedScreenId <= 0) {
      elements.monitorStatus.textContent = 'Select a valid interview screen.';
      return;
    }

    if (state.monitor && state.monitor.running && state.monitor.screenId !== selectedScreenId) {
      elements.monitorStatus.textContent = 'Switching capture to ' + screenShortLabel(selectedScreenId) + '...';
      startMonitor(selectedScreenId);
    } else {
      renderMonitor();
    }
  });
  elements.startMonitorButton.addEventListener('click', function () { startNewQuestion(); });
  elements.stopMonitorButton.addEventListener('click', stopMonitor);
  elements.answerButton.addEventListener('click', requestAnswer);
  elements.captureButton.addEventListener('click', requestCapture);
  elements.listenButton.addEventListener('click', toggleListening);
  elements.questionInput.addEventListener('input', renderQuestionInput);
  elements.questionInput.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitQuestionInput();
    }
  });
  elements.questionInputForm.addEventListener('submit', function (event) {
    event.preventDefault();
    submitQuestionInput();
  });
  if (elements.answerTab) {
    elements.answerTab.addEventListener('click', function () { selectTab('answer'); });
  }
  if (elements.questionTab) {
    elements.questionTab.addEventListener('click', function () { selectTab('question'); });
  }
  elements.firstTryAnswerTab.addEventListener('click', function () { selectAnswerMode('firstTry'); });
  elements.robustAnswerTab.addEventListener('click', function () { selectAnswerMode('robust'); });
  elements.overlayToggle.addEventListener('click', toggleOverlay);
  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (hotkeysBlocked(event)) {
      return;
    }

    var key = String(event.key || '').toLowerCase();
    if (event.key === 'Escape') {
      toggleOverlay(false);
      return;
    }

    if (/^[1-9]$/.test(key)) {
      if (selectMonitorByIndex(Number(key) - 1)) {
        event.preventDefault();
      }
      return;
    }

    if (key === 'a') {
      event.preventDefault();
      selectTab('answer');
      return;
    }
    if (key === 'q') {
      event.preventDefault();
      selectTab('question');
      return;
    }
    if (key === 'w') {
      event.preventDefault();
      selectAnswerMode('firstTry');
      return;
    }
    if (key === 'e') {
      event.preventDefault();
      selectAnswerMode('robust');
      return;
    }
    if (key === 'f') {
      event.preventDefault();
      requestAnswer();
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      requestCapture();
      return;
    }
    if (key === 'l') {
      event.preventDefault();
      toggleListening();
      return;
    }
    if (key === 'n') {
      event.preventDefault();
      startNewQuestion();
      return;
    }
    if (key === 's') {
      event.preventDefault();
      stopMonitor();
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      loadSelectedRun();
    }
  });
  loadSelectedRun().then(function () {
  if (elements.screenSelect && elements.screenSelect.value === '') {
      toggleOverlay(true);
    }
  });
  renderQuestionInput();
  startTimer();
  if (elements.answerTab || elements.questionTab || elements.answerPanel || elements.questionPanel) {
    selectTab('answer');
  }
}

boot();`;

function pageHtml(): string {
  return HTML.replace("__CSS__", CSS).replace("__JS__", JS);
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  sendText(res, statusCode, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..");
}

function makeMonitorSpawnArgs(
  outDir: string,
  screenId: number,
  language: string,
  intervalMs: number,
  profilePath?: string | null,
  handoff?: AnswerHandoff,
): string[] {
  const intervalSeconds = Math.max(1, Math.round(intervalMs / 1000));
  const args = [
    "run",
    "watch",
    "--",
    "--screen",
    String(screenId),
    "--language",
    language,
    "--manual",
    "--out",
    outDir,
    "--interval",
    String(intervalSeconds),
    "--keep-all-screens",
  ];

  if (profilePath) {
    args.push("--profile", path.resolve(profilePath));
  }
  args.push("--handoff", handoff ?? "codex");

  return args;
}

function stopMonitorTree(pid: number): void {
  const taskkill = spawn("cmd", ["/c", "taskkill", "/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  taskkill.unref();
}

function runIdFromMonitorLog(line: string): string | null {
  const match = line.match(/^Run directory:\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const runId = match[1].trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  return /^[a-zA-Z0-9._-]+$/.test(runId) ? runId : null;
}

function appendMonitorLog(monitor: MonitorProcess, chunk: Buffer): void {
  const lines = chunk
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const runId = runIdFromMonitorLog(line);
    if (runId) {
      monitor.activeRunId = runId;
    }
  }

  monitor.log.push(...lines);
  if (monitor.log.length > 120) {
    monitor.log.splice(0, monitor.log.length - 120);
  }
}

function monitorStatus(monitor: MonitorProcess | null): MonitorStatus {
  return {
    running: Boolean(monitor && monitor.exitCode === null),
    screenId: monitor?.screenId ?? null,
    activeRunId: monitor?.activeRunId ?? null,
    pid: monitor?.child.pid ?? null,
    startedAt: monitor?.startedAt ?? null,
    stoppedAt: monitor?.stoppedAt ?? null,
    exitCode: monitor?.exitCode ?? null,
    lastError: monitor?.lastError ?? null,
    log: monitor?.log ?? [],
  };
}

function stopMonitorProcess(monitor: MonitorProcess | null): void {
  if (!monitor || monitor.exitCode !== null) {
    return;
  }

  monitor.stoppedAt = new Date().toISOString();
  monitor.lastError = null;
  monitor.exitCode = 0;
  if (process.platform === "win32" && monitor.child.pid) {
    stopMonitorTree(monitor.child.pid);
    return;
  }

  monitor.child.kill();
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  const text = await readOptionalText(filePath);
  if (!text) {
    return null;
  }

  return JSON.parse(text) as T;
}

async function clearRunState(runDir: string): Promise<void> {
  const state = createEmptyState();
  state.lastUpdatedAt = new Date().toISOString();
  await writeFile(path.join(runDir, "question-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await clearAnswerArtifacts(runDir);
  await rm(path.join(runDir, "turns.json"), { force: true }).catch(() => undefined);
}

async function clearAnswerArtifacts(runDir: string): Promise<void> {
  await Promise.all([
    rm(path.join(runDir, "answer.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "hints.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "agent-prompt.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "question.txt"), { force: true }).catch(() => undefined),
  ]);
}

async function writeQuestionState(runDir: string, state: QuestionState): Promise<void> {
  await writeFile(path.join(runDir, "question-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function markdownFromQuestionState(state: QuestionState | null): string {
  if (!state?.question) {
    return "";
  }

  const question = state.question;
  const parts: string[] = [];
  if (question.prompt) {
    parts.push(`## Prompt\n\n${question.prompt}`);
  }
  if (question.inputOutput) {
    parts.push(`## Input / Output\n\n${question.inputOutput}`);
  }
  if (question.examples.length) {
    parts.push(`## Examples\n\n${question.examples.map((item) => `- ${item}`).join("\n")}`);
  }
  if (question.constraints.length) {
    parts.push(`## Constraints\n\n${question.constraints.map((item) => `- ${item}`).join("\n")}`);
  }
  if (question.functionSignature) {
    parts.push(`## Signature\n\n\`${question.functionSignature}\``);
  }
  if (question.notes.length) {
    parts.push(`## Notes\n\n${question.notes.map((item) => `- ${item}`).join("\n")}`);
  }
  if (state.transcriptText) {
    parts.push(`## Transcript\n\n${state.transcriptText}`);
  }
  return parts.join("\n\n");
}

function makeTurnId(index: number): string {
  return index === 0 ? "original" : `followup-${index}`;
}

function makeTurnTitle(index: number): string {
  return index === 0 ? "Original" : `Follow-up ${index}`;
}

function turnDetail(turn: RunTurnArtifact): RunTurnDetail {
  return {
    id: turn.id,
    kind: turn.kind,
    title: turn.title,
    questionMarkdown: turn.questionMarkdown,
    answerMarkdown: turn.answerMarkdown,
    hintsMarkdown: turn.hintsMarkdown,
    hasAnswer: Boolean(turn.answerMarkdown.trim()),
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

async function readTurnArtifacts(runDir: string): Promise<RunTurnArtifact[]> {
  const turns = await readOptionalJson<RunTurnArtifact[]>(path.join(runDir, "turns.json"));
  if (!Array.isArray(turns)) {
    return [];
  }

  return turns
    .filter((turn) => turn && typeof turn.id === "string")
    .map((turn, index) => {
      const now = new Date().toISOString();
      return {
        id: turn.id || makeTurnId(index),
        kind: turn.kind === "followup" ? "followup" : "original",
        title: turn.title || makeTurnTitle(index),
        questionMarkdown: typeof turn.questionMarkdown === "string" ? turn.questionMarkdown : "",
        answerMarkdown: typeof turn.answerMarkdown === "string" ? turn.answerMarkdown : "",
        hintsMarkdown: typeof turn.hintsMarkdown === "string" ? turn.hintsMarkdown : "",
        hasAnswer: Boolean(turn.answerMarkdown?.trim()),
        createdAt: turn.createdAt || now,
        updatedAt: turn.updatedAt || turn.createdAt || now,
        state: turn.state ?? null,
      };
    });
}

async function writeTurnArtifacts(runDir: string, turns: RunTurnArtifact[]): Promise<void> {
  await writeFile(path.join(runDir, "turns.json"), `${JSON.stringify(turns, null, 2)}\n`, "utf8");
}

async function ensureOriginalTurn(runDir: string, state: QuestionState | null): Promise<RunTurnArtifact[]> {
  const turns = await readTurnArtifacts(runDir);
  if (turns.length) {
    return turns;
  }

  const answerMarkdown = (await readOptionalText(path.join(runDir, "answer.md")))?.trim() ?? "";
  const hintsMarkdown = (await readOptionalText(path.join(runDir, "hints.md")))?.trim() ?? "";
  if (!state && !answerMarkdown) {
    return [];
  }

  const now = new Date().toISOString();
  const original: RunTurnArtifact = {
    id: "original",
    kind: "original",
    title: "Original",
    questionMarkdown: markdownFromQuestionState(state),
    answerMarkdown,
    hintsMarkdown,
    hasAnswer: Boolean(answerMarkdown),
    createdAt: state?.lastUpdatedAt ?? now,
    updatedAt: now,
    state,
  };
  await writeTurnArtifacts(runDir, [original]);
  return [original];
}

function followUpQuestionMarkdown(text: string): string {
  const clean = text.trim();
  return clean ? `## Follow-up\n\n${clean}` : "## Follow-up\n\nAdditional context captured.";
}

async function recordFollowUpTurn(
  runDir: string,
  previousState: QuestionState,
  nextState: QuestionState,
  questionText: string,
): Promise<void> {
  const turns = await ensureOriginalTurn(runDir, previousState);
  if (!turns.length || !turns.some((turn) => turn.answerMarkdown.trim())) {
    return;
  }

  const now = new Date().toISOString();
  const latest = turns.at(-1);
  const nextQuestionMarkdown = followUpQuestionMarkdown(questionText);
  if (latest && latest.kind === "followup" && !latest.answerMarkdown.trim()) {
    latest.questionMarkdown = latest.questionMarkdown.trim()
      ? `${latest.questionMarkdown.trim()}\n\n${nextQuestionMarkdown}`
      : nextQuestionMarkdown;
    latest.updatedAt = now;
    latest.state = nextState;
    await writeTurnArtifacts(runDir, turns);
    return;
  }

  const index = turns.length;
  turns.push({
    id: makeTurnId(index),
    kind: "followup",
    title: makeTurnTitle(index),
    questionMarkdown: nextQuestionMarkdown,
    answerMarkdown: "",
    hintsMarkdown: "",
    hasAnswer: false,
    createdAt: now,
    updatedAt: now,
    state: nextState,
  });
  await writeTurnArtifacts(runDir, turns);
}

async function writeTranscriptChunk(runDir: string, transcript: string, index: number): Promise<string> {
  const transcriptDir = path.join(runDir, "transcripts");
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `chunk-${String(index).padStart(3, "0")}.txt`);
  await writeFile(transcriptPath, `${transcript.trim()}\n`, "utf8");
  return transcriptPath;
}

async function addTranscriptToRun(
  outDir: string,
  runId: string,
  transcript: string,
): Promise<RunDetail> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Invalid run id.");
  }

  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) {
    throw new Error("Transcript text is required.");
  }

  await mkdir(runPath, { recursive: true });
  const statePath = path.join(runPath, "question-state.json");
  const currentState = await readOptionalJson<QuestionState>(statePath);
  const normalizedState = currentState ?? (() => {
    const created = createEmptyState();
    created.lastUpdatedAt = new Date().toISOString();
    return created;
  })();
  const transcriptPath = await writeTranscriptChunk(
    runPath,
    cleanTranscript,
    (normalizedState.transcriptPaths?.length ?? 0) + 1,
  );
  const observation = observeTranscriptLocally(normalizedState, cleanTranscript);
  const nextState = mergeObservation(normalizedState, observation, {
    kind: "transcript",
    path: transcriptPath,
    transcriptText: cleanTranscript,
  });

  await writeQuestionState(runPath, nextState);
  await recordFollowUpTurn(runPath, normalizedState, nextState, cleanTranscript);

  const detail = await readRunDetail(outDir, runId);
  if (!detail) {
    throw new Error("Failed to read transcript artifacts.");
  }
  return detail;
}

async function captureScreenshotForRun(
  outDir: string,
  runId: string,
  screenId: number,
): Promise<RunDetail> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Invalid run id.");
  }

  const displays = await listDisplays();
  const screen = displays.find((item) => item.id === screenId);
  if (!screen) {
    throw new Error(`Screen ${screenId} was not found.`);
  }

  await mkdir(runPath, { recursive: true });
  const statePath = path.join(runPath, "question-state.json");
  const currentState = await readOptionalJson<QuestionState>(statePath);
  const normalizedState = currentState ?? (() => {
    const created = createEmptyState();
    created.lastUpdatedAt = new Date().toISOString();
    return created;
  })();

  const screenshotPath = await captureScreen(
    runPath,
    {
      x: screen.x,
      y: screen.y,
      width: screen.width,
      height: screen.height,
    },
  );

  const observation = observeScreenshotLocally(normalizedState, screenshotPath);
  const nextState = mergeObservation(normalizedState, observation, {
    kind: "screenshot",
    path: screenshotPath,
  });

  await writeQuestionState(runPath, nextState);
  await recordFollowUpTurn(
    runPath,
    normalizedState,
    nextState,
    `Screenshot ${(normalizedState.screenshotPaths?.length ?? 0) + 1} captured. See the screenshot gallery for the follow-up prompt.`,
  );

  const detail = await readRunDetail(outDir, runId);
  if (!detail) {
    throw new Error("Failed to read answer artifacts.");
  }
  return detail;
}

function normalizeCaptureRunId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const runId = value.trim();
  return runId.length > 0 && /^[a-zA-Z0-9._-]+$/.test(runId) ? runId : null;
}

function withinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRunPath(outDir: string, runId: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    return null;
  }

  const root = path.resolve(outDir);
  const runPath = path.resolve(root, runId);
  return withinPath(root, runPath) ? runPath : null;
}

async function readCandidateProfile(profilePath: string | null): Promise<string | null> {
  if (!profilePath) {
    return null;
  }

  try {
    const profile = await readFile(path.resolve(profilePath), "utf8");
    const trimmed = profile.trim();
    return trimmed.length ? trimmed : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeUiAnswerArtifacts(
  runDir: string,
  answer: string,
): Promise<{ answerPath: string; hintsPath: string }> {
  const answerPath = path.join(runDir, "answer.md");
  const hintsPath = path.join(runDir, "hints.md");
  const hints = extractMarkdownSection(answer, "Hints") ?? "## Hints\n\nNo separate hints were generated.";
  await writeFile(answerPath, `${answer.trim()}\n`, "utf8");
  await writeFile(hintsPath, `${hints.trim()}\n`, "utf8");
  return { answerPath, hintsPath };
}

async function writeUiFallbackArtifacts(runDir: string, answer: string): Promise<void> {
  const answerPath = path.join(runDir, "answer.md");
  const hintsPath = path.join(runDir, "hints.md");
  const trimmed = answer.trim();
  await writeFile(answerPath, `${trimmed}\n`, "utf8");
  await writeFile(hintsPath, "## Hints\n\nNo separate hints were generated.\n", "utf8");
}

function buildTurnAnswerPrompt(basePrompt: string, turn: RunTurnArtifact): string {
  if (turn.kind !== "followup") {
    return basePrompt;
  }

  return [
    basePrompt,
    "",
    "Current follow-up turn:",
    turn.questionMarkdown.trim() || "Follow-up context was captured, but no separate text was available.",
    "",
    "Answer this follow-up directly while preserving the original question and answer as context. Do not rewrite the original answer unless the follow-up asks for a correction.",
  ].join("\n");
}

async function saveAnswerForTurn(
  runDir: string,
  turns: RunTurnArtifact[],
  turnIndex: number,
  answer: string,
  fallback = false,
): Promise<void> {
  const trimmed = answer.trim();
  const hints = fallback
    ? "## Hints\n\nNo separate hints were generated."
    : extractMarkdownSection(trimmed, "Hints") ?? "## Hints\n\nNo separate hints were generated.";
  const now = new Date().toISOString();
  turns[turnIndex] = {
    ...turns[turnIndex],
    answerMarkdown: trimmed,
    hintsMarkdown: hints.trim(),
    hasAnswer: Boolean(trimmed),
    updatedAt: now,
  };
  await writeTurnArtifacts(runDir, turns);
  if (turns[turnIndex].kind !== "original") {
    return;
  }
  if (fallback) {
    await writeUiFallbackArtifacts(runDir, trimmed);
  } else {
    await writeUiAnswerArtifacts(runDir, trimmed);
  }
}

async function answerRun(
  outDir: string,
  runId: string,
  language: string,
  handoff: AnswerHandoff,
  profilePath: string | null,
  requestedTurnId: string | null = null,
): Promise<void> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Run not found.");
  }

  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  if (!state) {
    throw new Error("Question state is missing.");
  }
  let turns = await ensureOriginalTurn(runPath, state);
  if (!turns.length) {
    throw new Error("Question state is missing.");
  }

  let turnIndex = requestedTurnId ? turns.findIndex((turn) => turn.id === requestedTurnId) : -1;
  if (turnIndex < 0) {
    const pendingIndex = turns.findIndex((turn) => !turn.answerMarkdown.trim());
    turnIndex = pendingIndex >= 0 ? pendingIndex : turns.length - 1;
  }

  const targetTurn = turns[turnIndex];
  const answerState = targetTurn.state ?? state;
  const baseAnswerPrompt = buildAnswerPrompt(
    answerState,
    language,
    await readCandidateProfile(profilePath),
    answerState.screenshotPaths ?? [],
  );
  const answerPrompt = buildTurnAnswerPrompt(baseAnswerPrompt, targetTurn);
  const promptPath = path.join(runPath, "agent-prompt.md");
  const questionPath = path.join(runPath, "question.txt");
  await writeFile(promptPath, `${answerPrompt.trim()}\n`, "utf8");
  await writeFile(questionPath, `${targetTurn.questionMarkdown.trim() || answerState.question.prompt?.trim() || ""}\n`, "utf8");

  const repoRoot = path.resolve(packageRoot(), "..");

  if (handoff === "codex") {
    const agentResult = await askCodexCliAgent(repoRoot, promptPath, runPath, answerState.screenshotPaths ?? []);
    if (agentResult.answered) {
      await saveAnswerForTurn(runPath, turns, turnIndex, agentResult.answer);
      return;
    }

    const fallback = [
      "## Agent Handoff Ready",
      "",
      "Codex CLI did not return an answer in time, so the prompt is ready to paste manually.",
      "",
      `Prompt file: ${promptPath}`,
      "",
      agentResult.error ? `Codex error: ${agentResult.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await saveAnswerForTurn(runPath, turns, turnIndex, fallback, true);
    return;
  }

  if (handoff === "openclaw") {
    const agentResult = await askOpenClawAgent(repoRoot, promptPath);
    if (agentResult.answered) {
      await saveAnswerForTurn(runPath, turns, turnIndex, agentResult.answer);
      return;
    }

    const fallback = [
      "## Agent Handoff Ready",
      "",
      "OpenClaw did not return an answer from the CLI call, so the prompt is ready to paste manually.",
      "",
      `Prompt file: ${promptPath}`,
      "",
      agentResult.error ? `OpenClaw error: ${agentResult.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await saveAnswerForTurn(runPath, turns, turnIndex, fallback, true);
    return;
  }

  const fallback = [
    "## Prompt Ready",
    "",
    "The prompt is ready to paste into Codex, ChatGPT, or OpenClaw.",
    "",
    `Prompt file: ${promptPath}`,
  ].join("\n");
  await saveAnswerForTurn(runPath, turns, turnIndex, fallback, true);
}

function runTitle(state: QuestionState | null, runId: string): string {
  return state?.question.title ?? state?.question.prompt?.slice(0, 80) ?? runId;
}

function runKind(state: QuestionState | null): string {
  return state?.question.kind ?? "question";
}

async function optionalMtime(filePath: string): Promise<string | null> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function summarizeRun(outDir: string, runId: string): Promise<RunSummary | null> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    return null;
  }

  const answerPath = path.join(runPath, "answer.md");
  const hintsPath = path.join(runPath, "hints.md");
  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  const answer = await readOptionalText(answerPath);
  const hints = await readOptionalText(hintsPath);
  const turns = await readTurnArtifacts(runPath);
  const hasTurnAnswer = turns.some((turn) => turn.answerMarkdown.trim());
  const runStat = await stat(runPath);
  const updatedAt = [
    runStat.mtime.toISOString(),
    state?.lastUpdatedAt ?? null,
    await optionalMtime(answerPath),
    await optionalMtime(hintsPath),
    await optionalMtime(path.join(runPath, "turns.json")),
  ]
    .filter((item): item is string => Boolean(item))
    .sort()
    .at(-1) ?? runStat.mtime.toISOString();

  return {
    id: runId,
    updatedAt,
    title: runTitle(state, runId),
    kind: runKind(state),
    completenessScore: state?.completenessScore ?? 0,
    readyToAnswer: state?.readyToAnswer ?? false,
    hasAnswer: Boolean(answer?.trim()) || hasTurnAnswer,
    hasHints: Boolean(hints?.trim()) || turns.some((turn) => turn.hintsMarkdown.trim()),
  };
}

async function readRunDetail(outDir: string, runId: string): Promise<RunDetail | null> {
  const summary = await summarizeRun(outDir, runId);
  const runPath = resolveRunPath(outDir, runId);
  if (!summary || !runPath) {
    return null;
  }

  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  const answer = (await readOptionalText(path.join(runPath, "answer.md")))?.trim() ?? "";
  const hints = (await readOptionalText(path.join(runPath, "hints.md")))?.trim() ?? "";
  const storedTurns = await readTurnArtifacts(runPath);
  const turns = storedTurns.length
    ? storedTurns
    : answer
      ? await ensureOriginalTurn(runPath, state)
      : [];
  const screenshotFiles = await listScreenshotFiles(outDir, runId);
  const latestScreenshotFile = screenshotFiles.at(-1)?.path ?? null;
  const latestScreenshot = latestScreenshotFile
    ? `/api/runs/${encodeURIComponent(runId)}/latest-screen?updated=${encodeURIComponent(summary.updatedAt ?? "")}`
    : null;
  const screenshotUrls = screenshotFiles.map(
    (item, index) => `/api/runs/${encodeURIComponent(runId)}/screens/${index}?updated=${encodeURIComponent(item.updatedAt.toString())}`,
  );

  return {
    ...summary,
    state,
    answerMarkdown: answer,
    hintsMarkdown: hints,
    turns: turns.map(turnDetail),
    latestScreenshotUrl: latestScreenshot,
    screenshotUrls,
    screenshotCount: screenshotFiles.length,
  };
}

async function listRuns(outDir: string): Promise<RunSummary[]> {
  await mkdir(outDir, { recursive: true });
  const entries = await readdir(outDir, { withFileTypes: true });
  const summaries = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => summarizeRun(outDir, entry.name)),
  );

  return summaries
    .filter((item): item is RunSummary => item !== null)
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

async function listScreenshotFiles(outDir: string, runId: string): Promise<ScreenshotRecord[]> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    return [];
  }

  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  const orderedPaths: string[] = [];
  const seen = new Set<string>();

  if (state?.screenshotPaths && state.screenshotPaths.length > 0) {
    for (const item of state.screenshotPaths) {
      if (!item) {
        continue;
      }
      const absolutePath = path.isAbsolute(item) ? path.resolve(item) : path.resolve(runPath, item);
      if (!withinPath(runPath, absolutePath) || seen.has(absolutePath)) {
        continue;
      }
      orderedPaths.push(absolutePath);
      seen.add(absolutePath);
    }
  }

  const screensDir = path.join(runPath, "screens");
  const dirFiles = await listScreenshotFilesInDir(screensDir);
  for (const file of dirFiles) {
    if (!seen.has(file.path)) {
      orderedPaths.push(file.path);
      seen.add(file.path);
    }
  }

  const results: ScreenshotRecord[] = [];
  for (const candidatePath of orderedPaths) {
    const updatedAt = await fileUpdatedAtMs(candidatePath);
    if (updatedAt === null) {
      continue;
    }
    results.push({ path: candidatePath, updatedAt });
  }

  return results;
}

async function screenshotPathAtIndex(outDir: string, runId: string, index: number): Promise<string | null> {
  if (!Number.isFinite(index) || index < 0) {
    return null;
  }

  const screenshots = await listScreenshotFiles(outDir, runId);
  const target = screenshots[index];
  if (!target) {
    return null;
  }

  return target.path;
}

async function latestScreenshotPath(outDir: string, runId: string): Promise<string | null> {
  const screenshots = await listScreenshotFiles(outDir, runId);
  return screenshots.at(-1)?.path ?? null;
}

async function listScreenshotFilesInDir(dirPath: string): Promise<ScreenshotRecord[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
      .map((entry) => path.join(dirPath, entry.name));

    const records: ScreenshotRecord[] = [];
    for (const filePath of files) {
      const updatedAt = await fileUpdatedAtMs(filePath);
      if (updatedAt === null) {
        continue;
      }
      records.push({ path: filePath, updatedAt });
    }

    return records.sort((left, right) => left.updatedAt - right.updatedAt);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function fileUpdatedAtMs(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function serveScreenshot(res: ServerResponse, filePath: string): void {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function createMonitorController(options: UiServerOptions, outDir: string): {
  status: () => MonitorStatus;
  start: (screenId: number) => Promise<MonitorStatus>;
  stop: () => MonitorStatus;
  close: () => void;
} {
  let monitor: MonitorProcess | null = null;

  return {
    status: () => monitorStatus(monitor),
    start: async (screenId: number) => {
      const displays = await listDisplays();
      const display = displays.find((item) => item.id === screenId);
      if (!display) {
        throw new Error(`Screen ${screenId} was not found.`);
      }

      stopMonitorProcess(monitor);

      const spawnArgs = makeMonitorSpawnArgs(
        outDir,
        display.id,
        options.language ?? "python",
        options.intervalMs ?? 8000,
        options.profilePath,
        options.handoff,
      );
      const child = spawn("npm", spawnArgs, {
        cwd: packageRoot(),
        env: process.env,
        windowsHide: true,
        shell: process.platform === "win32",
      });

      monitor = {
        child,
        screenId: display.id,
        activeRunId: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        exitCode: null,
        lastError: null,
        log: [],
      };
      const activeMonitor = monitor;

      child.stdout.on("data", (chunk: Buffer) => {
        if (monitor === activeMonitor) {
          appendMonitorLog(activeMonitor, chunk);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (monitor === activeMonitor) {
          appendMonitorLog(activeMonitor, chunk);
        }
      });

      child.on("error", (error) => {
        if (monitor !== activeMonitor) {
          return;
        }
        activeMonitor.lastError = error.message;
        activeMonitor.stoppedAt = new Date().toISOString();
        activeMonitor.exitCode = -1;
      });

      child.on("close", (code) => {
        if (monitor !== activeMonitor) {
          return;
        }
        if (activeMonitor.exitCode !== null) {
          return;
        }
        activeMonitor.exitCode = code ?? 0;
        activeMonitor.stoppedAt = new Date().toISOString();
        if (code && code !== 0) {
          activeMonitor.lastError = `Watcher exited with code ${code}.`;
        }
      });

      return monitorStatus(monitor);
    },
    stop: () => {
      stopMonitorProcess(monitor);
      return monitorStatus(monitor);
    },
    close: () => {
      stopMonitorProcess(monitor);
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  outDir: string,
  monitorController: ReturnType<typeof createMonitorController>,
  options: UiServerOptions,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;

  if (pathname === "/") {
    sendText(res, 200, pageHtml(), "text/html; charset=utf-8");
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (pathname === "/api/runs") {
    sendJson(res, 200, { runs: await listRuns(outDir) });
    return;
  }

  if (pathname === "/api/displays") {
    sendJson(res, 200, { displays: await listDisplays() });
    return;
  }

  if (pathname === "/api/monitor/status") {
    sendJson(res, 200, monitorController.status());
    return;
  }

  if (pathname === "/api/monitor/start" && req.method === "POST") {
    const body = await readRequestJson(req);
    const screenId = Number(body.screenId);
    if (!Number.isInteger(screenId) || screenId <= 0) {
      sendJson(res, 400, { error: "screenId must be a positive integer." });
      return;
    }

    sendJson(res, 200, await monitorController.start(screenId));
    return;
  }

  if (pathname === "/api/monitor/stop" && req.method === "POST") {
    sendJson(res, 200, monitorController.stop());
    return;
  }

  const resetRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/reset$/);
  if (resetRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(resetRunMatch[1]);
    const runPath = resolveRunPath(outDir, runId);
    if (!runPath) {
      sendJson(res, 400, { error: "Invalid run id." });
      return;
    }

    const statePath = path.join(runPath, "question-state.json");
    const currentState = await readOptionalJson<QuestionState>(statePath);
    if (!currentState) {
      sendJson(res, 404, { error: "Run not found." });
      return;
    }
    await clearRunState(runPath);
    const detail = await readRunDetail(outDir, runId);
    if (!detail) {
      sendJson(res, 500, { error: "Failed to read answer artifacts." });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  const captureRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/capture$/);
  if (captureRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(captureRunMatch[1]);
    const body = await readRequestJson(req);
    const screenId = Number(body.screenId);
    if (!Number.isInteger(screenId) || screenId <= 0) {
      sendJson(res, 400, { error: "screenId must be a positive integer." });
      return;
    }

    const detail = await captureScreenshotForRun(outDir, runId, screenId);
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === "/api/capture" && req.method === "POST") {
    const body = await readRequestJson(req);
    const requestedRunId = normalizeCaptureRunId(body.runId);
    const runId = requestedRunId ?? makeRunId();
    const screenId = Number(body.screenId);
    if (!Number.isInteger(screenId) || screenId <= 0) {
      sendJson(res, 400, { error: "screenId must be a positive integer." });
      return;
    }

    const detail = await captureScreenshotForRun(outDir, runId, screenId);
    sendJson(res, 200, detail);
    return;
  }

  const transcriptRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/transcript$/);
  if (transcriptRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(transcriptRunMatch[1]);
    const body = await readRequestJson(req);
    const transcript = typeof body.text === "string" ? body.text.trim() : "";
    if (!transcript) {
      sendJson(res, 400, { error: "text is required." });
      return;
    }

    const detail = await addTranscriptToRun(outDir, runId, transcript);
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === "/api/transcript" && req.method === "POST") {
    const body = await readRequestJson(req);
    const requestedRunId = normalizeCaptureRunId(body.runId);
    const runId = requestedRunId ?? makeRunId();
    const transcript = typeof body.text === "string" ? body.text.trim() : "";
    if (!transcript) {
      sendJson(res, 400, { error: "text is required." });
      return;
    }

    const detail = await addTranscriptToRun(outDir, runId, transcript);
    sendJson(res, 200, detail);
    return;
  }

  const answerRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/answer$/);
  if (answerRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(answerRunMatch[1]);
    const body = await readRequestJson(req);
    const requestedTurnId = typeof body.turnId === "string" && /^[a-zA-Z0-9._-]+$/.test(body.turnId)
      ? body.turnId
      : null;
    const runPath = resolveRunPath(outDir, runId);
    if (!runPath) {
      sendJson(res, 400, { error: "Invalid run id." });
      return;
    }

    const runState = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
    if (!runState) {
      sendJson(res, 404, { error: "Run not found." });
      return;
    }

    await answerRun(
      outDir,
      runId,
      options.language ?? "python",
      options.handoff,
      options.profilePath ?? null,
      requestedTurnId,
    );
    const detail = await readRunDetail(outDir, runId);
    if (!detail) {
      sendJson(res, 500, { error: "Failed to read answer artifacts." });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch?.[1]) {
    const detail = await readRunDetail(outDir, decodeURIComponent(runMatch[1]));
    if (!detail) {
      sendJson(res, 404, { error: "Run not found." });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  const screenshotMatch = pathname.match(/^\/api\/runs\/([^/]+)\/latest-screen$/);
  if (screenshotMatch?.[1]) {
    const filePath = await latestScreenshotPath(outDir, decodeURIComponent(screenshotMatch[1]));
    if (!filePath) {
      sendJson(res, 404, { error: "Screenshot not found." });
      return;
    }
    serveScreenshot(res, filePath);
    return;
  }

  const screenshotIndexMatch = pathname.match(/^\/api\/runs\/([^/]+)\/screens\/(\d+)$/);
  if (screenshotIndexMatch?.[1] && screenshotIndexMatch[2]) {
    const runId = decodeURIComponent(screenshotIndexMatch[1]);
    const screenshotIndex = Number(screenshotIndexMatch[2]);
    const filePath = await screenshotPathAtIndex(outDir, runId, screenshotIndex);
    if (!filePath) {
      sendJson(res, 404, { error: "Screenshot not found." });
      return;
    }
    serveScreenshot(res, filePath);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const monitorController = createMonitorController(options, outDir);

  const server = createServer((req, res) => {
    handleRequest(req, res, outDir, monitorController, options).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });

  return {
    url: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        monitorController.close();
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
