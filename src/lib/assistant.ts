import type { Job, Profile } from "./types.js";

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function uniqueMatches(profile: Profile, job: Job): string[] {
  const profileTerms = new Set(
    [...profile.skills, ...profile.targetRoles, profile.resumeSummary]
      .flatMap(words)
      .filter(Boolean),
  );

  const jobTerms = new Set(words([job.title, job.company, job.description].join(" ")));

  return [...profileTerms].filter((term) => jobTerms.has(term)).slice(0, 12);
}

export function summarizeJob(job: Job): string {
  const desc = job.description.trim();
  if (!desc) {
    return "No description saved yet. Add the job description for better tailoring.";
  }

  return desc.length > 320 ? `${desc.slice(0, 317)}...` : desc;
}

export function buildFitSummary(profile: Profile, job: Job): string {
  const matches = uniqueMatches(profile, job);
  const score = Math.min(95, 35 + matches.length * 8);

  return [
    `Fit score: ${score}/100`,
    `Role: ${job.title} at ${job.company}`,
    matches.length > 0
      ? `Matched profile terms: ${matches.join(", ")}`
      : "Matched profile terms: none yet. Your profile likely needs more detail.",
    `Summary: ${summarizeJob(job)}`,
  ].join("\n");
}

export function buildApplicationPlan(profile: Profile, job: Job): string {
  const matches = uniqueMatches(profile, job);

  const bullets = [
    `Target role: ${job.title} at ${job.company}.`,
    `Update your resume headline to align with ${job.title}.`,
    matches.length > 0
      ? `Highlight these relevant terms in your resume and application answers: ${matches.join(", ")}.`
      : "Add clearer skills and achievements to your profile so the assistant can tailor better.",
    "Customize 3-5 bullets in your resume to match the job description language.",
    "Prepare a short answer for why this company and why this role.",
    "Save the application date, recruiter name, and follow-up deadline after submission.",
  ];

  return bullets.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

export function buildLinkedInDraft(profile: Profile, job: Job): string {
  const firstName = profile.name.trim().split(/\s+/)[0] || "there";

  return [
    `Hi ${firstName},`,
    "",
    `I’m interested in the ${job.title} role at ${job.company} and wanted to reach out directly.`,
    "My background aligns with the role, and I’ve been reviewing the position closely.",
    "If there’s a recruiter or hiring manager I should connect with, I’d appreciate the direction.",
    "",
    "Thank you,",
    profile.name || "[Your Name]",
  ].join("\n");
}

export function answerChat(input: string, profile: Profile, jobs: Job[]): string {
  const normalized = input.trim().toLowerCase();

  if (normalized.includes("help")) {
    return [
      "You can ask me to review your saved jobs, suggest priorities, or help with LinkedIn outreach.",
      "Try commands like `/jobs`, `/job plan <id>`, or `/job linkedin <id>`.",
    ].join("\n");
  }

  if (normalized.includes("what should i apply to")) {
    if (jobs.length === 0) {
      return "No jobs saved yet. Use `/job add` first.";
    }

    const ranked = [...jobs]
      .map((job) => ({
        job,
        score: uniqueMatches(profile, job).length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return ranked
      .map(
        ({ job, score }, index) =>
          `${index + 1}. ${job.id} | ${job.title} at ${job.company} | match signals: ${score}`,
      )
      .join("\n");
  }

  if (normalized.includes("linkedin")) {
    return "Use `/job linkedin <id>` to generate a LinkedIn outreach draft for a saved job.";
  }

  return [
    "I can help you track jobs, plan applications, and draft LinkedIn outreach.",
    `Saved jobs: ${jobs.length}`,
    `Target roles in profile: ${profile.targetRoles.join(", ") || "none yet"}`,
  ].join("\n");
}

