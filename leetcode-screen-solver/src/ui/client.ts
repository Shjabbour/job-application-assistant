export const JS = String.raw`var state = {
  currentRunId: null,
  timer: null,
  lastRefreshAt: 0,
  capturing: false,
  currentRunReady: false,
  currentRunHasAnswer: false,
  displays: [],
  windows: [],
  monitor: null,
  pendingScreenId: null,
  overlayOpen: false,
  answering: false,
  activeTab: 'answer',
  activeAnswerMode: 'firstTry',
  activeSourceTab: 'applications',
  previewQueueToken: 0,
  sourcePickerSignature: '',
  activeTurnId: null,
  currentRun: null,
  newQuestionPending: false,
  answerRequestedRunId: null,
  answerRequestedTurnId: null,
  recognition: null,
  listening: false,
  captureStream: null,
  captureVideo: null,
  captureSourceLabel: '',
  transcriptPost: Promise.resolve(),
  questionTextSubmitting: false,
  screenshotGallerySignature: '',
};

var elements = {};
var SELECTED_SCREEN_KEY = 'interviewCoder.selectedScreenId';
var SELECTED_WINDOW_KEY = 'interviewCoder.selectedWindowId';
var THEME_KEY = 'interviewCoder.theme';

function fallbackDisplayLabel(display) {
  if (!display) {
    return 'Unknown screen';
  }
  return 'Screen ' + display.id + (display.primary ? ' - primary' : '') +
    ' | ' + display.width + 'x' + display.height + ' at ' + display.x + ',' + display.y;
}

function displayOptionLabel(display) {
  return display && display.label ? display.label : fallbackDisplayLabel(display);
}

function displayShortLabel(display) {
  if (!display) {
    return '';
  }
  return display.shortLabel || ('Screen ' + display.id + (display.primary ? ' - primary' : ''));
}

function displayById(screenId) {
  return state.displays.find(function (display) {
    return String(display.id) === String(screenId);
  }) || null;
}

function windowById(windowId) {
  return state.windows.find(function (windowInfo) {
    return String(windowInfo.id) === String(windowId);
  }) || null;
}

function windowOptionLabel(windowInfo) {
  return windowInfo && windowInfo.label
    ? windowInfo.label
    : (windowInfo ? windowInfo.processName + ' - ' + windowInfo.title : 'Unknown window');
}

function storedTheme() {
  try {
    var theme = localStorage.getItem(THEME_KEY);
    return theme === 'light' ? 'light' : 'dark';
  } catch (_error) {
    return 'dark';
  }
}

function applyTheme(theme) {
  var nextTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;

  if (!elements.themeToggle) {
    return;
  }

  var isLight = nextTheme === 'light';
  elements.themeToggle.textContent = isLight ? 'Light' : 'Dark';
  elements.themeToggle.setAttribute('aria-pressed', String(isLight));
  elements.themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
}

function toggleTheme() {
  var nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_KEY, nextTheme);
  } catch (_error) {
  }
  applyTheme(nextTheme);
}

function sourceInitial(value) {
  var clean = String(value || '').trim();
  return clean ? clean.charAt(0).toUpperCase() : '?';
}

function shortWindowTitle(windowInfo) {
  var title = String(windowInfo && windowInfo.title ? windowInfo.title : '').trim();
  return title || (windowInfo ? windowInfo.processName : 'Window');
}

function currentSourceLabel() {
  if (state.captureSourceLabel) {
    return state.captureSourceLabel;
  }
  return 'Sources';
}

function updateSourceButton() {
  if (!elements.overlayToggle) {
    return;
  }

  var label = currentSourceLabel();
  elements.overlayToggle.textContent = label === 'Sources' ? 'Choose Source' : 'Source: ' + label;
}

function screenShortLabel(screenId) {
  var display = displayById(screenId);
  return display ? displayShortLabel(display) : 'screen ' + screenId;
}

function defaultDisplayId() {
  if (!state.displays.length) {
    return '';
  }
  var primary = state.displays.find(function (display) { return display.primary; });
  return String((primary || state.displays[0]).id);
}

function displayMapText(display) {
  var position = String(display && display.relativePosition ? display.relativePosition : '').toLowerCase();
  if (display && display.primary) {
    return 'Primary';
  }
  if (position.indexOf('far left') !== -1) {
    return 'Far L';
  }
  if (position.indexOf('left') !== -1) {
    return 'Left';
  }
  if (position.indexOf('far right') !== -1) {
    return 'Far R';
  }
  if (position.indexOf('right') !== -1) {
    return 'Right';
  }
  if (position.indexOf('above') !== -1 || position.indexOf('upper') !== -1) {
    return 'Top';
  }
  if (position.indexOf('below') !== -1 || position.indexOf('lower') !== -1) {
    return 'Bottom';
  }
  return 'S' + (display ? display.id : '');
}

function selectMonitorByIndex(index) {
  if (!elements.screenSelect || elements.screenSelect.disabled) {
    return false;
  }
  if (!Number.isFinite(index) || index < 0 || index >= state.displays.length) {
    return false;
  }

  elements.screenSelect.value = String(state.displays[index].id);
  elements.screenSelect.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function renderMonitorMap() {
  if (!elements.monitorMap) {
    return;
  }

  elements.monitorMap.innerHTML = '';
  if (!state.displays.length) {
    return;
  }

  var minX = Math.min.apply(null, state.displays.map(function (display) { return display.x; }));
  var minY = Math.min.apply(null, state.displays.map(function (display) { return display.y; }));
  var maxX = Math.max.apply(null, state.displays.map(function (display) { return display.x + display.width; }));
  var maxY = Math.max.apply(null, state.displays.map(function (display) { return display.y + display.height; }));
  var virtualWidth = Math.max(1, maxX - minX);
  var virtualHeight = Math.max(1, maxY - minY);
  var mapWidth = elements.monitorMap.clientWidth || 360;
  var mapHeight = elements.monitorMap.clientHeight || 44;
  var padding = 4;
  var scale = Math.min((mapWidth - padding * 2) / virtualWidth, (mapHeight - padding * 2) / virtualHeight);
  var renderedWidth = virtualWidth * scale;
  var renderedHeight = virtualHeight * scale;
  var offsetX = (mapWidth - renderedWidth) / 2;
  var offsetY = (mapHeight - renderedHeight) / 2;
  var selectedScreen = elements.screenSelect ? String(elements.screenSelect.value || '') : '';
  var monitoringScreen = state.monitor && state.monitor.running && state.monitor.screenId
    ? String(state.monitor.screenId)
    : '';

  state.displays.forEach(function (display, index) {
    var screenId = String(display.id);
    var monitorHotkey = index < 9 ? String(index + 1) : '';
    var button = document.createElement('button');
    var width = Math.max(50, Math.floor(display.width * scale) - 1);
    var height = Math.max(28, Math.floor(display.height * scale) - 1);
    button.type = 'button';
    button.className = 'monitor-tile' +
      (display.primary ? ' primary' : '') +
      (screenId === selectedScreen ? ' active' : '') +
      (screenId === monitoringScreen ? ' monitoring' : '');
    button.style.left = Math.round(offsetX + (display.x - minX) * scale) + 'px';
    button.style.top = Math.round(offsetY + (display.y - minY) * scale) + 'px';
    button.style.width = width + 'px';
    button.style.height = height + 'px';
    button.textContent = displayMapText(display) + (monitorHotkey ? ' (' + monitorHotkey + ')' : '');
    var monitorTitle = displayOptionLabel(display) + (monitorHotkey ? ' (' + monitorHotkey + ')' : '');
    button.title = monitorTitle;
    button.setAttribute('aria-label', monitorTitle);
    button.addEventListener('click', function () {
      selectMonitorByIndex(index);
    });
    elements.monitorMap.appendChild(button);
  });
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function flushList(buffer, ordered) {
  if (buffer.length === 0) {
    return '';
  }
  var tag = ordered ? 'ol' : 'ul';
  var html = '<' + tag + '>';
  buffer.forEach(function (item) {
    html += '<li>' + renderInline(item) + '</li>';
  });
  return html + '</' + tag + '>';
}

function slugifyHeading(value, used) {
  var base = String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  var slug = base;
  var count = 2;
  while (used[slug]) {
    slug = base + '-' + count;
    count += 1;
  }
  used[slug] = true;
  return slug;
}

function renderCodeBlock(code, language) {
  var label = language || 'code';
  return '<div class="code-shell"><div class="code-label">' + escapeHtml(label) + '</div><pre><code>' +
    escapeHtml(code.join('\n')) + '</code></pre></div>';
}

function renderMarkdown(markdown, options) {
  if (!markdown || !markdown.trim()) {
    return '<p class="empty">Nothing generated yet.</p>';
  }

  options = options || {};
  var sectioned = Boolean(options.sectioned);
  var showSummary = options.summary !== false;
  var lines = markdown.replace(/\r\n/g, '\n').split('\n');
  var html = '';
  var paragraph = [];
  var list = [];
  var orderedList = [];
  var inCode = false;
  var code = [];
  var codeLanguage = '';
  var sectionOpen = false;
  var sectionHeadings = [];
  var usedSlugs = {};

  function flushParagraph() {
    if (paragraph.length) {
      html += '<p>' + renderInline(paragraph.join(' ')) + '</p>';
      paragraph = [];
    }
  }

  function flushLists() {
    html += flushList(list, false);
    html += flushList(orderedList, true);
    list = [];
    orderedList = [];
  }

  function closeSection() {
    if (sectionOpen) {
      html += '</section>';
      sectionOpen = false;
    }
  }

  function sectionClass(title) {
    return String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  }

  lines.forEach(function (line) {
    var fence = line.match(/^\`\`\`\s*([a-zA-Z0-9_-]+)?/);
    if (fence) {
      if (inCode) {
        html += renderCodeBlock(code, codeLanguage);
        code = [];
        codeLanguage = '';
        inCode = false;
      } else {
        flushParagraph();
        flushLists();
        codeLanguage = fence[1] || '';
        inCode = true;
      }
      return;
    }

    if (inCode) {
      code.push(line);
      return;
    }

    if (!line.trim()) {
      flushParagraph();
      flushLists();
      return;
    }

    var h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushParagraph();
      flushLists();
      if (sectioned) {
        closeSection();
        var sectionId = slugifyHeading(h2[1], usedSlugs);
        sectionHeadings.push({ id: sectionId, title: h2[1] });
        html += '<section id="' + sectionId + '" class="md-section md-section-' + sectionClass(h2[1]) + '">';
        sectionOpen = true;
      }
      html += '<h2>' + renderInline(h2[1]) + '</h2>';
      return;
    }

    var h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushParagraph();
      flushLists();
      html += '<h3>' + renderInline(h3[1]) + '</h3>';
      return;
    }

    var bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (orderedList.length) {
        html += flushList(orderedList, true);
        orderedList = [];
      }
      orderedList = [];
      list.push(bullet[1]);
      return;
    }

    var ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (list.length) {
        html += flushList(list, false);
        list = [];
      }
      list = [];
      orderedList.push(ordered[1]);
      return;
    }

    paragraph.push(line.trim());
  });

  if (inCode) {
    html += renderCodeBlock(code, codeLanguage);
  }
  flushParagraph();
  flushLists();
  closeSection();
  if (sectioned && showSummary && sectionHeadings.length > 2) {
    var summary = '<nav class="answer-summary" aria-label="Solution sections">';
    sectionHeadings.forEach(function (heading) {
      summary += '<a class="section-chip" href="#' + escapeHtml(heading.id) + '">' + renderInline(heading.title) + '</a>';
    });
    summary += '</nav>';
    return summary + html;
  }
  return html;
}

function normalizeAnswerHeading(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitAnswerSections(markdown) {
  var lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  var intro = [];
  var sections = [];
  var current = null;

  lines.forEach(function (line) {
    var h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      if (current) {
        sections.push(current);
      }
      current = { title: h2[1].trim(), lines: [] };
      return;
    }

    if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  });

  if (current) {
    sections.push(current);
  }

  return {
    intro: intro.join('\n').trim(),
    sections: sections,
  };
}

function sectionToMarkdown(section) {
  var body = section.lines.join('\n').trim();
  return body ? '## ' + section.title + '\n\n' + body : '## ' + section.title;
}

function answerHasWalkthroughTabs(markdown) {
  var split = splitAnswerSections(markdown);
  return split.sections.some(function (section) {
    var name = normalizeAnswerHeading(section.title);
    return name === 'naive first try' || name === 'robust walkthrough' || name === 'robust answer';
  });
}

function answerMarkdownForMode(markdown, mode) {
  var split = splitAnswerSections(markdown);
  if (!split.sections.length || !answerHasWalkthroughTabs(markdown)) {
    return markdown;
  }

  var firstTrySections = {
    'say this first': true,
    'hints': true,
    'naive first try': true,
  };
  var robustPrimarySections = {
    'robust walkthrough': true,
    'robust answer': true,
    'code': true,
    'complexity': true,
    'fix': true,
    'if asked': true,
  };
  var selected = split.sections.filter(function (section) {
    var name = normalizeAnswerHeading(section.title);
    var isFirstTrySection = Boolean(firstTrySections[name]);
    if (mode === 'robust') {
      return name === 'say this first' || (!isFirstTrySection && Boolean(robustPrimarySections[name]));
    }
    return isFirstTrySection;
  });

  if (!selected.length) {
    selected = mode === 'robust'
      ? split.sections
      : split.sections.slice(0, Math.min(3, split.sections.length));
  }

  var parts = [];
  if (mode !== 'robust' && split.intro) {
    parts.push(split.intro);
  }
  selected.forEach(function (section) {
    parts.push(sectionToMarkdown(section));
  });

  return parts.join('\n\n').trim() || markdown;
}

function renderAnswerModeButtons(showTabs) {
  if (!elements.answerModeTabs || !elements.firstTryAnswerTab || !elements.robustAnswerTab) {
    return;
  }

  elements.answerModeTabs.classList.toggle('hidden', !showTabs);
  var robustActive = state.activeAnswerMode === 'robust';
  elements.firstTryAnswerTab.classList.toggle('active', !robustActive);
  elements.firstTryAnswerTab.setAttribute('aria-selected', String(!robustActive));
  elements.robustAnswerTab.classList.toggle('active', robustActive);
  elements.robustAnswerTab.setAttribute('aria-selected', String(robustActive));
}

function clearAnswerHash() {
  if (window.location.hash && window.history && window.history.replaceState) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }
}

function scrollAnswerToTop() {
  if (elements.answerView) {
    elements.answerView.scrollTop = 0;
  }
  window.scrollTo(0, 0);
}

function runTurns(run) {
  return run && Array.isArray(run.turns) ? run.turns : [];
}

function latestTurnId(run) {
  var turns = runTurns(run);
  return turns.length ? turns[turns.length - 1].id : null;
}

function selectedTurn(run) {
  var turns = runTurns(run);
  if (!turns.length) {
    return null;
  }

  var selected = turns.find(function (turn) { return turn.id === state.activeTurnId; });
  return selected || turns[turns.length - 1];
}

function selectedAnswerMarkdown(run) {
  var turn = selectedTurn(run);
  return turn ? (turn.answerMarkdown || '') : (run && run.answerMarkdown ? run.answerMarkdown : '');
}

function selectedHintsMarkdown(run) {
  var turn = selectedTurn(run);
  return turn ? (turn.hintsMarkdown || '') : (run && run.hintsMarkdown ? run.hintsMarkdown : '');
}

function selectedTurnLabel(run) {
  var turn = selectedTurn(run);
  return turn ? turn.title : 'Question';
}

function selectedTurnReadyForAnswer(run) {
  var turn = selectedTurn(run);
  if (turn && turn.kind === 'followup') {
    return Boolean(turn.questionMarkdown && turn.questionMarkdown.trim());
  }
  return Boolean(run && run.readyToAnswer);
}

function renderTurnTabList(container, run) {
  if (!container) {
    return;
  }

  var turns = runTurns(run);
  container.innerHTML = '';
  container.classList.toggle('hidden', turns.length === 0);
  if (!turns.length) {
    return;
  }

  turns.forEach(function (turn) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'turn-tab-button' +
      (turn.id === state.activeTurnId ? ' active' : '') +
      (turn.hasAnswer ? '' : ' pending');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(turn.id === state.activeTurnId));
    button.textContent = turn.title;
    button.title = turn.hasAnswer ? turn.title : turn.title + ' needs an answer';
    button.addEventListener('click', function () {
      selectTurn(turn.id);
    });
    container.appendChild(button);
  });
}

function renderTurnTabs(run) {
  renderTurnTabList(elements.answerTurnTabs, run);
  renderTurnTabList(elements.questionTurnTabs, run);
}

function renderAnswerContent(run) {
  var answerMarkdown = selectedAnswerMarkdown(run);
  var hasAnswerMarkdown = Boolean(answerMarkdown && answerMarkdown.trim());
  if (hasAnswerMarkdown) {
    var useWalkthroughTabs = answerHasWalkthroughTabs(answerMarkdown);
    renderAnswerModeButtons(useWalkthroughTabs);
    var markdown = useWalkthroughTabs
      ? answerMarkdownForMode(answerMarkdown, state.activeAnswerMode)
      : answerMarkdown;
    elements.answerView.innerHTML = renderMarkdown(markdown, { sectioned: true, summary: false });
    return;
  }

  renderAnswerModeButtons(false);
  if (selectedTurnReadyForAnswer(run)) {
    elements.answerView.innerHTML = '<p class="empty">' + escapeHtml(selectedTurnLabel(run)) + ' is ready. Click Answer to generate a solution.</p>';
    return;
  }

  elements.answerView.innerHTML = '<p class="empty">Solution will appear after the question is ready.</p>';
}

function selectAnswerMode(mode) {
  state.activeAnswerMode = mode === 'robust' ? 'robust' : 'firstTry';
  renderAnswerModeButtons(Boolean(selectedAnswerMarkdown(state.currentRun)));
  if (state.currentRun) {
    renderAnswerContent(state.currentRun);
    clearAnswerHash();
    scrollAnswerToTop();
  }
}

function renderHintsContent(run) {
  var answerMarkdown = selectedAnswerMarkdown(run);
  var hintsMarkdown = selectedHintsMarkdown(run);
  var answerIncludesHints = /^##\s+Hints\b/im.test(answerMarkdown || '');
  var showSeparateHints = Boolean(hintsMarkdown && hintsMarkdown.trim() && !answerIncludesHints);
  elements.hintsSection.classList.toggle('hidden', !showSeparateHints);
  if (showSeparateHints) {
    elements.hintsView.innerHTML = renderMarkdown(hintsMarkdown);
  } else {
    elements.hintsView.innerHTML = '';
  }
}

function selectTurn(turnId) {
  if (state.activeTurnId !== turnId) {
    state.activeAnswerMode = 'firstTry';
  }
  state.activeTurnId = turnId || null;
  if (!state.currentRun) {
    return;
  }
  renderTurnTabs(state.currentRun);
  elements.questionBody.innerHTML = renderMarkdown(questionMarkdown(state.currentRun));
  renderAnswerContent(state.currentRun);
  renderHintsContent(state.currentRun);
  clearAnswerHash();
  scrollAnswerToTop();
}

function normalizeDisplayText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function questionMarkdown(run) {
  if (!run || !run.state || !run.state.question) {
    return '';
  }

  var turn = selectedTurn(run);
  if (turn && turn.questionMarkdown && turn.questionMarkdown.trim()) {
    return turn.questionMarkdown;
  }

  var question = run.state.question;
  var parts = [];
  if (question.prompt) {
    parts.push('## Prompt\n\n' + question.prompt);
  }
  if (question.inputOutput) {
    parts.push('## Input / Output\n\n' + question.inputOutput);
  }
  if (question.examples && question.examples.length) {
    parts.push('## Examples\n\n' + question.examples.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.constraints && question.constraints.length) {
    parts.push('## Constraints\n\n' + question.constraints.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.functionSignature) {
    parts.push('## Signature\n\n\`' + question.functionSignature + '\`');
  }
  if (question.notes && question.notes.length) {
    parts.push('## Notes\n\n' + question.notes.map(function (item) { return '- ' + item; }).join('\n'));
  }
  if (question.followUp && normalizeDisplayText(question.prompt).indexOf(normalizeDisplayText(question.followUp)) === -1) {
    parts.push('## Follow-up\n\n' + question.followUp);
  }
  if (run.state.transcriptText) {
    parts.push('## Transcript\n\n' + run.state.transcriptText);
  }
  if (run.state.missingInformation && run.state.missingInformation.length) {
    parts.push('## Still Missing\n\n' + run.state.missingInformation.map(function (item) { return '- ' + item; }).join('\n'));
  }
  return parts.join('\n\n');
}

function formatElapsed(ms) {
  var totalSeconds = Math.max(0, Math.floor(ms / 1000));
  var seconds = String(totalSeconds % 60).padStart(2, '0');
  var minutes = Math.floor(totalSeconds / 60) % 60;
  var hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds;
  }
  return String(minutes).padStart(2, '0') + ':' + seconds;
}

function updateElapsedTimer() {
  if (!elements.lastUpdated) {
    return;
  }

  var monitor = state.monitor;
  if (!monitor || !monitor.startedAt) {
    elements.lastUpdated.textContent = '00:00';
    elements.lastUpdated.title = 'Capture timer';
    return;
  }

  var startedAt = Date.parse(monitor.startedAt);
  if (!Number.isFinite(startedAt)) {
    elements.lastUpdated.textContent = '00:00';
    elements.lastUpdated.title = 'Capture timer';
    return;
  }

  var stoppedAt = monitor.stoppedAt ? Date.parse(monitor.stoppedAt) : NaN;
  var endAt = monitor.running || !Number.isFinite(stoppedAt) ? Date.now() : stoppedAt;
  elements.lastUpdated.textContent = formatElapsed(endAt - startedAt);
  elements.lastUpdated.title = monitor.running ? 'Capture elapsed time' : 'Last capture duration';
}

function renderDisplays() {
  if (!elements.screenSelect) {
    return;
  }

  var previousValue = elements.screenSelect.value;
  var savedValue = '';
  try {
    savedValue = localStorage.getItem(SELECTED_SCREEN_KEY) || '';
  } catch (_error) {
    savedValue = '';
  }
  var activeMonitorScreen = state.monitor && state.monitor.running && state.monitor.screenId
    ? String(state.monitor.screenId)
    : '';
  var pendingScreen = state.pendingScreenId ? String(state.pendingScreenId) : '';
  var activeScreen = previousValue || pendingScreen || savedValue || activeMonitorScreen || defaultDisplayId();
  elements.screenSelect.innerHTML = '';

  var placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose the interview monitor';
  placeholder.disabled = true;
  elements.screenSelect.appendChild(placeholder);

  if (!state.displays.length) {
    var option = document.createElement('option');
    option.textContent = 'No screens detected';
    option.value = '';
    option.disabled = true;
    elements.screenSelect.appendChild(option);
    elements.screenSelect.disabled = true;
    elements.screenSelect.value = '';
    renderMonitorMap();
    return;
  }

  state.displays.forEach(function (display) {
    var option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = displayOptionLabel(display);
    elements.screenSelect.appendChild(option);
  });

  elements.screenSelect.disabled = false;
  var hasMonitors = state.displays.length > 0;
  var requestedScreen = activeScreen && state.displays.some(function (display) { return String(display.id) === activeScreen; })
    ? activeScreen
    : null;
  if (requestedScreen) {
    elements.screenSelect.value = activeScreen;
    placeholder.hidden = true;
  } else {
    elements.screenSelect.value = '';
    placeholder.hidden = false;
  }

  if (state.monitor && state.monitor.running && state.monitor.screenId) {
    elements.screenSelect.disabled = !hasMonitors;
    placeholder.hidden = true;
  }
  try {
    localStorage.setItem(SELECTED_SCREEN_KEY, elements.screenSelect.value);
  } catch (_error) {
  }
  var selectedDisplay = displayById(elements.screenSelect.value);
  elements.screenSelect.title = selectedDisplay ? displayOptionLabel(selectedDisplay) : 'Choose the interview monitor';
  updateSourceButton();
  renderMonitorMap();
}

function renderWindows() {
  if (!elements.windowSelect) {
    return;
  }

  var previousValue = elements.windowSelect.value;
  var savedValue = '';
  try {
    savedValue = localStorage.getItem(SELECTED_WINDOW_KEY) || '';
  } catch (_error) {
    savedValue = '';
  }
  var activeWindow = previousValue || savedValue;
  elements.windowSelect.innerHTML = '';

  var placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Capture full selected screen';
  elements.windowSelect.appendChild(placeholder);

  state.windows.forEach(function (windowInfo) {
    var option = document.createElement('option');
    option.value = String(windowInfo.id);
    option.textContent = windowOptionLabel(windowInfo);
    elements.windowSelect.appendChild(option);
  });

  var requestedWindow = activeWindow && state.windows.some(function (windowInfo) { return String(windowInfo.id) === activeWindow; })
    ? activeWindow
    : '';
  elements.windowSelect.value = requestedWindow;
  if (!requestedWindow && state.activeSourceTab === 'applications' && state.windows.length) {
    elements.windowSelect.value = String(state.windows[0].id);
  }
  try {
    localStorage.setItem(SELECTED_WINDOW_KEY, elements.windowSelect.value);
  } catch (_error) {
  }

  var selectedWindow = windowById(elements.windowSelect.value);
  elements.windowSelect.title = selectedWindow ? windowOptionLabel(selectedWindow) : 'Capture full selected screen';
  updateSourceButton();
  renderSourcePicker();
}

function selectSourceTab(tab) {
  state.activeSourceTab = tab;
  renderSourcePicker();
}

function renderSourceTabs() {
  [
    ['applicationsSourceTab', 'applications'],
    ['screenSourceTab', 'screen'],
    ['devicesSourceTab', 'devices'],
  ].forEach(function (entry) {
    var element = elements[entry[0]];
    if (!element) {
      return;
    }
    var active = state.activeSourceTab === entry[1];
    element.classList.toggle('active', active);
    element.setAttribute('aria-selected', String(active));
  });
}

function selectSourceWindow(windowId) {
  if (!elements.windowSelect) {
    return;
  }
  elements.windowSelect.value = String(windowId);
  try {
    localStorage.setItem(SELECTED_WINDOW_KEY, elements.windowSelect.value);
  } catch (_error) {
  }
  updateSourceButton();
  renderSourcePicker();
  toggleOverlay(false);
}

function selectSourceScreen(screenId) {
  if (elements.windowSelect) {
    elements.windowSelect.value = '';
    try {
      localStorage.setItem(SELECTED_WINDOW_KEY, '');
    } catch (_error) {
    }
  }
  if (elements.screenSelect) {
    elements.screenSelect.value = String(screenId);
    try {
      localStorage.setItem(SELECTED_SCREEN_KEY, elements.screenSelect.value);
    } catch (_error) {
    }
  }
  updateSourceButton();
  renderSourcePicker();
  toggleOverlay(false);
}

function renderSourcePicker() {
  if (!elements.sourceGrid) {
    return;
  }

  renderSourceTabs();
  var selectedWindowId = elements.windowSelect ? String(elements.windowSelect.value || '') : '';
  var selectedScreenId = elements.screenSelect ? String(elements.screenSelect.value || '') : '';
  var sourceIds = state.activeSourceTab === 'applications'
    ? state.windows.map(function (item) { return item.id + ':' + item.title; }).join('|')
    : state.displays.map(function (item) { return item.id + ':' + item.width + 'x' + item.height; }).join('|');
  var signature = [state.activeSourceTab, selectedWindowId, selectedScreenId, sourceIds].join('::');
  if (state.sourcePickerSignature === signature) {
    return;
  }
  state.sourcePickerSignature = signature;
  var html = '';
  state.previewQueueToken += 1;
  var previewQueueToken = state.previewQueueToken;

  if (state.activeSourceTab === 'applications') {
    if (!state.windows.length) {
      elements.sourceGrid.innerHTML = '<p class="source-empty">No visible app windows found.</p>';
      return;
    }

    state.windows.forEach(function (windowInfo) {
      var active = elements.windowSelect && String(elements.windowSelect.value) === String(windowInfo.id);
      html += '<button class="source-card' + (active ? ' active' : '') + '" type="button" role="listitem" data-window-id="' +
        escapeHtml(windowInfo.id) + '" title="' + escapeHtml(windowOptionLabel(windowInfo)) + '">';
      html += '<span class="source-preview"><span>' + escapeHtml(sourceInitial(windowInfo.processName)) + '</span><img data-preview-src="' +
        escapeHtml('/api/windows/' + encodeURIComponent(windowInfo.id) + '/preview') + '" alt=""></span>';
      html += '<span class="source-name">' + escapeHtml(shortWindowTitle(windowInfo)) + '</span>';
      html += '<span class="source-subtitle">' + escapeHtml(windowInfo.processName) + '</span>';
      html += '</button>';
    });
  } else if (state.activeSourceTab === 'screen') {
    if (!state.displays.length) {
      elements.sourceGrid.innerHTML = '<p class="source-empty">No screens detected.</p>';
      return;
    }

    state.displays.forEach(function (display) {
      var active = (!elements.windowSelect || !elements.windowSelect.value) &&
        elements.screenSelect && String(elements.screenSelect.value) === String(display.id);
      var previewUrl = '/api/displays/' + encodeURIComponent(display.id) + '/preview';
      html += '<button class="source-card' + (active ? ' active' : '') + '" type="button" role="listitem" data-screen-id="' +
        escapeHtml(display.id) + '" title="' + escapeHtml(displayOptionLabel(display)) + '">';
      html += '<span class="source-preview"><span>S</span><img src="' + escapeHtml(previewUrl) + '" alt=""></span>';
      html += '<span class="source-name">Screen ' + escapeHtml(display.id) + '</span>';
      html += '<span class="source-subtitle">' + escapeHtml(display.width + 'x' + display.height) + '</span>';
      html += '</button>';
    });
  } else {
    html = '<p class="source-empty">Device capture is not available in this assistant.</p>';
  }

  elements.sourceGrid.innerHTML = html;
  Array.prototype.forEach.call(elements.sourceGrid.querySelectorAll('[data-window-id]'), function (button) {
    button.addEventListener('click', function () {
      selectSourceWindow(button.getAttribute('data-window-id'));
    });
  });
  Array.prototype.forEach.call(elements.sourceGrid.querySelectorAll('[data-screen-id]'), function (button) {
    button.addEventListener('click', function () {
      selectSourceScreen(button.getAttribute('data-screen-id'));
    });
  });
  loadSourcePreviews(previewQueueToken);
}

function loadSourcePreviews(token) {
  if (!elements.sourceGrid) {
    return;
  }

  var images = Array.prototype.slice.call(elements.sourceGrid.querySelectorAll('img[data-preview-src]'));
  var index = 0;
  var active = 0;
  var limit = state.activeSourceTab === 'applications' ? 2 : 4;

  function pump() {
    if (token !== state.previewQueueToken) {
      return;
    }
    while (active < limit && index < images.length) {
      var image = images[index];
      index += 1;
      active += 1;
      image.onload = image.onerror = function () {
        active -= 1;
        pump();
      };
      image.src = image.getAttribute('data-preview-src');
      image.removeAttribute('data-preview-src');
    }
  }

  pump();
}

function renderMonitor() {
  var monitor = state.monitor;
  var switching = monitor && monitor.running && state.pendingScreenId && monitor.screenId !== state.pendingScreenId;
  if (switching) {
    elements.monitorStatus.textContent = 'Switching capture to ' + screenShortLabel(state.pendingScreenId) + '...';
    elements.stopMonitorButton.disabled = false;
    elements.startMonitorButton.disabled = true;
    updateElapsedTimer();
    renderDisplays();
    renderWindows();
    return;
  }

  if (monitor && monitor.running) {
    elements.monitorStatus.textContent = 'Monitoring ' + screenShortLabel(monitor.screenId) + '. Click New when the prompt changes.';
    elements.stopMonitorButton.disabled = false;
    elements.startMonitorButton.disabled = false;
  } else if (monitor && monitor.lastError) {
    elements.monitorStatus.textContent = 'Stopped: ' + monitor.lastError;
    elements.stopMonitorButton.disabled = true;
    elements.startMonitorButton.disabled = false;
  } else if (state.newQuestionPending) {
    elements.monitorStatus.textContent = 'Ready for a new question. Type, dictate, or choose a screen to capture.';
    elements.stopMonitorButton.disabled = true;
    elements.startMonitorButton.disabled = false;
  } else {
    elements.monitorStatus.textContent = elements.screenSelect.value
      ? 'Ready: click Capture to grab the selected screen'
      : 'Select a screen first';
    elements.stopMonitorButton.disabled = true;
    elements.startMonitorButton.disabled = false;
  }
  if (state.listening) {
    elements.monitorStatus.textContent = 'Dictating into the question text box...';
  }
  updateElapsedTimer();
  renderDisplays();
  renderWindows();
}

function renderRuns(runs) {
  return runs;
}

function renderRun(run) {
  if (!run) {
    state.currentRun = null;
    state.currentRunReady = false;
    state.currentRunHasAnswer = false;
    state.activeTurnId = null;
    elements.kindLabel.textContent = 'No run selected';
    elements.titleLabel.textContent = 'Waiting for a captured question';
    elements.readyLabel.textContent = 'Not ready';
    elements.completenessLabel.textContent = '0% captured';
    elements.questionBody.innerHTML = '<p class="empty">Capture a screen, listen, or type the question.</p>';
    renderTurnTabs(null);
    renderAnswerContent(null);
    elements.hintsView.innerHTML = '<p class="empty">Hints will appear when available.</p>';
    elements.hintsSection.classList.add('hidden');
    elements.screenshotWrap.classList.add('hidden');
    setScreenshotGallery(null);
    if (elements.answerButton) {
      elements.answerButton.disabled = true;
    }
    if (elements.captureButton) {
      elements.captureButton.disabled = state.capturing;
    }
    return;
  }

  var previousRun = state.currentRun;
  var previousAnswerMarkdown = previousRun && previousRun.id === run.id
    ? String(selectedAnswerMarkdown(previousRun) || '').trim()
    : '';

  if (!state.currentRun || state.currentRun.id !== run.id) {
    state.activeAnswerMode = 'firstTry';
    state.activeTurnId = latestTurnId(run);
  } else {
    var turns = runTurns(run);
    var hasActiveTurn = state.activeTurnId && turns.some(function (turn) { return turn.id === state.activeTurnId; });
    if (turns.length && !hasActiveTurn) {
      state.activeTurnId = latestTurnId(run);
      state.activeAnswerMode = 'firstTry';
    } else if (!turns.length) {
      state.activeTurnId = null;
    }
  }
  state.currentRun = run;
  state.currentRunReady = Boolean(run.readyToAnswer);
  state.currentRunHasAnswer = Boolean(run.hasAnswer);
  var nextAnswerMarkdown = String(selectedAnswerMarkdown(run) || '').trim();
  var answerJustFinished = Boolean(nextAnswerMarkdown) &&
    (!previousAnswerMarkdown || (state.answerRequestedRunId === run.id &&
      (!state.answerRequestedTurnId || state.answerRequestedTurnId === state.activeTurnId)));
  elements.kindLabel.textContent = run.kind;
  elements.titleLabel.textContent = run.title;
  elements.readyLabel.textContent = run.readyToAnswer ? 'Ready' : 'Capturing';
  elements.readyLabel.style.color = run.readyToAnswer ? 'var(--accent)' : 'var(--amber)';
  elements.completenessLabel.textContent = Math.round(run.completenessScore * 100) + '% captured';
  renderTurnTabs(run);
  elements.questionBody.innerHTML = renderMarkdown(questionMarkdown(run));
  renderAnswerContent(run);
  if (answerJustFinished) {
    state.answerRequestedRunId = null;
    state.answerRequestedTurnId = null;
    selectTab('answer');
    clearAnswerHash();
    scrollAnswerToTop();
  }

  renderHintsContent(run);

  setScreenshotGallery(run);

  if (elements.answerButton) {
    elements.answerButton.disabled = state.answering || state.capturing || !selectedTurnReadyForAnswer(run);
  }
  if (elements.captureButton) {
    elements.captureButton.disabled = state.capturing;
  }
}

function setScreenshotGallery(run) {
  if (!elements.screenshotGallery || !elements.screenshotWrap || !elements.screenshotMeta) {
    return;
  }

  var screenshots = run && run.screenshots && run.screenshots.length
    ? run.screenshots
    : (run && run.screenshotUrls ? run.screenshotUrls.map(function (url, index) {
      return { index: index, url: url, status: 'pending', canDelete: true };
    }) : []);

  if (!run || !screenshots.length) {
    state.screenshotGallerySignature = '';
    elements.screenshotGallery.innerHTML = '';
    elements.screenshotWrap.classList.add('hidden');
    elements.screenshotMeta.textContent = '';
    return;
  }

  var signature = run.id + '|' + screenshots.map(function (item) {
    return item.url + ':' + item.status + ':' + item.canDelete;
  }).join('|');
  if (state.screenshotGallerySignature === signature) {
    elements.screenshotWrap.classList.remove('hidden');
    elements.screenshotMeta.textContent = screenshotMetaText(screenshots);
    return;
  }

  var itemsHtml = '';
  var total = screenshots.length;
  for (var i = 0; i < total; i++) {
    var item = screenshots[i];
    var url = item.url;
    var label = 'Screenshot ' + (i + 1);
    itemsHtml += '<figure class="screenshot-item" role="listitem">';
    itemsHtml += '<figcaption><span>' + label + '</span><span class="screenshot-actions">';
    itemsHtml += '<span class="screenshot-status ' + escapeHtml(item.status) + '">' + escapeHtml(item.status === 'sent' ? 'Sent' : 'Pending') + '</span>';
    itemsHtml += '<button class="screenshot-delete" type="button" data-screenshot-index="' + item.index + '"' + (item.canDelete ? '' : ' disabled') + ' title="' + (item.canDelete ? 'Remove this pending screenshot from the next answer' : 'Already sent to AI') + '">&times;</button>';
    itemsHtml += '</span></figcaption>';
    itemsHtml += '<img src="' + url + '" alt="' + label + '">';
    itemsHtml += '</figure>';
  }

  state.screenshotGallerySignature = signature;
  elements.screenshotGallery.innerHTML = itemsHtml;
  elements.screenshotWrap.classList.remove('hidden');
  elements.screenshotMeta.textContent = screenshotMetaText(screenshots);
}

function screenshotMetaText(screenshots) {
  var pending = screenshots.filter(function (item) { return item.status !== 'sent'; }).length;
  var sent = screenshots.length - pending;
  return pending + ' pending, ' + sent + ' already sent';
}

async function deleteScreenshot(index) {
  if (!state.currentRunId || !Number.isFinite(index)) {
    return;
  }

  try {
    var detail = await deleteJson('/api/runs/' + encodeURIComponent(state.currentRunId) + '/screens/' + index);
    state.currentRun = detail;
    state.screenshotGallerySignature = '';
    renderRunDetail(detail);
    await refreshRuns();
  } catch (error) {
    elements.monitorStatus.textContent = error && error.message ? error.message : String(error);
  }
}

function resolveCaptureScreenId() {
  if (state.monitor && state.monitor.running && state.monitor.screenId) {
    return state.monitor.screenId;
  }

  if (!elements.screenSelect && !state.displays.length) {
    return null;
  }

  var selectedScreenId = elements.screenSelect ? Number(elements.screenSelect.value) : NaN;
  if (Number.isFinite(selectedScreenId) && selectedScreenId > 0) {
    return selectedScreenId;
  }

  var fallbackScreenId = Number(defaultDisplayId());
  return Number.isFinite(fallbackScreenId) && fallbackScreenId > 0 ? fallbackScreenId : null;
}

function resolveCaptureTarget() {
  var selectedWindowId = elements.windowSelect ? Number(elements.windowSelect.value) : NaN;
  if (Number.isFinite(selectedWindowId) && selectedWindowId > 0) {
    return { windowId: selectedWindowId };
  }

  var selectedScreenId = resolveCaptureScreenId();
  return selectedScreenId ? { screenId: selectedScreenId } : null;
}

function clearForNewCapture(screenId) {
  var hasScreen = Number.isFinite(Number(screenId)) && Number(screenId) > 0;
  state.currentRunId = null;
  state.currentRun = null;
  state.currentRunReady = false;
  state.currentRunHasAnswer = false;
  state.answerRequestedRunId = null;
  state.answerRequestedTurnId = null;
  state.activeTurnId = null;
  elements.kindLabel.textContent = 'New question';
  elements.titleLabel.textContent = 'Ready for a new question';
  elements.readyLabel.textContent = 'Waiting';
  elements.readyLabel.style.color = 'var(--muted)';
  elements.completenessLabel.textContent = '0% captured';
  elements.questionBody.innerHTML = hasScreen
    ? '<p class="empty">Click Capture when the prompt is visible on ' + escapeHtml(screenShortLabel(screenId)) + ', listen when the interviewer reads it aloud, or type it below.</p>'
    : '<p class="empty">Type or dictate the question below, or choose a screen and click Capture.</p>';
  renderTurnTabs(null);
  elements.answerView.innerHTML = '<p class="empty">Capture the new question before generating a solution.</p>';
  renderAnswerModeButtons(false);
  elements.hintsView.innerHTML = '<p class="empty">Hints will appear when available.</p>';
  elements.hintsSection.classList.add('hidden');
  elements.screenshotWrap.classList.add('hidden');
  setScreenshotGallery(null);
  if (elements.answerButton) {
    elements.answerButton.disabled = true;
  }
  if (elements.captureButton) {
    elements.captureButton.disabled = state.capturing;
  }
}

async function fetchJson(url) {
  var response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}

async function postJson(url, body) {
  var response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!response.ok) {
    var errorText = await response.text();
    throw new Error(errorText || 'HTTP ' + response.status);
  }
  return response.json();
}

async function deleteJson(url) {
  var response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    var errorText = await response.text();
    throw new Error(errorText || 'HTTP ' + response.status);
  }
  return response.json();
}

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function renderListenButton() {
  if (!elements.listenButton) {
    return;
  }
  elements.listenButton.textContent = state.listening ? 'Listening...' : 'Listen';
  elements.listenButton.classList.toggle('active', state.listening);
  elements.listenButton.setAttribute('aria-pressed', String(state.listening));
}

function renderQuestionInput() {
  if (!elements.questionInput || !elements.questionSubmitButton) {
    return;
  }

  var hasText = Boolean(String(elements.questionInput.value || '').trim());
  elements.questionSubmitButton.disabled = state.questionTextSubmitting || !hasText;
  elements.questionSubmitButton.textContent = state.questionTextSubmitting ? 'Sending...' : 'Send';
}

function appendQuestionInputText(text) {
  if (!elements.questionInput) {
    return;
  }

  var clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return;
  }

  var current = String(elements.questionInput.value || '').trimEnd();
  elements.questionInput.value = current ? current + ' ' + clean : clean;
  elements.questionInput.focus();
  elements.questionInput.setSelectionRange(elements.questionInput.value.length, elements.questionInput.value.length);
  renderQuestionInput();
}

function setListening(active) {
  state.listening = Boolean(active);
  renderListenButton();
}

function stopListening() {
  state.listening = false;
  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.stop();
    state.recognition = null;
  }
  renderListenButton();
}

async function postTranscript(text, source) {
  var clean = String(text || '').trim();
  if (!clean) {
    return;
  }

  var activeRunId = state.monitor && state.monitor.running && state.monitor.activeRunId ? state.monitor.activeRunId : null;
  var targetRunId = activeRunId || (state.newQuestionPending ? null : state.currentRunId);
  var isText = source === 'text' || source === 'manual';
  elements.monitorStatus.textContent = isText ? 'Sending question text...' : 'Processing voice transcript...';

  var detail = await postJson('/api/transcript', {
    text: clean,
    runId: targetRunId || undefined,
  });

  if (detail && detail.id) {
    state.currentRunId = detail.id;
    state.newQuestionPending = false;
    state.activeTurnId = latestTurnId(detail);
    state.activeAnswerMode = 'firstTry';
  }
  renderRun(detail);
  selectTab('question');
  elements.monitorStatus.textContent = detail && detail.readyToAnswer
    ? (isText ? 'Question text sent. Click Answer.' : 'Voice question is ready. Click Answer.')
    : (isText ? 'Question text sent.' : 'Captured voice transcript.');
}

function queueTranscript(text, source) {
  state.transcriptPost = state.transcriptPost
    .catch(function () {})
    .then(function () {
      return postTranscript(text, source);
    });
  return state.transcriptPost;
}

async function submitQuestionInput() {
  if (!elements.questionInput || state.questionTextSubmitting) {
    return;
  }

  var text = String(elements.questionInput.value || '').trim();
  if (!text) {
    renderQuestionInput();
    return;
  }

  state.questionTextSubmitting = true;
  renderQuestionInput();
  try {
    await queueTranscript(text, 'text');
    elements.questionInput.value = '';
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  } finally {
    state.questionTextSubmitting = false;
    renderQuestionInput();
  }
}

function startListening() {
  var Recognition = recognitionCtor();
  if (!Recognition) {
    elements.monitorStatus.textContent = 'Browser speech recognition is not available in this browser.';
    return;
  }

  stopListening();
  selectTab('question');
  if (elements.questionInput) {
    elements.questionInput.focus();
  }
  var recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = function (event) {
    var finalText = '';
    for (var index = event.resultIndex; index < event.results.length; index += 1) {
      var result = event.results[index];
      if (result.isFinal && result[0] && result[0].transcript) {
        finalText += result[0].transcript + ' ';
      }
    }

    if (finalText.trim()) {
      appendQuestionInputText(finalText);
      elements.monitorStatus.textContent = 'Dictating into the question text box...';
    }
  };

  recognition.onerror = function (event) {
    var message = event && event.error ? event.error : 'Speech recognition error';
    elements.monitorStatus.textContent = message;
    if (message === 'not-allowed' || message === 'service-not-allowed') {
      setListening(false);
    }
  };

  recognition.onend = function () {
    if (!state.listening) {
      return;
    }
    try {
      recognition.start();
    } catch (error) {
      setListening(false);
      elements.monitorStatus.textContent = error.message || String(error);
    }
  };

  state.recognition = recognition;
  setListening(true);
  try {
    recognition.start();
    elements.monitorStatus.textContent = 'Dictating into the question text box...';
  } catch (error) {
    setListening(false);
    state.recognition = null;
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

function toggleListening() {
  if (state.listening) {
    stopListening();
    elements.monitorStatus.textContent = 'Stopped listening.';
    return;
  }
  startListening();
}

async function loadMonitor() {
  var displaysData = await fetchJson('/api/displays');
  var windowsData = await fetchJson('/api/windows');
  var monitorData = await fetchJson('/api/monitor/status');
  state.displays = displaysData.displays || [];
  state.windows = windowsData.windows || [];
  state.monitor = monitorData;
  if (!monitorData || !monitorData.running || !monitorData.screenId || monitorData.screenId === state.pendingScreenId) {
    state.pendingScreenId = null;
  }
  renderMonitor();
}

async function startMonitor(screenId) {
  try {
    var selectedScreenId = Number(screenId || elements.screenSelect.value);
    if (!Number.isFinite(selectedScreenId) || selectedScreenId <= 0) {
      elements.monitorStatus.textContent = 'Choose a screen first.';
      if (elements.screenSelect.options.length) {
        elements.screenSelect.focus();
      }
      return;
    }
    try {
      localStorage.setItem(SELECTED_SCREEN_KEY, String(selectedScreenId));
    } catch (_error) {
    }
    state.pendingScreenId = selectedScreenId;
    state.newQuestionPending = false;
    clearForNewCapture(selectedScreenId);
    elements.monitorStatus.textContent = 'Starting new question capture on ' + screenShortLabel(selectedScreenId) + '...';
    state.monitor = await postJson('/api/monitor/start', { screenId: selectedScreenId });
    state.pendingScreenId = null;
    renderMonitor();
    loadSelectedRun();
  } catch (error) {
    state.pendingScreenId = null;
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function stopMonitor() {
  try {
    state.pendingScreenId = null;
    state.monitor = await postJson('/api/monitor/stop', {});
    renderMonitor();
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function requestAnswer() {
  if (!state.currentRunId || !selectedTurnReadyForAnswer(state.currentRun) || !elements.answerButton || state.answering || state.capturing) {
    return;
  }

  selectTab('answer');
  clearAnswerHash();
  scrollAnswerToTop();
  renderAnswerModeButtons(false);
  elements.answerView.innerHTML = '<p class="empty">Generating answer...</p>';
  state.answering = true;
  state.answerRequestedRunId = state.currentRunId;
  state.answerRequestedTurnId = state.activeTurnId;
  elements.answerButton.disabled = true;
  elements.answerButton.textContent = 'Generating answer...';
  elements.monitorStatus.textContent = 'Generating answer...';

  try {
    var url = '/api/runs/' + encodeURIComponent(state.currentRunId) + '/answer';
    await postJson(url, { turnId: state.activeTurnId || undefined });
  } catch (error) {
    state.answerRequestedRunId = null;
    state.answerRequestedTurnId = null;
    elements.monitorStatus.textContent = error.message || String(error);
  } finally {
    state.answering = false;
    if (elements.answerButton) {
      elements.answerButton.textContent = 'Answer (F)';
    }
    if (elements.captureButton) {
      elements.captureButton.disabled = state.capturing;
    }
    if (state.currentRunId) {
      try {
        await loadSelectedRun();
      } catch (_error) {
      }
    }
  }
}

async function requestCapture() {
  if (!elements.captureButton || state.capturing) {
    return;
  }

  if (!state.captureStream || !state.captureVideo) {
    elements.monitorStatus.textContent = 'Choose a source first.';
    await chooseBrowserSource();
    if (!state.captureStream || !state.captureVideo) {
      return;
    }
  }

  state.capturing = true;
  elements.captureButton.disabled = true;
  if (elements.answerButton) {
    elements.answerButton.disabled = true;
  }
  elements.captureButton.textContent = 'Capturing...';

  try {
    var imageData = await captureBrowserSourceFrame();
    if (!imageData) {
      elements.monitorStatus.textContent = 'Choose a source first.';
      return;
    }

    var activeRunId = state.monitor && state.monitor.running && state.monitor.activeRunId ? state.monitor.activeRunId : null;
    var targetRunId = activeRunId || (state.newQuestionPending ? null : state.currentRunId);
    var targetUrl = targetRunId ? '/api/runs/' + encodeURIComponent(targetRunId) + '/capture-image' : '/api/capture-image';
    var payload = { runId: targetRunId || undefined, imageData: imageData };
    var detail = await postJson(targetUrl, payload);
    if (detail && detail.id) {
      state.currentRunId = detail.id;
      state.newQuestionPending = false;
      state.activeTurnId = latestTurnId(detail);
      state.activeAnswerMode = 'firstTry';
    }
    renderRun(detail);
    if (detail && detail.id) {
      setScreenshotGallery(detail);
    }
    elements.monitorStatus.textContent = 'Captured screenshot.';
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  } finally {
    state.capturing = false;
    if (elements.captureButton) {
      elements.captureButton.textContent = 'Capture (C)';
      elements.captureButton.disabled = state.capturing;
    }
    if (elements.answerButton) {
      elements.answerButton.disabled = state.answering || state.capturing || !selectedTurnReadyForAnswer(state.currentRun);
    }
  }
}

async function startNewQuestion(screenId) {
  try {
    var selectedScreenId = Number(screenId || elements.screenSelect.value);
    var hasScreen = Number.isFinite(selectedScreenId) && selectedScreenId > 0;
    if (hasScreen) {
      try {
        localStorage.setItem(SELECTED_SCREEN_KEY, String(selectedScreenId));
      } catch (_error) {
      }
    }

    state.pendingScreenId = hasScreen ? selectedScreenId : null;
    state.newQuestionPending = true;
    clearForNewCapture(hasScreen ? selectedScreenId : null);
    selectTab('question');
    elements.monitorStatus.textContent = hasScreen
      ? 'Ready for a new question. Click Capture when the prompt is visible.'
      : 'Ready for a new question. Type or dictate it below.';

    if (state.monitor && state.monitor.running) {
      state.monitor = await postJson('/api/monitor/stop', {});
    }

    state.pendingScreenId = null;
    renderMonitor();
  } catch (error) {
    state.pendingScreenId = null;
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function requestReset() {
  if (!state.currentRunId) {
    return;
  }

  try {
    var url = '/api/runs/' + encodeURIComponent(state.currentRunId) + '/reset';
    await postJson(url, {});
    await loadSelectedRun();
  } catch (error) {
    elements.monitorStatus.textContent = error.message || String(error);
  }
}

async function loadRuns() {
  var data = await fetchJson('/api/runs');
  var runs = data.runs || [];
  var activeRunId = state.monitor && state.monitor.running && state.monitor.activeRunId;
  var hasCurrentRun = state.currentRunId && runs.some(function (run) { return run.id === state.currentRunId; });
  var hasActiveRun = activeRunId && runs.some(function (run) { return run.id === activeRunId; });

  if (hasActiveRun) {
    state.newQuestionPending = false;
    state.currentRunId = activeRunId;
  } else if (state.newQuestionPending) {
    state.currentRunId = null;
  } else if (state.monitor && state.monitor.running) {
    state.currentRunId = null;
  } else if (!hasCurrentRun) {
    state.currentRunId = runs.length ? runs[0].id : null;
  }

  renderRuns(runs);
  return runs;
}

async function loadSelectedRun() {
  state.lastRefreshAt = Date.now();
  try {
    await loadMonitor();
    await loadRuns();
    if (!state.currentRunId) {
      if (state.newQuestionPending) {
        clearForNewCapture(resolveCaptureScreenId());
      } else {
        renderRun(null);
      }
      return;
    }
    var run = await fetchJson('/api/runs/' + encodeURIComponent(state.currentRunId));
    renderRun(run);
    updateElapsedTimer();
  } catch (error) {
    elements.monitorStatus.textContent = 'Disconnected';
    elements.answerView.innerHTML = '<p class="empty">UI server is not responding.</p>';
    elements.hintsView.innerHTML = '<p class="empty">UI server is not responding.</p>';
    updateElapsedTimer();
  }
}

function startTimer() {
  if (state.timer) {
    clearInterval(state.timer);
  }
  state.timer = setInterval(function () {
    updateElapsedTimer();
    if (Date.now() - state.lastRefreshAt >= 2000) {
      loadSelectedRun();
    }
  }, 1000);
}

function selectTab(tabName) {
  if (!elements.answerTab && !elements.questionTab && !elements.answerPanel && !elements.questionPanel) {
    return;
  }

  var answerActive = tabName === 'answer';
  state.activeTab = answerActive ? 'answer' : 'question';

  if (elements.answerTab) {
    elements.answerTab.classList.toggle('active', answerActive);
    elements.answerTab.setAttribute('aria-selected', String(answerActive));
  }
  if (elements.questionTab) {
    elements.questionTab.classList.toggle('active', !answerActive);
    elements.questionTab.setAttribute('aria-selected', String(!answerActive));
  }
  if (elements.answerPanel) {
    elements.answerPanel.classList.toggle('hidden', !answerActive);
  }
  if (elements.questionPanel) {
    elements.questionPanel.classList.toggle('hidden', answerActive);
  }
}

function hotkeysBlocked(event) {
  var target = event && event.target;
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  var tagName = target.tagName ? String(target.tagName).toLowerCase() : '';
  return tagName === 'input' || tagName === 'textarea';
}

function toggleOverlay(forceOpen) {
  var nextOpen = typeof forceOpen === 'boolean'
    ? forceOpen
    : elements.overlayPanel.classList.contains('hidden');
  state.overlayOpen = nextOpen;
  elements.overlayPanel.classList.toggle('hidden', !nextOpen);
  elements.overlayToggle.setAttribute('aria-expanded', String(nextOpen));
}

function stopBrowserSource() {
  if (state.captureStream) {
    state.captureStream.getTracks().forEach(function (track) {
      track.stop();
    });
  }
  state.captureStream = null;
  state.captureVideo = null;
  state.captureSourceLabel = '';
  updateSourceButton();
  if (elements.captureButton) {
    elements.captureButton.textContent = 'Capture (C)';
    elements.captureButton.disabled = false;
  }
}

async function chooseBrowserSource() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    elements.monitorStatus.textContent = 'Browser source capture is not available in this browser.';
    toggleOverlay(true);
    return;
  }

  try {
    stopBrowserSource();
    var stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
      },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    var video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise(function (resolve) {
        video.onloadedmetadata = resolve;
      });
    }

    var track = stream.getVideoTracks()[0];
    var settings = track && track.getSettings ? track.getSettings() : {};
    state.captureStream = stream;
    state.captureVideo = video;
    state.captureSourceLabel = settings && settings.displaySurface
      ? String(settings.displaySurface)
      : 'selected source';
    track.addEventListener('ended', function () {
      stopBrowserSource();
      elements.monitorStatus.textContent = 'Source sharing stopped.';
    });
    updateSourceButton();
    elements.monitorStatus.textContent = 'Source selected. Click Capture when ready.';
    toggleOverlay(false);
  } catch (error) {
    elements.monitorStatus.textContent = error && error.message ? error.message : String(error);
  }
}

async function captureBrowserSourceFrame() {
  if (!state.captureVideo || !state.captureStream) {
    await chooseBrowserSource();
  }
  if (!state.captureVideo || !state.captureStream) {
    return null;
  }

  var video = state.captureVideo;
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('Selected source is not ready yet.');
  }

  var canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  var context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create capture canvas.');
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function boot() {
  ['lastUpdated', 'monitorStatus', 'startMonitorButton',
    'stopMonitorButton', 'screenSelect', 'windowSelect', 'kindLabel', 'titleLabel', 'completenessLabel', 'readyLabel',
    'questionBody', 'screenshotWrap', 'screenshotGallery', 'answerView', 'hintsSection', 'hintsView',
    'screenshotMeta', 'questionInputForm', 'questionInput', 'questionSubmitButton',
    'answerTab', 'questionTab', 'answerPanel', 'questionPanel',
    'answerTurnTabs', 'questionTurnTabs', 'answerModeTabs', 'firstTryAnswerTab', 'robustAnswerTab',
    'monitorMap', 'sourceGrid', 'applicationsSourceTab', 'screenSourceTab', 'devicesSourceTab',
    'captureButton', 'listenButton',
    'overlayToggle', 'overlayPanel', 'answerButton', 'themeToggle'].forEach(function (id) {
    elements[id] = byId(id);
  });

  if (!elements.lastUpdated || !elements.screenSelect || !elements.windowSelect || !elements.startMonitorButton
    || !elements.stopMonitorButton || !elements.overlayToggle || !elements.overlayPanel || !elements.answerButton
    || !elements.captureButton || !elements.listenButton || !elements.monitorStatus || !elements.answerView || !elements.hintsView
    || !elements.answerModeTabs || !elements.firstTryAnswerTab || !elements.robustAnswerTab
    || !elements.answerTurnTabs || !elements.questionTurnTabs
    || !elements.sourceGrid || !elements.applicationsSourceTab || !elements.screenSourceTab || !elements.devicesSourceTab
    || !elements.questionInputForm || !elements.questionInput || !elements.questionSubmitButton) {
    return;
  }

  applyTheme(storedTheme());
  if (elements.themeToggle) {
    elements.themeToggle.addEventListener('click', toggleTheme);
  }

  elements.screenSelect.addEventListener('change', function () {
    try {
      localStorage.setItem(SELECTED_SCREEN_KEY, elements.screenSelect.value);
    } catch (_error) {
    }

    var selectedScreenId = Number(elements.screenSelect.value);
    if (!Number.isFinite(selectedScreenId) || selectedScreenId <= 0) {
      elements.monitorStatus.textContent = 'Select a valid interview screen.';
      return;
    }

    if (state.monitor && state.monitor.running && state.monitor.screenId !== selectedScreenId) {
      elements.monitorStatus.textContent = 'Switching capture to ' + screenShortLabel(selectedScreenId) + '...';
      startMonitor(selectedScreenId);
    } else {
      renderMonitor();
    }
  });
  elements.windowSelect.addEventListener('change', function () {
    try {
      localStorage.setItem(SELECTED_WINDOW_KEY, elements.windowSelect.value);
    } catch (_error) {
    }
    renderMonitor();
  });
  elements.applicationsSourceTab.addEventListener('click', function () { selectSourceTab('applications'); });
  elements.screenSourceTab.addEventListener('click', function () { selectSourceTab('screen'); });
  elements.devicesSourceTab.addEventListener('click', function () { selectSourceTab('devices'); });
  elements.startMonitorButton.addEventListener('click', function () { startNewQuestion(); });
  elements.stopMonitorButton.addEventListener('click', stopMonitor);
  elements.answerButton.addEventListener('click', requestAnswer);
  elements.captureButton.addEventListener('click', requestCapture);
  elements.listenButton.addEventListener('click', toggleListening);
  elements.screenshotGallery.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.matches || !target.matches('.screenshot-delete')) {
      return;
    }
    deleteScreenshot(Number(target.getAttribute('data-screenshot-index')));
  });
  elements.questionInput.addEventListener('input', renderQuestionInput);
  elements.questionInput.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitQuestionInput();
    }
  });
  elements.questionInputForm.addEventListener('submit', function (event) {
    event.preventDefault();
    submitQuestionInput();
  });
  if (elements.answerTab) {
    elements.answerTab.addEventListener('click', function () { selectTab('answer'); });
  }
  if (elements.questionTab) {
    elements.questionTab.addEventListener('click', function () { selectTab('question'); });
  }
  elements.firstTryAnswerTab.addEventListener('click', function () { selectAnswerMode('firstTry'); });
  elements.robustAnswerTab.addEventListener('click', function () { selectAnswerMode('robust'); });
  elements.overlayToggle.addEventListener('click', chooseBrowserSource);
  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (hotkeysBlocked(event)) {
      return;
    }

    var key = String(event.key || '').toLowerCase();
    if (event.key === 'Escape') {
      toggleOverlay(false);
      return;
    }

    if (/^[1-9]$/.test(key)) {
      if (selectMonitorByIndex(Number(key) - 1)) {
        event.preventDefault();
      }
      return;
    }

    if (key === 'a') {
      event.preventDefault();
      selectTab('answer');
      return;
    }
    if (key === 'q') {
      event.preventDefault();
      selectTab('question');
      return;
    }
    if (key === 'w') {
      event.preventDefault();
      selectAnswerMode('firstTry');
      return;
    }
    if (key === 'e') {
      event.preventDefault();
      selectAnswerMode('robust');
      return;
    }
    if (key === 'f') {
      event.preventDefault();
      requestAnswer();
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      requestCapture();
      return;
    }
    if (key === 'l') {
      event.preventDefault();
      toggleListening();
      return;
    }
    if (key === 'n') {
      event.preventDefault();
      startNewQuestion();
      return;
    }
    if (key === 's') {
      event.preventDefault();
      stopMonitor();
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      loadSelectedRun();
    }
  });
  loadSelectedRun().then(function () {
    toggleOverlay(false);
  });
  renderQuestionInput();
  startTimer();
  if (elements.answerTab || elements.questionTab || elements.answerPanel || elements.questionPanel) {
    selectTab('answer');
  }
}

boot();`;