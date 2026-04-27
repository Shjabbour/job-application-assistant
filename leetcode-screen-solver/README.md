# Interview Coder

Standalone coding-interview practice assistant. It captures screenshots or speech input, accumulates prompt context, and produces an answer-ready handoff.

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

No OpenAI API key is required.

## Single Command

Use one command entrypoint and pick input through options/arguments:

```powershell
npm run watch -- [options] [screenshot1 screenshot2 ...]
```

If you pass screenshot file paths, the tool runs in file-input mode and builds the answer from those captures.
If you pass no paths, it captures the selected screen in intervals.

Examples:

```powershell
npm run watch -- .\top.png .\middle.png .\bottom.png --language python
npm run watch -- --once --language python
npm run watch -- --clipboard --language python
npm run watch -- --listen --language python --profile .\candidate-context.txt
npm run watch -- --ui --language python
npm run native
```

Use `npm run native` for the Electron app. The native app avoids the browser screen-share picker and can capture a selected app window such as Chrome Remote Desktop directly from the source picker.

## Key options

- `--once`: capture once and stop.
- `--clipboard`: capture from clipboard instead of files.
- `--listen`: start the local listening page for spoken prompts.
- `--ui`: open the coding-solution UI while capturing.
- `--language <name>`: solution language. Default: `python`.
- `--region x,y,w,h`: capture only a region of the screen.
- `--screen <number>`: choose a screen without prompting.
- `--auto` / `--manual`: control auto-answer behavior.
- `--handoff <codex|openclaw|clipboard>`: output mode.
- `--profile <file>`: add interviewer context notes.

Keyboard controls in capture mode:

- `a` or `s`: prepare an answer when ready
- `r`: reset captured context
- `q`: quit

With `--listen`, open the printed local URL, start browser speech recognition, then click `Listen` and `Answer`.

## Candidate Context

Interview explanations can include your profile text:

```text
Name: ...
Target role: ...
Strong project stories:
- Situation / task / action / result ...
- ...
```

```powershell
npm run watch -- .\coding-question.png --profile .\candidate-context.txt
```

## Output format

Each run writes artifacts under `runs/<timestamp>/`:

- `question-state.json`: captured prompt state
- `screens/`: screenshots used
- `transcripts/`: listen transcript chunks
- `question.txt`: captured question text
- `agent-prompt.md`: agent handoff prompt
- `answer.md`: generated answer or paste-ready prompt
- `hints.md`: extracted hints section (when available)

The answer format stays interview-friendly with approach, code, complexity, tests, and follow-ups.

## Notes

- Screenshot captures are passed to Codex CLI with `codex exec --image`.
- Speech/manual text capture still uses the local transcript parser.
- The tool is intentionally read-only with respect to your browser and screen.
