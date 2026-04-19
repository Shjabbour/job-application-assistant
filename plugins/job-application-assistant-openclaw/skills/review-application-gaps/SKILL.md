---
name: review-application-gaps
description: Review unanswered application questions, attached form state, and recent browser artifacts before retrying autofill or submission in this repo.
---

# Review Application Gaps

Use this skill only inside the `job-application-assistant` repository.

This skill is for diagnosis before another submit attempt. It uses the repo's existing commands and local data, not a separate automation engine.

Primary wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 <action> [args]
```

## Primary review actions

- `review-unanswered-questions [limit]`
- `review-attached-form`
- `review-linkedin-attached`
- `review-current-form`
- `review-form-url <url>`
- `save-application-answer <text|radio|checkbox|select> "<pattern>" "<value>"`
- `autofill-attached-form`
- `auto-apply-attached-form`
- `autofill-current-form`
- `autofill-form-url <url>`

## Files to inspect

- `data/browser/*.json`
- `data/application-answers.json`
- `data/question-bank.json`
- `data/jobs.json`

## Review rules

1. Start with `review-unanswered-questions` when a prior automation run stopped on missing answers or unknown fields.
2. If the application is open in the attached Chrome session, run `review-attached-form` before any retry.
3. Read the newest `data/browser/*.json` artifacts and extract:
   `stopReason`, `unresolvedRequired`, `notes`, `externalApplyFound`, `trackerAction`, and any employer-site routing details.
4. Compare unresolved labels against `data/application-answers.json` and `data/question-bank.json`.
5. If a stable answer is missing, add it with `save-application-answer ...` before rerunning autofill.
6. Do not jump to `auto-apply-*` until unresolved required fields are either answered or explicitly accepted by the user.

## Recommended workflow

### Diagnose a blocked application

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 review-unanswered-questions 20
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 review-attached-form
```

Then inspect the newest relevant files in `data/browser/`.

### Save a missing answer and retry

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 save-application-answer text "years of react experience" "5"
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 autofill-attached-form
```

### Review one external employer form by URL

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 review-form-url "https://company.example/apply"
```

## Expected output

Produce a short diagnosis that answers:

- what blocked the previous attempt
- which required fields are still unresolved
- whether the answer bank already contains a matching answer
- what exact command should run next

If nothing is clearly blocking submission, only then recommend `auto-apply-attached-form`, `apply-job-url <url>`, or `apply-saved-jobs`.
