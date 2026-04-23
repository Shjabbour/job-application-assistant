# Interview Coder

Standalone coding-interview practice assistant. It captures screenshots or browser speech recognition, accumulates context across scrolls or spoken chunks, and prepares a readable Interview Coder solution handoff.

Supported prompt types:

- coding and LeetCode-style problems
- debugging and implementation tasks
- technical explanation prompts
- spoken coding prompts from browser speech recognition

This is for mock interviews, interview prep, or explicitly authorized coaching. It does not click, type, paste, submit, or control your browser.

## Setup

```powershell
cd .\leetcode-screen-solver
npm install
```

No OpenAI API key is required for any mode.

## Recommended: Screenshot File Mode

Save one or more screenshots, then pass them to the tool:

```powershell
npm run image -- C:\path\to\question.png --language python
```

If a coding problem spans multiple scroll positions, pass screenshots in order:

```powershell
npm run image -- .\top.png .\middle.png .\bottom.png --language python
```

Screenshot mode attaches the image directly to Codex CLI instead of relying on OCR. If you use the clipboard handoff, attach the saved screenshot listed in `agent-prompt.md` when you paste the prompt manually.

## Clipboard Screenshot Mode

On Windows:

1. Press `Win+Shift+S`.
2. Select the question area.
3. Run:

```powershell
npm run clipboard -- --language python
```

This reads the screenshot image from the clipboard and prepares an answer if the captured context is complete.

## Watch Mode

```powershell
npm run watch -- --language python
```

The tool asks which monitor has the interview question, then captures only that screen every 8 seconds. You handle any scrolling manually.

Watch mode answers automatically once enough context is captured.
When run with `--ui`, watch mode waits for you to click **Answer** so you can collect multiple screenshots first.
By default it uses Codex CLI for answer generation (`--handoff codex`).

In UI mode, pick your interview monitor first, click **New** to clear the workspace, then click **Capture** when the prompt is visible.

To skip the prompt and choose a screen directly:

```powershell
npm run watch -- --screen 2 --language python
```

Keyboard controls:

- `a` or `s`: prepare an answer once enough context has been captured
- `r`: reset captured question context
- `q`: quit

Disable auto-answer and capture only:

```powershell
npm run watch -- --language python --manual
```

Start the coding-solution UI while watching:

```powershell
npm run watch -- --language python --ui
```

Then open:

```text
http://127.0.0.1:4378
```

You can also run the UI by itself in a second terminal:

```powershell
npm run ui
```

The UI includes a **Screen Monitor** selector. Pick the screen with the interview prompt, click **New** to start a clean question workspace, then use **Capture** whenever you want to grab the selected screen. Capture as many screenshots as the prompt needs, then click **Answer** when you are ready. Use **Stop** only if a background watcher is running.

## Listen Mode

Use listen mode when the question is spoken instead of written on screen:

```powershell
npm run listen -- --language python --profile .\candidate-context.txt
```

Open the printed local URL, then click `Listen`. Chrome or Edge speech recognition captures final transcript chunks and sends only text to the local Node server.

If browser speech recognition is unavailable, paste or type the question into the text box and click `Add Text`.

When you click `Answer`, the tool writes:

- `question.txt`: the captured prompt text
- `agent-prompt.md`: a Codex/OpenClaw-ready answer prompt
- `answer.md`: either the Codex/OpenClaw answer or a paste-ready handoff note

By default listen mode tries Codex CLI first:

```powershell
npm run listen -- --handoff codex
```

If Codex CLI is not ready, the prompt is still displayed and copied so you can paste it manually. To use OpenClaw instead:

```powershell
npm run listen -- --handoff openclaw
```

To skip agent calls entirely and only prepare a paste-ready prompt:

```powershell
npm run listen -- --handoff clipboard
```

You can tune Codex or OpenClaw wait time before fallback:

```powershell
$env:CODEX_AGENT_TIMEOUT_SECONDS="90"
$env:OPENCLAW_AGENT_TIMEOUT_SECONDS="45"
```

Options:

```powershell
npm run listen -- --handoff codex --auto
```

- `--auto` prepares an answer automatically as soon as the transcript has enough context.

## Candidate Context For Communication Profile

Interview explanations are stronger when grounded in your actual experience. Create a short profile file with your preferred framing:

```text
Name: ...
Target role: ...
Strong project stories:
- Situation / task / action / result ...
- Situation / task / action / result ...
Leadership examples:
- ...
Conflict examples:
- ...
```

Then run:

```powershell
npm run image -- .\coding-question.png --profile .\candidate-context.txt
```

If no profile is provided, responses use placeholders instead of inventing personal history.

## Capture Only Part Of The Screen

If you want OCR to focus on the question area, pass a rectangle:

```powershell
npm run watch -- --region 0,0,1400,1000 --language python
```

The format is `x,y,width,height` in screen pixels.

## One-Shot Mode

For one direct screen capture:

```powershell
npm run once -- --language python
```

This also asks which monitor to capture unless you pass `--screen` or `--region`.

If OCR cannot identify a clear question, it writes the partial `question-state.json` and tells you what is missing.

## Output Format

Each run writes artifacts under `runs/<timestamp>/`:

- `question-state.json`: captured prompt context
- `screens/`: screenshots used for extraction
- `transcripts/`: listening-mode transcript chunks
- `question.txt`: captured question text
- `agent-prompt.md`: agent handoff prompt
- `answer.md`: generated practice answer, once ready
- `hints.md`: optional extracted `## Hints` section from the generated answer

The answer is formatted as readable Markdown for quick practice:

- coding: clarify, approach, code, complexity, quick tests, follow-ups, watch-outs
- debugging: first checks, likely cause, fix, verification, follow-ups
- technical: short answer, deeper explanation, example, follow-ups

## Notes

- Screenshot captures are passed to Codex CLI with `codex exec --image`.
- Speech/manual text capture still uses the local transcript parser.
- The tool is intentionally read-only with respect to your browser and screen.
