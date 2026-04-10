export type Profile = {
  name: string;
  email: string;
  phone: string;
  location: string;
  city: string;
  state: string;
  linkedinUrl: string;
  resumeSummary: string;
  skills: string[];
  targetRoles: string[];
  workAuthorization: string;
  yearsOfExperience: string;
};

export type JobStatus =
  | "saved"
  | "researching"
  | "applying"
  | "applied"
  | "interviewing"
  | "closed";

export type Job = {
  id: string;
  title: string;
  company: string;
  url: string;
  source: string;
  status: JobStatus;
  description: string;
  notes: string;
  createdAt: string;
};

export type ExtractedJobDraft = {
  title: string;
  company: string;
  description: string;
  source: string;
  url: string;
};

export type ApplicationField = {
  label: string;
  type: string;
  required: boolean;
};

export type LinkedInApplyReview = {
  url: string;
  title: string;
  company: string;
  hasEasyApply: boolean;
  stage: string;
  primaryAction: string;
  fields: ApplicationField[];
  notes: string[];
};

export type JobCollectionItem = {
  title: string;
  company: string;
  url: string;
  location: string;
  compensationText?: string;
  estimatedMaxAnnualCompensation?: number | null;
};

export type AutofillResult = {
  filled: string[];
  skipped: string[];
  nextAction: string;
  stoppedBeforeSubmit: boolean;
};

export type SiteFormReview = {
  url: string;
  title: string;
  fields: ApplicationField[];
  primaryAction: string;
  notes: string[];
};

export type WorkloadScreening = {
  pass: boolean;
  score: number;
  reasons: string[];
  matchedPositiveSignals: string[];
  matchedNegativeSignals: string[];
};

export type ExternalApplyResult = {
  sourceJobUrl: string;
  sourceJobTitle: string;
  sourceCompany?: string;
  compensationText?: string;
  estimatedMaxAnnualCompensation?: number | null;
  workloadScreening?: WorkloadScreening;
  destinationUrl: string;
  destinationTitle: string;
  externalApplyFound: boolean;
  autofill: AutofillResult | null;
  review: SiteFormReview | null;
  notes: string[];
};

export type HighPayingCompanyRecord = {
  company: string;
  title: string;
  sourceJobUrl: string;
  compensationText: string;
  estimatedMaxAnnualCompensation: number;
  capturedAt: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
