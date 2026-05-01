(function () {
  "use strict";

  var STORAGE_KEY = "prepMomentumCompanion.v1";

  var LANES = [
    {
      id: "automation",
      name: "Automation Tool",
      target: 90,
      color: "#4cc9b0",
      summary: "Ship code, fix flows, test browser automation, and reduce manual work."
    },
    {
      id: "applications",
      name: "Applications",
      target: 35,
      color: "#7fb1ff",
      summary: "Queue roles, tailor answers, submit clean applications, and follow up."
    },
    {
      id: "interview",
      name: "Interview Prep",
      target: 40,
      color: "#f0b75e",
      summary: "Practice stories, system design, recruiter screens, and concise answers."
    },
    {
      id: "mock",
      name: "Mock YouTube",
      target: 45,
      color: "#ff8f8f",
      summary: "Watch mock interviews, pause for answers, and write takeaways."
    },
    {
      id: "coding",
      name: "Coding",
      target: 50,
      color: "#88d18a",
      summary: "Solve reps, explain tradeoffs, test edge cases, and review patterns."
    }
  ];

  var PLAN_SET = [
    { lane: "automation", title: "Ship one visible improvement in the automation tool" },
    { lane: "applications", title: "Move one target role from found to submitted or queued" },
    { lane: "interview", title: "Practice one behavioral answer out loud" },
    { lane: "mock", title: "Watch one mock interview segment and capture three takeaways" },
    { lane: "coding", title: "Complete one coding rep with tests and complexity" }
  ];

  var PROMPTS = [
    { lane: "automation", text: "Pick the smallest annoying manual step in the application flow and turn it into a tracked fix." },
    { lane: "automation", text: "Open the automation code, find one brittle selector or assumption, and make it easier to trust." },
    { lane: "applications", text: "Choose one role you actually want, then write the answer that makes your fit obvious." },
    { lane: "applications", text: "Clean up one application artifact: resume variant, answer bank, follow-up note, or company note." },
    { lane: "interview", text: "Record a two-minute answer for a project story, then tighten it to situation, action, impact." },
    { lane: "interview", text: "Take one weak interview topic and write the first answer you would say out loud." },
    { lane: "mock", text: "Watch ten minutes of a mock interview, pause before the candidate answers, and answer first." },
    { lane: "mock", text: "Turn one YouTube mock interview into three patterns to copy and one habit to avoid." },
    { lane: "coding", text: "Solve one problem slowly enough to explain the invariant, edge cases, and complexity." },
    { lane: "coding", text: "Redo a problem you have seen before without notes, then compare the clean version." }
  ];

  var state = loadState();
  var today = dateKey(new Date());
  var timer = {
    lane: "automation",
    duration: 25,
    remaining: 25 * 60,
    running: false,
    intervalId: null,
    lastTickAt: null
  };

  var elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dateKey(date) {
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-");
  }

  function addDays(date, amount) {
    var next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  }

  function newId(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function laneById(laneId) {
    return LANES.find(function (lane) {
      return lane.id === laneId;
    }) || LANES[0];
  }

  function createState() {
    return {
      version: 2,
      theme: "light",
      promptIndex: 0,
      queue: [],
      days: {}
    };
  }

  function starterTasks() {
    return PLAN_SET.slice(0, 3).map(function (item) {
      return {
        id: newId("task"),
        lane: item.lane,
        title: item.title,
        done: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
        generated: true
      };
    });
  }

  function createDay() {
    return {
      tasks: starterTasks(),
      sessions: [],
      energy: 3,
      blocker: "",
      nextAction: "",
      createdAt: new Date().toISOString()
    };
  }

  function normalizeDay(day) {
    var next = day && typeof day === "object" ? day : createDay();
    next.tasks = Array.isArray(next.tasks) ? next.tasks : [];
    next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
    next.energy = Number.isFinite(Number(next.energy)) ? Number(next.energy) : 3;
    next.blocker = typeof next.blocker === "string" ? next.blocker : "";
    next.nextAction = typeof next.nextAction === "string" ? next.nextAction : "";
    return next;
  }

  function loadState() {
    var fallback = createState();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return fallback;
      }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return fallback;
      }
      var parsedVersion = Number(parsed.version) || 1;
      return {
        version: 2,
        theme: parsed.theme === "dark" && parsedVersion >= 2 ? "dark" : "light",
        promptIndex: Number.isFinite(Number(parsed.promptIndex)) ? Number(parsed.promptIndex) : 0,
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        days: parsed.days && typeof parsed.days === "object" ? parsed.days : {}
      };
    } catch (_error) {
      return fallback;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_error) {
    }
  }

  function ensureDay(key) {
    var targetKey = key || today;
    state.days[targetKey] = normalizeDay(state.days[targetKey]);
    return state.days[targetKey];
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDateLabel() {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric"
    }).format(new Date());
  }

  function formatTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function taskCounts(day) {
    var total = day.tasks.length;
    var done = day.tasks.filter(function (task) {
      return task.done;
    }).length;
    return { done: done, total: total };
  }

  function laneMinutes(day, laneId) {
    return day.sessions.reduce(function (sum, session) {
      if (session.lane !== laneId || session.kind === "win") {
        return sum;
      }
      return sum + Math.max(0, Number(session.minutes) || 0);
    }, 0);
  }

  function totalMinutes(day) {
    return LANES.reduce(function (sum, lane) {
      return sum + laneMinutes(day, lane.id);
    }, 0);
  }

  function winCount(day, laneId) {
    return day.sessions.filter(function (session) {
      return session.kind === "win" && (!laneId || session.lane === laneId);
    }).length;
  }

  function hasProgress(day) {
    return totalMinutes(day) > 0 || winCount(day) > 0 || taskCounts(day).done > 0;
  }

  function currentStreak() {
    var count = 0;
    var cursor = new Date();
    for (var index = 0; index < 90; index += 1) {
      var key = dateKey(cursor);
      var day = state.days[key] ? normalizeDay(state.days[key]) : null;
      if (!day || !hasProgress(day)) {
        break;
      }
      count += 1;
      cursor = addDays(cursor, -1);
    }
    return count;
  }

  function weekMinutes(laneId) {
    var sum = 0;
    var cursor = new Date();
    for (var index = 0; index < 7; index += 1) {
      var day = state.days[dateKey(cursor)] ? normalizeDay(state.days[dateKey(cursor)]) : null;
      if (day) {
        sum += laneId ? laneMinutes(day, laneId) : totalMinutes(day);
      }
      cursor = addDays(cursor, -1);
    }
    return sum;
  }

  function momentumScore(day) {
    var tasks = taskCounts(day);
    var taskScore = tasks.total ? (tasks.done / tasks.total) * 28 : 0;
    var minuteScore = Math.min(52, (totalMinutes(day) / 140) * 52);
    var winScore = Math.min(20, winCount(day) * 6);
    return Math.max(0, Math.min(100, Math.round(taskScore + minuteScore + winScore)));
  }

  function recommendedLane(day) {
    var openTask = day.tasks.find(function (task) {
      return !task.done;
    });
    if (openTask) {
      return laneById(openTask.lane);
    }

    var sorted = LANES.slice().sort(function (a, b) {
      var aRatio = laneMinutes(day, a.id) / a.target;
      var bRatio = laneMinutes(day, b.id) / b.target;
      return aRatio - bRatio;
    });
    return sorted[0];
  }

  function nextBlock(day) {
    var lane = recommendedLane(day);
    var minutes = day.energy <= 2 ? 10 : 25;
    var openTask = day.tasks.find(function (task) {
      return !task.done && task.lane === lane.id;
    });
    return {
      lane: lane,
      minutes: minutes,
      title: openTask ? openTask.title : lane.name
    };
  }

  function momentumMessage(day) {
    var minutes = totalMinutes(day);
    var tasks = taskCounts(day);
    var next = nextBlock(day);

    if (day.energy <= 2 && minutes === 0) {
      return "Keep the bar low: one short " + next.lane.name.toLowerCase() + " block counts today.";
    }
    if (minutes === 0) {
      return "Start with one visible block, then let the streak do the rest.";
    }
    if (tasks.total && tasks.done === tasks.total) {
      return "Daily plan cleared. Bank the proof and stop with a clean next action.";
    }
    if (minutes >= 140) {
      return "Strong day. Use the next block for review, notes, or a small cleanup.";
    }
    if (winCount(day) > 0) {
      return "You have proof on the board. Add one more focused block while context is warm.";
    }
    return "Momentum is active. Make the next block specific enough to finish.";
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    if (elements.themeButton) {
      elements.themeButton.textContent = state.theme === "light" ? "Bright" : "Deep";
      elements.themeButton.setAttribute("aria-label", state.theme === "light" ? "Switch to deep theme" : "Switch to bright theme");
    }
  }

  function populateLaneSelect(select, selectedLane) {
    if (!select) {
      return;
    }
    select.innerHTML = LANES.map(function (lane) {
      return "<option value=\"" + escapeHtml(lane.id) + "\">" + escapeHtml(lane.name) + "</option>";
    }).join("");
    select.value = selectedLane || LANES[0].id;
  }

  function renderHeader(day) {
    var tasks = taskCounts(day);
    elements.todayMinutes.textContent = String(totalMinutes(day));
    elements.taskRatio.textContent = tasks.done + "/" + tasks.total;
    elements.streakCount.textContent = String(currentStreak());
    elements.dateLabel.textContent = formatDateLabel();
    elements.weekSummary.textContent = weekMinutes() + " min this week";
  }

  function renderMomentum(day) {
    var score = momentumScore(day);
    var block = nextBlock(day);
    elements.momentumMessage.textContent = momentumMessage(day);
    elements.nextBlockTitle.textContent = block.title;
    elements.nextBlockMeta.textContent = block.minutes + " min - " + block.lane.name;
    elements.scoreValue.textContent = score + "%";
    elements.scoreRing.style.setProperty("--score", String(score));
  }

  function renderTimer() {
    var minutes = Math.floor(timer.remaining / 60);
    var seconds = timer.remaining % 60;
    elements.timerDisplay.textContent = pad(minutes) + ":" + pad(seconds);
    elements.timerStartButton.textContent = timer.running ? "Pause" : "Start";
    elements.timerLane.value = timer.lane;

    document.querySelectorAll("[data-duration]").forEach(function (button) {
      button.classList.toggle("active", Number(button.getAttribute("data-duration")) === timer.duration);
    });
  }

  function renderCheckin(day) {
    elements.energyRange.value = String(day.energy);
    elements.energyValue.textContent = day.energy + "/5";
    elements.blockerInput.value = day.blocker;
    elements.nextActionInput.value = day.nextAction;
  }

  function laneChip(laneId) {
    var lane = laneById(laneId);
    return "<span class=\"lane-chip\" style=\"border-color:" + escapeHtml(lane.color) + "\">" + escapeHtml(lane.name) + "</span>";
  }

  function renderTasks(day) {
    if (!day.tasks.length) {
      elements.taskList.innerHTML = "<div class=\"empty-state\">No tasks for today.</div>";
      return;
    }

    elements.taskList.innerHTML = day.tasks.map(function (task) {
      return [
        "<article class=\"task-item" + (task.done ? " done" : "") + "\" data-task-id=\"" + escapeHtml(task.id) + "\">",
        "<input type=\"checkbox\" " + (task.done ? "checked" : "") + " aria-label=\"Complete task\">",
        "<div>",
        "<span class=\"task-title\">" + escapeHtml(task.title) + "</span>",
        "<div class=\"task-meta\">" + laneChip(task.lane) + "<span>" + (task.done ? "done" : "open") + "</span></div>",
        "</div>",
        "<button class=\"remove-button\" type=\"button\" data-remove-task=\"" + escapeHtml(task.id) + "\">Remove</button>",
        "</article>"
      ].join("");
    }).join("");
  }

  function renderLanes(day) {
    elements.laneGrid.innerHTML = LANES.map(function (lane) {
      var minutes = laneMinutes(day, lane.id);
      var wins = winCount(day, lane.id);
      var percent = Math.min(100, Math.round((minutes / lane.target) * 100));
      return [
        "<article class=\"lane-card\" style=\"--lane:" + escapeHtml(lane.color) + "\">",
        "<h3>" + escapeHtml(lane.name) + "</h3>",
        "<p>" + escapeHtml(lane.summary) + "</p>",
        "<div class=\"lane-stats\"><strong>" + minutes + "</strong><span>" + lane.target + " min target</span></div>",
        "<div class=\"progress-track\"><div class=\"progress-fill\" style=\"width:" + percent + "%\"></div></div>",
        "<div class=\"task-meta\"><span>" + wins + " wins</span><span>" + weekMinutes(lane.id) + " min week</span></div>",
        "<div class=\"lane-actions\">",
        "<button type=\"button\" data-lane=\"" + escapeHtml(lane.id) + "\" data-minutes=\"15\">+15</button>",
        "<button type=\"button\" data-lane=\"" + escapeHtml(lane.id) + "\" data-minutes=\"30\">+30</button>",
        "<button type=\"button\" data-lane=\"" + escapeHtml(lane.id) + "\" data-win=\"1\">Win</button>",
        "</div>",
        "</article>"
      ].join("");
    }).join("");
  }

  function renderPrompt() {
    var prompt = PROMPTS[state.promptIndex % PROMPTS.length];
    elements.prepPrompt.textContent = prompt.text;
  }

  function renderVideos() {
    var queued = state.queue.filter(function (item) {
      return item.status !== "watched";
    }).length;
    elements.queueCount.textContent = queued + " queued";

    if (!state.queue.length) {
      elements.videoList.innerHTML = "<div class=\"empty-state\">No mock interviews queued.</div>";
      return;
    }

    elements.videoList.innerHTML = state.queue.map(function (item) {
      var watched = item.status === "watched";
      return [
        "<article class=\"video-item\" data-video-id=\"" + escapeHtml(item.id) + "\">",
        "<div>",
        "<a class=\"video-title\" href=\"" + escapeHtml(item.url) + "\" target=\"_blank\" rel=\"noreferrer\">" + escapeHtml(item.title) + "</a>",
        "<div class=\"video-meta\"><span>" + (watched ? "watched" : "queued") + "</span>",
        watched && item.watchedAt ? "<span>" + escapeHtml(formatTime(item.watchedAt)) + "</span>" : "",
        "</div>",
        "</div>",
        "<div class=\"video-actions\">",
        "<button class=\"mini-button\" type=\"button\" data-watch-video=\"" + escapeHtml(item.id) + "\">" + (watched ? "Watched" : "Mark Watched") + "</button>",
        "<button class=\"remove-button\" type=\"button\" data-remove-video=\"" + escapeHtml(item.id) + "\">Remove</button>",
        "</div>",
        "</article>"
      ].join("");
    }).join("");
  }

  function renderProof(day) {
    var events = [];

    day.sessions.forEach(function (session) {
      events.push({
        id: session.id,
        kind: session.kind || "session",
        lane: session.lane,
        at: session.createdAt,
        title: session.kind === "win"
          ? session.note || "Logged a win"
          : (session.minutes + " min " + laneById(session.lane).name),
        meta: session.kind === "win" ? laneById(session.lane).name : (session.note || "focus block")
      });
    });

    day.tasks.filter(function (task) {
      return task.done && task.completedAt;
    }).forEach(function (task) {
      events.push({
        id: task.id,
        kind: "task",
        lane: task.lane,
        at: task.completedAt,
        title: task.title,
        meta: "completed - " + laneById(task.lane).name
      });
    });

    events.sort(function (a, b) {
      return new Date(b.at).getTime() - new Date(a.at).getTime();
    });

    if (!events.length) {
      elements.proofLog.innerHTML = "<div class=\"empty-state\">No proof logged today.</div>";
      return;
    }

    elements.proofLog.innerHTML = events.slice(0, 12).map(function (event) {
      return [
        "<article class=\"log-item " + escapeHtml(event.kind) + "\">",
        "<strong>" + escapeHtml(event.title) + "</strong>",
        "<div class=\"log-meta\"><span>" + escapeHtml(formatTime(event.at)) + "</span><span>" + escapeHtml(event.meta) + "</span></div>",
        "</article>"
      ].join("");
    }).join("");
  }

  function render() {
    var day = ensureDay(today);
    renderHeader(day);
    renderMomentum(day);
    renderTimer();
    renderCheckin(day);
    renderTasks(day);
    renderLanes(day);
    renderPrompt();
    renderVideos();
    renderProof(day);
    saveState();
  }

  function addTask(title, laneId, generated) {
    var day = ensureDay(today);
    day.tasks.push({
      id: newId("task"),
      lane: laneById(laneId).id,
      title: title.trim(),
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      generated: Boolean(generated)
    });
    render();
  }

  function addSession(laneId, minutes, note, kind) {
    var day = ensureDay(today);
    day.sessions.push({
      id: newId(kind || "session"),
      lane: laneById(laneId).id,
      minutes: Math.max(0, Number(minutes) || 0),
      note: note || "",
      kind: kind || "session",
      createdAt: new Date().toISOString()
    });
    render();
  }

  function toggleTask(taskId, done) {
    var day = ensureDay(today);
    var task = day.tasks.find(function (item) {
      return item.id === taskId;
    });
    if (!task) {
      return;
    }
    task.done = done;
    task.completedAt = done ? new Date().toISOString() : null;
    render();
  }

  function removeTask(taskId) {
    var day = ensureDay(today);
    day.tasks = day.tasks.filter(function (task) {
      return task.id !== taskId;
    });
    render();
  }

  function addPlanSet() {
    var day = ensureDay(today);
    PLAN_SET.forEach(function (item) {
      var exists = day.tasks.some(function (task) {
        return task.title === item.title && task.lane === item.lane;
      });
      if (!exists) {
        day.tasks.push({
          id: newId("task"),
          lane: item.lane,
          title: item.title,
          done: false,
          createdAt: new Date().toISOString(),
          completedAt: null,
          generated: true
        });
      }
    });
    render();
  }

  function addRecommendedBlock() {
    var block = nextBlock(ensureDay(today));
    addTask(block.title + " (" + block.minutes + " min)", block.lane.id, true);
  }

  function addCurrentPrompt() {
    var prompt = PROMPTS[state.promptIndex % PROMPTS.length];
    addTask(prompt.text, prompt.lane, true);
  }

  function setDuration(minutes) {
    timer.duration = minutes;
    timer.remaining = minutes * 60;
    timer.running = false;
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
    renderTimer();
  }

  function tickTimer() {
    if (!timer.running) {
      return;
    }

    var now = Date.now();
    var elapsed = timer.lastTickAt ? Math.floor((now - timer.lastTickAt) / 1000) : 1;
    timer.lastTickAt = now;
    timer.remaining = Math.max(0, timer.remaining - Math.max(1, elapsed));

    if (timer.remaining <= 0) {
      timer.running = false;
      clearInterval(timer.intervalId);
      timer.intervalId = null;
      addSession(timer.lane, timer.duration, "timer completed", "session");
      timer.remaining = timer.duration * 60;
    }

    renderTimer();
  }

  function toggleTimer() {
    timer.lane = elements.timerLane.value;
    timer.running = !timer.running;
    timer.lastTickAt = Date.now();

    if (timer.running && !timer.intervalId) {
      timer.intervalId = setInterval(tickTimer, 1000);
    }
    if (!timer.running && timer.intervalId) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
    renderTimer();
  }

  function resetTimer() {
    timer.running = false;
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
    timer.remaining = timer.duration * 60;
    renderTimer();
  }

  function safeTitleFromUrl(url) {
    try {
      var parsed = new URL(url);
      if (parsed.hostname.indexOf("youtube") !== -1 || parsed.hostname.indexOf("youtu.be") !== -1) {
        return "YouTube mock interview";
      }
      return parsed.hostname;
    } catch (_error) {
      return "Mock interview";
    }
  }

  function addVideo(title, url) {
    state.queue.unshift({
      id: newId("video"),
      title: title.trim() || safeTitleFromUrl(url),
      url: url.trim(),
      status: "queued",
      createdAt: new Date().toISOString(),
      watchedAt: null
    });
    render();
  }

  function markVideoWatched(videoId) {
    var item = state.queue.find(function (video) {
      return video.id === videoId;
    });
    if (!item || item.status === "watched") {
      return;
    }
    item.status = "watched";
    item.watchedAt = new Date().toISOString();
    addSession("mock", 30, "watched: " + item.title, "session");
  }

  function removeVideo(videoId) {
    state.queue = state.queue.filter(function (video) {
      return video.id !== videoId;
    });
    render();
  }

  function resetTodayData() {
    if (!window.confirm("Reset today's tasks, minutes, wins, and check-in? Your YouTube queue stays saved.")) {
      return;
    }
    resetTimer();
    state.days[today] = createDay();
    render();
  }

  function clearAllData() {
    if (!window.confirm("Clear all Momentum Desk data, including history and the YouTube queue?")) {
      return;
    }
    resetTimer();
    state = createState();
    ensureDay(today);
    applyTheme();
    render();
  }

  function bindEvents() {
    elements.themeButton.addEventListener("click", function () {
      state.theme = state.theme === "light" ? "dark" : "light";
      applyTheme();
      render();
    });

    elements.resetTodayButton.addEventListener("click", resetTodayData);
    elements.clearAllButton.addEventListener("click", clearAllData);

    elements.taskForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var title = elements.taskTitleInput.value.trim();
      if (!title) {
        return;
      }
      addTask(title, elements.taskLaneInput.value, false);
      elements.taskTitleInput.value = "";
      elements.taskTitleInput.focus();
    });

    elements.seedPlanButton.addEventListener("click", addPlanSet);
    elements.addNextBlockButton.addEventListener("click", addRecommendedBlock);
    elements.addPromptButton.addEventListener("click", addCurrentPrompt);

    elements.newPromptButton.addEventListener("click", function () {
      state.promptIndex = (state.promptIndex + 1) % PROMPTS.length;
      render();
    });

    elements.taskList.addEventListener("change", function (event) {
      var target = event.target;
      var item = target.closest(".task-item");
      if (item && target.matches("input[type='checkbox']")) {
        toggleTask(item.getAttribute("data-task-id"), target.checked);
      }
    });

    elements.taskList.addEventListener("click", function (event) {
      var removeId = event.target.getAttribute("data-remove-task");
      if (removeId) {
        removeTask(removeId);
      }
    });

    elements.laneGrid.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) {
        return;
      }
      var lane = button.getAttribute("data-lane");
      if (button.hasAttribute("data-minutes")) {
        addSession(lane, Number(button.getAttribute("data-minutes")), "manual log", "session");
      }
      if (button.hasAttribute("data-win")) {
        addSession(lane, 0, "Small win logged", "win");
      }
    });

    elements.energyRange.addEventListener("input", function () {
      var day = ensureDay(today);
      day.energy = Number(elements.energyRange.value);
      render();
    });

    elements.blockerInput.addEventListener("input", function () {
      ensureDay(today).blocker = elements.blockerInput.value;
      saveState();
    });

    elements.nextActionInput.addEventListener("input", function () {
      ensureDay(today).nextAction = elements.nextActionInput.value;
      saveState();
    });

    elements.timerLane.addEventListener("change", function () {
      timer.lane = elements.timerLane.value;
      renderTimer();
    });

    document.querySelectorAll("[data-duration]").forEach(function (button) {
      button.addEventListener("click", function () {
        setDuration(Number(button.getAttribute("data-duration")));
      });
    });

    elements.timerStartButton.addEventListener("click", toggleTimer);
    elements.timerResetButton.addEventListener("click", resetTimer);

    elements.videoForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var url = elements.videoUrlInput.value.trim();
      if (!url) {
        return;
      }
      addVideo(elements.videoTitleInput.value, url);
      elements.videoTitleInput.value = "";
      elements.videoUrlInput.value = "";
    });

    elements.videoList.addEventListener("click", function (event) {
      var watchId = event.target.getAttribute("data-watch-video");
      var removeId = event.target.getAttribute("data-remove-video");
      if (watchId) {
        markVideoWatched(watchId);
      }
      if (removeId) {
        removeVideo(removeId);
      }
    });

    elements.winForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = elements.winTextInput.value.trim();
      if (!value) {
        return;
      }
      addSession(elements.winLaneInput.value, 0, value, "win");
      elements.winTextInput.value = "";
    });
  }

  function boot() {
    [
      "todayMinutes",
      "taskRatio",
      "streakCount",
      "resetTodayButton",
      "clearAllButton",
      "themeButton",
      "dateLabel",
      "momentumMessage",
      "nextBlockTitle",
      "nextBlockMeta",
      "addNextBlockButton",
      "scoreRing",
      "scoreValue",
      "weekSummary",
      "timerLane",
      "timerDisplay",
      "timerStartButton",
      "timerResetButton",
      "energyRange",
      "energyValue",
      "blockerInput",
      "nextActionInput",
      "prepPrompt",
      "newPromptButton",
      "addPromptButton",
      "taskForm",
      "taskTitleInput",
      "taskLaneInput",
      "seedPlanButton",
      "taskList",
      "laneGrid",
      "queueCount",
      "videoForm",
      "videoTitleInput",
      "videoUrlInput",
      "videoList",
      "winLaneInput",
      "winForm",
      "winTextInput",
      "proofLog"
    ].forEach(function (id) {
      elements[id] = byId(id);
    });

    populateLaneSelect(elements.timerLane, timer.lane);
    populateLaneSelect(elements.taskLaneInput, "automation");
    populateLaneSelect(elements.winLaneInput, "automation");
    applyTheme();
    bindEvents();
    render();
  }

  boot();
}());
