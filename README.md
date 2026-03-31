# Job Application Assistant

A local TypeScript CLI that helps you track jobs, keep your profile in one place, talk through applications, and generate tailored job plans and LinkedIn outreach drafts.

## What it does

- Stores your profile locally in JSON
- Stores job leads locally in JSON
- Lets you chat with the assistant in your terminal
- Generates:
  - fit summaries
  - application plans
  - LinkedIn outreach drafts
  - follow-up suggestions
- Captures job postings with Playwright

## Quick start

```bash
npm install
npm run browser:install
npm run chat
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
npm run cli -- job plan <job-id>
npm run cli -- job linkedin <job-id>
npm run cli -- browser open <url>
npm run cli -- browser capture <url>
npm run cli -- browser capture-linkedin-current
npm run cli -- browser review-linkedin-current
npm run cli -- browser attach-help
npm run cli -- browser review-linkedin-attached
npm run cli -- browser capture-attached-current
npm run cli -- browser collect-attached-jobs
npm run cli -- browser save-attached-jobs
npm run cli -- browser autofill-attached-current
npm run cli -- browser process-visible-jobs
npm run cli -- browser review-attached-form
npm run cli -- browser autofill-attached-form
npm run cli -- browser process-visible-external-jobs
npm run cli -- browser start-autopilot
```

## Data files

The CLI writes local files into `data/`:

- `data/profile.json`
- `data/jobs.json`
- `data/conversation.json`
- `data/high-paying-companies.json`
- `data/browser/*.json`

## Chat commands

Inside `npm run chat`:

- `/help`
- `/profile show`
- `/profile edit`
- `/jobs`
- `/job add`
- `/job view <id>`
- `/job plan <id>`
- `/job linkedin <id>`
- `/browser open <url>`
- `/browser capture <url>`
- `/browser capture-linkedin-current`
- `/browser review-linkedin-current`
- `/browser attach-help`
- `/browser review-linkedin-attached`
- `/browser capture-attached-current`
- `/browser collect-attached-jobs`
- `/browser save-attached-jobs`
- `/browser autofill-attached-current`
- `/browser process-visible-jobs`
- `/browser review-attached-form`
- `/browser autofill-attached-form`
- `/browser process-visible-external-jobs`
- `/browser start-autopilot`
- `/quit`

## Real Browser Attach Mode

If Google blocks sign-in inside the Playwright-managed browser, use a real Chrome session with remote debugging:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-debug-chrome.ps1
```

Then log in manually in that Chrome window and run:

```bash
npm run cli -- browser collect-attached-jobs
npm run cli -- browser save-attached-jobs
npm run cli -- browser review-linkedin-attached
npm run cli -- browser capture-attached-current
npm run cli -- browser autofill-attached-current
npm run cli -- browser process-visible-jobs
npm run cli -- browser review-attached-form
npm run cli -- browser autofill-attached-form
npm run cli -- browser process-visible-external-jobs
npm run cli -- browser start-autopilot
```

## Notes

- This repo is intentionally local-first.
- Browser sessions use a persistent Playwright profile in `.browser-profile/`.
- Set `JAA_BROWSER_CHANNEL=msedge` to use Microsoft Edge instead of Chrome.
- `browser capture-linkedin-current` is meant for a page you already opened in the persistent browser profile.
- `browser review-linkedin-current` opens the current LinkedIn application flow, inspects visible fields, and stops before any submit action.
- Attach mode connects to a real Chrome session at `http://127.0.0.1:9222`.
- `browser collect-attached-jobs` scrapes visible job cards from the current LinkedIn collection/search page.
- `browser save-attached-jobs` saves visible attached-browser jobs into `data/jobs.json`.
- `browser autofill-attached-current` fills common Easy Apply fields from your saved profile and stops before submit.
- `browser process-visible-jobs` iterates visible jobs, opens each one, checks for Easy Apply, autofills common fields, and stops before submit.
- `browser review-attached-form` inspects the current employer-site application page and lists detected fields.
- `browser autofill-attached-form` fills common employer-site application fields and stops before final submit.
- `browser process-visible-external-jobs` stays on the LinkedIn collection page, clicks previews, captures external employer apply URLs, and saves companies when detected compensation is at least `$250k`.
- `browser start-autopilot` starts the attached-browser batch flow from LinkedIn remote jobs if the debug browser is available.
- It still does not auto-submit applications. That should stay behind explicit commands.

## Batch Controls

Use environment variables to control the attached-browser batch collector:

```powershell
$env:JAA_BATCH_LIMIT="10"
$env:JAA_PAGE_LIMIT="3"
npm run cli -- browser process-visible-external-jobs
```

- `JAA_BATCH_LIMIT` caps total jobs processed in one run.
- `JAA_PAGE_LIMIT` caps how many LinkedIn result pages the collector advances through.
