export const HTML = String.raw`<!doctype html>
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
            <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch to light mode" aria-pressed="false">Dark</button>
          </div>
          <div class="tab-strip" role="tablist" aria-label="Question and answer views">
            <button id="answerTab" class="tab-button active" type="button" role="tab" aria-selected="true" aria-controls="answerPanel" title="Switch to Answer tab (A)">Answer (A)</button>
            <button id="questionTab" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="questionPanel" title="Switch to Question tab (Q)">Question (Q)</button>
          </div>
        <div class="monitor-dock">
            <button id="overlayToggle" class="overlay-toggle" type="button" aria-expanded="false" title="Choose capture source">Choose Source</button>
            <div id="overlayPanel" class="overlay-panel hidden">
              <p id="monitorStatus" class="monitor-status">Not monitoring</p>
              <label class="field">
                <span>Screen</span>
                <select id="screenSelect"></select>
              </label>
              <label class="field">
                <span>App window</span>
                <select id="windowSelect"></select>
              </label>
              <div class="source-picker" aria-label="Capture source picker">
                <div class="source-tabs" role="tablist" aria-label="Capture source type">
                  <button id="applicationsSourceTab" class="source-tab active" type="button" role="tab" aria-selected="true">Applications</button>
                  <button id="screenSourceTab" class="source-tab" type="button" role="tab" aria-selected="false">Entire Screen</button>
                  <button id="devicesSourceTab" class="source-tab" type="button" role="tab" aria-selected="false">Devices</button>
                </div>
                <div id="sourceGrid" class="source-grid" role="list"></div>
              </div>
              <div id="monitorMap" class="monitor-map" aria-label="Monitor layout"></div>
            </div>
            <div class="overlay-actions">
              <button id="answerButton" class="small-button" type="button" title="Generate an answer from current captures (F)">Answer (F)</button>
              <button id="captureButton" class="small-button" type="button" title="Capture the selected source for this question (C)">Capture (C)</button>
              <button id="startMonitorButton" class="small-button" type="button" title="Reset for a new question without capturing (N)">New (N)</button>
              <button id="stopMonitorButton" class="small-button danger" type="button" title="Stop monitoring (S)">Stop (S)</button>
            </div>
          </div>
        </div>
      </header>

      <div class="content-stack">
        <section id="answerPanel" class="answer-pane" role="tabpanel" aria-labelledby="answerTab">
          <div id="answerTurnTabs" class="turn-tabs hidden" role="tablist" aria-label="Answer turns"></div>
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
            <select id="audioInputSelect" aria-label="Voice input source" title="Voice input source">
              <option value="pc">PC audio</option>
              <option value="microphone">Microphone</option>
            </select>
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
