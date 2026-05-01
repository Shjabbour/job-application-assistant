export type Profile = {
  name: string;
  email: string;
  phone: string;
  location: string;
  city: string;
  state: string;
  postalCode: string;
  streetAddress: string;
  addressLine2: string;
  linkedinUrl: string;
  resumeFilePath: string;
  coverLetterFilePath: string;
  resumeTextPath: string;
  resumeSummary: string;
  skills: string[];
  targetRoles: string[];
  workAuthorization: string;
  yearsOfExperience: string;
};

export const JOB_STATUSES = [
  "saved",
  "researching",
  "applying",
  "blocked",
  "applied",
  "interviewing",
  "closed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

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
  evaluation?: JobEvaluationSnapshot;
};

export const FOLLOW_UP_CATEGORIES = [
  "confirmation",
  "status_update",
  "action_required",
  "assessment",
  "interview",
  "recruiter_reply",
  "rejection",
  "manual_follow_up",
  "unknown",
] as const;

export type FollowUpCategory = (typeof FOLLOW_UP_CATEGORIES)[number];

export const FOLLOW_UP_STATUSES = ["open", "waiting", "done", "closed"] as const;

export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export type FollowUpPriority = "high" | "medium" | "low";

export type FollowUpSource = "email" | "tracker";

export type FollowUpEmailCandidate = {
  sender: string;
  subject: string;
  snippet: string;
  bodyText?: string;
  receivedAt: string;
  sourceUrl: string;
  accountIndex: number;
  searchQuery: string;
  detectedAt: string;
};

export type FollowUpAction = {
  id: string;
  source: FollowUpSource;
  status: FollowUpStatus;
  category: FollowUpCategory;
  priority: FollowUpPriority;
  jobId?: string;
  jobTitle: string;
  company: string;
  sender: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  detectedAt: string;
  updatedAt: string;
  dueAt: string;
  nextAction: string;
  evidence: string[];
  sourceUrl?: string;
  searchQuery?: string;
  confidence: number;
};

export type ExtractedJobDraft = {
  title: string;
  company: string;
  description: string;
  source: string;
  url: string;
};

export type JobEnrichmentResult = {
  inputUrl: string;
  normalizedUrl: string;
  success: boolean;
  draft: ExtractedJobDraft | null;
  error?: string;
};

export type ApplicationField = {
  label: string;
  type: string;
  required: boolean;
};

export type ApplicationSiteKind =
  | "generic"
  | "workday"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "taleo"
  | "hirebridge"
  | "talemetry"
  | "smartrecruiters"
  | "workable"
  | "paycor"
  | "rippling"
  | "phenom"
  | "ukg"
  | "successfactors"
  | "oraclehcm";

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
  submitted?: boolean;
  stopReason?: string;
  finalUrl?: string;
  finalTitle?: string;
  postSubmitDetails?: {
    bodyText?: string;
    sessionStorageApplySuccess?: string;
    candidateInterviewUrl?: string;
  };
  debugSteps?: Array<{
    step: number;
    url: string;
    stage: string;
    nextAction: string;
    fieldCount: number;
    fieldPreview: string[];
  }>;
};

export type SiteFormReview = {
  url: string;
  title: string;
  siteKind: ApplicationSiteKind;
  stage: string;
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
  profileName?: string;
  profileSummary?: string;
};

export const JOB_EVALUATION_DECISIONS = ["saved", "dismissed", "skipped"] as const;

export type JobEvaluationDecision = (typeof JOB_EVALUATION_DECISIONS)[number];

export type JobEvaluationSnapshot = WorkloadScreening & {
  decision?: JobEvaluationDecision;
  evaluatedAt?: string;
  trackedBy?: string;
  alreadySaved?: boolean;
};

export type JobEvaluationSignal = {
  phrase: string;
  score: number;
  reason: string;
  hardReject?: boolean;
  appliesTo?: "all" | "title" | "company" | "description";
};

export type JobEvaluationProfile = {
  name: string;
  summary: string;
  saveWhen: string[];
  avoidWhen: string[];
  maxScore: number;
  positiveSignals: JobEvaluationSignal[];
  negativeSignals: JobEvaluationSignal[];
};

export type JobEvaluationProfilesState = {
  activeProfileName: string;
  profiles: JobEvaluationProfile[];
};

export type JobEvaluationDecisionRecord = JobEvaluationSnapshot & {
  id: string;
  title: string;
  company: string;
  url: string;
  normalizedUrl: string;
  source: string;
  descriptionSnippet: string;
  decision: JobEvaluationDecision;
  jobId?: string;
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
  siteKind?: ApplicationSiteKind;
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
