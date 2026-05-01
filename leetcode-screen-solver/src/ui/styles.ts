export const CSS = String.raw`:root {
  color-scheme: dark;
  --bg: #070b12;
  --panel: #101722;
  --panel-strong: #131d2a;
  --text: #edf3fb;
  --muted: #95a6b8;
  --border: #263343;
  --border-strong: #3a4a5e;
  --accent: #4cc9b0;
  --accent-soft: rgba(76, 201, 176, 0.16);
  --accent-line: #5eead4;
  --amber: #f0b75e;
  --danger: #ff8f8f;
  --code-bg: #10161d;
  --code-panel: #151e27;
  --code-text: #edf4f8;
  --code-comment: #7ee787;
  --soft-row: #172231;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

:root[data-theme="light"] {
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
  --code-comment: #7ee787;
  --soft-row: #f7fafb;
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
  background:
    radial-gradient(circle at top right, rgba(76, 201, 176, 0.12), transparent 28%),
    linear-gradient(180deg, #0b111b 0%, var(--bg) 58%, #05070b 100%);
  color: var(--text);
  overflow: hidden;
}

:root[data-theme="light"] body {
  background: var(--bg);
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

.markdown pre .code-comment {
  color: var(--code-comment);
  font-weight: 700;
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
  flex: 0 0 auto;
  max-height: min(52vh, 560px);
  min-height: 190px;
  overflow: auto;
}

.screenshot-gallery {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
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
  height: min(44vh, 460px);
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
  grid-template-columns: minmax(0, 1fr) 118px 92px 86px;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
  background: #f8fafb;
}

.question-input textarea,
.question-input select {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
}

.question-input textarea {
  min-height: 70px;
  max-height: 180px;
  resize: vertical;
  padding: 10px 12px;
  line-height: 1.45;
}

.question-input select {
  min-height: 34px;
  align-self: stretch;
  padding: 0 9px;
  font-size: 13px;
  font-weight: 650;
}

.question-input textarea:focus,
.question-input select:focus {
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #b8c4d1;
  font-size: 12px;
  margin: 6px 0 2px;
}

.screenshot-status {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border: 1px solid #2c3a48;
  border-radius: 999px;
  padding: 0 8px;
  color: #d9e8f5;
  font-size: 11px;
  font-weight: 750;
}

.screenshot-status.pending {
  color: var(--accent-line);
}

.screenshot-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.screenshot-delete {
  min-width: 30px;
  min-height: 26px;
  border: 1px solid #354250;
  border-radius: 6px;
  background: #141d27;
  color: var(--danger);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.screenshot-delete:disabled {
  cursor: not-allowed;
  opacity: 0.45;
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

.theme-toggle {
  min-height: 34px;
  min-width: 68px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 750;
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
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
  flex: 0 0 auto;
  min-width: 640px;
  max-width: 100%;
}

.overlay-toggle {
  min-height: 34px;
  min-width: 132px;
  max-width: 260px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 6px 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overlay-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 20;
  width: 100%;
  min-width: min(900px, calc(100vw - 32px));
  border: 1px solid #343741;
  border-radius: 10px;
  background: #24262b;
  padding: 10px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.overlay-panel.hidden {
  display: none;
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
  flex: 1 1 180px;
  flex-direction: column;
  margin-bottom: 0;
  min-width: 0;
}

.field span {
  display: block;
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

.source-picker {
  flex: 1 1 100%;
  width: 100%;
  min-width: 0;
  border-radius: 8px;
  background: transparent;
  color: #f2f3f5;
  padding: 8px;
}

.source-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  border-radius: 7px;
  background: #111214;
  padding: 4px;
}

.source-tab {
  min-height: 42px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #b7bac1;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
}

.source-tab.active {
  background: #2f3138;
  color: #ffffff;
}

.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  min-height: 180px;
  max-height: min(48vh, 520px);
  overflow: auto;
  padding: 18px 0 4px;
}

.source-card {
  min-width: 0;
  border: 2px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #f2f3f5;
  cursor: pointer;
  padding: 0;
  text-align: left;
}

.source-card.active {
  border-color: #8b5cf6;
}

.source-preview {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  background: #060607;
  border: 1px solid #33363d;
  overflow: hidden;
  padding: 12px;
}

.source-preview img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #060607;
}

.source-preview span {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 10px;
  background: #2f3138;
  color: #ffffff;
  font-size: 22px;
  font-weight: 800;
}

.source-preview em {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  color: #b7bac1;
  font-size: 12px;
  font-style: normal;
  font-weight: 650;
  line-height: 1.25;
  text-align: center;
}

.source-name {
  display: block;
  margin-top: 10px;
  color: #f2f3f5;
  font-size: 14px;
  font-weight: 750;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-subtitle {
  display: block;
  margin-top: 3px;
  color: #a6a9b0;
  font-size: 12px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-empty {
  grid-column: 1 / -1;
  color: #b7bac1;
  padding: 24px 8px;
}

.monitor-map {
  display: none;
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

:root:not([data-theme="light"]) .runs-pane,
:root:not([data-theme="light"]) .monitor-panel,
:root:not([data-theme="light"]) .turn-tabs,
:root:not([data-theme="light"]) .question-input,
:root:not([data-theme="light"]) .top-bar,
:root:not([data-theme="light"]) .status-pill,
:root:not([data-theme="light"]) .status-text,
:root:not([data-theme="light"]) .overlay-toggle,
:root:not([data-theme="light"]) .field select,
:root:not([data-theme="light"]) .question-input textarea,
:root:not([data-theme="light"]) .question-input select,
:root:not([data-theme="light"]) .answer-summary,
:root:not([data-theme="light"]) .hints-section,
:root:not([data-theme="light"]) .hints-markdown {
  background: var(--panel);
  color: var(--text);
}

:root:not([data-theme="light"]) .runs-pane,
:root:not([data-theme="light"]) .top-bar,
:root:not([data-theme="light"]) .question-pane,
:root:not([data-theme="light"]) .answer-pane,
:root:not([data-theme="light"]) .status-pill,
:root:not([data-theme="light"]) .status-text,
:root:not([data-theme="light"]) .small-button,
:root:not([data-theme="light"]) .theme-toggle,
:root:not([data-theme="light"]) .overlay-toggle,
:root:not([data-theme="light"]) .field select,
:root:not([data-theme="light"]) .question-input textarea,
:root:not([data-theme="light"]) .question-input select,
:root:not([data-theme="light"]) .turn-tab-button,
:root:not([data-theme="light"]) .section-chip,
:root:not([data-theme="light"]) .monitor-tile {
  border-color: var(--border);
}

:root:not([data-theme="light"]) .top-bar {
  background: rgba(16, 23, 34, 0.88);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
}

:root:not([data-theme="light"]) .tab-strip,
:root:not([data-theme="light"]) .source-tabs {
  border-color: var(--border);
  background: #0b111b;
}

:root:not([data-theme="light"]) .tab-button,
:root:not([data-theme="light"]) .turn-tab-button {
  color: var(--muted);
}

:root:not([data-theme="light"]) .tab-button:hover,
:root:not([data-theme="light"]) .turn-tab-button:hover {
  background: var(--soft-row);
  color: var(--text);
}

:root:not([data-theme="light"]) .turn-tab-button {
  background: var(--panel);
}

:root:not([data-theme="light"]) .turn-tab-button.active,
:root:not([data-theme="light"]) .display-button.active,
:root:not([data-theme="light"]) .run-item.active,
:root:not([data-theme="light"]) .monitor-tile.active {
  background: var(--accent-soft);
  color: var(--accent-line);
}

:root:not([data-theme="light"]) .markdown strong {
  color: var(--text);
}

:root:not([data-theme="light"]) .markdown code {
  background: #1b2838;
  color: #dce8f4;
}

:root:not([data-theme="light"]) .answer-summary {
  background: rgba(16, 23, 34, 0.96);
}

:root:not([data-theme="light"]) .section-chip {
  background: var(--soft-row);
  color: #cbd8e5;
}

:root:not([data-theme="light"]) .md-section-say-this-first,
:root:not([data-theme="light"]) .md-section-robust-walkthrough,
:root:not([data-theme="light"]) .md-section-robust-answer {
  background: rgba(76, 201, 176, 0.06);
}

:root:not([data-theme="light"]) .md-section-hints,
:root:not([data-theme="light"]) .hints-section,
:root:not([data-theme="light"]) .hints-markdown {
  background: rgba(240, 183, 94, 0.08);
}

:root:not([data-theme="light"]) .md-section-naive-first-try {
  background: rgba(240, 183, 94, 0.1);
}

:root:not([data-theme="light"]) .md-section-code {
  background: #0d141f;
}

:root:not([data-theme="light"]) .overlay-panel {
  border-color: var(--border-strong);
  background: #111722;
  box-shadow: 0 22px 58px rgba(0, 0, 0, 0.48);
}

:root:not([data-theme="light"]) .source-tab.active,
:root:not([data-theme="light"]) .source-preview span {
  background: #263343;
}

:root:not([data-theme="light"]) .source-card.active {
  border-color: var(--accent-line);
}

:root:not([data-theme="light"]) .source-preview,
:root:not([data-theme="light"]) .source-preview img {
  background: #070b12;
}

:root:not([data-theme="light"]) .meter {
  background: #1d2a39;
}

:root:not([data-theme="light"]) input::placeholder,
:root:not([data-theme="light"]) textarea::placeholder {
  color: #788b9d;
}

:root:not([data-theme="light"]) select option {
  background: var(--panel);
  color: var(--text);
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

  .monitor-dock {
    align-items: flex-start;
    flex-wrap: wrap;
    margin-left: 0;
    min-width: 0;
    width: 100%;
  }

  .overlay-panel {
    position: static;
    min-width: 0;
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
