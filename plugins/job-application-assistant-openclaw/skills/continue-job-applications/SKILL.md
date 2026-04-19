---
name: continue-job-applications
description: Continue LinkedIn and employer-site application flows in this repo by using the local CLI, dashboard, attached Chrome session, and browser artifacts.
---

# Continue Job Applications

Use this skill only inside the `job-application-assistant` repository.

This bundle is intentionally thin. It does not replace the repo's browser logic. It tells OpenClaw to drive the existing local commands through the repo helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 <action> [args]
```

## Primary actions

- `setup`
- `dashboard`
- `dashboard-public`
- `start-debug-chrome`
- `attach-help`
- `save-remote-jobs`
- `apply-saved-jobs`
- `apply-job-url <url>`
- `review-linkedin-attached`
- `review-attached-form`
- `autofill-attached-form`
- `auto-apply-attached-form`
- `review-unanswered-questions [limit]`
- `save-application-answer <text|radio|checkbox|select> "<pattern>" "<value>"`
- `start-autopilot`
- `start-full-autopilot`

Any action not listed above can still be forwarded if the repo already supports it as `npm run cli -- browser <action>`.

## Working rules

1. Run `setup` once before using browser automation in a fresh clone.
2. If LinkedIn authentication blocks the managed browser, run `start-debug-chrome` and wait for the user to finish logging in manually.
3. Prefer the bounded flow before large batch runs:
   `save-remote-jobs` -> `review-linkedin-attached` or `apply-job-url <url>` -> `apply-saved-jobs`
4. Use `start-full-autopilot` only when the user clearly wants batch submission.
5. Review outputs in `data/browser/`, `data/application-answers.json`, and `data/question-bank.json` when diagnosing failures or unanswered questions.

## Recommended flow

### Continue LinkedIn applications

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 setup
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 start-debug-chrome
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 save-remote-jobs
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 apply-saved-jobs
```

### Continue one specific job

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 apply-job-url "https://www.linkedin.com/jobs/view/1234567890/"
```

### Review unanswered fields before retrying

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 review-unanswered-questions 20
```

## Notes

- The dashboard defaults to `http://127.0.0.1:3030`.
- Browser artifacts are written to `data/browser/*.json`.
- The attached Chrome workflow uses `start-debug-chrome.ps1` and remote debugging on port `9222`.
