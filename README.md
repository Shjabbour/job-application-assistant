# Job Application Assistant

A local TypeScript CLI that helps you track jobs, keep your profile in one place, talk through applications, and generate tailored job plans and LinkedIn outreach drafts.

## What it does

- Stores your profile locally in JSON
- Stores job leads locally in JSON
- Opens a local dashboard for job review and automation actions
- Lets you chat with the assistant in your terminal
- Generates:
  - fit summaries
  - application plans
  - LinkedIn outreach drafts
  - follow-up suggestions
- Captures job postings with Playwright

## Quick start

Windows easiest path:

```bat
Open Job Assistant.cmd
```

That installs dependencies if needed, makes sure the Playwright browser runtime exists, and starts the local-only dashboard so you can use the UI instead of remembering the CLI commands.

If you want the same dashboard plus a temporary Cloudflare public URL:

```bat
Open Job Assistant Public.cmd
```

That starts the dashboard with the quick tunnel enabled and prints the `*.trycloudflare.com` URL in the terminal window.

If LinkedIn needs the attached real-Chrome workflow, use:

```bat
Start Debug Chrome.cmd
```

Terminal fallback:

```bash
npm install
npm run browser:install
npm start
```

Public-link fallback:

```bash
npm run dev
```

To try Microsoft Edge instead of Chrome for Playwright:

```bash
$env:JAA_BROWSER_CHANNEL="msedge"
npm run chat
```

Or use direct commands:

```bash
npm run cli -- profile edit
npm run cli -- job add
npm run cli -- job list
npm run cli -- job dedupe
npm run cli -- dashboard [port] [--no-open]
npm run cli -- job plan <job-id>
npm run cli -- job match <job-id>
npm run cli -- job rank
npm run cli -- job linkedin <job-id>
npm run cli -- browser attach-help
npm run cli -- browser save-remote-jobs
npm run cli -- browser apply-saved-jobs
npm run cli -- browser apply-job-url <url>
npm run cli -- browser start-autopilot
npm run cli -- browser start-full-autopilot
```

## OpenClaw Integration

This repo now includes a local OpenClaw-compatible bundle at `plugins/job-application-assistant-openclaw/`.

Prerequisite: `openclaw` must already be installed and available on your `PATH`.

Included skills:

- `continue-job-applications`
- `review-application-gaps`

What OpenClaw adds here:

- a repo-local skill bundle that can be linked into OpenClaw
- a consistent wrapper script for the existing dashboard and browser commands
- a cleaner agent entry point for continuing LinkedIn save/apply flows

What it does not add:

- a new browser automation engine
- better LinkedIn sign-in handling than the existing attached Chrome flow
- any replacement for the Playwright logic already in this repo

Install the repo-local bundle into OpenClaw without copying files:

```powershell
npm run openclaw:plugin:link
```

Or install a copied snapshot:

```powershell
npm run openclaw:plugin:install
```

Or bootstrap the full repo-side setup automatically. This will install OpenClaw first if it is missing, then link the local plugin bundle:

```powershell
npm run openclaw:bootstrap
```

To make the repo startup path automatic, use:

```powershell
npm run openclaw:start
```

That bootstraps OpenClaw for this repo, installs project dependencies if needed, ensures the Playwright browser runtime exists, starts the local dashboard, and launches the attached Chrome workflow unless it is already running.

If you want startup plus the first LinkedIn collection step in one command, use:

```powershell
npm run openclaw:start-save
```

Or double-click:

```bat
OpenClaw Save Remote Jobs.cmd
```

That save launcher defaults to `JAA_BATCH_LIMIT=40` and `JAA_PAGE_LIMIT=3` unless you already set your own values.

If you want the full repo-local automation pass in one command, use:

```powershell
npm run openclaw:start-full
```

Or double-click:

```bat
OpenClaw Full Autopilot.cmd
```

That full launcher bootstraps the repo, starts the dashboard and attached Chrome session, saves jobs from LinkedIn Remote Jobs in the attached browser, and then applies from the saved local queue. The apply step prefers visible Jobs Tracker items when available and falls back to direct job pages for the rest of the queue.

If your shell-level `openclaw` command still points at an older Node runtime, use the repo wrapper instead:

```powershell
npm run openclaw:cli -- --version
npm run openclaw:cli -- plugins inspect job-application-assistant-openclaw --json
```

After that, open this repo as the workspace in OpenClaw and use the helper wrapper when you want OpenClaw to continue applications:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 setup
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 start-debug-chrome
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 save-remote-jobs
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 apply-saved-jobs
```

The wrapper also supports:

- `dashboard`
- `dashboard-public`
- `attach-help`
- any existing `browser` subcommand such as `apply-job-url`, `review-attached-form`, `review-unanswered-questions`, `start-autopilot`, and `start-full-autopilot`

Use `review-application-gaps` when you want OpenClaw to inspect `data/browser/*.json`, `data/application-answers.json`, and `data/question-bank.json` before another apply attempt.

Recommended OpenClaw flow for this repo:

1. Run `npm run openclaw:start` for automatic startup, or `npm run openclaw:start-save` to start up and immediately run the Remote Jobs save flow.
2. If LinkedIn or Google auth blocks the managed browser, run `start-debug-chrome` and sign in manually.
3. Use `save-remote-jobs` to collect candidates from the LinkedIn Remote Jobs lane.
4. Use `apply-saved-jobs` or `apply-job-url <url>` to continue filing from Jobs Tracker.
5. Use the dashboard or `data/browser/*.json` artifacts to review what happened.

## Data files

The CLI writes local files into `data/`:

- `data/profile.json`
- `data/jobs.json`
- `data/conversation.json`
- `data/high-paying-companies.json`
- `data/job-evaluation-profile.json`
- `data/application-answers.json`
- `data/question-bank.json`
- `data/browser/*.json`

## Dashboard

Run the local dashboard with:

```bash
npm run dashboard
```

Or use:

```bash
npm run cli -- dashboard
```

If you want a phone-accessible public dev URL without a domain, run:

```bash
pnpm dev
```

That starts the dashboard and auto-creates a temporary Cloudflare quick tunnel so you can open it over cellular from your phone. The URL will be a random `*.trycloudflare.com` hostname and changes each time the tunnel restarts.

The dashboard opens a local server on `http://127.0.0.1:3030` by default and reads the same `data/` files as the CLI. The UI is organized around a simple flow:

- open the session
- save from LinkedIn Remote Jobs
- apply from LinkedIn Jobs Tracker

It also shows:

- status and notes editing for the selected job
- autofill/profile completeness for forms
- browser artifact activity from `data/browser/`
- external apply findings and employer routes
- live runner status, logs, and recent runs
- a Cloudflare quick tunnel button so the dashboard can be opened from anywhere while the tunnel is running
- named Cloudflare Tunnel settings in the UI for a stable hostname once you add your tunnel token and hostname mapping

## Automation Split

There are two separate browser lanes:

- Remote Jobs save flow: `browser save-remote-jobs`
- Jobs Tracker apply flow: `browser apply-saved-jobs`
- Single-job apply: `browser apply-job-url <url>`
- Batch wrappers: `browser start-autopilot` and `browser start-full-autopilot`
- `https://www.linkedin.com/jobs/collections/remote-jobs/` is the save lane
- `https://www.linkedin.com/jobs-tracker/` is the apply lane

Compatibility aliases only:

- `browser save-attached-jobs` -> `browser save-remote-jobs`
- `browser process-visible-jobs` -> `browser save-remote-jobs`
- `browser auto-apply-visible-jobs` -> `browser apply-saved-jobs`
- `browser auto-apply-saved-jobs` -> `browser apply-saved-jobs`

To use a different port or skip auto-opening the browser:

```bash
npm run cli -- dashboard 3031 --no-open
```

To start the dashboard and auto-open a Cloudflare public URL from the CLI:

```bash
npm run cli -- dashboard --public
```

## Chat commands

Inside `npm run chat`:

- `/help`
- `/dashboard`
- `/profile show`
- `/profile edit`
- `/jobs`
- `/job add`
- `/job view <id>`
- `/job match <id>`
- `/job dedupe`
- `/job rank [limit]`
- `/job plan <id>`
- `/job linkedin <id>`
- `/browser attach-help`
- `/browser save-remote-jobs`
- `/browser apply-saved-jobs`
- `/browser apply-job-url <url>`
- `/browser start-autopilot`
- `/browser start-full-autopilot`
- `/quit`

## Real Browser Attach Mode

If Google blocks sign-in inside the Playwright-managed browser, use a real Chrome session with remote debugging:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-debug-chrome.ps1
```

Then log in manually in that Chrome window and run:

```bash
npm run cli -- browser save-remote-jobs
npm run cli -- browser apply-saved-jobs
npm run cli -- browser apply-job-url <url>
npm run cli -- browser start-autopilot
npm run cli -- browser start-full-autopilot
```

## Notes

- This repo is intentionally local-first.
- Browser sessions use a persistent Playwright profile in `.browser-profile/`.
- Set `JAA_BROWSER_CHANNEL=msedge` to use Microsoft Edge instead of Chrome.
- Attach mode connects to a real Chrome session at `http://127.0.0.1:9222`.

## Advanced Batch Controls

Use environment variables to control the Remote Jobs collector and saved-job apply batch:

```powershell
$env:JAA_BATCH_LIMIT="10"
$env:JAA_PAGE_LIMIT="3"
$env:JAA_APPLY_CONCURRENCY="3"
npm run cli -- browser process-visible-external-jobs
```

- `JAA_BATCH_LIMIT` caps total jobs processed in one run.
- `JAA_PAGE_LIMIT` caps how many LinkedIn result pages the collector advances through.
- `JAA_APPLY_CONCURRENCY` controls how many saved-job apply subprocesses run at once. The default is `3`; the CLI caps it at `6` to avoid overloading the attached Chrome session.
- `JAA_APPLY_TIMEOUT_MS` controls the per-job apply timeout. The default is `300000` milliseconds.
