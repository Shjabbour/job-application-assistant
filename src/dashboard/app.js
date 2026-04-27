const STAGE_ORDER = ["enrich", "ready", "external", "filed"];
const STAGE_LABELS = {
  enrich: "Needs Cleanup",
  ready: "Ready to Apply",
  external: "Employer Route",
  filed: "Applied",
};

const STAGE_HELP_TEXT = {
  enrich: "Jobs that still need cleaner metadata before applying.",
  ready: "Jobs that are ready for a normal LinkedIn apply flow.",
  external: "Jobs that already point to an employer-hosted application route.",
  filed: "Jobs already submitted or moved beyond the active filing flow.",
};

const ACTION_CONSOLE_TABS = [
  { id: "runner", label: "Runner" },
  { id: "tunnel", label: "Public Link" },
  { id: "history", label: "Recent Runs" },
];

const PRIMARY_ACTION_IDS = [
  "start-debug-browser",
  "browser-review-linkedin-attached",
  "browser-auto-apply-attached-current",
  "browser-start-full-autopilot",
];

const LINKEDIN_REMOTE_JOBS_URL = "https://www.linkedin.com/jobs/collections/remote-jobs/";
const LINKEDIN_JOBS_TRACKER_URL = "https://www.linkedin.com/jobs-tracker/";

const FILING_STATUS_OPTIONS = [
  { value: "saved", label: "Collected" },
  { value: "researching", label: "Reviewing" },
  { value: "applying", label: "In Form Fill" },
  { value: "blocked", label: "Blocked" },
  { value: "applied", label: "Filed" },
  { value: "interviewing", label: "Post-filed" },
  { value: "closed", label: "Closed" },
];

const THEME_STORAGE_KEY = "jobApplicationAssistant.theme";
const DEFAULT_THEME = "dark";

const state = {
  snapshot: null,
  selectedQuestionKey: "",
  filters: {
    stage: "all",
    search: "",
    source: "all",
  },
  formDirty: false,
  saveState: "",
  questionSaveState: "",
  questionBucket: "auto",
  draftJobId: "",
  detailDraft: null,
  actionConfig: {
    url: "",
    enrichLimit: 10,
    batchLimit: 25,
    pageLimit: 3,
  },
  actionStatusMessage: "",
  evaluation: {
    apiState: "idle",
    apiMessage: "",
    profiles: [],
    activeProfileName: "",
    selectedProfileName: "",
    draftOriginalName: "",
    draft: null,
    dirty: false,
    saveState: "",
  },
  ui: {
    consoleTab: "runner",
    actionGroup: null,
    theme: DEFAULT_THEME,
  },
};

const elements = {
  appStatus: document.getElementById("appStatus"),
  generatedAt: document.getElementById("generatedAt"),
  focusSummary: document.getElementById("focusSummary"),
  focusNextStep: document.getElementById("focusNextStep"),
  summaryGrid: document.getElementById("summaryGrid"),
  searchInput: document.getElementById("searchInput"),
  statusFilter: document.getElementById("statusFilter"),
  sourceFilter: document.getElementById("sourceFilter"),
  refreshButton: document.getElementById("refreshButton"),
  workspaceGuide: document.getElementById("workspaceGuide"),
  supportOverview: document.getElementById("supportOverview"),
  actionPanel: document.getElementById("actionPanel"),
  activityPanel: document.getElementById("activityPanel"),
  attentionPanel: document.getElementById("attentionPanel"),
  profilePanel: document.getElementById("profilePanel"),
  questionCapturePanel: document.getElementById("questionCapturePanel"),
  artifactPanel: document.getElementById("artifactPanel"),
  companyPanel: document.getElementById("companyPanel"),
  themeToggle: document.getElementById("themeToggle"),
};

initializeTheme();
bindEvents();
void loadDashboard();
window.setInterval(() => {
  void loadDashboard({ silent: true });
}, 4_000);

function bindEvents() {
  bindSectionMap();
  bindThemeToggle();

  elements.searchInput?.addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    syncBoardStage();
    renderWorkflowPanels();
  });

  elements.statusFilter?.addEventListener("change", (event) => {
    state.filters.stage = event.target.value;
    syncBoardStage();
    renderWorkflowPanels();
  });

  elements.sourceFilter?.addEventListener("change", (event) => {
    state.filters.source = event.target.value;
    syncBoardStage();
    renderWorkflowPanels();
  });

  elements.refreshButton?.addEventListener("click", () => {
    void loadDashboard();
  });
}

function initializeTheme() {
  state.ui.theme = getStoredTheme();
  applyTheme(state.ui.theme);
}

function getStoredTheme() {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "light" || storedTheme === "dark" ? storedTheme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function bindThemeToggle() {
  elements.themeToggle?.addEventListener("click", () => {
    const nextTheme = state.ui.theme === "dark" ? "light" : "dark";
    state.ui.theme = nextTheme;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Theme switching should still work when storage is unavailable.
    }

    applyTheme(nextTheme);
  });
}

function applyTheme(theme) {
  const normalizedTheme = theme === "light" ? "light" : DEFAULT_THEME;
  document.documentElement.dataset.theme = normalizedTheme;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", normalizedTheme === "light" ? "#f5f7fb" : "#09111a");

  if (!elements.themeToggle) {
    return;
  }

  const isLight = normalizedTheme === "light";
  elements.themeToggle.setAttribute("aria-pressed", String(isLight));
  elements.themeToggle.setAttribute("aria-label", isLight ? "Switch to dark mode" : "Switch to light mode");

  const label = elements.themeToggle.querySelector(".theme-toggle-text");
  if (label) {
    label.textContent = isLight ? "Light" : "Dark";
  }
}

function bindSectionMap() {
  const links = Array.from(document.querySelectorAll(".section-map-link"));
  if (links.length === 0) {
    return;
  }

  const sectionLinks = links
    .map((link) => {
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("#")) {
        return null;
      }

      const section = document.querySelector(href);
      if (!(section instanceof HTMLElement)) {
        return null;
      }

      return { link, section };
    })
    .filter(Boolean);

  if (sectionLinks.length === 0) {
    return;
  }

  const setActiveSection = (sectionId) => {
    sectionLinks.forEach(({ link, section }) => {
      link.classList.toggle("is-active", section.id === sectionId);
    });
  };

  let currentSectionId = sectionLinks[0].section.id;

  const syncFromHash = () => {
    const hash = window.location.hash;
    if (!hash.startsWith("#")) {
      setActiveSection(currentSectionId);
      return;
    }

    const linked = sectionLinks.find(({ section }) => `#${section.id}` === hash);
    if (linked) {
      currentSectionId = linked.section.id;
      setActiveSection(currentSectionId);
    }
  };

  if (!("IntersectionObserver" in window)) {
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const visibleEntries = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio);

      if (visibleEntries.length === 0) {
        setActiveSection(currentSectionId);
        return;
      }

      currentSectionId = visibleEntries[0].target.id;
      setActiveSection(currentSectionId);
    },
    {
      rootMargin: "-16% 0px -62% 0px",
      threshold: [0.15, 0.3, 0.55],
    },
  );

  sectionLinks.forEach(({ section }) => observer.observe(section));
  syncFromHash();
  window.addEventListener("hashchange", syncFromHash);
}

async function loadDashboard(options = {}) {
  const { silent = false } = options;

  if (!silent) {
    setAppStatus("Refreshing filing automation dashboard");
  }

  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Dashboard request failed with ${response.status}`);
    }

    state.snapshot = await response.json();
    await loadEvaluationProfiles({ preserveDraft: state.evaluation.dirty });
    syncActionDefaults();
    syncFilterOptions();
    syncQuestionSelection();
    renderAll();
    setDashboardStatus();
  } catch (error) {
    setAppStatus(error instanceof Error ? error.message : "Dashboard load failed");
  }
}

async function loadEvaluationProfiles(options = {}) {
  const { preserveDraft = false, preferredName = "" } = options;

  state.evaluation.apiState = state.evaluation.apiState === "idle" ? "loading" : state.evaluation.apiState;

  try {
    const response = await fetch("/api/evaluation-profiles", { cache: "no-store" });

    if (response.status === 404) {
      state.evaluation.apiState = "missing";
      state.evaluation.apiMessage = "Evaluation profile API not available yet.";
      if (!preserveDraft) {
        state.evaluation.profiles = [];
        state.evaluation.activeProfileName = "";
        state.evaluation.selectedProfileName = "";
        state.evaluation.draftOriginalName = "";
        state.evaluation.draft = null;
        state.evaluation.dirty = false;
        state.evaluation.saveState = "";
      }
      return;
    }

    if (!response.ok) {
      throw new Error(`Evaluation profile request failed with ${response.status}`);
    }

    const payload = await response.json().catch(() => ({}));
    const normalized = normalizeEvaluationProfilesPayload(payload);

    state.evaluation.apiState = "ready";
    state.evaluation.apiMessage = "";
    state.evaluation.profiles = normalized.profiles;
    state.evaluation.activeProfileName = normalized.activeProfileName;

    const availableNames = new Set(normalized.profiles.map((profile) => profile.name));
    const nextPreferredName =
      preserveDraft && state.evaluation.selectedProfileName && availableNames.has(state.evaluation.selectedProfileName)
        ? state.evaluation.selectedProfileName
        : cleanText(preferredName) && availableNames.has(cleanText(preferredName))
          ? cleanText(preferredName)
        : normalized.activeProfileName || normalized.profiles[0]?.name || "";

    if (!preserveDraft || !state.evaluation.draft) {
      state.evaluation.selectedProfileName = nextPreferredName;
      state.evaluation.draftOriginalName = nextPreferredName;
      state.evaluation.draft = nextPreferredName
        ? cloneEvaluationProfile(normalized.profiles.find((profile) => profile.name === nextPreferredName) || createEmptyEvaluationProfile())
        : null;
      state.evaluation.dirty = false;
      state.evaluation.saveState = "";
      return;
    }

    if (!availableNames.has(state.evaluation.selectedProfileName)) {
      state.evaluation.selectedProfileName = nextPreferredName;
      state.evaluation.draftOriginalName = nextPreferredName;
      state.evaluation.draft = nextPreferredName
        ? cloneEvaluationProfile(normalized.profiles.find((profile) => profile.name === nextPreferredName) || createEmptyEvaluationProfile())
        : null;
      state.evaluation.dirty = false;
      state.evaluation.saveState = "";
    }
  } catch (error) {
    state.evaluation.apiState = "error";
    state.evaluation.apiMessage = error instanceof Error ? error.message : "Evaluation profile request failed";
  }
}

function createEmptyEvaluationProfile(name = "") {
  return {
    name,
    summary: "",
    maxScore: 3,
    saveWhen: [],
    avoidWhen: [],
    positiveSignals: [],
    negativeSignals: [],
  };
}

function cloneEvaluationSignal(signal = {}) {
  return {
    phrase: cleanText(signal.phrase || ""),
    score: Number.isFinite(Number(signal.score)) ? Number(signal.score) : 0,
    reason: cleanText(signal.reason || ""),
    appliesTo: normalizeSignalScope(signal.appliesTo),
    hardReject: Boolean(signal.hardReject),
  };
}

function cloneEvaluationProfile(profile = createEmptyEvaluationProfile()) {
  return {
    name: cleanText(profile.name || ""),
    summary: cleanText(profile.summary || ""),
    maxScore: Number.isFinite(Number(profile.maxScore)) ? Number(profile.maxScore) : 3,
    saveWhen: Array.isArray(profile.saveWhen) ? profile.saveWhen.map((entry) => cleanText(entry)).filter(Boolean) : [],
    avoidWhen: Array.isArray(profile.avoidWhen) ? profile.avoidWhen.map((entry) => cleanText(entry)).filter(Boolean) : [],
    positiveSignals: Array.isArray(profile.positiveSignals)
      ? profile.positiveSignals.map((signal) => cloneEvaluationSignal(signal)).filter((signal) => signal.phrase || signal.reason)
      : [],
    negativeSignals: Array.isArray(profile.negativeSignals)
      ? profile.negativeSignals.map((signal) => cloneEvaluationSignal(signal)).filter((signal) => signal.phrase || signal.reason)
      : [],
  };
}

function normalizeSignalScope(value) {
  return ["all", "title", "company", "description"].includes(value) ? value : "all";
}

function normalizeEvaluationProfilesPayload(payload) {
  const profilesInput = Array.isArray(payload?.profiles)
    ? payload.profiles
    : Array.isArray(payload)
      ? payload
      : payload?.name
        ? [payload]
        : [];
  const profiles = profilesInput
    .map((profile) => cloneEvaluationProfile(profile))
    .filter((profile) => profile.name);
  const activeProfileName = cleanText(payload?.activeProfileName || payload?.selectedProfileName || profiles[0]?.name || "");

  return {
    profiles,
    activeProfileName,
  };
}

function getStoredSelectedEvaluationProfile() {
  if (!state.evaluation.selectedProfileName) {
    return null;
  }

  return state.evaluation.profiles.find((profile) => profile.name === state.evaluation.selectedProfileName) || null;
}

function getEditableEvaluationProfile() {
  if (state.evaluation.draft) {
    return state.evaluation.draft;
  }

  const selected = getStoredSelectedEvaluationProfile();
  return selected ? cloneEvaluationProfile(selected) : null;
}

function getActiveEvaluationProfile() {
  if (!state.evaluation.activeProfileName) {
    return null;
  }

  return state.evaluation.profiles.find((profile) => profile.name === state.evaluation.activeProfileName) || null;
}

function updateEvaluationSaveState(message) {
  state.evaluation.saveState = message;
  const saveState = document.getElementById("evaluationSaveState");
  if (saveState) {
    saveState.textContent = message;
  }
}

function markEvaluationDirty(message = "Unsaved evaluation changes") {
  state.evaluation.dirty = true;
  updateEvaluationSaveState(message);
}

function buildEvaluationInsights(snapshot) {
  if (!snapshot) {
    return {
      decisions: [],
      savedDecisionCount: 0,
      dismissedDecisionCount: 0,
      skippedDecisionCount: 0,
      profileNamesSeen: [],
      latestDecision: null,
      savedQueue: [],
      evaluatedSavedJobs: [],
      missingSavedJobs: [],
      flaggedSavedJobs: [],
      activeProfileName: state.evaluation.activeProfileName || "",
    };
  }

  const evaluationSnapshot = snapshot.evaluation || {};
  const rawDecisions = Array.isArray(evaluationSnapshot.decisions)
    ? [...evaluationSnapshot.decisions]
    : Array.isArray(evaluationSnapshot.recentDecisions)
      ? [...evaluationSnapshot.recentDecisions]
      : [];
  const decisions = rawDecisions.map((decision) => {
    const action = decision.action || decision.decision || (decision.pass ? "saved" : "dismissed");
    return {
      ...decision,
      action,
      actionLabel: decision.actionLabel || capitalize(action),
      timestamp: decision.timestamp || decision.evaluatedAt || "",
    };
  });
  const latestDecisionByUrl = new Map();

  for (const decision of decisions) {
    const key = normalizeJobUrlKey(decision.normalizedUrl || decision.url);
    if (key && !latestDecisionByUrl.has(key)) {
      latestDecisionByUrl.set(key, decision);
    }
  }

  const savedQueue = snapshot.jobs
    .map((job) => buildSavedQueueEvaluation(job, latestDecisionByUrl.get(normalizeJobUrlKey(job.url))))
    .sort(
      (left, right) =>
        Date.parse(right.screening?.evaluatedAt || right.job.latestAutomationEventAt || right.job.createdAt || "") -
        Date.parse(left.screening?.evaluatedAt || left.job.latestAutomationEventAt || left.job.createdAt || ""),
    );

  const evaluatedSavedJobs = savedQueue.filter((entry) => Boolean(entry.screening));
  const missingSavedJobs = savedQueue.filter((entry) => !entry.screening);
  const flaggedSavedJobs = savedQueue.filter((entry) => entry.screening && !entry.screening.pass);
  const profileNamesSeen = [
    ...new Set([
      ...(Array.isArray(evaluationSnapshot.profiles?.profiles)
        ? evaluationSnapshot.profiles.profiles.map((profile) => profile.name).filter(Boolean)
        : []),
      ...decisions.map((decision) => decision.profileName).filter(Boolean),
    ]),
  ];

  return {
    decisions,
    savedDecisionCount:
      Number(evaluationSnapshot.stats?.savedCount) ||
      decisions.filter((decision) => decision.decision === "saved" || decision.action === "saved").length,
    dismissedDecisionCount:
      Number(evaluationSnapshot.stats?.dismissedCount) ||
      decisions.filter((decision) => decision.decision === "dismissed" || decision.action === "dismissed").length,
    skippedDecisionCount:
      Number(evaluationSnapshot.stats?.skippedCount) ||
      decisions.filter((decision) => decision.decision === "skipped" || decision.action === "skipped").length,
    profileNamesSeen,
    latestDecision:
      (Array.isArray(evaluationSnapshot.recentDecisions) ? evaluationSnapshot.recentDecisions[0] : null) ||
      decisions[0] ||
      null,
    savedQueue,
    evaluatedSavedJobs,
    missingSavedJobs,
    flaggedSavedJobs,
    activeProfileName:
      evaluationSnapshot.activeProfile?.name ||
      state.evaluation.activeProfileName ||
      profileNamesSeen[0] ||
      evaluatedSavedJobs[0]?.screening?.profileName ||
      "",
  };
}

function parseEvaluationDecisionsFromRun(run) {
  if (
    !run?.logs?.length ||
    !["browser-save-remote-jobs", "browser-start-autopilot"].includes(run.actionId)
  ) {
    return [];
  }

  const lines = run.logs.map(stripRunLogLine).filter((line) => line);
  const profile = parseEvaluationProfileFromLines(lines);
  const decisions = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^(\d+)\.\s+([A-Z-]+)\s+\|\s+(.+)$/);
    if (!header) {
      continue;
    }

    const rawAction = cleanText(header[2]);
    if (!["SAVED", "DISMISSED", "SKIPPED", "ALREADY-SAVED"].includes(rawAction)) {
      continue;
    }

    const titleAndCompany = cleanText(header[3]);
    const splitIndex = titleAndCompany.lastIndexOf(" @ ");
    const title = splitIndex >= 0 ? cleanText(titleAndCompany.slice(0, splitIndex)) : titleAndCompany;
    const company = splitIndex >= 0 ? cleanText(titleAndCompany.slice(splitIndex + 3)) : "";
    let url = "";
    let score = null;
    let reasons = [];
    let cursor = index + 1;

    while (cursor < lines.length) {
      const line = lines[cursor];
      if (/^\d+\.\s+[A-Z-]+\s+\|/.test(line) || /^Reviewed:/.test(line)) {
        break;
      }

      if (/^URL:/i.test(line)) {
        url = cleanText(line.replace(/^URL:\s*/i, ""));
      } else if (/^Score:/i.test(line)) {
        const nextScore = Number(line.replace(/^Score:\s*/i, ""));
        score = Number.isFinite(nextScore) ? nextScore : null;
      } else if (/^Reasons:/i.test(line)) {
        reasons = line
          .replace(/^Reasons:\s*/i, "")
          .split(";")
          .map((reason) => cleanText(reason))
          .filter((reason) => reason && reason.toLowerCase() !== "none");
      }

      cursor += 1;
    }

    decisions.push({
      id: `${run.runId}:${header[1]}:${rawAction}`,
      action: rawAction === "SAVED" || rawAction === "ALREADY-SAVED" ? "saved" : "dismissed",
      actionLabel:
        rawAction === "ALREADY-SAVED"
          ? "Already saved"
          : rawAction === "SAVED"
            ? "Saved"
            : "Dismissed",
      title,
      company,
      url,
      score,
      reasons,
      profileName: profile.name,
      profileSummary: profile.summary,
      timestamp: run.endedAt || run.startedAt,
      runLabel: run.label,
      runStatus: run.status,
    });

    index = cursor - 1;
  }

  return decisions;
}

function parseEvaluationProfileFromLines(lines) {
  const line = lines.find((entry) => /^Evaluation profile:/i.test(entry));
  if (!line) {
    return { name: "", summary: "" };
  }

  const value = cleanText(line.replace(/^Evaluation profile:\s*/i, ""));
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    return { name: value, summary: "" };
  }

  return {
    name: cleanText(value.slice(0, colonIndex)),
    summary: cleanText(value.slice(colonIndex + 1)),
  };
}

function buildSavedQueueEvaluation(job, fallbackDecision) {
  const jobEvaluation = job.evaluation
    ? {
      ...job.evaluation,
      evaluatedAt: job.evaluation.evaluatedAt || job.createdAt,
      source: "saved-job",
    }
    : null;

  const logEvaluation = fallbackDecision
    ? {
      pass: (fallbackDecision.decision || fallbackDecision.action) === "saved",
      score: fallbackDecision.score,
      reasons: fallbackDecision.reasons,
      profileName: fallbackDecision.profileName,
      profileSummary: fallbackDecision.profileSummary,
      evaluatedAt: fallbackDecision.evaluatedAt || fallbackDecision.timestamp,
      source: "runner-log",
    }
    : null;

  return {
    job,
    screening: jobEvaluation || logEvaluation,
    latestDecision: fallbackDecision || null,
  };
}

function parseLineList(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function ensureEvaluationDraft() {
  if (!state.evaluation.draft) {
    const selected = getStoredSelectedEvaluationProfile() || createEmptyEvaluationProfile();
    state.evaluation.draft = cloneEvaluationProfile(selected);
  }

  return state.evaluation.draft;
}

function uniqueEvaluationProfileName(baseName) {
  const base = cleanText(baseName) || "New profile";
  const existing = new Set(state.evaluation.profiles.map((profile) => profile.name.toLowerCase()));

  if (!existing.has(base.toLowerCase())) {
    return base;
  }

  let counter = 2;
  while (existing.has(`${base} ${counter}`.toLowerCase())) {
    counter += 1;
  }

  return `${base} ${counter}`;
}

function selectEvaluationProfile(name, saveState = "") {
  const selected = state.evaluation.profiles.find((profile) => profile.name === name);
  state.evaluation.selectedProfileName = selected?.name || "";
  state.evaluation.draftOriginalName = selected?.name || "";
  state.evaluation.draft = selected ? cloneEvaluationProfile(selected) : null;
  state.evaluation.dirty = false;
  if (saveState) {
    state.evaluation.saveState = saveState;
  }
}

function buildEvaluationProfilesPayload(options = {}) {
  const { deleteSelected = false, activeProfileName = state.evaluation.activeProfileName } = options;
  const originalName = cleanText(state.evaluation.draftOriginalName || state.evaluation.selectedProfileName);
  const draft = getEditableEvaluationProfile();
  let profiles = state.evaluation.profiles.map((profile) => cloneEvaluationProfile(profile));

  if (deleteSelected) {
    profiles = profiles.filter((profile) => profile.name !== originalName);
  } else if (draft) {
    const normalizedDraft = cloneEvaluationProfile(draft);
    normalizedDraft.name = cleanText(normalizedDraft.name);
    normalizedDraft.summary = cleanText(normalizedDraft.summary);
    if (!normalizedDraft.name) {
      throw new Error("Profile name is required.");
    }

    const index = profiles.findIndex((profile) => profile.name === originalName);
    if (index >= 0) {
      profiles[index] = normalizedDraft;
    } else {
      profiles.push(normalizedDraft);
    }
  }

  profiles = profiles.filter((profile) => cleanText(profile.name));
  if (profiles.length === 0) {
    throw new Error("At least one evaluation profile is required.");
  }

  const seenNames = new Set();
  for (const profile of profiles) {
    const normalizedName = cleanText(profile.name).toLowerCase();
    if (seenNames.has(normalizedName)) {
      throw new Error(`Duplicate evaluation profile name: ${profile.name}`);
    }
    seenNames.add(normalizedName);
  }

  let nextActiveName = cleanText(activeProfileName);
  if (!profiles.some((profile) => profile.name === nextActiveName)) {
    nextActiveName = profiles[0].name;
  }

  return {
    profiles,
    activeProfileName: nextActiveName,
  };
}

function applyEvaluationProfilesResponse(payload, preferredName = "", message = "Evaluation profiles saved") {
  const normalized = normalizeEvaluationProfilesPayload(payload?.profiles || payload);
  state.evaluation.profiles = normalized.profiles;
  state.evaluation.activeProfileName = normalized.activeProfileName;

  const nextSelectedName =
    preferredName && normalized.profiles.some((profile) => profile.name === preferredName)
      ? preferredName
      : normalized.activeProfileName || normalized.profiles[0]?.name || "";

  selectEvaluationProfile(nextSelectedName, message);
}

async function saveEvaluationProfiles(options = {}) {
  const { activateSelected = false, deleteSelected = false } = options;

  try {
    updateEvaluationSaveState(deleteSelected ? "Deleting evaluation profile..." : "Saving evaluation profiles...");

    const requestedActiveName = activateSelected
      ? cleanText(getEditableEvaluationProfile()?.name || state.evaluation.selectedProfileName)
      : state.evaluation.activeProfileName;
    const payload = buildEvaluationProfilesPayload({
      deleteSelected,
      activeProfileName: requestedActiveName,
    });

    const response = await fetch("/api/evaluation-profiles", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.error || `Save failed with ${response.status}`);
    }

    const data = await response.json().catch(() => ({}));
    const preferredName = deleteSelected
      ? payload.activeProfileName
      : cleanText(getEditableEvaluationProfile()?.name || state.evaluation.selectedProfileName);

    applyEvaluationProfilesResponse(
      data.profiles || data,
      preferredName,
      deleteSelected
        ? "Evaluation profile deleted"
        : activateSelected
          ? "Evaluation profile saved and activated"
          : "Evaluation profiles saved",
    );
    await loadDashboard({ silent: true });
  } catch (error) {
    updateEvaluationSaveState(error instanceof Error ? error.message : "Evaluation profile save failed");
  }
}

async function activateEvaluationProfile() {
  const selectedName = cleanText(getEditableEvaluationProfile()?.name || state.evaluation.selectedProfileName);
  if (!selectedName) {
    updateEvaluationSaveState("Select a profile first");
    return;
  }

  if (state.evaluation.dirty) {
    await saveEvaluationProfiles({ activateSelected: true });
    return;
  }

  try {
    updateEvaluationSaveState("Switching active evaluation profile...");
    const response = await fetch("/api/evaluation-profiles/active", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ activeProfileName: selectedName }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.error || `Switch failed with ${response.status}`);
    }

    const data = await response.json().catch(() => ({}));
    applyEvaluationProfilesResponse(data.profiles || data, selectedName, "Active evaluation profile updated");
    await loadDashboard({ silent: true });
  } catch (error) {
    updateEvaluationSaveState(error instanceof Error ? error.message : "Could not switch the active evaluation profile");
  }
}

function renderEvaluationSignalRows(kind, signals) {
  const label = kind === "positiveSignals" ? "positive" : "negative";

  if (!Array.isArray(signals) || signals.length === 0) {
    return `
      <div class="evaluation-readonly">
        <p>No ${escapeHtml(label)} signals yet.</p>
      </div>
    `;
  }

  return `
    <div class="evaluation-signal-list">
      ${signals
        .map(
          (signal, index) => `
            <div class="evaluation-signal-row">
              <div class="evaluation-signal-grid">
                <label class="field">
                  <span>Phrase</span>
                  <input
                    type="text"
                    data-evaluation-signal-field="${escapeAttribute(`${kind}:${index}:phrase`)}"
                    value="${escapeAttribute(signal.phrase || "")}"
                    placeholder="long hours"
                  />
                </label>
                <label class="field">
                  <span>Score</span>
                  <input
                    type="number"
                    step="1"
                    data-evaluation-signal-field="${escapeAttribute(`${kind}:${index}:score`)}"
                    value="${escapeAttribute(String(Number.isFinite(Number(signal.score)) ? Number(signal.score) : 0))}"
                  />
                </label>
                <label class="field">
                  <span>Scope</span>
                  <select data-evaluation-signal-field="${escapeAttribute(`${kind}:${index}:appliesTo`)}">
                    ${["all", "title", "company", "description"]
                      .map(
                        (scope) =>
                          `<option value="${escapeAttribute(scope)}" ${normalizeSignalScope(signal.appliesTo) === scope ? "selected" : ""}>${escapeHtml(scope)}</option>`,
                      )
                      .join("")}
                  </select>
                </label>
                <label class="field">
                  <span>Reason shown on site</span>
                  <input
                    type="text"
                    data-evaluation-signal-field="${escapeAttribute(`${kind}:${index}:reason`)}"
                    value="${escapeAttribute(signal.reason || "")}"
                    placeholder="signals long-hours culture"
                  />
                </label>
              </div>
              <div class="evaluation-signal-actions">
                <label class="evaluation-checkbox">
                  <input
                    type="checkbox"
                    data-evaluation-signal-field="${escapeAttribute(`${kind}:${index}:hardReject`)}"
                    ${signal.hardReject ? "checked" : ""}
                  />
                  <span>Hard reject</span>
                </label>
                <button
                  class="ghost-button"
                  type="button"
                  data-evaluation-signal-remove="${escapeAttribute(`${kind}:${index}`)}"
                >Remove</button>
              </div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderEvaluationProfileSurface(profile, activeProfile, evaluationInsights) {
  if (state.evaluation.apiState === "missing") {
    return `
      ${renderEmptyState({
        eyebrow: "API needed",
        title: "Evaluation profile editing is waiting on /api/evaluation-profiles",
        body: state.evaluation.apiMessage || "The save-lane criteria editor will activate here as soon as the backend exposes the evaluation profile API.",
        tone: "warning",
      })}
      ${
        evaluationInsights.activeProfileName || evaluationInsights.latestDecision?.profileSummary
          ? `
            <div class="evaluation-readonly">
              <p class="signal-label">Latest known profile</p>
              <p class="list-title">${escapeHtml(evaluationInsights.activeProfileName || evaluationInsights.latestDecision?.profileName || "Unknown profile")}</p>
              <p class="timeline-detail">${escapeHtml(evaluationInsights.latestDecision?.profileSummary || "A profile name was seen in runner output, but the editor needs the backend API to load the full library.")}</p>
            </div>
          `
          : ""
      }
    `;
  }

  if (state.evaluation.apiState === "error") {
    return renderEmptyState({
      eyebrow: "API error",
      title: "The evaluation profile editor could not load",
      body: state.evaluation.apiMessage || "The dashboard could not reach the evaluation profile API.",
      tone: "warning",
    });
  }

  if (state.evaluation.apiState !== "ready" || !profile) {
    return renderEmptyState({
      eyebrow: "Loading",
      title: "Loading evaluation profiles",
      body: "The dashboard is fetching the criteria library now.",
      tone: "calm",
    });
  }

  const canDelete = state.evaluation.profiles.length > 1;

  return `
    <div class="evaluation-form">
      <div class="evaluation-toolbar">
        <label class="field">
          <span>Profile</span>
          <select id="evaluationProfileSelect">
            ${state.evaluation.profiles
              .map(
                (entry) =>
                  `<option value="${escapeAttribute(entry.name)}" ${entry.name === state.evaluation.selectedProfileName ? "selected" : ""}>${escapeHtml(entry.name)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <div class="evaluation-toolbar-actions">
          <button class="ghost-button" type="button" data-evaluation-create>Create</button>
          <button class="ghost-button" type="button" data-evaluation-duplicate ${state.evaluation.selectedProfileName ? "" : "disabled"}>Duplicate</button>
          <button class="ghost-button" type="button" data-evaluation-delete ${canDelete ? "" : "disabled"}>Delete</button>
          <button class="ghost-button" type="button" data-evaluation-activate ${profile.name === activeProfile?.name && !state.evaluation.dirty ? "disabled" : ""}>Make active</button>
          <button class="action-button" type="button" data-evaluation-save>Save criteria</button>
        </div>
      </div>

      <div class="metric-row">
        <div class="metric-pill">
          <span>Active now</span>
          <strong>${escapeHtml(activeProfile?.name || "None")}</strong>
        </div>
        <div class="metric-pill">
          <span>Tracked</span>
          <strong>${escapeHtml(String(evaluationInsights.decisions.length))}</strong>
        </div>
        <div class="metric-pill">
          <span>Dismissed</span>
          <strong>${escapeHtml(String(evaluationInsights.dismissedDecisionCount))}</strong>
        </div>
      </div>

      <form id="evaluationProfileForm" class="detail-form evaluation-form">
        <div class="option-grid">
          <label class="field">
            <span>Name</span>
            <input id="evaluationProfileName" type="text" data-evaluation-field="name" value="${escapeAttribute(profile.name || "")}" />
          </label>
          <label class="field">
            <span>Max score to save</span>
            <input id="evaluationProfileMaxScore" type="number" step="1" data-evaluation-field="maxScore" value="${escapeAttribute(String(profile.maxScore ?? 3))}" />
          </label>
        </div>

        <label>
          <span>Summary</span>
          <textarea id="evaluationProfileSummary" data-evaluation-field="summary" placeholder="Low-stress remote backend roles with clear scope and predictable workload">${escapeHtml(profile.summary || "")}</textarea>
        </label>

        <div class="option-grid">
          <label>
            <span>Always save when description includes</span>
            <textarea id="evaluationProfileSaveWhen" data-evaluation-field="saveWhen" placeholder="remote-first&#10;async-friendly">${escapeHtml((profile.saveWhen || []).join("\n"))}</textarea>
          </label>
          <label>
            <span>Avoid when description includes</span>
            <textarea id="evaluationProfileAvoidWhen" data-evaluation-field="avoidWhen" placeholder="long hours&#10;fast-paced&#10;weekends">${escapeHtml((profile.avoidWhen || []).join("\n"))}</textarea>
          </label>
        </div>

        <section class="detail-section">
          <div class="console-section-head">
            <div>
              <h3>Positive signals</h3>
              <p class="timeline-detail">Negative scores make a role easier to keep.</p>
            </div>
            <button class="ghost-button" type="button" data-evaluation-signal-add="positiveSignals">Add positive signal</button>
          </div>
          ${renderEvaluationSignalRows("positiveSignals", profile.positiveSignals)}
        </section>

        <section class="detail-section">
          <div class="console-section-head">
            <div>
              <h3>Negative signals</h3>
              <p class="timeline-detail">Positive scores and hard rejects push a role out of the save lane.</p>
            </div>
            <button class="ghost-button" type="button" data-evaluation-signal-add="negativeSignals">Add negative signal</button>
          </div>
          ${renderEvaluationSignalRows("negativeSignals", profile.negativeSignals)}
        </section>

        <div class="form-footer">
          <p id="evaluationSaveState" class="save-state">${escapeHtml(state.evaluation.saveState || "Edit criteria here, then save to update the local evaluation profile file.")}</p>
        </div>
      </form>
    </div>
  `;
}

function bindEvaluationProfileInputs() {
  const select = document.getElementById("evaluationProfileSelect");

  select?.addEventListener("change", (event) => {
    const nextName = cleanText(event.target.value);
    selectEvaluationProfile(nextName, state.evaluation.dirty ? "Switched profiles and discarded unsaved changes" : "Profile loaded");
    renderProfile();
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-field]").forEach((input) => {
    const applyValue = () => {
      const field = input.getAttribute("data-evaluation-field");
      const draft = ensureEvaluationDraft();

      if (field === "name" || field === "summary") {
        draft[field] = input.value;
      } else if (field === "maxScore") {
        draft.maxScore = Number.isFinite(Number(input.value)) ? Number(input.value) : 3;
      } else if (field === "saveWhen" || field === "avoidWhen") {
        draft[field] = parseLineList(input.value);
      }

      markEvaluationDirty("Unsaved evaluation changes");
    };

    input.addEventListener("input", applyValue);
    input.addEventListener("change", applyValue);
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-signal-field]").forEach((input) => {
    const updateSignal = () => {
      const descriptor = cleanText(input.getAttribute("data-evaluation-signal-field"));
      const [kind, indexText, field] = descriptor.split(":");
      const index = Number(indexText);
      const draft = ensureEvaluationDraft();
      const list = Array.isArray(draft[kind]) ? draft[kind] : [];
      if (!Number.isInteger(index) || !list[index]) {
        return;
      }

      if (field === "hardReject") {
        list[index].hardReject = Boolean(input.checked);
      } else if (field === "score") {
        list[index].score = Number.isFinite(Number(input.value)) ? Number(input.value) : 0;
      } else if (field === "appliesTo") {
        list[index].appliesTo = normalizeSignalScope(input.value);
      } else {
        list[index][field] = input.value;
      }

      markEvaluationDirty("Unsaved evaluation changes");
    };

    input.addEventListener("input", updateSignal);
    input.addEventListener("change", updateSignal);
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-signal-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.getAttribute("data-evaluation-signal-add");
      const draft = ensureEvaluationDraft();
      draft[kind] ||= [];
      draft[kind].push({
        phrase: "",
        score: kind === "positiveSignals" ? -2 : 2,
        reason: "",
        appliesTo: "description",
        hardReject: false,
      });
      markEvaluationDirty("Added evaluation signal");
      renderProfile();
    });
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-signal-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const descriptor = cleanText(button.getAttribute("data-evaluation-signal-remove"));
      const [kind, indexText] = descriptor.split(":");
      const index = Number(indexText);
      const draft = ensureEvaluationDraft();
      const list = Array.isArray(draft[kind]) ? draft[kind] : [];
      if (!Number.isInteger(index) || !list[index]) {
        return;
      }

      list.splice(index, 1);
      markEvaluationDirty("Removed evaluation signal");
      renderProfile();
    });
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-create]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = uniqueEvaluationProfileName("New profile");
      const nextProfile = createEmptyEvaluationProfile(name);
      nextProfile.summary = "Describe the kind of roles this profile should keep.";
      state.evaluation.selectedProfileName = name;
      state.evaluation.draftOriginalName = "";
      state.evaluation.draft = nextProfile;
      state.evaluation.dirty = true;
      updateEvaluationSaveState("New profile created locally. Save to persist it.");
      renderProfile();
    });
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-duplicate]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = getEditableEvaluationProfile();
      if (!current) {
        return;
      }

      const duplicate = cloneEvaluationProfile(current);
      duplicate.name = uniqueEvaluationProfileName(`${current.name || "Profile"} copy`);
      state.evaluation.selectedProfileName = duplicate.name;
      state.evaluation.draftOriginalName = "";
      state.evaluation.draft = duplicate;
      state.evaluation.dirty = true;
      updateEvaluationSaveState("Profile duplicated locally. Save to persist it.");
      renderProfile();
    });
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.evaluation.profiles.length <= 1) {
        updateEvaluationSaveState("At least one evaluation profile must remain");
        return;
      }

      void saveEvaluationProfiles({ deleteSelected: true });
    });
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-activate]").forEach((button) => {
    button.addEventListener("click", () => {
      void activateEvaluationProfile();
    });
  });

  elements.profilePanel.querySelectorAll("[data-evaluation-save]").forEach((button) => {
    button.addEventListener("click", () => {
      void saveEvaluationProfiles();
    });
  });
}

function renderEvaluationDecisionItem(decision, tone = "") {
  const resolvedTone = tone || (decision.action === "saved" ? "saved" : decision.action === "dismissed" ? "dismissed" : "");
  const decisionLabel = decision.actionLabel || decision.decision || decision.action || "tracked";

  return `
    <li class="timeline-item compact-item decision-item ${resolvedTone ? `decision-item--${escapeHtml(resolvedTone)}` : ""}">
      <div class="list-head">
        <div>
          <p class="list-title">${escapeHtml(decision.title || "Untitled role")}</p>
          <p class="timeline-detail">${escapeHtml(decision.company || "Unknown company")}</p>
        </div>
        <span class="chip ${resolvedTone === "dismissed" ? "is-alert" : resolvedTone === "saved" ? "is-accent" : ""}">${escapeHtml(decisionLabel)}</span>
      </div>
      <div class="chip-row">
        ${decision.profileName ? `<span class="chip">${escapeHtml(decision.profileName)}</span>` : ""}
        ${Number.isFinite(decision.score) ? `<span class="chip">${escapeHtml(`Score ${decision.score}`)}</span>` : ""}
        ${decision.url ? `<span class="chip mono">${escapeHtml(shortenUrl(decision.url))}</span>` : ""}
        ${decision.alreadySaved ? `<span class="chip">Already saved on LinkedIn</span>` : ""}
      </div>
      <p class="timeline-detail">${escapeHtml(Array.isArray(decision.reasons) && decision.reasons.length > 0 ? decision.reasons.join("; ") : "No explicit reason captured")}</p>
      <div class="meta-row">
        <span class="meta-pill">${escapeHtml(formatDateTime(decision.evaluatedAt || decision.timestamp || ""))}</span>
        ${decision.runLabel ? `<span class="meta-pill">${escapeHtml(decision.runLabel)}</span>` : ""}
      </div>
    </li>
  `;
}

function renderSavedQueueAuditItem(entry) {
  const job = entry.job;
  const screening = entry.screening;
  const toneClass = screening && !screening.pass ? "is-alert" : screening ? "is-accent" : "";
  const summary = screening
    ? `${screening.profileName || "No profile"} | score ${Number.isFinite(Number(screening.score)) ? Number(screening.score) : 0}`
    : "Missing tracked evaluation details";

  return `
    <li class="list-item compact-item">
      <div class="list-head">
        <div>
          <p class="list-title">${escapeHtml(job.displayTitle)}</p>
          <p class="timeline-detail">${escapeHtml(job.displayCompany)}</p>
        </div>
        <span class="chip ${toneClass}">${escapeHtml(screening ? (screening.pass ? "kept" : "flagged") : "missing")}</span>
      </div>
      <p class="list-meta">${escapeHtml(summary)}</p>
      <div class="chip-row">
        ${
          screening?.reasons?.length
            ? screening.reasons.slice(0, 3).map((reason) => `<span class="chip ${toneClass}">${escapeHtml(reason)}</span>`).join("")
            : `<span class="chip">No reasons tracked yet</span>`
        }
      </div>
    </li>
  `;
}

function renderAll() {
  renderSummary();
  renderWorkspaceGuide();
  renderActions();
  renderSupportOverview();
  renderActivity();
  renderAttention();
  renderProfile();
  renderAnswerCapture();
  renderModules();
  renderExternalApply();
}

function setDashboardStatus() {
  const activeRun = state.snapshot?.actionRunner?.activeRun;
  if (activeRun) {
    setAppStatus(
      `Running: ${activeRun.label}${activeRun.targetJobTitle ? ` for ${activeRun.targetJobTitle}` : ""}`,
    );
    return;
  }

  const tunnel = state.snapshot?.tunnel;
  if (tunnel?.status === "starting") {
    setAppStatus("Starting Cloudflare Tunnel");
    return;
  }

  if (tunnel?.status === "running" && tunnel.publicUrl) {
    setAppStatus(`Public link live: ${shortenUrl(tunnel.publicUrl)}`);
    return;
  }

  setAppStatus(state.actionStatusMessage || "Live filing automation data");
}

function renderGeneratedAt() {
  if (!elements.generatedAt) {
    return;
  }

  elements.generatedAt.textContent = state.snapshot
    ? formatDateTime(state.snapshot.generatedAt)
    : "Waiting for snapshot";
}

function renderFocusSummary() {
  if (!elements.focusSummary || !elements.focusNextStep) {
    return;
  }

  if (!state.snapshot) {
    elements.focusSummary.textContent = "Waiting for lane data";
    elements.focusNextStep.textContent = "Loading the next recommended step.";
    return;
  }

  const activeRun = state.snapshot.actionRunner.activeRun;
  elements.focusSummary.textContent = activeRun ? activeRun.label : "Two-lane automation";
  elements.focusNextStep.textContent = activeRun
    ? `Runner busy on ${activeRun.label}${activeRun.targetJobTitle ? ` for ${activeRun.targetJobTitle}` : ""}.`
    : "Open LinkedIn Remote Jobs to save matching roles, then open LinkedIn Jobs Tracker to apply the saved queue.";
}

function renderSummary() {
  if (!state.snapshot) {
    elements.summaryGrid.innerHTML = "";
    return;
  }

  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const { autofillProfile, answerCapture, actionRunner } = state.snapshot;
  const cards = [
    {
      label: "Workflow",
      value: "Remote Jobs -> Tracker",
      context: "Save or dismiss on LinkedIn Remote Jobs, then apply only from LinkedIn Jobs Tracker.",
      tone: "queue",
    },
    {
      label: "Runner",
      value: actionRunner.activeRun ? "Busy" : "Ready",
      context: actionRunner.activeRun
        ? actionRunner.activeRun.label
        : `${actionRunner.recentRuns.length} recent run${actionRunner.recentRuns.length === 1 ? "" : "s"} recorded`,
      tone: "external",
    },
    {
      label: "Screening",
      value: `${evaluationInsights.savedDecisionCount}/${evaluationInsights.dismissedDecisionCount}`,
      context: evaluationInsights.latestDecision
        ? `${evaluationInsights.latestDecision.actionLabel} ${evaluationInsights.latestDecision.title} with ${evaluationInsights.activeProfileName || "the current profile"}`
        : "Saved vs dismissed counts appear here when the save lane runs from the dashboard.",
      tone: "queue",
    },
    {
      label: "Autofill readiness",
      value: `${autofillProfile.completionScore}%`,
      context: `${autofillProfile.completedFields}/${autofillProfile.totalFields} autofill fields are ready`,
      tone: "ready",
    },
    {
      label: "Answer capture",
      value: String(answerCapture.unresolvedCount),
      context: answerCapture.unresolvedCount > 0
        ? `${answerCapture.unresolvedCount} unanswered question${answerCapture.unresolvedCount === 1 ? "" : "s"} still need review`
        : `${answerCapture.answeredCount} saved answer${answerCapture.answeredCount === 1 ? "" : "s"} captured`,
      tone: "profile",
    },
  ];

  elements.summaryGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card stat-card--${escapeHtml(card.tone)}">
          <p class="stat-label">${escapeHtml(card.label)}</p>
          <p class="stat-value">${escapeHtml(String(card.value))}</p>
          <p class="stat-context">${escapeHtml(card.context)}</p>
        </article>
      `,
    )
    .join("");
}

function renderWorkflowPanels() {
  renderFocusSummary();
  renderSummary();
  renderWorkspaceGuide();
  renderActions();
  renderSupportOverview();
}

function setBoardStage(stage) {
  if (!STAGE_ORDER.includes(stage)) {
    return;
  }

  state.ui.boardStage = stage;
  state.filters.stage = stage;
  if (elements.statusFilter) {
    elements.statusFilter.value = stage;
  }
  renderWorkflowPanels();
}

function setConsoleTab(tab) {
  if (!ACTION_CONSOLE_TABS.some((entry) => entry.id === tab)) {
    return;
  }

  state.ui.consoleTab = tab;
  renderActions();
}

function clearFilters() {
  state.filters.search = "";
  state.filters.source = "all";
  state.filters.stage = "all";

  if (elements.searchInput) {
    elements.searchInput.value = "";
  }
  if (elements.sourceFilter) {
    elements.sourceFilter.value = "all";
  }
  if (elements.statusFilter) {
    elements.statusFilter.value = "all";
  }

  syncBoardStage();
  renderWorkflowPanels();
}

function scrollToSection(sectionId) {
  document.getElementById(sectionId)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function renderWorkspaceGuide() {
  if (!elements.workspaceGuide) {
    return;
  }

  if (!state.snapshot) {
    elements.workspaceGuide.innerHTML = `<p class="empty-state">Loading workspace flow.</p>`;
    return;
  }

  const activeRun = state.snapshot.actionRunner.activeRun;
  const queuedJobs = state.snapshot.jobs.filter((job) => job.automationStage !== "filed").length;
  const appliedJobs = state.snapshot.jobs.filter((job) => job.automationStage === "filed").length;
  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const remoteJobsHref = escapeAttribute(LINKEDIN_REMOTE_JOBS_URL);
  const trackerHref = escapeAttribute(LINKEDIN_JOBS_TRACKER_URL);

  elements.workspaceGuide.innerHTML = `
    <div class="section-head">
      <div>
        <p class="eyebrow">Operating lane</p>
        <h2>Two automations: save from Remote Jobs, then apply from your saved queue</h2>
      </div>
      <p class="section-note">${escapeHtml(
        activeRun
          ? `Runner active: ${activeRun.label}`
          : "Run the save lane against LinkedIn Remote Jobs, then run the apply lane against your saved queue.",
      )}</p>
    </div>

    <div class="workspace-guide-shell">
      <div class="workspace-brief-grid">
        <article class="guide-card">
          <p class="stat-label">Step 1</p>
          <p class="guide-value">Save from Remote Jobs</p>
          <p class="guide-context">${escapeHtml(
            "Stay on LinkedIn Remote Jobs, read each preview description, and save only the roles that match your criteria.",
          )}</p>
          <div class="chip-row">
            <span class="chip">Remote Jobs</span>
            <span class="chip">${escapeHtml(activeRun ? "Runner busy" : `${queuedJobs} queued`)}</span>
            ${
              evaluationInsights.activeProfileName
                ? `<span class="chip">${escapeHtml(evaluationInsights.activeProfileName)}</span>`
                : ""
            }
          </div>
          <div class="guide-action-row">
            <a class="action-button" href="${remoteJobsHref}" target="_blank" rel="noreferrer">Open Remote Jobs</a>
            <button class="ghost-button" type="button" data-guide-run-action="browser-save-remote-jobs"${activeRun ? " disabled" : ""}>Save Matching Jobs</button>
          </div>
        </article>

        <article class="guide-card">
          <p class="stat-label">Step 2</p>
          <p class="guide-value">Apply from Saved Queue</p>
          <p class="guide-context">${escapeHtml(
            "Visible Jobs Tracker items are used first, then the runner falls back to direct job pages so the full saved queue can keep moving.",
          )}</p>
          <div class="chip-row">
            <span class="chip">Jobs Tracker</span>
            <span class="chip">${escapeHtml(appliedJobs === 0 ? "Nothing filed yet" : `${appliedJobs} filed`)}</span>
          </div>
          <div class="guide-action-row">
            <a class="action-button" href="${trackerHref}" target="_blank" rel="noreferrer">Open Jobs Tracker</a>
            <button class="ghost-button" type="button" data-guide-run-action="browser-start-full-autopilot"${activeRun ? " disabled" : ""}>Apply Saved Jobs</button>
          </div>
        </article>
      </div>
    </div>
  `;

  elements.workspaceGuide.querySelectorAll("[data-guide-run-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const presetUrl = button.getAttribute("data-action-url");
      if (presetUrl) {
        primeActionUrl(presetUrl);
      }
      void runDashboardAction(button.getAttribute("data-guide-run-action"));
    });
  });
}

function renderBoard() {
  if (!state.snapshot) {
    elements.pipelineBoard.innerHTML = "";
    elements.boardCount.textContent = "";
    return;
  }

  const filteredJobs = getFilteredJobs();
  const activeStage = state.ui.boardStage || getDefaultBoardStage(filteredJobs);
  const stageCounts = getStageCounts(filteredJobs);
  const activeJobs = filteredJobs.filter((job) => job.automationStage === activeStage);
  const flaggedJobs = activeJobs.filter((job) => job.attentionReasons.length > 0).length;

  elements.boardCount.textContent = `${filteredJobs.length} queue item${filteredJobs.length === 1 ? "" : "s"} match the current search and source filters`;

  elements.pipelineBoard.innerHTML = `
    <div class="workspace-shell">
      <div class="stage-rail" role="tablist" aria-label="Queue stages">
        ${STAGE_ORDER.map((stage) => renderStageCard(stage, stageCounts[stage], filteredJobs)).join("")}
      </div>

      <section class="queue-panel">
        <header class="queue-head">
          <div>
            <p class="eyebrow">Stage Focus</p>
            <h3>${escapeHtml(STAGE_LABELS[activeStage])}</h3>
            <p class="column-copy">${escapeHtml(STAGE_HELP_TEXT[activeStage])}</p>
          </div>
          <div class="queue-head-meta">
            <span class="chip">${activeJobs.length} job${activeJobs.length === 1 ? "" : "s"}</span>
            ${flaggedJobs > 0 ? `<span class="chip is-alert">${flaggedJobs} flagged</span>` : ""}
          </div>
        </header>
        ${
          activeJobs.length === 0
            ? renderEmptyState(
              filteredJobs.length === 0
                ? {
                  eyebrow: state.snapshot.stats.totalJobs === 0 ? "No saved jobs" : "Queue hidden",
                  title: state.snapshot.stats.totalJobs === 0 ? "The queue has not been populated yet" : "Nothing matches the current filters",
                  body: state.snapshot.stats.totalJobs === 0
                    ? "Open LinkedIn Remote Jobs, run the save automation there, and the matching roles will be queued here."
                    : "Your search, source, or stage filters removed every saved job from view. Clear them to bring the queue back.",
                  tone: state.snapshot.stats.totalJobs === 0 ? "calm" : "warning",
                  actions: state.snapshot.stats.totalJobs === 0
                    ? [
                      { label: "Open tools", href: "#actionPanel", variant: "primary" },
                      { label: "Jump to queue", href: "#queueWorkspace" },
                    ]
                    : [
                      { label: "Clear filters", intent: "clear-filters", variant: "primary" },
                      { label: "Open tools", href: "#actionPanel" },
                    ],
                }
                : {
                  eyebrow: "Stage is empty",
                  title: `${STAGE_LABELS[activeStage]} has no jobs in this view`,
                  body: "Other stages still have queue items. Switch lanes to keep moving, or clear filters if this stage should be populated.",
                  tone: "calm",
                  actions: [
                    ...getStageJumpActions(stageCounts, activeStage, 2, true),
                    ...(Boolean(state.filters.search) || state.filters.source !== "all" || state.filters.stage !== "all"
                      ? [{ label: "Clear filters", intent: "clear-filters" }]
                      : []),
                  ],
                },
            )
            : `<div class="job-list">${activeJobs.map((job) => renderJobCard(job)).join("")}</div>`
        }
      </section>
    </div>
  `;

  elements.pipelineBoard.querySelectorAll("[data-board-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextStage = button.getAttribute("data-board-stage");
      if (!nextStage || nextStage === state.ui.boardStage) {
        return;
      }

      setBoardStage(nextStage);
    });
  });

  wireSelectionClicks(elements.pipelineBoard);
  bindDashboardIntents(elements.pipelineBoard);
}

function renderSupportOverview() {
  if (!elements.supportOverview) {
    return;
  }

  if (!state.snapshot) {
    elements.supportOverview.innerHTML = "";
    return;
  }

  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const latestActivity = state.snapshot.recentAutomationActivity[0];
  const latestArtifact = state.snapshot.recentBrowserArtifacts[0];
  const activeModules = state.snapshot.automationModules.filter((module) => module.fileCount > 0).length;
  const answerReview = state.snapshot.answerCapture;
  const cards = [
    {
      href: "#activityPanel",
      label: "Evaluation decisions",
      value: String(evaluationInsights.decisions.length),
      context: evaluationInsights.latestDecision
        ? `${evaluationInsights.latestDecision.actionLabel}: ${evaluationInsights.latestDecision.title}`
        : "No screening decisions have been tracked yet.",
      tone: "queue",
    },
    {
      href: "#attentionPanel",
      label: "Saved queue review",
      value: String(evaluationInsights.savedQueue.length),
      context: evaluationInsights.missingSavedJobs.length > 0
        ? `${evaluationInsights.missingSavedJobs.length} saved job${evaluationInsights.missingSavedJobs.length === 1 ? "" : "s"} are still missing tracked evaluation data.`
        : `${evaluationInsights.evaluatedSavedJobs.length} saved job${evaluationInsights.evaluatedSavedJobs.length === 1 ? "" : "s"} already show score and reasons.`,
      tone: "external",
    },
    {
      href: "#companyPanel",
      label: "Screening outcomes",
      value: String(state.snapshot.evaluation?.stats?.trackedCount || evaluationInsights.decisions.length),
      context:
        (state.snapshot.evaluation?.stats?.trackedCount || evaluationInsights.decisions.length) > 0
          ? `${evaluationInsights.savedDecisionCount} saved, ${evaluationInsights.dismissedDecisionCount} dismissed, ${evaluationInsights.skippedDecisionCount} skipped.`
          : "No save-lane decisions have been tracked yet.",
      tone: "ready",
    },
    {
      href: "#profilePanel",
      label: "Evaluation profiles",
      value: state.evaluation.apiState === "ready" ? String(state.evaluation.profiles.length) : "API",
      context: state.evaluation.apiState === "ready"
        ? `${state.evaluation.activeProfileName || "No active profile"} is selected for the save lane.`
        : "The website is waiting for the evaluation profile API before criteria can be edited here.",
      tone: "profile",
    },
    {
      href: "#profilePanel",
      label: "Autofill profile",
      value: `${state.snapshot.autofillProfile.completionScore}%`,
      context: `${state.snapshot.autofillProfile.missingFields.length} missing field${state.snapshot.autofillProfile.missingFields.length === 1 ? "" : "s"} still affect autofill coverage.`,
      tone: "profile",
    },
    {
      href: "#answerCaptureWorkspace",
      label: "Question review",
      value: String(answerReview.unresolvedCount),
      context: answerReview.unresolvedCount > 0
        ? `${answerReview.unresolvedCount} unresolved question${answerReview.unresolvedCount === 1 ? "" : "s"} are ready to answer.`
        : `${answerReview.answeredCount} saved answer${answerReview.answeredCount === 1 ? "" : "s"} are in the local map.`,
      tone: "external",
    },
    {
      href: "#artifactPanel",
      label: "Modules and artifacts",
      value: String(state.snapshot.stats.browserArtifactCount),
      context: latestArtifact
        ? `${activeModules} modules are active. Latest artifact: ${latestArtifact.name}.`
        : "No browser artifacts are currently saved.",
      tone: "queue",
    },
  ];

  elements.supportOverview.innerHTML = cards
    .map(
      (card) => `
        <a class="support-card support-card--${escapeHtml(card.tone)}" href="${escapeAttribute(card.href)}">
          <p class="stat-label">${escapeHtml(card.label)}</p>
          <p class="support-card-value">${escapeHtml(card.value)}</p>
          <p class="support-card-context">${escapeHtml(card.context)}</p>
        </a>
      `,
    )
    .join("");
}

function renderJobCard(job) {
  const chips = [
    `<span class="chip">${escapeHtml(job.source || "Unknown source")}</span>`,
    `<span class="chip">${escapeHtml(relativeAgeLabel(job.ageInDays))}</span>`,
    job.externalApplyFound ? `<span class="chip">Employer URL found</span>` : "",
    ...job.attentionReasons.slice(0, 2).map((reason) => `<span class="chip is-alert">${escapeHtml(reason)}</span>`),
  ].filter(Boolean);
  const cardSignals = getJobCardSignals(job);

  return `
    <button class="job-card ${job.id === state.selectedJobId ? "is-selected" : ""}" type="button" data-select-job="${escapeHtml(job.id)}">
      <div class="job-card-head">
        <h4>${escapeHtml(job.displayTitle)}</h4>
        <p class="job-company">${escapeHtml(job.displayCompany)}</p>
      </div>
      <div class="job-meta">
        <span>${escapeHtml(shortenId(job.id))}</span>
        <span>${escapeHtml(formatDate(job.latestAutomationEventAt))}</span>
      </div>
      <div class="job-signal-grid">
        ${cardSignals
          .map(
            (signal) => `
              <article class="job-signal ${signal.className}">
                <p class="job-signal-label">${escapeHtml(signal.label)}</p>
                <p class="job-signal-value">${escapeHtml(signal.value)}</p>
              </article>
            `,
          )
          .join("")}
      </div>
      <div class="chip-row">${chips.join("")}</div>
      <p class="job-snippet">${escapeHtml(job.nextAutomationStep)}</p>
    </button>
  `;
}

function renderDetail() {
  if (!state.snapshot) {
    elements.jobDetail.innerHTML = `<p class="empty-state">Loading job details.</p>`;
    return;
  }

  const job = getSelectedJob();
  if (!job) {
    const filteredJobs = getFilteredJobs();
    const activeStage = state.ui.boardStage || getDefaultBoardStage(filteredJobs);
    const stageCounts = getStageCounts(filteredJobs);
    const totalJobs = state.snapshot.stats.totalJobs;

    elements.jobDetail.innerHTML = renderEmptyState(
      totalJobs === 0
        ? {
          eyebrow: "No selected job",
          title: "Pick a saved job to unlock Apply",
          body: "Once the queue is synced, select one saved job and this panel will center on that single apply action.",
          tone: "calm",
          actions: [
            { label: "Open tools", href: "#actionPanel", variant: "primary" },
            { label: "Jump to queue", href: "#queueWorkspace" },
          ],
        }
        : filteredJobs.length === 0
          ? {
            eyebrow: "No selected job",
            title: "The current filters hid every queue item",
            body: "Clear the filters to bring jobs back into view. Once a card is visible, Step 2 will explain what to do with it.",
            tone: "warning",
            actions: [
              { label: "Clear filters", intent: "clear-filters", variant: "primary" },
              { label: "Jump to queue", href: "#queueWorkspace" },
            ],
          }
          : {
            eyebrow: "No selected job",
            title: `Nothing is selected in ${STAGE_LABELS[activeStage]}`,
            body: stageCounts[activeStage] === 0
              ? "The active stage is empty in this filtered view. Switch to another populated stage or clear filters to repopulate the detail panel."
              : "Pick any card from the queue and this panel will narrow the workflow to one job at a time.",
            tone: "calm",
            actions: stageCounts[activeStage] === 0
              ? [
                ...getStageJumpActions(stageCounts, activeStage, 2, true),
                { label: "Jump to queue", href: "#queueWorkspace" },
              ]
              : [{ label: "Jump to queue", href: "#queueWorkspace", variant: "primary" }],
          },
    );
    bindDashboardIntents(elements.jobDetail);
    return;
  }

  ensureDraft(job);
  const draft = state.detailDraft;
  const warnings =
    job.attentionReasons.length > 0
      ? job.attentionReasons.map((reason) => `<span class="chip is-alert">${escapeHtml(reason)}</span>`).join("")
      : `<span class="chip">No active filing blockers</span>`;

  const reviewNotes = [
    job.linkedInApplyReviewed
      ? `LinkedIn review seen: ${job.linkedInReviewStage || "review captured"}`
      : "LinkedIn review not captured yet",
    job.linkedInPrimaryAction ? `Next button: ${job.linkedInPrimaryAction}` : "",
    job.externalApplyFound && job.externalApplyDestinationUrl
      ? "Employer apply route is available"
      : "No external employer route captured yet",
  ].filter(Boolean);
  const signals = [
    {
      label: "Description",
      value: job.hasDescription ? "Captured" : "Missing",
      className: job.hasDescription ? "" : "is-alert",
    },
    {
      label: "Company",
      value: job.hasUnknownCompany ? "Needs cleanup" : "Captured",
      className: job.hasUnknownCompany ? "is-alert" : "",
    },
    {
      label: "Easy Apply",
      value: job.linkedInApplyReviewed ? `${job.linkedInFieldCount} fields seen` : "Not reviewed",
      className: "",
    },
    {
      label: "Employer route",
      value: job.externalApplyFound ? "Captured" : "Not found",
      className: "",
    },
  ];
  const planSteps = getJobActionPlan(job);
  const quickActions = getActionRecommendations(state.snapshot.actionRunner.actions, job, job.automationStage).slice(0, 2);
  const decisionCards = getJobDecisionCards(job, state.snapshot);
  const jobRunState = getJobRunState(job);
  const activeJobRun = jobRunState.activeRun;
  const latestJobRun = activeJobRun || jobRunState.lastRun;
  const runArtifacts = latestJobRun?.producedArtifacts ?? [];
  const runError = latestJobRun ? getRunErrorLine(latestJobRun) : "";
  const runLogExcerpt = latestJobRun ? getRunLatestLogLine(latestJobRun) : "";
  const runStatusLabel = activeJobRun
    ? "Running now"
    : latestJobRun
      ? capitalize(latestJobRun.status)
      : "No dashboard run";
  const runStatusCopy = activeJobRun
    ? `${activeJobRun.label} started ${formatDateTime(activeJobRun.startedAt)}${activeJobRun.pid ? ` on PID ${activeJobRun.pid}` : ""}.`
    : latestJobRun
      ? `${latestJobRun.label}${latestJobRun.endedAt ? ` finished ${formatDateTime(latestJobRun.endedAt)}` : ` started ${formatDateTime(latestJobRun.startedAt)}`}.`
      : "Run one of the inline actions here and the selected job will keep its own dashboard execution trail.";
  const runArtifactCopy = latestJobRun
    ? runArtifacts.length > 0
      ? `${runArtifacts[0].category}: ${runArtifacts[0].name}`
      : "This run did not write a tracked browser artifact into data/browser."
    : "No dashboard-triggered run has been attributed to this selected job yet.";
  const runSignalLabel = runError ? "Last error" : latestJobRun ? "Latest runner note" : "Runner note";
  const runSignalValue = runError
    ? truncateText(runError, 72)
    : runLogExcerpt
      ? truncateText(runLogExcerpt, 72)
      : "No logs yet";
  const runSignalCopy = runError
    ? "The most recent error line from the job-attributed dashboard run is pinned here."
    : latestJobRun
      ? `${capitalize(latestJobRun.status)} ${latestJobRun.endedAt ? `at ${formatDateTime(latestJobRun.endedAt)}` : `since ${formatDateTime(latestJobRun.startedAt)}`}.`
      : "Once this job launches a dashboard action, the latest log excerpt will stay attached here.";
  const jobHistory = getJobHistory(job, state.snapshot);
  const relevantArtifacts = getRelevantArtifacts(job, state.snapshot);
  const filingStatusLabel = FILING_STATUS_OPTIONS.find((option) => option.value === draft.status)?.label || draft.status;

  elements.jobDetail.innerHTML = `
    <div class="detail-shell">
      <div>
        <h3 class="detail-title">${escapeHtml(job.displayTitle)}</h3>
        <p class="detail-company">${escapeHtml(job.displayCompany)}</p>
      </div>

      <div class="detail-meta">
        <span>${escapeHtml(shortenId(job.id))}</span>
        <span>${escapeHtml(job.source || "Unknown source")}</span>
        <span>${escapeHtml(formatDateTime(job.latestAutomationEventAt))}</span>
      </div>

      <div class="chip-row">
        <span class="chip">${escapeHtml(STAGE_LABELS[job.automationStage])}</span>
        ${warnings}
      </div>

      <section class="detail-spotlight">
        <p class="spotlight-label">Do next</p>
        <p class="detail-next-step">${escapeHtml(job.nextAutomationStep)}</p>
        <p class="helper-text">${escapeHtml(job.automationSummary)}</p>
      </section>

      <div class="detail-actions">
        <a class="ghost-button" href="${escapeAttribute(job.url)}" target="_blank" rel="noreferrer">Open job page</a>
        ${
          job.externalApplyFound && job.externalApplyDestinationUrl
            ? `<a class="ghost-button" href="${escapeAttribute(job.externalApplyDestinationUrl)}" target="_blank" rel="noreferrer">Open employer form</a>`
            : ""
        }
      </div>

      <section class="detail-section">
        <div class="console-section-head">
          <div>
            <h3>Immediate next moves</h3>
            <p class="timeline-detail">This section explains why the job is in this lane, what unlocks the next step, and which action is the best first move.</p>
          </div>
          <span class="chip">${escapeHtml(STAGE_LABELS[job.automationStage])}</span>
        </div>
        <div class="detail-status-grid">
          ${decisionCards.map(renderDetailStatusCard).join("")}
        </div>
        <div class="detail-quick-actions">
          ${quickActions.map((item, index) => renderDetailQuickAction(item, Boolean(state.snapshot.actionRunner.activeRun), index)).join("")}
        </div>
        <div class="detail-actions">
          <button class="ghost-button" type="button" data-detail-load-url="${escapeAttribute(job.url)}">Load job page</button>
          ${
            job.externalApplyFound && job.externalApplyDestinationUrl
              ? `<button class="ghost-button" type="button" data-detail-load-url="${escapeAttribute(job.externalApplyDestinationUrl)}">Load employer route</button>`
              : ""
          }
        </div>
        <p class="helper-text">The highlighted move is the main action. The load-only buttons below just stage the selected URL for a manual follow-up when needed.</p>
      </section>

      ${renderDetailDisclosure({
        title: "Job execution",
        badgeMarkup: `<span class="chip ${latestJobRun ? getRunToneClass(latestJobRun.status) : ""}">${escapeHtml(activeJobRun ? "Live run" : `${jobRunState.recentRuns.length} saved`)}</span>`,
        open: Boolean(activeJobRun),
        content: `
          <p class="timeline-detail">Dashboard-triggered runs from this selected job keep their status, exact outputs, and latest runner note here.</p>
          <div class="detail-status-grid">
            <article class="detail-status-card ${latestJobRun ? getRunToneClass(latestJobRun.status) : ""}">
              <p class="signal-label">Execution state</p>
              <p class="detail-status-value">${escapeHtml(runStatusLabel)}</p>
              <p class="detail-status-copy">${escapeHtml(runStatusCopy)}</p>
            </article>
            <article class="detail-status-card ${runArtifacts.length > 0 ? "is-accent" : ""}">
              <p class="signal-label">Exact outputs</p>
              <p class="detail-status-value">${escapeHtml(`${runArtifacts.length} artifact${runArtifacts.length === 1 ? "" : "s"}`)}</p>
              <p class="detail-status-copy">${escapeHtml(runArtifactCopy)}</p>
            </article>
            <article class="detail-status-card ${runError ? "is-alert" : latestJobRun ? "is-accent" : ""}">
              <p class="signal-label">${escapeHtml(runSignalLabel)}</p>
              <p class="detail-status-value">${escapeHtml(runSignalValue)}</p>
              <p class="detail-status-copy">${escapeHtml(runSignalCopy)}</p>
            </article>
          </div>
          ${
            latestJobRun
              ? `
                <div class="detail-history-block detail-run-output-block">
                  <div class="console-section-head">
                    <div>
                      <p class="signal-label">Run context</p>
                      <p class="timeline-detail">${escapeHtml(
                        latestJobRun.targetJobTitle
                          ? `${latestJobRun.label} stayed attached to ${latestJobRun.targetJobTitle} @ ${latestJobRun.targetJobCompany}.`
                          : "This dashboard run was stored without a selected job context.",
                      )}</p>
                    </div>
                    <span class="chip">${escapeHtml(latestJobRun.targetJobTitle ? "Job-linked" : "Queue-level")}</span>
                  </div>
                  ${
                    runArtifacts.length > 0
                      ? `<ul class="detail-mini-list">${runArtifacts.map(renderDetailArtifactItem).join("")}</ul>`
                      : `<p class="helper-text">No tracked browser artifact was written by this run, but the status and latest log line are still attached above.</p>`
                  }
                </div>
              `
              : `<p class="helper-text">Dashboard-triggered runs that start from this selected job will keep exact output files here instead of only showing up in the shared runner console.</p>`
          }
        `,
      })}

      ${renderDetailDisclosure({
        title: "Action path",
        badgeMarkup: `<span class="chip ${planSteps[0]?.stateClass === "is-blocked" ? "is-alert" : planSteps[0]?.stateClass === "is-next" ? "is-accent" : ""}">${escapeHtml(planSteps[0]?.stateLabel || "Planned")}</span>`,
        content: `
          <p class="timeline-detail">The filing path stays here when you need the full step-by-step sequence.</p>
          <div class="plan-grid">
            ${planSteps.map((step, index) => renderPlanStep(step, index)).join("")}
          </div>
        `,
      })}

      ${renderDetailDisclosure({
        title: "Recent history",
        badgeMarkup: `<span class="chip">${escapeHtml(`${jobHistory.length + relevantArtifacts.length}`)}</span>`,
        content: `
          <p class="timeline-detail">Recent job-linked events plus the newest saved artifacts for this filing lane.</p>
          <div class="detail-history-grid">
            <div class="detail-history-block">
              <p class="signal-label">Job events</p>
              ${
                jobHistory.length > 0
                  ? `<ul class="detail-mini-list">${jobHistory.map(renderDetailHistoryItem).join("")}</ul>`
                  : `<p class="helper-text">No saved job-linked events for this listing yet.</p>`
              }
            </div>
            <div class="detail-history-block">
              <p class="signal-label">Lane artifacts</p>
              ${
                relevantArtifacts.length > 0
                  ? `<ul class="detail-mini-list">${relevantArtifacts.map(renderDetailArtifactItem).join("")}</ul>`
                  : `<p class="helper-text">No recent saved artifacts matched this job's current lane.</p>`
              }
            </div>
          </div>
        `,
      })}

      ${renderDetailDisclosure({
        title: "At a glance",
        badgeMarkup: `<span class="chip ${job.attentionReasons.length > 0 ? "is-alert" : "is-accent"}">${escapeHtml(job.attentionReasons.length > 0 ? `${job.attentionReasons.length} blocker${job.attentionReasons.length === 1 ? "" : "s"}` : "Clean")}</span>`,
        content: `
          <div class="signal-grid">
            ${signals.map((signal) => `
              <article class="signal-card ${signal.className}">
                <p class="signal-label">${escapeHtml(signal.label)}</p>
                <p class="signal-value">${escapeHtml(signal.value)}</p>
              </article>
            `).join("")}
          </div>
          ${reviewNotes.map((note) => `<p class="timeline-detail">${escapeHtml(note)}</p>`).join("")}
          ${
            job.workloadReasons.length > 0
              ? `<div class="chip-row">${job.workloadReasons.map((reason) => `<span class="chip is-alert">${escapeHtml(reason)}</span>`).join("")}</div>`
              : ""
          }
        `,
      })}

      ${renderDetailDisclosure({
        title: "Description",
        badgeMarkup: `<span class="chip">${escapeHtml(job.hasDescription ? "Captured" : "Missing")}</span>`,
        content: `
          <div class="detail-copy">
            <p>${escapeHtml(cleanText(job.description) || "No description captured yet.")}</p>
          </div>
        `,
      })}

      ${renderDetailDisclosure({
        title: "Filing update",
        badgeMarkup: `<span class="chip">${escapeHtml(filingStatusLabel)}</span>`,
        open: state.formDirty,
        content: `
          <form id="detailForm" class="detail-form">
            <label>
              <span>Queue status</span>
              <select id="detailStatus">
                ${FILING_STATUS_OPTIONS.map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Notes</span>
              <textarea id="detailNotes" placeholder="Track filing blockers, manual checks, or why this queue item is paused"></textarea>
            </label>
            <div class="form-footer">
              <p id="saveState" class="save-state">${escapeHtml(state.saveState || "Changes save back to data/jobs.json")}</p>
              <button class="action-button" type="submit">Save filing update</button>
            </div>
          </form>
        `,
      })}
    </div>
  `;

  const detailStatus = document.getElementById("detailStatus");
  const detailNotes = document.getElementById("detailNotes");
  const detailForm = document.getElementById("detailForm");

  detailStatus.value = draft.status;
  detailNotes.value = draft.notes;

  detailStatus.addEventListener("change", (event) => {
    state.detailDraft = {
      status: event.target.value,
      notes: detailNotes.value,
    };
    state.formDirty = true;
    updateSaveState("Unsaved changes");
  });

  detailNotes.addEventListener("input", (event) => {
    state.detailDraft = {
      status: detailStatus.value,
      notes: event.target.value,
    };
    state.formDirty = true;
    updateSaveState("Unsaved changes");
  });

  detailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSelectedJob();
  });

  elements.jobDetail.querySelectorAll("[data-detail-load-url]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextUrl = button.getAttribute("data-detail-load-url");
      if (!nextUrl) {
        return;
      }

      primeActionUrl(nextUrl);
    });
  });

  elements.jobDetail.querySelectorAll("[data-detail-run-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const presetUrl = button.getAttribute("data-action-url");
      if (presetUrl) {
        primeActionUrl(presetUrl);
      }

      void runDashboardAction(button.getAttribute("data-detail-run-action"));
    });
  });
}

function renderActions() {
  if (!state.snapshot) {
    elements.actionPanel.innerHTML = `<p class="empty-state">Loading dashboard actions.</p>`;
    return;
  }

  const runner = state.snapshot.actionRunner;
  const activeRun = runner.activeRun;
  const primaryActions = PRIMARY_ACTION_IDS
    .map((id) => runner.actions.find((action) => action.id === id))
    .filter(Boolean);
  const setupAction = primaryActions.find((action) => action.id === "start-debug-browser");
  const saveAction = primaryActions.find((action) => action.id === "browser-save-remote-jobs");
  const applyAction = primaryActions.find((action) => action.id === "browser-start-full-autopilot");
  const totalAppliedJobs = state.snapshot.jobs.filter((job) => job.automationStage === "filed").length;

  elements.actionPanel.innerHTML = `
    <div class="section-head">
      <div>
        <p class="eyebrow">Automation</p>
        <h2>Two automation lanes</h2>
      </div>
      <p class="section-note">${escapeHtml(
        "This dashboard only promotes setup plus the two lanes: save from LinkedIn Remote Jobs, then apply from LinkedIn Jobs Tracker.",
      )}</p>
    </div>

    <div class="action-overview">
      <article class="action-status-card">
        <p class="stat-label">Lane 1</p>
        <p class="action-status-value">Save Remote Jobs</p>
        <p class="stat-context">${escapeHtml("Read preview descriptions on LinkedIn Remote Jobs and keep only the roles that pass your criteria.")}</p>
      </article>
      <article class="action-status-card">
        <p class="stat-label">Lane 2</p>
        <p class="action-status-value">Apply Saved Jobs</p>
        <p class="stat-context">${escapeHtml("Apply only the saved queue that is already visible in LinkedIn Jobs Tracker.")}</p>
      </article>
      <article class="action-status-card">
        <p class="stat-label">Runner</p>
        <p class="action-status-value">${escapeHtml(activeRun ? "Busy" : "Ready")}</p>
        <p class="stat-context">${escapeHtml(
          activeRun
            ? activeRun.label
            : runner.recentRuns.length > 0
              ? `${runner.recentRuns.length} recent run${runner.recentRuns.length === 1 ? "" : "s"}`
              : "No run in progress",
        )}</p>
      </article>
      <article class="action-status-card">
        <p class="stat-label">Profile</p>
        <p class="action-status-value">${escapeHtml(`${state.snapshot.autofillProfile.completionScore}%`)}</p>
        <p class="stat-context">${escapeHtml(`${state.snapshot.autofillProfile.completedFields}/${state.snapshot.autofillProfile.totalFields} autofill fields are ready`)}</p>
      </article>
      <article class="action-status-card">
        <p class="stat-label">Applied</p>
        <p class="action-status-value">${escapeHtml(String(totalAppliedJobs))}</p>
        <p class="stat-context">${escapeHtml(`Job${totalAppliedJobs === 1 ? "" : "s"} already marked filed`)}</p>
      </article>
    </div>

    <div class="action-layout">
      <div class="action-groups">
        <section class="detail-section recommendation-strip">
          <div class="console-section-head">
            <div>
              <h3>Primary actions</h3>
              <p class="timeline-detail">Only setup plus the two lane controls are promoted here. Everything else stays in the detailed job views.</p>
            </div>
            <span class="chip">${escapeHtml(String(primaryActions.length))}</span>
          </div>
          <div class="recommendation-grid">
            ${saveAction ? `
              <article class="recommended-action-card is-primary">
                <div class="recommended-action-head">
                  <div>
                    <p class="mini-eyebrow">Lane 1</p>
                    <p class="list-title">${escapeHtml(saveAction.label)}</p>
                    <p class="timeline-detail">${escapeHtml(saveAction.description)}</p>
                  </div>
                  <span class="chip">${escapeHtml(saveAction.group)}</span>
                </div>
                <p class="recommended-action-note">${escapeHtml(saveAction.commandPreview)}</p>
                <button class="action-button" type="button" data-action-run="${escapeHtml(saveAction.id)}" ${activeRun ? "disabled" : ""}>${escapeHtml(saveAction.label)}</button>
              </article>
            ` : ""}
            ${applyAction ? `
              <article class="recommended-action-card">
                <div class="recommended-action-head">
                  <div>
                    <p class="mini-eyebrow">Lane 2</p>
                    <p class="list-title">${escapeHtml(applyAction.label)}</p>
                    <p class="timeline-detail">${escapeHtml(applyAction.description)}</p>
                  </div>
                  <span class="chip">${escapeHtml(applyAction.group)}</span>
                </div>
                <p class="recommended-action-note">${escapeHtml(applyAction.commandPreview)}</p>
                <button class="action-button" type="button" data-action-run="${escapeHtml(applyAction.id)}" ${activeRun ? "disabled" : ""}>${escapeHtml(applyAction.label)}</button>
              </article>
            ` : ""}
            ${setupAction ? `
              <article class="recommended-action-card">
                <div class="recommended-action-head">
                  <div>
                    <p class="mini-eyebrow">Setup</p>
                    <p class="list-title">${escapeHtml(setupAction.label)}</p>
                    <p class="timeline-detail">${escapeHtml(setupAction.description)}</p>
                  </div>
                  <span class="chip">${escapeHtml(setupAction.group)}</span>
                </div>
                <p class="recommended-action-note">${escapeHtml(setupAction.commandPreview)}</p>
                <button class="action-button" type="button" data-action-run="${escapeHtml(setupAction.id)}" ${activeRun ? "disabled" : ""}>${escapeHtml(setupAction.label)}</button>
              </article>
            ` : ""}
          </div>
        </section>
      </div>

      <div class="action-console">
        <div class="console-shell">
          ${renderRunnerConsole(activeRun)}
          ${
            runner.recentRuns.length > 0
              ? renderHistoryConsole(runner)
              : ""
          }
        </div>
      </div>
    </div>
  `;

  bindActionInputs();
}

function renderPlanStep(step, index) {
  return `
    <article class="plan-step ${escapeHtml(step.stateClass)}">
      <p class="mini-eyebrow">Step ${escapeHtml(String(index + 1))}</p>
      <p class="list-title">${escapeHtml(step.label)}</p>
      <p class="timeline-detail">${escapeHtml(step.detail)}</p>
      <span class="chip ${step.stateClass === "is-next" ? "is-accent" : step.stateClass === "is-blocked" ? "is-alert" : ""}">${escapeHtml(step.stateLabel)}</span>
    </article>
  `;
}

function renderDetailDisclosure({ title, badgeMarkup = "", content, open = false }) {
  return `
    <details class="detail-section detail-disclosure" ${open ? "open" : ""}>
      <summary class="disclosure-summary">
        <span>${escapeHtml(title)}</span>
        ${badgeMarkup}
      </summary>
      <div class="detail-disclosure-body">
        ${content}
      </div>
    </details>
  `;
}

function renderDetailQuickAction(item, hasActiveRun, index) {
  const outcome = getRecommendationOutcome(item);
  const isPrimary = index === 0;

  return `
    <article class="detail-quick-card ${isPrimary ? "is-primary" : ""}">
      <div class="detail-quick-head">
        <div>
          <p class="mini-eyebrow">${escapeHtml(isPrimary ? "Do first" : "Good fallback")}</p>
          <p class="list-title">${escapeHtml(item.action.label)}</p>
          <p class="timeline-detail">${escapeHtml(item.reason)}</p>
        </div>
        <button
          class="action-button"
          type="button"
          data-detail-run-action="${escapeHtml(item.action.id)}"
          ${item.presetUrl ? `data-action-url="${escapeAttribute(item.presetUrl)}"` : ""}
          ${hasActiveRun ? "disabled" : ""}
        >${escapeHtml(isPrimary ? "Run now" : "Run next")}</button>
      </div>
      <p class="detail-status-copy">${escapeHtml(outcome)}</p>
      <div class="chip-row">
        <span class="chip">${escapeHtml(item.action.group)}</span>
        ${item.presetUrl ? `<span class="chip mono">${escapeHtml(shortenUrl(item.presetUrl))}</span>` : `<span class="chip">Uses current browser context</span>`}
      </div>
    </article>
  `;
}

function renderDetailHistoryItem(item) {
  return `
    <li class="detail-mini-item">
      <div class="detail-mini-head">
        <p class="timeline-title">${escapeHtml(item.title)}</p>
        <span class="chip">${escapeHtml(capitalize(item.kind))}</span>
      </div>
      <p class="timeline-detail">${escapeHtml(item.detail)}</p>
      <div class="meta-row">
        <span class="meta-pill">${escapeHtml(formatDateTime(item.timestamp))}</span>
        ${item.targetJobId ? `<span class="meta-pill">Linked queue item</span>` : ""}
      </div>
    </li>
  `;
}

function renderDetailArtifactItem(artifact) {
  return `
    <li class="detail-mini-item">
      <div class="detail-mini-head">
        <div>
          <p class="mini-eyebrow">${escapeHtml(artifact.category)}</p>
          <p class="timeline-title mono">${escapeHtml(artifact.name)}</p>
        </div>
        <span class="chip">${escapeHtml((artifact.extension || "file").toUpperCase())}</span>
      </div>
      <div class="meta-row">
        <span class="meta-pill">${escapeHtml(formatDateTime(artifact.updatedAt))}</span>
        <span class="meta-pill">${escapeHtml(formatBytes(artifact.size))}</span>
        <span class="meta-pill">${escapeHtml(artifact.prefix || "artifact")}</span>
      </div>
    </li>
  `;
}

function getJobRunState(job) {
  return state.snapshot?.actionRunner?.jobStates?.[job.id] || {
    activeRun: null,
    lastRun: null,
    recentRuns: [],
  };
}

function getRunToneClass(status) {
  if (status === "failed") {
    return "is-alert";
  }

  if (status === "running" || status === "completed") {
    return "is-accent";
  }

  return "";
}

function getRunContextLabel(run) {
  return run?.targetJobTitle ? `${run.targetJobTitle} @ ${run.targetJobCompany}` : "Dashboard-level run";
}

function getRunErrorLine(run) {
  if (!run?.logs?.length) {
    return "";
  }

  return [...run.logs]
    .map(stripRunLogLine)
    .reverse()
    .find((line) => /^ERR:/i.test(line) || /Action failed|Process error/i.test(line)) || "";
}

function getRunLatestLogLine(run) {
  if (!run?.logs?.length) {
    return "";
  }

  const lines = run.logs.map(stripRunLogLine).filter(Boolean);
  return lines[lines.length - 1] || "";
}

function stripRunLogLine(value) {
  return value.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function renderRecentRunItem(run) {
  const runError = getRunErrorLine(run);
  const runContext = getRunContextLabel(run);

  return `
    <li class="list-item compact-item">
      <div class="list-head">
        <div>
          <p class="list-title">${escapeHtml(run.label)}</p>
          <p class="timeline-detail mono">${escapeHtml(run.commandPreview)}</p>
        </div>
        <span class="chip ${getRunToneClass(run.status)}">${escapeHtml(capitalize(run.status))}</span>
      </div>
      <p class="timeline-detail">${escapeHtml(runContext)}</p>
      ${
        runError
          ? `<p class="timeline-detail">${escapeHtml(truncateText(runError, 120))}</p>`
          : ""
      }
      <div class="meta-row">
        <span class="meta-pill">${escapeHtml(`Started ${formatDateTime(run.startedAt)}`)}</span>
        <span class="meta-pill">${escapeHtml(run.endedAt ? `Ended ${formatDateTime(run.endedAt)}` : "Still running")}</span>
        ${run.producedArtifacts.length > 0 ? `<span class="meta-pill">${escapeHtml(`${run.producedArtifacts.length} artifact${run.producedArtifacts.length === 1 ? "" : "s"}`)}</span>` : ""}
      </div>
    </li>
  `;
}

function renderRunnerConsole(activeRun) {
  const runContext = activeRun ? getRunContextLabel(activeRun) : "No selected run";
  const runArtifacts = activeRun?.producedArtifacts ?? [];

  return `
    <section class="detail-section console-section">
      <div class="console-section-head">
        <div>
          <h3>Runner</h3>
          <p class="timeline-detail">${escapeHtml(
            activeRun ? "Live process output streams here while the run is active." : "Run one of the minimal controls above to start the next step.",
          )}</p>
        </div>
        ${
          activeRun
            ? `<button id="stopActionButton" class="ghost-button" type="button">Stop run</button>`
            : `<span class="chip">Ready</span>`
        }
      </div>
      <div class="console-stat-grid">
        <article class="console-stat">
          <p class="console-stat-label">Run state</p>
          <p class="console-stat-value">${escapeHtml(activeRun ? activeRun.label : "Idle")}</p>
        </article>
        <article class="console-stat">
          <p class="console-stat-label">Focused job</p>
          <p class="console-stat-value">${escapeHtml(runContext)}</p>
        </article>
        <article class="console-stat">
          <p class="console-stat-label">Exact outputs</p>
          <p class="console-stat-value">${escapeHtml(activeRun ? `${runArtifacts.length} artifact${runArtifacts.length === 1 ? "" : "s"}` : "No active outputs")}</p>
        </article>
        <article class="console-stat">
          <p class="console-stat-label">Session</p>
          <p class="console-stat-value">${escapeHtml(
            state.actionStatusMessage ||
              (activeRun
                ? `PID ${activeRun.pid ?? "unknown"} started ${formatDateTime(activeRun.startedAt)}`
                : "Waiting for the next run"),
          )}</p>
        </article>
      </div>
      <p class="list-meta mono">${escapeHtml(activeRun ? activeRun.commandPreview : "No active command")}</p>
      <pre class="log-view log-view--short">${escapeHtml(activeRun ? activeRun.logs.join("\n") || "Waiting for process output..." : "No active run.")}</pre>
    </section>
  `;
}

function renderTunnelConsole({
  tunnel,
  tunnelDisplayUrl,
  tunnelLabel,
  tunnelDetail,
  canStartTunnel,
  startTunnelLabel,
  tunnelHelperText,
  tunnelTokenPlaceholder,
}) {
  return `
    <section class="detail-section console-section">
      <div class="console-section-head">
        <div>
          <h3>Public link</h3>
          <p class="list-title">${
            tunnelDisplayUrl
              ? `<a href="${escapeAttribute(tunnelDisplayUrl)}" target="_blank" rel="noreferrer">${escapeHtml(tunnelLabel)}</a>`
              : escapeHtml(tunnelLabel)
          }</p>
          <p class="timeline-detail">${escapeHtml(tunnelDetail)}</p>
        </div>
        ${
          tunnel.status === "starting" || tunnel.status === "running"
            ? `<button id="stopTunnelButton" class="ghost-button" type="button">Stop link</button>`
            : `<button id="startTunnelButton" class="action-button" type="button" ${canStartTunnel ? "" : "disabled"}>${escapeHtml(startTunnelLabel)}</button>`
        }
      </div>
      <div class="chip-row">
        <span class="chip">${escapeHtml(capitalize(tunnel.status))}</span>
        <span class="chip">${escapeHtml(tunnel.mode === "named" ? "Named tunnel" : "Quick tunnel")}</span>
        ${tunnel.pid ? `<span class="chip mono">PID ${escapeHtml(String(tunnel.pid))}</span>` : ""}
      </div>
      <p class="helper-text">${escapeHtml(tunnelHelperText)}</p>
    </section>

    <section class="detail-section">
      <h3>Tunnel setup</h3>
      <form id="tunnelConfigForm" class="detail-form">
        <div class="option-grid">
          <label class="field">
            <span>Mode</span>
            <select id="tunnelMode">
              <option value="quick" ${tunnel.preferredMode === "quick" ? "selected" : ""}>Quick tunnel</option>
              <option value="named" ${tunnel.preferredMode === "named" ? "selected" : ""}>Named tunnel</option>
            </select>
          </label>
          <label class="field">
            <span>Tunnel name</span>
            <input id="tunnelName" type="text" placeholder="job-assistant-dashboard" value="${escapeAttribute(tunnel.tunnelName || "job-assistant-dashboard")}" />
          </label>
          <label class="field">
            <span>Public hostname</span>
            <input id="tunnelHostname" type="text" placeholder="jobs.example.com" value="${escapeAttribute(tunnel.publicHostname || "")}" />
          </label>
          <label class="field">
            <span>Tunnel token</span>
            <input id="tunnelToken" type="password" autocomplete="current-password" placeholder="${escapeAttribute(tunnelTokenPlaceholder)}" value="" />
          </label>
        </div>
        <div class="chip-row">
          <span class="chip">${escapeHtml(tunnel.preferredMode === "named" ? "Stable hostname mode" : "Temporary link mode")}</span>
          ${tunnel.namedTunnelConfigured ? `<span class="chip">Named tunnel configured</span>` : ""}
          ${tunnel.tokenConfigured ? `<span class="chip">Token saved</span>` : ""}
          ${tunnel.configSource === "env" ? `<span class="chip">Env override</span>` : ""}
        </div>
        <p class="helper-text">${escapeHtml(
          tunnel.preferredMode === "named"
            ? "Named mode uses a stable hostname, but you still need a Cloudflare-managed tunnel token and a public hostname already routed to that tunnel."
            : "Quick mode uses a temporary trycloudflare.com URL for testing and sharing.",
        )}</p>
        <div class="detail-actions">
          <button id="saveTunnelConfigButton" class="ghost-button" type="submit">Save tunnel settings</button>
          ${tunnel.tokenConfigured ? `<button id="clearTunnelTokenButton" class="ghost-button" type="button">Clear saved token</button>` : ""}
        </div>
      </form>
      <pre class="log-view log-view--short">${escapeHtml(tunnel.logs.join("\n") || "No tunnel activity yet.")}</pre>
    </section>
  `;
}

function renderHistoryConsole(runner) {
  return `
    <section class="detail-section console-section">
      <div class="console-section-head">
        <div>
          <h3>Recent runs</h3>
          <p class="timeline-detail">Completed dashboard runs stay here so you can see what executed most recently.</p>
        </div>
        <span class="chip">${escapeHtml(String(runner.recentRuns.length))}</span>
      </div>
      ${
      runner.recentRuns.length === 0
          ? renderEmptyState({
            eyebrow: "No runs yet",
            title: "No dashboard action has run yet",
            body: "Run one of the minimal controls above. After that, this section becomes the audit trail.",
            tone: "calm",
            actions: [
              { label: "Open tools", href: "#actionPanel", variant: "primary" },
              { label: "Open tracker bridge", href: "#workspaceGuide" },
            ],
          })
          : `<ul class="panel-list panel-scroll">${runner.recentRuns.map(renderRecentRunItem).join("")}</ul>`
      }
    </section>
  `;
}

function bindActionInputs() {
  const actionUrl = document.getElementById("actionUrl");
  const actionEnrichLimit = document.getElementById("actionEnrichLimit");
  const actionBatchLimit = document.getElementById("actionBatchLimit");
  const actionPageLimit = document.getElementById("actionPageLimit");
  const runButtons = elements.actionPanel.querySelectorAll("[data-action-run]");
  const loadUrlButtons = elements.actionPanel.querySelectorAll("[data-load-url]");
  const stopButton = document.getElementById("stopActionButton");
  const startTunnelButton = document.getElementById("startTunnelButton");
  const stopTunnelButton = document.getElementById("stopTunnelButton");
  const tunnelConfigForm = document.getElementById("tunnelConfigForm");
  const clearTunnelTokenButton = document.getElementById("clearTunnelTokenButton");
  const consoleTabButtons = elements.actionPanel.querySelectorAll("[data-console-tab]");
  const actionGroups = Array.from(elements.actionPanel.querySelectorAll("[data-action-group]"));

  actionUrl?.addEventListener("input", (event) => {
    state.actionConfig.url = event.target.value;
  });

  actionEnrichLimit?.addEventListener("input", (event) => {
    state.actionConfig.enrichLimit = coercePositiveInteger(event.target.value, state.actionConfig.enrichLimit);
  });

  actionBatchLimit?.addEventListener("input", (event) => {
    state.actionConfig.batchLimit = coercePositiveInteger(event.target.value, state.actionConfig.batchLimit);
  });

  actionPageLimit?.addEventListener("input", (event) => {
    state.actionConfig.pageLimit = coercePositiveInteger(event.target.value, state.actionConfig.pageLimit);
  });

  runButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const presetUrl = button.getAttribute("data-action-url");
      if (presetUrl) {
        state.actionConfig.url = presetUrl;
        if (actionUrl) {
          actionUrl.value = presetUrl;
        }
      }
      void runDashboardAction(button.getAttribute("data-action-run"));
    });
  });

  loadUrlButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextUrl = button.getAttribute("data-load-url");
      if (!nextUrl) {
        return;
      }

      primeActionUrl(nextUrl);
    });
  });

  consoleTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextTab = button.getAttribute("data-console-tab");
      if (!nextTab || nextTab === state.ui.consoleTab) {
        return;
      }

      state.ui.consoleTab = nextTab;
      renderActions();
    });
  });

  stopButton?.addEventListener("click", () => {
    void stopDashboardAction();
  });

  startTunnelButton?.addEventListener("click", () => {
    void startPublicTunnel();
  });

  stopTunnelButton?.addEventListener("click", () => {
    void stopPublicTunnel();
  });

  tunnelConfigForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveTunnelConfig();
  });

  clearTunnelTokenButton?.addEventListener("click", () => {
    void saveTunnelConfig({ clearToken: true });
  });

  actionGroups.forEach((groupElement) => {
    groupElement.addEventListener("toggle", () => {
      const groupName = groupElement.getAttribute("data-action-group");
      if (!groupName) {
        return;
      }

      if (groupElement.open) {
        state.ui.actionGroup = groupName;
        actionGroups.forEach((otherGroup) => {
          if (otherGroup !== groupElement) {
            otherGroup.open = false;
          }
        });
        return;
      }

      if (state.ui.actionGroup === groupName) {
        state.ui.actionGroup = "";
      }
    });
  });

  bindDashboardIntents(elements.actionPanel);
}

function renderActivity() {
  if (!state.snapshot) {
    return;
  }

  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const decisions = evaluationInsights.decisions.slice(0, 10);
  elements.activityPanel.innerHTML = `
    ${renderSubpanelHead("Evaluation", "Recent save and dismiss decisions", `${decisions.length} decision${decisions.length === 1 ? "" : "s"}`)}
    <div class="metric-row">
      <div class="metric-pill">
        <span>Saved</span>
        <strong>${escapeHtml(String(evaluationInsights.savedDecisionCount))}</strong>
      </div>
      <div class="metric-pill">
        <span>Dismissed</span>
        <strong>${escapeHtml(String(evaluationInsights.dismissedDecisionCount))}</strong>
      </div>
    </div>
    ${
      decisions.length === 0
        ? renderEmptyState({
          eyebrow: "No save decisions yet",
          title: "Run the Remote Jobs save lane to track every screening decision here",
          body: "This stream now comes from the persisted decision ledger, so each saved, dismissed, or skipped role stays visible with its score and reasons.",
          tone: "calm",
          actions: [
            { label: "Open runner", intent: "console-tab:runner", variant: "primary" },
            { label: "Open controls", href: "#actionPanel" },
          ],
        })
        : `<ul class="timeline-list panel-scroll">${decisions.map((decision) => renderEvaluationDecisionItem(decision, decision.action)).join("")}</ul>`
    }
  `;

  bindDashboardIntents(elements.activityPanel);
}

function renderAttention() {
  if (!state.snapshot) {
    return;
  }

  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const jobs = evaluationInsights.savedQueue.slice(0, 10);
  elements.attentionPanel.innerHTML = `
    ${renderSubpanelHead("Saved queue", "Why these jobs were kept", `${state.snapshot.jobs.length} saved`)}
    <div class="metric-row">
      <div class="metric-pill">
        <span>Evaluated</span>
        <strong>${escapeHtml(String(evaluationInsights.evaluatedSavedJobs.length))}</strong>
      </div>
      <div class="metric-pill">
        <span>Missing score</span>
        <strong>${escapeHtml(String(evaluationInsights.missingSavedJobs.length))}</strong>
      </div>
    </div>
    ${
      state.snapshot.jobs.length === 0
        ? renderEmptyState({
          eyebrow: "No saved jobs yet",
          title: "The queue will explain itself once jobs are saved",
          body: "After the Remote Jobs lane saves matching roles, this panel will show the saved jobs, their score, the profile used, and the reasons they stayed in the queue.",
          tone: "calm",
          actions: [
            { label: "Open controls", href: "#actionPanel", variant: "primary" },
            { label: "Open Remote Jobs", href: LINKEDIN_REMOTE_JOBS_URL },
          ],
        })
        : jobs.length === 0
          ? renderEmptyState({
            eyebrow: "No tracked scores yet",
            title: "Saved jobs exist, but the dashboard has not captured their screening output yet",
            body: "Run the save automation again and the queue review below will attach the latest saved reasons and scores.",
            tone: "warning",
            actions: [
              { label: "Run Save Remote Jobs", intent: "console-tab:runner", variant: "primary" },
              { label: "Open controls", href: "#actionPanel" },
            ],
          })
          : `<ul class="panel-list panel-scroll">${jobs.map(renderSavedQueueEvaluationItem).join("")}</ul>`
    }
  `;

  bindDashboardIntents(elements.attentionPanel);
}

function renderSavedQueueEvaluationItem(entry) {
  const { job, screening, latestDecision } = entry;
  const toneClass = screening && !screening.pass ? " is-alert" : screening ? " is-accent" : "";
  const reasonSummary = screening?.reasons?.length
    ? screening.reasons.join("; ")
    : "No tracked evaluation reasons are attached to this saved job yet.";

  return `
    <li class="list-item compact-item saved-evaluation-item${toneClass}">
      <div class="list-head">
        <div>
          <p class="list-title">${escapeHtml(job.displayTitle || job.title)}</p>
          <p class="timeline-detail">${escapeHtml(job.displayCompany)}</p>
        </div>
        <span class="chip ${screening && screening.pass ? "is-accent" : screening ? "is-alert" : ""}">
          ${escapeHtml(screening ? (screening.pass ? "Saved" : "Flagged") : "Unscored")}
        </span>
      </div>
      <div class="chip-row">
        ${screening?.profileName ? `<span class="chip">${escapeHtml(screening.profileName)}</span>` : ""}
        ${Number.isFinite(screening?.score) ? `<span class="chip">${escapeHtml(`Score ${screening.score}`)}</span>` : ""}
        ${latestDecision?.url || job.url ? `<span class="chip mono">${escapeHtml(shortenUrl(latestDecision?.url || job.url))}</span>` : ""}
      </div>
      <p class="timeline-detail">${escapeHtml(reasonSummary)}</p>
      <div class="chip-row">
        ${job.attentionReasons.map((reason) => `<span class="chip is-alert">${escapeHtml(reason)}</span>`).join("")}
        ${screening?.source ? `<span class="chip">${escapeHtml(screening.source === "saved-job" ? "Persisted on job" : "Recovered from run logs")}</span>` : ""}
      </div>
    </li>
  `;
}

function renderProfile() {
  if (!state.snapshot) {
    return;
  }

  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const evaluationProfile = getEditableEvaluationProfile();
  const activeEvaluationProfile = getActiveEvaluationProfile();
  const { autofillProfile } = state.snapshot;
  const profileLines = [
    { label: "Name", value: autofillProfile.data.name || "No name saved yet" },
    { label: "Email", value: autofillProfile.data.email || "No email saved" },
    { label: "Phone", value: autofillProfile.data.phone || "No phone saved" },
  ];

  elements.profilePanel.innerHTML = `
    ${renderSubpanelHead("Profiles", "Evaluation criteria and autofill readiness", state.evaluation.apiState === "ready" ? `${state.evaluation.profiles.length} profile${state.evaluation.profiles.length === 1 ? "" : "s"}` : "API")}

    <section class="detail-section">
      <div class="console-section-head">
        <div>
          <h3>Evaluation profiles</h3>
          <p class="timeline-detail">These criteria control what the Remote Jobs save lane keeps or dismisses.</p>
        </div>
        <span class="chip">${escapeHtml(activeEvaluationProfile?.name || evaluationInsights.activeProfileName || "No active profile")}</span>
      </div>
      <div class="metric-row">
        <div class="metric-pill">
          <span>Saved decisions</span>
          <strong>${escapeHtml(String(evaluationInsights.savedDecisionCount))}</strong>
        </div>
        <div class="metric-pill">
          <span>Dismissed decisions</span>
          <strong>${escapeHtml(String(evaluationInsights.dismissedDecisionCount))}</strong>
        </div>
      </div>
      ${renderEvaluationProfileSurface(evaluationProfile, activeEvaluationProfile, evaluationInsights)}
    </section>

    <section class="detail-section">
      <div class="console-section-head">
        <div>
          <h3>Autofill profile</h3>
          <p class="timeline-detail">This still controls form-filling readiness separately from the save criteria above.</p>
        </div>
        <span class="chip">${escapeHtml(`${autofillProfile.completedFields}/${autofillProfile.totalFields}`)}</span>
      </div>

      <div class="profile-head">
        <p class="profile-score">${escapeHtml(String(autofillProfile.completionScore))}%</p>
        <div class="profile-meter">
          <div class="profile-meter-fill" style="width: ${Math.max(0, Math.min(100, autofillProfile.completionScore))}%"></div>
        </div>
        <p class="profile-copy">${escapeHtml(`${autofillProfile.completedFields} of ${autofillProfile.totalFields} autofill fields are ready.`)}</p>
      </div>

      <div class="mini-grid">
        ${profileLines
          .map(
            (line) => `
              <article class="mini-card">
                <p class="signal-label">${escapeHtml(line.label)}</p>
                <p class="timeline-detail">${escapeHtml(line.value)}</p>
              </article>
            `,
          )
          .join("")}
      </div>

      <div class="detail-section">
        <h3>Missing autofill fields</h3>
        ${
          autofillProfile.missingFields.length === 0
            ? `<p>Autofill profile looks complete.</p>`
            : `<div class="chip-row">${autofillProfile.missingFields.map((field) => `<span class="chip is-alert">${escapeHtml(field)}</span>`).join("")}</div>`
        }
      </div>
    </section>
  `;

  if (state.evaluation.apiState === "ready") {
    bindEvaluationProfileInputs();
  }
}

function renderAnswerCapture() {
  if (!state.snapshot || !elements.questionCapturePanel) {
    return;
  }

  const review = state.snapshot.answerCapture;
  const selected = getSelectedQuestionReviewItem();

  elements.questionCapturePanel.innerHTML = `
    ${renderSubpanelHead("Answer capture", "Unresolved application questions", `${review.unresolvedCount} open`) }

    <div class="question-capture-shell">
      <div class="question-review-stack">
        <section class="detail-section">
          <div class="console-section-head">
            <div>
              <h3>Unresolved questions</h3>
              <p class="timeline-detail">Click a question to fill the editor and save it back into the local answer map.</p>
            </div>
            <span class="chip is-alert">${escapeHtml(String(review.unresolvedCount))}</span>
          </div>
          ${
            review.unresolvedQuestions.length === 0
              ? renderEmptyState({
                eyebrow: "All caught up",
                title: "No unresolved questions are waiting right now",
                body: "New unanswered questions will appear here the next time the browser captures a form review.",
                tone: "calm",
              })
              : `<div class="question-review-list">${review.unresolvedQuestions.map((item) => renderQuestionReviewItem(item, item.key === state.selectedQuestionKey)).join("")}</div>`
          }
        </section>

        <section class="detail-section">
          <div class="console-section-head">
            <div>
              <h3>Saved answers</h3>
              <p class="timeline-detail">These are the most recent answered questions already persisted in the local files.</p>
            </div>
            <span class="chip">${escapeHtml(String(review.answeredCount))}</span>
          </div>
          ${
            review.answeredQuestions.length === 0
              ? `<p class="question-review-note">No answered questions have been saved yet.</p>`
              : `<div class="question-review-list">${review.answeredQuestions.map((item) => renderQuestionReviewItem(item, item.key === state.selectedQuestionKey)).join("")}</div>`
          }
        </section>
      </div>

      <section class="question-editor-shell">
        ${
          selected
            ? renderQuestionEditor(selected)
            : renderEmptyState({
              eyebrow: "Pick a question",
              title: "Select an unanswered row to edit its answer",
              body: "The editor stays blank until you choose a question from the list. Once filled, saving updates both data/application-answers.json and data/question-bank.json.",
              tone: "calm",
            })
        }
      </section>
    </div>
  `;

  bindQuestionCaptureInputs();
}

function renderQuestionReviewItem(question, isSelected) {
  const answerText = cleanText(question.currentAnswer || question.suggestedAnswer || "");
  const valueText = answerText || "Awaiting answer";
  const summaryText = question.status === "answered"
    ? `Saved answer: ${valueText}`
    : question.suggestedAnswer
      ? `Suggested answer: ${question.suggestedAnswer}`
      : "No saved answer yet";

  return `
    <button class="question-review-card ${isSelected ? "is-selected" : ""}" type="button" data-question-select="${escapeHtml(question.key)}">
      <div class="list-head">
        <div>
          <p class="question-review-title">${escapeHtml(question.label)}</p>
          <p class="question-review-detail">${escapeHtml(question.type)}</p>
        </div>
        <span class="chip ${question.status === "unanswered" ? "is-alert" : "is-accent"}">${escapeHtml(question.status)}</span>
      </div>
      <p class="question-review-note">${escapeHtml(summaryText)}</p>
      <div class="question-review-meta">
        <span class="chip">${escapeHtml(question.bucket)}</span>
        <span class="chip">${escapeHtml(`Seen ${question.seenCount}`)}</span>
        <span class="chip">${escapeHtml(formatDateTime(question.lastSeenAt))}</span>
      </div>
    </button>
  `;
}

function renderQuestionEditor(question) {
  const bucketOptions = [
    { value: "auto", label: "Auto" },
    { value: "text", label: "Text" },
    { value: "select", label: "Select" },
    { value: "radio", label: "Radio" },
    { value: "checkbox", label: "Checkbox" },
    { value: "all", label: "All buckets" },
  ];
  const answerValue = cleanText(question.currentAnswer || question.suggestedAnswer || "");

  return `
    <div class="detail-section">
      <div class="console-section-head">
        <div>
          <h3>Answer editor</h3>
          <p class="timeline-detail">Update the label, type, and answer, then save it into the local JSON files.</p>
        </div>
        <span class="chip">${escapeHtml(question.status)}</span>
      </div>

      <form id="questionCaptureForm" class="detail-form">
        <label>
          <span>Question label</span>
          <input id="questionCaptureLabel" type="text" value="${escapeAttribute(question.label)}" readonly />
        </label>
        <label>
          <span>Question type</span>
          <input id="questionCaptureType" type="text" value="${escapeAttribute(question.type)}" readonly />
        </label>
        <div class="option-grid">
          <label class="field">
            <span>Bucket</span>
            <select id="questionCaptureBucket">
              ${bucketOptions.map((option) => `<option value="${escapeAttribute(option.value)}" ${option.value === state.questionBucket ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>Seen count</span>
            <input type="text" value="${escapeAttribute(String(question.seenCount))}" disabled />
          </label>
        </div>
        <label>
          <span>Answer</span>
          <textarea id="questionCaptureAnswer" placeholder="Enter the answer to save, or leave blank to clear">${escapeHtml(answerValue)}</textarea>
        </label>
        <div class="detail-section">
          <h3>Captured choices</h3>
          ${
            question.choices.length > 0
              ? `<div class="chip-row">${question.choices.slice(0, 8).map((choice) => `<span class="chip">${escapeHtml(choice)}</span>`).join("")}</div>`
              : `<p class="question-review-note">No captured choices were stored with this question.</p>`
          }
        </div>
        <div class="detail-section">
          <h3>Current answer</h3>
          <p class="question-review-note">${escapeHtml(question.currentAnswer || "No saved answer yet")}</p>
          <h3>Suggested answer</h3>
          <p class="question-review-note">${escapeHtml(question.suggestedAnswer || "No suggestion available")}</p>
        </div>
        <div class="chip-row">
          <span class="chip">${escapeHtml(question.key)}</span>
          <span class="chip">${escapeHtml(question.source)}</span>
        </div>
        <div class="form-footer">
          <p id="questionSaveState" class="save-state">${escapeHtml(state.questionSaveState || "Saving updates data/application-answers.json and data/question-bank.json")}</p>
          <div class="detail-actions">
            <button class="ghost-button" type="button" data-question-clear>Clear answer</button>
            <button class="action-button" type="submit">Save answer</button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function bindQuestionCaptureInputs() {
  const form = document.getElementById("questionCaptureForm");
  const bucket = document.getElementById("questionCaptureBucket");
  const answer = document.getElementById("questionCaptureAnswer");
  const label = document.getElementById("questionCaptureLabel");
  const type = document.getElementById("questionCaptureType");

  elements.questionCapturePanel.querySelectorAll("[data-question-select]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextKey = button.getAttribute("data-question-select");
      if (!nextKey) {
        return;
      }

      state.selectedQuestionKey = nextKey;
      state.questionBucket = "auto";
      updateQuestionSaveState("Question loaded");
      renderAnswerCapture();
    });
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveQuestionCaptureAnswer(false);
  });

  elements.questionCapturePanel.querySelectorAll("[data-question-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      void saveQuestionCaptureAnswer(true);
    });
  });

  bucket?.addEventListener("change", (event) => {
    state.questionBucket = event.target.value;
    updateQuestionSaveState("Bucket updated locally");
  });

  label?.addEventListener("input", () => updateQuestionSaveState("Unsaved changes"));
  type?.addEventListener("input", () => updateQuestionSaveState("Unsaved changes"));
  answer?.addEventListener("input", () => updateQuestionSaveState("Unsaved changes"));
}

function syncQuestionSelection() {
  const review = state.snapshot?.answerCapture;
  if (!review) {
    state.selectedQuestionKey = "";
    return;
  }

  const hasSelection =
    review.unresolvedQuestions.some((question) => question.key === state.selectedQuestionKey) ||
    review.answeredQuestions.some((question) => question.key === state.selectedQuestionKey);

  if (hasSelection) {
    return;
  }

  state.selectedQuestionKey =
    review.unresolvedQuestions[0]?.key ||
    review.answeredQuestions[0]?.key ||
    "";
  state.questionBucket = "auto";
}

function getSelectedQuestionReviewItem() {
  const review = state.snapshot?.answerCapture;
  if (!review) {
    return null;
  }

  return (
    review.unresolvedQuestions.find((question) => question.key === state.selectedQuestionKey) ||
    review.answeredQuestions.find((question) => question.key === state.selectedQuestionKey) ||
    review.unresolvedQuestions[0] ||
    review.answeredQuestions[0] ||
    null
  );
}

function updateQuestionSaveState(message) {
  state.questionSaveState = message;
  const saveState = document.getElementById("questionSaveState");
  if (saveState) {
    saveState.textContent = message;
  }
}

async function saveQuestionCaptureAnswer(clearAnswer) {
  const selected = getSelectedQuestionReviewItem();
  if (!selected) {
    updateQuestionSaveState("Select a question first");
    return;
  }

  const label = cleanText(document.getElementById("questionCaptureLabel")?.value || selected.label);
  const type = cleanText(document.getElementById("questionCaptureType")?.value || selected.type);
  const bucket = document.getElementById("questionCaptureBucket")?.value || state.questionBucket || "auto";
  const answer = clearAnswer
    ? ""
    : cleanText(document.getElementById("questionCaptureAnswer")?.value || "");

  updateQuestionSaveState(clearAnswer ? "Clearing answer..." : "Saving answer...");

  try {
    const response = await fetch("/api/application-answers", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: selected.key,
        label,
        type,
        answer,
        bucket,
        choices: selected.choices,
      }),
    });

    if (!response.ok) {
      throw new Error(`Save failed with ${response.status}`);
    }

    state.selectedQuestionKey = selected.key;
    state.questionBucket = "auto";
    updateQuestionSaveState(answer ? "Answer saved" : "Answer cleared");
    await loadDashboard({ silent: true });
  } catch (error) {
    updateQuestionSaveState(error instanceof Error ? error.message : "Answer save failed");
  }
}

function renderModules() {
  if (!state.snapshot) {
    return;
  }

  const modules = state.snapshot.automationModules;
  const artifacts = state.snapshot.recentBrowserArtifacts;

  elements.artifactPanel.innerHTML = `
    ${renderSubpanelHead("Modules", "What the automation is doing", `${modules.length} modules`)}

    <div class="module-grid">
      ${modules.map(renderModuleItem).join("")}
    </div>

    <div class="detail-section">
      <div class="console-section-head">
        <div>
          <h3>Recent artifacts</h3>
          <p class="timeline-detail">Newest browser outputs written by the automation, ordered by most recent save time.</p>
        </div>
        <span class="chip">${escapeHtml(String(Math.min(artifacts.length, 8)))}</span>
      </div>
      ${
        artifacts.length === 0
          ? `<p>No browser artifacts found in data/browser.</p>`
          : `<ul class="panel-list panel-scroll">${artifacts.slice(0, 8).map(renderArtifactItem).join("")}</ul>`
      }
    </div>
  `;
}

function renderModuleItem(module) {
  const statusClass = module.fileCount === 0 ? " is-alert" : "";

  return `
    <article class="module-card">
      <div class="list-head">
        <p class="list-title">${escapeHtml(module.label)}</p>
        <span class="chip${statusClass}">${escapeHtml(module.status)}</span>
      </div>
      <p class="timeline-detail">${escapeHtml(module.description)}</p>
      <div class="metric-row">
        <div class="metric-pill">
          <span>Artifacts</span>
          <strong>${escapeHtml(String(module.fileCount))}</strong>
        </div>
        <div class="metric-pill">
          <span>Latest</span>
          <strong>${escapeHtml(module.latestAt ? formatDateTime(module.latestAt) : "No saved run")}</strong>
        </div>
      </div>
    </article>
  `;
}

function renderArtifactItem(artifact) {
  return `
    <li class="list-item compact-item">
      <div class="list-head">
        <div>
          <p class="mini-eyebrow">${escapeHtml(artifact.category)}</p>
          <p class="list-title mono">${escapeHtml(artifact.name)}</p>
        </div>
        <span class="chip">${escapeHtml((artifact.extension || "file").toUpperCase())}</span>
      </div>
      <div class="meta-row">
        <span class="meta-pill">${escapeHtml(formatDateTime(artifact.updatedAt))}</span>
        <span class="meta-pill">${escapeHtml(formatBytes(artifact.size))}</span>
        <span class="meta-pill">${escapeHtml(artifact.prefix || "artifact")}</span>
      </div>
    </li>
  `;
}

function renderExternalApply() {
  if (!state.snapshot) {
    return;
  }

  const jobs = state.snapshot.externalApplyJobs;
  const evaluation = state.snapshot.evaluation || {};
  const evaluationInsights = buildEvaluationInsights(state.snapshot);
  const savedDecisions = Array.isArray(evaluation.savedDecisions) ? evaluation.savedDecisions.slice(0, 6) : [];
  const dismissedDecisions = Array.isArray(evaluation.dismissedDecisions) ? evaluation.dismissedDecisions.slice(0, 6) : [];
  const skippedDecisions = Array.isArray(evaluation.skippedDecisions) ? evaluation.skippedDecisions.slice(0, 4) : [];
  const queueAudit = evaluationInsights.savedQueue.slice(0, 6);

  elements.companyPanel.innerHTML = `
    ${renderSubpanelHead("Screening outcomes", "Saved vs dismissed and why", `${evaluation.stats?.trackedCount || evaluationInsights.decisions.length} tracked`)}

    <section class="detail-section">
      <div class="metric-row">
        <div class="metric-pill">
          <span>Saved</span>
          <strong>${escapeHtml(String(evaluationInsights.savedDecisionCount))}</strong>
        </div>
        <div class="metric-pill">
          <span>Dismissed</span>
          <strong>${escapeHtml(String(evaluationInsights.dismissedDecisionCount))}</strong>
        </div>
        <div class="metric-pill">
          <span>Skipped</span>
          <strong>${escapeHtml(String(evaluationInsights.skippedDecisionCount))}</strong>
        </div>
      </div>
      <p class="timeline-detail">
        ${
          evaluationInsights.latestDecision
            ? escapeHtml(
              `Latest decision: ${(evaluationInsights.latestDecision.title || "Untitled role")} @ ${(evaluationInsights.latestDecision.company || "Unknown company")} on ${formatDateTime(evaluationInsights.latestDecision.evaluatedAt || evaluationInsights.latestDecision.timestamp || "")}.`,
            )
            : "Run the Remote Jobs save lane and this panel will show exactly what was kept or rejected."
        }
      </p>
    </section>

    <div class="evaluation-decision-columns">
      <section class="detail-section">
        <div class="console-section-head">
          <div>
            <h3>Saved jobs</h3>
            <p class="timeline-detail">Roles that passed the current or prior criteria and were kept in the queue.</p>
          </div>
          <span class="chip is-accent">${escapeHtml(String(evaluationInsights.savedDecisionCount))}</span>
        </div>
        ${
          savedDecisions.length === 0
            ? `<p class="question-review-note">No saved decisions have been tracked yet.</p>`
            : `<ul class="panel-list panel-scroll">${savedDecisions.map((decision) => renderEvaluationDecisionItem(decision, "saved")).join("")}</ul>`
        }
      </section>

      <section class="detail-section">
        <div class="console-section-head">
          <div>
            <h3>Dismissed jobs</h3>
            <p class="timeline-detail">Roles the save lane rejected, with the reasons that pushed them out.</p>
          </div>
          <span class="chip is-alert">${escapeHtml(String(evaluationInsights.dismissedDecisionCount))}</span>
        </div>
        ${
          dismissedDecisions.length === 0
            ? `<p class="question-review-note">No dismissed decisions have been tracked yet.</p>`
            : `<ul class="panel-list panel-scroll">${dismissedDecisions.map((decision) => renderEvaluationDecisionItem(decision, "dismissed")).join("")}</ul>`
        }
      </section>
    </div>

    ${
      skippedDecisions.length > 0
        ? `
          <section class="detail-section">
            <div class="console-section-head">
              <div>
                <h3>Skipped</h3>
                <p class="timeline-detail">Jobs where the collector could not fully inspect or act on the preview.</p>
              </div>
              <span class="chip">${escapeHtml(String(evaluationInsights.skippedDecisionCount))}</span>
            </div>
            <ul class="panel-list panel-scroll">${skippedDecisions.map((decision) => renderEvaluationDecisionItem(decision, "skipped")).join("")}</ul>
          </section>
        `
        : ""
    }

    <section class="detail-section">
      <div class="console-section-head">
        <div>
          <h3>Saved queue audit</h3>
          <p class="timeline-detail">Shows which saved jobs have tracked evaluation data and which ones now look risky under the recorded criteria.</p>
        </div>
        <span class="chip">${escapeHtml(String(evaluationInsights.savedQueue.length))}</span>
      </div>
      <div class="metric-row">
        <div class="metric-pill">
          <span>Tracked saved jobs</span>
          <strong>${escapeHtml(String(evaluationInsights.evaluatedSavedJobs.length))}</strong>
        </div>
        <div class="metric-pill">
          <span>Missing evaluation</span>
          <strong>${escapeHtml(String(evaluationInsights.missingSavedJobs.length))}</strong>
        </div>
        <div class="metric-pill">
          <span>Flagged saved jobs</span>
          <strong>${escapeHtml(String(evaluationInsights.flaggedSavedJobs.length))}</strong>
        </div>
      </div>
      ${
        queueAudit.length === 0
          ? `<p class="question-review-note">No locally saved jobs are in the queue yet.</p>`
          : `<ul class="panel-list panel-scroll">${queueAudit.map(renderSavedQueueAuditItem).join("")}</ul>`
      }
    </section>

    <section class="detail-section">
      <div class="console-section-head">
        <div>
          <h3>Employer routes</h3>
          <p class="timeline-detail">External apply findings still stay visible here for the saved queue.</p>
        </div>
        <span class="chip">${escapeHtml(String(jobs.length))}</span>
      </div>
      ${
        jobs.length === 0
          ? `<p class="question-review-note">No employer routes are saved yet.</p>`
          : `<ul class="panel-list panel-scroll">${jobs.map(renderExternalApplyItem).join("")}</ul>`
      }
    </section>
  `;

  bindDashboardIntents(elements.companyPanel);
}

function renderExternalApplyItem(job) {
  const meta = job.externalApplyDestinationUrl
    ? shortenUrl(job.externalApplyDestinationUrl)
    : "No employer URL captured";
  const routeHost = job.externalApplyDestinationUrl ? getHostname(job.externalApplyDestinationUrl) : "Missing route";

  return `
    <li class="list-item compact-item">
      <div class="list-head">
        <div>
          <p class="list-title">${escapeHtml(job.displayTitle)}</p>
          <p class="timeline-detail">${escapeHtml(job.displayCompany)}</p>
        </div>
        <span class="chip">${escapeHtml(routeHost)}</span>
      </div>
      <p class="list-meta mono">${escapeHtml(meta)}</p>
      <div class="chip-row">
        <span class="chip">${escapeHtml(STAGE_LABELS[job.automationStage])}</span>
        <span class="chip">${escapeHtml(job.externalApplyFound ? "Employer URL found" : "Flag only")}</span>
        ${job.workloadFiltered ? `<span class="chip is-alert">Workload flagged</span>` : ""}
      </div>
    </li>
  `;
}

function renderSubpanelHead(eyebrow, title, meta = "") {
  return `
    <div class="subpanel-head">
      <div>
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h3>${escapeHtml(title)}</h3>
      </div>
      ${meta ? `<span class="chip">${escapeHtml(meta)}</span>` : ""}
    </div>
  `;
}

async function runDashboardAction(actionId) {
  if (!actionId) {
    return;
  }

  state.actionStatusMessage = "Starting action...";
  setDashboardStatus();

  try {
    const response = await fetch("/api/actions/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actionId,
        url: state.actionConfig.url,
        enrichLimit: state.actionConfig.enrichLimit,
        batchLimit: state.actionConfig.batchLimit,
        pageLimit: state.actionConfig.pageLimit,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Action failed with ${response.status}`);
    }

    state.actionStatusMessage = `${payload.run.label} started${payload.run.targetJobTitle ? ` for ${payload.run.targetJobTitle}` : ""}`;
    await loadDashboard({ silent: true });
  } catch (error) {
    state.actionStatusMessage = error instanceof Error ? error.message : "Action failed to start";
    setDashboardStatus();
  }
}

async function stopDashboardAction() {
  try {
    const response = await fetch("/api/actions/stop", {
      method: "POST",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Stop failed with ${response.status}`);
    }

    state.actionStatusMessage = "Stop requested";
    await loadDashboard({ silent: true });
  } catch (error) {
    state.actionStatusMessage = error instanceof Error ? error.message : "Stop failed";
    setDashboardStatus();
  }
}

async function startPublicTunnel() {
  state.actionStatusMessage = "Starting Cloudflare Tunnel";
  setDashboardStatus();

  try {
    const response = await fetch("/api/tunnel/start", {
      method: "POST",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Tunnel failed with ${response.status}`);
    }

    state.actionStatusMessage = payload.tunnel?.publicUrl
      ? "Public link live"
      : "Cloudflare Tunnel starting";
    await loadDashboard({ silent: true });
  } catch (error) {
    state.actionStatusMessage = error instanceof Error ? error.message : "Tunnel failed to start";
    setDashboardStatus();
  }
}

async function stopPublicTunnel() {
  try {
    const response = await fetch("/api/tunnel/stop", {
      method: "POST",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Tunnel stop failed with ${response.status}`);
    }

    state.actionStatusMessage = "Public link stopped";
    await loadDashboard({ silent: true });
  } catch (error) {
    state.actionStatusMessage = error instanceof Error ? error.message : "Tunnel stop failed";
    setDashboardStatus();
  }
}

async function saveTunnelConfig(options = {}) {
  const { clearToken = false } = options;
  const tunnelMode = document.getElementById("tunnelMode");
  const tunnelName = document.getElementById("tunnelName");
  const tunnelHostname = document.getElementById("tunnelHostname");
  const tunnelToken = document.getElementById("tunnelToken");

  state.actionStatusMessage = clearToken ? "Clearing saved tunnel token" : "Saving tunnel settings";
  setDashboardStatus();

  try {
    const response = await fetch("/api/tunnel/config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        preferredMode: tunnelMode?.value || "quick",
        tunnelName: tunnelName?.value || "",
        publicHostname: tunnelHostname?.value || "",
        token: clearToken ? "" : tunnelToken?.value || "",
        clearToken,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Tunnel settings failed with ${response.status}`);
    }

    if (tunnelToken) {
      tunnelToken.value = "";
    }

    state.actionStatusMessage = clearToken ? "Saved tunnel settings and cleared token" : "Tunnel settings saved";
    await loadDashboard({ silent: true });
  } catch (error) {
    state.actionStatusMessage = error instanceof Error ? error.message : "Tunnel settings failed";
    setDashboardStatus();
  }
}

async function saveSelectedJob() {
  const job = getSelectedJob();
  if (!job || !state.detailDraft) {
    return;
  }

  updateSaveState("Saving...");

  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(state.detailDraft),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Save failed with ${response.status}`);
    }

    state.formDirty = false;
    updateSaveState("Saved");
    await loadDashboard({ silent: true });
  } catch (error) {
    updateSaveState(error instanceof Error ? error.message : "Save failed");
  }
}

function wireSelectionClicks(container) {
  void container;
}

function selectJob(jobId) {
  void jobId;
}

function syncFilterOptions() {
  if (!state.snapshot || !elements.statusFilter || !elements.sourceFilter) {
    return;
  }

  const previousStage = state.filters.stage;
  const previousSource = state.filters.source;

  elements.statusFilter.innerHTML = [
    `<option value="all">All automation stages</option>`,
    ...STAGE_ORDER.map((stage) => `<option value="${stage}">${escapeHtml(STAGE_LABELS[stage])}</option>`),
  ].join("");
  elements.statusFilter.value =
    previousStage === "all" || STAGE_ORDER.includes(previousStage) ? previousStage : "all";

  const availableSources = [...new Set(state.snapshot.jobs.map((job) => job.source || "Unknown source"))]
    .sort((left, right) => left.localeCompare(right));

  elements.sourceFilter.innerHTML = [
    `<option value="all">All sources</option>`,
    ...availableSources.map((source) => `<option value="${escapeAttribute(source)}">${escapeHtml(source)}</option>`),
  ].join("");
  elements.sourceFilter.value = availableSources.includes(previousSource) ? previousSource : "all";
  state.filters.stage = elements.statusFilter.value;
  state.filters.source = elements.sourceFilter.value;
}

function syncSelectionWithFilters() {
  void state;
}

function syncActionDefaults() {
  if (!state.snapshot?.actionRunner) {
    return;
  }

  const defaults = state.snapshot.actionRunner.defaults;

  if (!state.actionConfig.url) {
    state.actionConfig.url = defaults.url;
  }

  if (!state.actionConfig.enrichLimit) {
    state.actionConfig.enrichLimit = defaults.enrichLimit;
  }

  if (!state.actionConfig.batchLimit) {
    state.actionConfig.batchLimit = defaults.batchLimit;
  }

  if (!state.actionConfig.pageLimit) {
    state.actionConfig.pageLimit = defaults.pageLimit;
  }
}

function ensureDraft(job) {
  if (state.draftJobId === job.id && state.detailDraft) {
    return;
  }

  state.draftJobId = job.id;
  state.detailDraft = {
    status: job.status,
    notes: job.notes || "",
  };
}

function syncBoardStage() {
  const filteredJobs = getFilteredJobs();

  if (state.filters.stage !== "all" && STAGE_ORDER.includes(state.filters.stage)) {
    state.ui.boardStage = state.filters.stage;
    return;
  }

  if (!filteredJobs.length) {
    state.ui.boardStage = STAGE_ORDER[0];
    return;
  }

  if (STAGE_ORDER.includes(state.ui.boardStage)) {
    return;
  }

  state.ui.boardStage = getDefaultBoardStage(filteredJobs);
}

function getDefaultBoardStage(filteredJobs) {
  const firstStageWithJobs = STAGE_ORDER.find((stage) =>
    filteredJobs.some((job) => job.automationStage === stage),
  );

  return firstStageWithJobs || STAGE_ORDER[0];
}

function getStageCounts(jobs) {
  return STAGE_ORDER.reduce((counts, stage) => {
    counts[stage] = jobs.filter((job) => job.automationStage === stage).length;
    return counts;
  }, {});
}

function renderStageCard(stage, count, filteredJobs) {
  const jobs = filteredJobs.filter((job) => job.automationStage === stage);
  const flagged = jobs.filter((job) => job.attentionReasons.length > 0).length;

  return `
    <button
      class="stage-card stage-card--${escapeHtml(stage)} ${stage === state.ui.boardStage ? "is-active" : ""}"
      type="button"
      data-board-stage="${escapeHtml(stage)}"
    >
      <div class="stage-card-head">
        <p class="stage-card-title">${escapeHtml(STAGE_LABELS[stage])}</p>
        <span class="column-count">${count}</span>
      </div>
      <p class="stage-card-copy">${escapeHtml(STAGE_HELP_TEXT[stage])}</p>
      <div class="chip-row">
        <span class="chip">${count} job${count === 1 ? "" : "s"}</span>
        ${flagged > 0 ? `<span class="chip is-alert">${flagged} flagged</span>` : ""}
      </div>
    </button>
  `;
}

function renderFlowStage(stage, count, activeStage) {
  return `
    <button
      class="flow-stage ${stage === activeStage ? "is-active" : ""}"
      type="button"
      data-flow-stage="${escapeHtml(stage)}"
      role="tab"
      aria-selected="${stage === activeStage ? "true" : "false"}"
    >
      <span class="flow-stage-label">${escapeHtml(STAGE_LABELS[stage])}</span>
      <span class="flow-stage-count">${escapeHtml(String(count))}</span>
    </button>
  `;
}

function getStageJumpActions(stageCounts, activeStage, limit = 2, prioritizePrimary = false) {
  return STAGE_ORDER
    .filter((stage) => stage !== activeStage && stageCounts[stage] > 0)
    .slice(0, limit)
    .map((stage, index) => ({
      label: `Show ${STAGE_LABELS[stage]}`,
      intent: `stage:${stage}`,
      variant: prioritizePrimary && index === 0 ? "primary" : "ghost",
    }));
}

function getFilteredJobs() {
  if (!state.snapshot) {
    return [];
  }

  const query = normalizeSearch(state.filters.search);

  return state.snapshot.jobs.filter((job) => {
    const matchesSource = state.filters.source === "all" || (job.source || "Unknown source") === state.filters.source;
    const haystack = normalizeSearch([
      job.displayTitle,
      job.displayCompany,
      job.notes,
      job.descriptionSnippet,
      job.source,
      job.id,
      job.nextAutomationStep,
      job.automationSummary,
    ].join(" "));
    const matchesSearch = !query || haystack.includes(query);

    return matchesSource && matchesSearch;
  });
}

function getSelectedJob() {
  return null;
}

function updateSaveState(message) {
  state.saveState = message;
  const saveState = document.getElementById("saveState");
  if (saveState) {
    saveState.textContent = message;
  }
}

function setAppStatus(message) {
  if (elements.appStatus) {
    elements.appStatus.textContent = message;
  }
}

function shortenId(value) {
  return value.length > 26 ? `${value.slice(0, 22)}...` : value;
}

function truncateText(value, maxLength = 80) {
  const normalized = cleanText(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function shortenUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 60);
  } catch {
    return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  }
}

function normalizeJobUrlKey(value) {
  const input = cleanText(value);
  if (!input) {
    return "";
  }

  try {
    const url = new URL(input);
    if (url.hostname.includes("linkedin.com")) {
      const match = url.pathname.match(/\/jobs\/view\/(\d+)/i);
      if (match?.[1]) {
        return `linkedin:${match[1]}`;
      }
    }

    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.hostname}${normalizedPath}`.toLowerCase();
  } catch {
    return input.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function relativeAgeLabel(ageInDays) {
  if (ageInDays <= 0) {
    return "Today";
  }

  if (ageInDays === 1) {
    return "1 day ago";
  }

  return `${ageInDays} days ago`;
}

function formatDateTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 1024) {
    return `${value || 0} B`;
  }

  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unit = units[0];

  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }

  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

function normalizeSearch(value) {
  return cleanText(value).toLowerCase();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function coercePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function groupBy(items, selector) {
  return items.reduce((groups, item) => {
    const key = selector(item);
    groups[key] ||= [];
    groups[key].push(item);
    return groups;
  }, {});
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function getActionRecommendations(actions, selectedJob, activeStage) {
  const actionLookup = new Map(actions.map((action) => [action.id, action]));
  const recommendations = [];
  const seen = new Set();

  const pushRecommendation = (id, reason, presetUrl = "") => {
    const action = actionLookup.get(id);
    if (!action || seen.has(id)) {
      return;
    }

    recommendations.push({
      action,
      reason,
      presetUrl,
    });
    seen.add(id);
  };

  if (selectedJob) {
    if (selectedJob.automationStage === "filed") {
      pushRecommendation("browser-save-remote-jobs", "Go back to LinkedIn Remote Jobs and screen the next batch by description.");
      pushRecommendation("start-debug-browser", "Open the attached LinkedIn session if you need to review more jobs.");
    } else {
      pushRecommendation("browser-apply-job-url", "Apply this saved job. The app will choose LinkedIn Easy Apply or the employer route automatically.", selectedJob.url);
      pushRecommendation("browser-start-full-autopilot", "Run the batch if you want to apply the whole saved queue instead of one role.");
      pushRecommendation("browser-save-remote-jobs", "Return to LinkedIn Remote Jobs and save or dismiss more roles by criteria.");
      pushRecommendation("start-debug-browser", "Open the attached LinkedIn session if it is not already running.");
    }
  } else {
    pushRecommendation("browser-save-remote-jobs", "Open LinkedIn Remote Jobs and save or dismiss roles by criteria.");
    pushRecommendation("browser-start-full-autopilot", "Apply the saved jobs that are already in your local queue.");
    pushRecommendation("start-debug-browser", "Open the attached LinkedIn session if it is not already running.");
  }

  if (recommendations.length === 0) {
    pushRecommendation("start-debug-browser", "Prepare the browser session for attached automation.");
  }

  return recommendations.slice(0, 3);
}

function getJobCardSignals(job) {
  return [
    {
      label: "Route",
      value: job.externalApplyFound ? "Employer" : "LinkedIn",
      className: job.externalApplyFound ? "is-accent" : "",
    },
    {
      label: "Review",
      value: job.linkedInApplyReviewed ? "Seen" : "Pending",
      className: job.linkedInApplyReviewed ? "" : "",
    },
    {
      label: "Risk",
      value: job.attentionReasons.length > 0 ? `${job.attentionReasons.length} blocker${job.attentionReasons.length === 1 ? "" : "s"}` : "Clean",
      className: job.attentionReasons.length > 0 ? "is-alert" : "",
    },
  ];
}

function getJobActionPlan(job) {
  if (job.automationStage === "enrich") {
    return [
      {
        label: "Open or capture the saved listing",
        detail: "Load the job page or re-capture the listing if the saved draft still needs cleaner data.",
        stateLabel: "Next",
        stateClass: "is-next",
      },
      {
        label: "Fill missing metadata",
        detail: "Run enrichment so the queue has a full description and clean company fields.",
        stateLabel: job.hasDescription && !job.hasUnknownCompany ? "Ready" : "Pending",
        stateClass: job.hasDescription && !job.hasUnknownCompany ? "is-ready" : "",
      },
      {
        label: "Move into filing review",
        detail: "Once the metadata is clean, this job can move into Ready to File.",
        stateLabel: "Pending",
        stateClass: "",
      },
    ];
  }

  if (job.automationStage === "ready") {
    return [
      {
        label: "Load the selected job",
        detail: "Open the LinkedIn listing directly from the queue so review starts from the correct job.",
        stateLabel: "Next",
        stateClass: "is-next",
      },
      {
        label: "Review the application flow",
        detail: "Inspect the Easy Apply or employer handoff and confirm the current form structure.",
        stateLabel: job.linkedInApplyReviewed ? "Seen" : "Pending",
        stateClass: job.linkedInApplyReviewed ? "is-ready" : "",
      },
      {
        label: "Autofill and stop before submit",
        detail: "Run autofill only after the fields and destination look correct.",
        stateLabel: "Pending",
        stateClass: "",
      },
    ];
  }

  if (job.automationStage === "external") {
    return [
      {
        label: "Open the employer route",
        detail: job.externalApplyDestinationUrl
          ? "Load the captured employer URL from this queue item."
          : "Capture the employer route from LinkedIn before opening the external form.",
        stateLabel: job.externalApplyDestinationUrl ? "Next" : "Blocked",
        stateClass: job.externalApplyDestinationUrl ? "is-next" : "is-blocked",
      },
      {
        label: "Review the employer form",
        detail: "Inspect the current form structure and confirm the right application page opened.",
        stateLabel: "Pending",
        stateClass: "",
      },
      {
        label: "Autofill and stop before submit",
        detail: "Apply saved profile answers only after the form review looks correct.",
        stateLabel: "Pending",
        stateClass: "",
      },
    ];
  }

  return [
    {
      label: "Queue item is beyond filing",
      detail: "This listing is already marked filed or moved out of the active filing flow.",
      stateLabel: "Done",
      stateClass: "is-ready",
    },
    {
      label: "Keep notes current",
      detail: "Use the filing update form below if you need to preserve manual context.",
      stateLabel: "Available",
      stateClass: "",
    },
    {
      label: "Resume only if needed",
      detail: "Use the operations console again if this listing needs another automation pass.",
      stateLabel: "Optional",
      stateClass: "",
    },
  ];
}

function getLatestJobEvent(job, snapshot) {
  return snapshot.recentAutomationActivity.find((item) => item.targetJobId === job.id) || null;
}

function getLatestRelevantArtifact(job, snapshot) {
  const categories = getRelevantArtifactCategories(job);
  return snapshot.recentBrowserArtifacts.find((artifact) => categories.includes(artifact.category)) || null;
}

function getJobHistory(job, snapshot) {
  return snapshot.recentAutomationActivity
    .filter((item) => item.targetJobId === job.id)
    .slice(0, 4);
}

function getRelevantArtifacts(job, snapshot) {
  const categories = getRelevantArtifactCategories(job);
  return snapshot.recentBrowserArtifacts
    .filter((artifact) => categories.includes(artifact.category))
    .slice(0, 4);
}

function getRelevantArtifactCategories(job) {
  if (job.automationStage === "enrich") {
    return ["Enrichment", "Capture", "Collection"];
  }

  if (job.automationStage === "ready") {
    return ["Easy Apply Review", "Capture", "Enrichment"];
  }

  if (job.automationStage === "external") {
    return job.externalApplyDestinationUrl
      ? ["Employer Form Review", "External Apply Extraction"]
      : ["External Apply Extraction", "Employer Form Review"];
  }

  return ["Employer Form Review", "Easy Apply Review", "External Apply Extraction", "Enrichment"];
}

function getJobDecisionCards(job, snapshot) {
  const latestJobEvent = getLatestJobEvent(job, snapshot);
  const latestRelevantArtifact = getLatestRelevantArtifact(job, snapshot);
  const blockerSummary = job.attentionReasons.length > 0
    ? `Current blocker${job.attentionReasons.length === 1 ? "" : "s"}: ${job.attentionReasons.join(", ")}.`
    : "";

  let whyNow;
  let unlockNext;

  if (job.automationStage === "enrich") {
    const missingBits = [
      job.hasDescription ? "" : "description",
      job.hasUnknownCompany ? "company" : "",
    ].filter(Boolean);
    whyNow = {
      label: "Why it is here",
      value: missingBits.length > 0 ? "Metadata still needs cleanup" : "Draft still needs another pass",
      copy: `${missingBits.length > 0
        ? `This job is still in enrichment because the ${missingBits.join(" and ")} ${missingBits.length === 1 ? "field is" : "fields are"} not clean enough for filing review.`
        : "This saved draft still needs another capture or enrichment pass before it is worth reviewing for filing."} ${blockerSummary}`.trim(),
      className: job.attentionReasons.length > 0 ? "is-alert" : "is-accent",
    };
    unlockNext = {
      label: "What unlocks next",
      value: "Move to Ready to File",
      copy: "Open or re-capture the listing, then run enrichment until the description and company fields look clean.",
      className: "is-accent",
    };
  } else if (job.automationStage === "ready") {
    whyNow = {
      label: "Why it is here",
      value: "Ready for review",
      copy: `Metadata is present, so the next useful move is reviewing the LinkedIn or employer flow before autofill. ${blockerSummary}`.trim(),
      className: job.attentionReasons.length > 0 ? "is-alert" : "is-accent",
    };
    unlockNext = {
      label: "What unlocks next",
      value: "Review, then autofill",
      copy: job.linkedInApplyReviewed
        ? "The review step has already been seen, so the form is close to autofill-ready."
        : "Once the current application flow is reviewed, autofill can run and stop before submit.",
      className: job.linkedInApplyReviewed ? "is-accent" : "",
    };
  } else if (job.automationStage === "external") {
    whyNow = {
      label: "Why it is here",
      value: job.externalApplyDestinationUrl ? "Employer route is captured" : "Employer route is still missing",
      copy: `${job.externalApplyDestinationUrl
        ? "The LinkedIn handoff already exposed an employer-hosted application route."
        : "This job still needs its employer-hosted route captured before the external form can be reviewed."} ${blockerSummary}`.trim(),
      className: job.externalApplyDestinationUrl ? "is-accent" : "is-alert",
    };
    unlockNext = {
      label: "What unlocks next",
      value: job.externalApplyDestinationUrl ? "Review the employer form" : "Capture the employer route first",
      copy: job.externalApplyDestinationUrl
        ? "Open the employer route, confirm the form is correct, then autofill and stop before submit."
        : "Process the LinkedIn handoff again until the external destination is captured.",
      className: job.externalApplyDestinationUrl ? "is-accent" : "is-alert",
    };
  } else {
    whyNow = {
      label: "Why it is here",
      value: "Beyond the active filing lane",
      copy: "This listing is already filed or otherwise outside the main filing queue.",
      className: "",
    };
    unlockNext = {
      label: "What unlocks next",
      value: "Keep notes current",
      copy: "Use the filing update form if you want to preserve manual context or resume automation later.",
      className: "",
    };
  }

  const recentEvidence = latestJobEvent
    ? {
      label: "Recent proof",
      value: latestJobEvent.title,
      copy: `${latestJobEvent.detail} | ${formatDateTime(latestJobEvent.timestamp)}`,
      className: "",
    }
    : latestRelevantArtifact
      ? {
        label: "Recent proof",
        value: latestRelevantArtifact.category,
        copy: `${latestRelevantArtifact.name} | ${formatDateTime(latestRelevantArtifact.updatedAt)}`,
        className: "",
      }
      : {
        label: "Recent proof",
        value: "No saved proof yet",
        copy: "This job has not produced a recent linked event or saved artifact for its current lane yet.",
        className: "",
      };

  return [whyNow, unlockNext, recentEvidence];
}

function renderDetailStatusCard(card) {
  return `
    <article class="detail-status-card ${escapeHtml(card.className || "")}">
      <p class="signal-label">${escapeHtml(card.label)}</p>
      <p class="detail-status-value">${escapeHtml(card.value)}</p>
      <p class="detail-status-copy">${escapeHtml(card.copy)}</p>
    </article>
  `;
}

function getRecommendationOutcome(item) {
  switch (item.action.id) {
    case "start-debug-browser":
      return "Expected result: Chrome starts in remote-debug mode so attached-browser actions can run.";
    case "browser-open-url":
      return "Expected result: the saved job or employer page opens in the persistent browser profile.";
    case "browser-capture-url":
      return "Expected result: a fresh local draft is captured with cleaner page data.";
    case "browser-enrich-saved-jobs":
      return "Expected result: missing descriptions and company metadata are backfilled across saved jobs.";
    case "browser-review-linkedin-current":
    case "browser-review-linkedin-attached":
      return "Expected result: the current LinkedIn form is inspected without submitting anything.";
    case "browser-autofill-attached-current":
      return "Expected result: the current LinkedIn form is filled and stops before submit.";
    case "browser-review-attached-form":
      return "Expected result: the employer-hosted form is inspected before autofill.";
    case "browser-autofill-attached-form":
      return "Expected result: the employer form is filled and stops before submit.";
    case "browser-process-visible-jobs":
      return "Expected result: Remote Jobs previews are screened and saved for later without opening any apply flow.";
    case "browser-process-visible-external-jobs":
      return "Expected result: external employer routes are captured from visible LinkedIn jobs.";
    case "browser-export-external-apply-urls":
      return "Expected result: the saved employer-route export is rebuilt from recent artifacts.";
    case "browser-collect-attached-jobs":
      return "Expected result: visible LinkedIn cards are collected from the attached browser session.";
    case "browser-save-remote-jobs":
      return "Expected result: the LinkedIn Remote Jobs collection is screened by description and the matching roles are saved locally.";
    case "browser-apply-job-url":
      return "Expected result: the selected saved tracker job is opened and the right application flow is submitted when answerable.";
    case "browser-triage-visible-jobs":
      return "Expected result: Remote Jobs listings are screened for workload and saved with that signal.";
    case "browser-start-autopilot":
      return "Expected result: the Remote Jobs save automation runs as a batch against LinkedIn listings.";
    case "browser-start-full-autopilot":
      return "Expected result: the LinkedIn Jobs Tracker apply batch runs against saved jobs only.";
    default:
      return "Expected result: this action advances the current filing lane without needing the terminal.";
  }
}

function primeActionUrl(url, statusMessage = "Console URL updated") {
  if (!url) {
    return;
  }

  state.actionConfig.url = url;
  state.actionStatusMessage = statusMessage;
  renderWorkspaceGuide();
  renderActions();
  setDashboardStatus();
}

function getHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "Unknown host";
  }
}

function renderDashboardCta(action) {
  const className = action.variant === "primary" ? "action-button" : "ghost-button";

  if (action.href) {
    return `<a class="${className}" href="${escapeAttribute(action.href)}">${escapeHtml(action.label)}</a>`;
  }

  return `<button class="${className}" type="button" data-dashboard-intent="${escapeAttribute(action.intent)}">${escapeHtml(action.label)}</button>`;
}

function renderEmptyState({ eyebrow = "", title, body, actions = [], tone = "calm" }) {
  return `
    <article class="empty-state-card empty-state-card--${escapeHtml(tone)}">
      ${eyebrow ? `<p class="mini-eyebrow">${escapeHtml(eyebrow)}</p>` : ""}
      <h3>${escapeHtml(title)}</h3>
      <p class="empty-state-copy">${escapeHtml(body)}</p>
      ${
        actions.length > 0
          ? `<div class="empty-state-actions">${actions.map(renderDashboardCta).join("")}</div>`
          : ""
      }
    </article>
  `;
}

function bindDashboardIntents(container) {
  if (!container) {
    return;
  }

  container.querySelectorAll("[data-dashboard-intent]").forEach((button) => {
    button.addEventListener("click", () => {
      void handleDashboardIntent(button.getAttribute("data-dashboard-intent"));
    });
  });
}

async function handleDashboardIntent(intent) {
  if (!intent) {
    return;
  }

  if (intent === "clear-filters") {
    clearFilters();
    return;
  }

  if (intent === "prime-selected-url") {
    state.ui.consoleTab = "runner";
    scrollToSection("actionPanel");
    return;
  }

  if (intent === "prime-employer-url") {
    state.ui.consoleTab = "runner";
    scrollToSection("actionPanel");
    return;
  }

  if (intent.startsWith("stage:")) {
    const stage = intent.slice("stage:".length);
    setBoardStage(stage);
    scrollToSection("supportWorkspace");
    return;
  }

  if (intent.startsWith("console-tab:")) {
    const tab = intent.slice("console-tab:".length);
    setConsoleTab(tab);
    scrollToSection("actionPanel");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
