import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { QuestionState } from "./types.js";

export interface TranscriptPayload {
  text: string;
}

export interface ListenStatus {
  runDir: string;
  state: QuestionState;
  transcriptText: string;
  answerMarkdown: string;
  answerPrompt: string;
  processing: boolean;
  lastTranscript: string | null;
  lastError: string | null;
}

interface ListenServerOptions {
  port: number;
  autoAnswerDefault: boolean;
  getStatus: () => Promise<ListenStatus> | ListenStatus;
  onTranscript: (payload: TranscriptPayload) => Promise<void>;
  onAnswerRequest: () => Promise<void>;
  onResetRequest: () => Promise<void>;
}

export interface ListenServerHandle {
  url: string;
  close: () => Promise<void>;
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
    <main class="shell">
      <section class="topbar">
        <div>
          <p class="eyebrow" id="connection">Connecting</p>
          <h1>Interview Coder</h1>
        </div>
          <div class="actions">
            <button id="listenButton" type="button">Capture Voice</button>
            <button id="stopButton" type="button" disabled>Stop</button>
            <button id="answerButton" type="button">Generate</button>
            <button id="copyButton" type="button">Copy Solution Prompt</button>
            <button id="resetButton" type="button">Reset</button>
            <label class="toggle">
              <input id="autoAnswer" type="checkbox" __AUTO_CHECKED__>
                <span>Auto</span>
          </label>
        </div>
      </section>

      <section class="status-band">
        <div>
          <p class="eyebrow" id="kindLabel">Waiting</p>
          <h2 id="titleLabel">No question captured yet</h2>
          <p id="statusLine">Start capture or paste the prompt.</p>
        </div>
        <div class="meter" aria-label="Capture completeness">
          <div id="meterFill"></div>
        </div>
      </section>

      <section class="grid">
        <article class="panel">
          <header>
            <h3>Captured Question</h3>
            <span id="readyLabel">Not ready</span>
          </header>
          <div id="questionText" class="text empty">Captured question will appear here.</div>
        </article>

        <article class="panel">
          <header>
            <h3>Code Solution</h3>
            <span id="answerLabel">Pending</span>
          </header>
          <pre id="answerText" class="text empty">Generate once the prompt is complete.</pre>
        </article>

        <article class="panel transcript">
          <header>
            <h3>Live Transcript</h3>
            <span id="processingLabel">Idle</span>
          </header>
          <pre id="transcriptText" class="text empty">No transcript yet.</pre>
          <div class="manual-entry">
          <textarea id="manualText" rows="3" placeholder="Paste or type a coding prompt here"></textarea>
            <button id="addTextButton" type="button">Add Text</button>
          </div>
        </article>
      </section>
    </main>

    <script>
__JS__
    </script>
  </body>
</html>`;

const CSS = String.raw`:root {
  color-scheme: light;
  --bg: #f4f6f8;
  --panel: #ffffff;
  --panel-strong: #eef4f2;
  --text: #172026;
  --muted: #60707a;
  --border: #d7dee3;
  --accent: #006c67;
  --accent-soft: #d9eeeb;
  --amber: #a85f00;
  --danger: #b42318;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
}

button,
input,
textarea {
  font: inherit;
}

.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar,
.status-band {
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  padding: 18px 22px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.topbar h1,
.status-band h2,
.panel h3 {
  margin: 0;
}

.topbar h1 {
  font-size: 22px;
  line-height: 1.2;
}

.eyebrow {
  margin: 0 0 5px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

button {
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  padding: 0 12px;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

button.active,
#answerButton {
  border-color: var(--accent);
  background: var(--accent);
  color: #ffffff;
}

.toggle {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
}

.toggle input {
  accent-color: var(--accent);
}

.status-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  align-items: center;
  gap: 24px;
  background: var(--panel-strong);
}

.status-band h2 {
  font-size: 26px;
  line-height: 1.18;
}

#statusLine {
  margin: 8px 0 0;
  color: var(--muted);
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
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(320px, 0.9fr) minmax(420px, 1.1fr);
  grid-template-rows: minmax(0, 1fr) minmax(200px, 0.45fr);
  gap: 16px;
  padding: 16px;
}

.panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.panel header {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--border);
  padding: 10px 14px;
}

.panel h3 {
  font-size: 15px;
}

.panel span {
  color: var(--muted);
  font-size: 13px;
}

.text {
  flex: 1;
  margin: 0;
  overflow: auto;
  padding: 16px;
  white-space: pre-wrap;
  font: 15px/1.48 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.empty {
  color: var(--muted);
}

.transcript {
  grid-column: 1 / -1;
}

.manual-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding: 12px;
}

.manual-entry textarea {
  width: 100%;
  resize: vertical;
  min-height: 62px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
}

@media (max-width: 900px) {
  .topbar,
  .status-band,
  .grid,
  .manual-entry {
    grid-template-columns: 1fr;
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .actions {
    justify-content: flex-start;
  }

  .grid {
    grid-template-rows: auto;
  }
}`;

const JS = String.raw`var state = {
  recognition: null,
  listening: false,
  answering: false,
  answerPrompt: ''
};

var elements = {};

function byId(id) {
  return document.getElementById(id);
}

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setConnection(text) {
  elements.connection.textContent = text;
}

function setListening(active) {
  state.listening = active;
  elements.listenButton.disabled = active;
  elements.stopButton.disabled = !active;
  elements.listenButton.classList.toggle('active', active);
}

async function postTranscript(text) {
  var clean = String(text || '').trim();
  if (!clean) {
    return;
  }

  var response = await fetch('/api/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean })
  });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  await renderStatus(await response.json());
}

function startListening() {
  var Recognition = recognitionCtor();
  if (!Recognition) {
    elements.statusLine.textContent = 'Browser speech recognition is not available. Paste the prompt below.';
    return;
  }

  stopListening();
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
      postTranscript(finalText).catch(function (error) {
        elements.statusLine.textContent = error.message || String(error);
      });
    }
  };

  recognition.onerror = function (event) {
    elements.statusLine.textContent = event.error || 'Speech recognition error';
  };

  recognition.onend = function () {
    if (state.listening) {
      recognition.start();
    }
  };

  state.recognition = recognition;
  state.listening = true;
  recognition.start();
  setListening(true);
}

function stopListening() {
  state.listening = false;
  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.stop();
    state.recognition = null;
  }
  setListening(false);
}

async function copyPrompt() {
  var text = state.answerPrompt || elements.answerText.textContent || '';
  if (!text.trim()) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    elements.statusLine.textContent = 'Solution prompt copied.';
  } catch (error) {
    elements.statusLine.textContent = 'Copy failed. Select the prompt text manually.';
  }
}

async function postAnswer() {
  if (state.answering) {
    return;
  }
  state.answering = true;
  try {
    var response = await fetch('/api/answer', { method: 'POST' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    await renderStatus(await response.json());
    if (state.answerPrompt) {
      await copyPrompt();
    }
  } catch (error) {
    elements.statusLine.textContent = error.message || String(error);
  } finally {
    state.answering = false;
  }
}

async function postReset() {
  var response = await fetch('/api/reset', { method: 'POST' });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  await renderStatus(await response.json());
}

function questionText(data) {
  var question = data.state.question || {};
  var parts = [];
  if (question.prompt) {
    parts.push(question.prompt);
  }
  if (question.inputOutput) {
    parts.push('Input / Output:\n' + question.inputOutput);
  }
  if (question.examples && question.examples.length) {
    parts.push('Examples:\n' + question.examples.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.constraints && question.constraints.length) {
    parts.push('Constraints:\n' + question.constraints.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (data.state.missingInformation && data.state.missingInformation.length) {
    parts.push('Still missing:\n' + data.state.missingInformation.map(function (item) { return '- ' + item; }).join('\n'));
  }
  return parts.join('\n\n');
}

async function renderStatus(data) {
  setConnection(data.processing ? 'Processing' : 'Connected');
  state.answerPrompt = data.answerPrompt || '';
  var question = data.state.question || {};
  var score = Math.round((data.state.completenessScore || 0) * 100);
  var renderedQuestion = questionText(data);
  elements.kindLabel.textContent = question.kind || 'question';
  elements.titleLabel.textContent = question.title || (question.prompt ? question.prompt.slice(0, 90) : 'No question captured yet');
    elements.statusLine.textContent = data.lastError || (data.lastTranscript ? 'Last transcript: ' + data.lastTranscript : 'Ready to capture a prompt.');
  elements.readyLabel.textContent = data.state.readyToAnswer ? 'Ready' : 'Capturing';
  elements.readyLabel.style.color = data.state.readyToAnswer ? 'var(--accent)' : 'var(--amber)';
  elements.processingLabel.textContent = data.processing ? 'Processing' : 'Idle';
  elements.meterFill.style.width = score + '%';
  elements.questionText.textContent = renderedQuestion || 'Captured question will appear here.';
  elements.questionText.classList.toggle('empty', !renderedQuestion);
  elements.transcriptText.textContent = data.transcriptText || 'No transcript yet.';
  elements.transcriptText.classList.toggle('empty', !data.transcriptText);
    elements.answerText.textContent = data.answerMarkdown || data.answerPrompt || 'Generate once the prompt is complete.';
  elements.answerText.classList.toggle('empty', !data.answerMarkdown && !data.answerPrompt);
  elements.answerLabel.textContent = data.answerMarkdown ? 'Answered' : data.answerPrompt ? 'Prompt ready' : 'Pending';

  if (elements.autoAnswer.checked && data.state.readyToAnswer && !data.answerMarkdown && !state.answering) {
    await postAnswer();
  }
}

async function pollStatus() {
  try {
    var response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    await renderStatus(await response.json());
  } catch (error) {
    setConnection('Disconnected');
  }
}

function boot() {
  ['connection', 'listenButton', 'stopButton', 'answerButton', 'copyButton', 'resetButton', 'autoAnswer',
    'kindLabel', 'titleLabel', 'statusLine', 'meterFill', 'readyLabel', 'questionText',
    'answerLabel', 'answerText', 'processingLabel', 'transcriptText', 'manualText', 'addTextButton'].forEach(function (id) {
    elements[id] = byId(id);
  });

  elements.listenButton.addEventListener('click', startListening);
  elements.stopButton.addEventListener('click', stopListening);
  elements.answerButton.addEventListener('click', postAnswer);
  elements.copyButton.addEventListener('click', copyPrompt);
  elements.resetButton.addEventListener('click', function () {
    postReset().catch(function (error) {
      elements.statusLine.textContent = error.message || String(error);
    });
  });
  elements.addTextButton.addEventListener('click', function () {
    var text = elements.manualText.value;
    elements.manualText.value = '';
    postTranscript(text).catch(function (error) {
      elements.statusLine.textContent = error.message || String(error);
    });
  });

  pollStatus();
  setInterval(pollStatus, 1500);
}

boot();`;

function pageHtml(autoAnswerDefault: boolean): string {
  return HTML.replace("__CSS__", CSS)
    .replace("__AUTO_CHECKED__", autoAnswerDefault ? "checked" : "")
    .replace("__JS__", JS);
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

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function createRequestHandler(options: ListenServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  let transcriptQueue = Promise.resolve();

  return (req, res) => {
    const handle = async () => {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/listen")) {
        sendText(res, 200, pageHtml(options.autoAnswerDefault), "text/html; charset=utf-8");
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/status") {
        sendJson(res, 200, await options.getStatus());
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/transcript") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8")) as TranscriptPayload;
        const task = transcriptQueue.then(() => options.onTranscript({ text: body.text }));
        transcriptQueue = task.catch(() => undefined);
        await task;
        sendJson(res, 200, await options.getStatus());
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/answer") {
        await options.onAnswerRequest();
        sendJson(res, 200, await options.getStatus());
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/reset") {
        await options.onResetRequest();
        sendJson(res, 200, await options.getStatus());
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    };

    handle().catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };
}

export async function startListenServer(options: ListenServerOptions): Promise<ListenServerHandle> {
  const server: Server = createServer(createRequestHandler(options));

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
    url: `http://127.0.0.1:${options.port}/listen`,
    close: () =>
      new Promise<void>((resolve, reject) => {
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
