// ===================
// Pomodoro Timer App
// ===================

/*
Features:
- Modes: work / short / long
- Custom durations & long break cadence
- Start / Pause / Reset / Skip
- Persist state & resume after refresh/close (timestamp math)
- Notification API toggle
- Sound levels via Web Audio (no files)
- Daily / weekly local history + simple canvas bar chart
- Theme color + logo preference
*/

(function () {
  // ---------- DOM ----------
  const countdownEl = document.getElementById('countdown');
  const todayCountEl = document.getElementById('todayCount');
  const cycleLabelEl = document.getElementById('cycleLabel');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const resetBtn = document.getElementById('resetBtn');
  const skipBtn = document.getElementById('skipBtn');

  const tabs = document.querySelectorAll('.tab');

  const workMinsEl = document.getElementById('workMins');
  const shortMinsEl = document.getElementById('shortMins');
  const longMinsEl = document.getElementById('longMins');
  const longEveryEl = document.getElementById('longEvery');
  const soundLevelEl = document.getElementById('soundLevel');
  const notifyToggleEl = document.getElementById('notifyToggle');
  const saveSettingsBtn = document.getElementById('saveSettings');

  const themeColorEl = document.getElementById('themeColor');
  const logoUrlEl = document.getElementById('logoUrl');
  const applyBrandBtn = document.getElementById('applyBrand');
  const brandLogoImg = document.getElementById('brandLogo');

  const todayMinutesEl = document.getElementById('todayMinutes');
  const weekTotalEl = document.getElementById('weekTotal');
  const weekChart = document.getElementById('weekChart');
  const exportCsvBtn = document.getElementById('exportCsv');
  const clearHistoryBtn = document.getElementById('clearHistory');

  // ---------- State ----------
  const LS_KEY = 'pomodoro.state.v1';
  const LS_PREF = 'pomodoro.pref.v1';
  const LS_HISTORY = 'pomodoro.history.v1';

  const defaultPrefs = {
    work: 25,
    short: 5,
    long: 15,
    longEvery: 4,
    sound: 'normal',        // quiet | normal | loud | off
    notify: false,
    themeColor: '#4f46e5',
    logoUrl: ''
  };

  let state = {
    mode: 'work',           // 'work' | 'short' | 'long'
    running: false,
    // timestamps in ms
    startedAt: null,        // when this stretch began (wall clock)
    endsAt: null,           // when current stretch should end (wall clock)
    pausedRemaining: null,  // ms remaining when paused
    cycleIndex: 1,          // 1..longEvery
    todayPomodoros: 0
  };

  let prefs = loadPrefs();
  applyPrefsToUI();
  applyBranding();

  // resume from saved state
  const saved = loadState();
  if (saved) {
    state = { ...state, ...saved };
    // reconcile time
    reconcileTimer();
    updateUI();
  } else {
    // init UI from prefs
    setMode('work', false);
    updateUI();
  }

  // ---------- Event Listeners ----------
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    setMode(tab.dataset.mode, true);
  }));

  startBtn.addEventListener('click', startTimer);
  pauseBtn.addEventListener('click', pauseTimer);
  resetBtn.addEventListener('click', resetTimer);
  skipBtn.addEventListener('click', () => completeCurrent(true));

  saveSettingsBtn.addEventListener('click', () => {
    prefs.work = clampInt(workMinsEl.value, 1, 120);
    prefs.short = clampInt(shortMinsEl.value, 1, 60);
    prefs.long = clampInt(longMinsEl.value, 1, 60);
    prefs.longEvery = clampInt(longEveryEl.value, 2, 12);
    prefs.sound = soundLevelEl.value;
    prefs.notify = !!notifyToggleEl.checked;
    savePrefs();

    if (prefs.notify) ensureNotificationPermission();
    // If mode changed duration, adjust if not running
    if (!state.running) setMode(state.mode, false);
    drawChart();
  });

  applyBrandBtn.addEventListener('click', () => {
    prefs.themeColor = themeColorEl.value || defaultPrefs.themeColor;
    prefs.logoUrl = logoUrlEl.value || '';
    savePrefs();
    applyBranding();
  });

  window.addEventListener('beforeunload', (e) => {
    // Warn only if running
    if (state.running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  exportCsvBtn.addEventListener('click', exportCSV);
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Clear all local history? This cannot be undone.')) {
      localStorage.removeItem(LS_HISTORY);
      updateHistoryUI();
      drawChart();
    }
  });

  // ---------- Timer Engine ----------
  let rafTimer = null; // using setInterval for second tick. requestAnimationFrame not needed.
  let tickInterval = null;

  function setMode(mode, userClickedTab) {
    state.mode = mode;
    state.running = false;
    state.startedAt = null;
    state.endsAt = null;
    state.pausedRemaining = getModeMs(mode);
    saveState();

    // update tabs if set programmatically
    if (!userClickedTab) {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    }
    updateUI();
  }

  function getModeMs(mode) {
    const minutes = (mode === 'work') ? prefs.work : (mode === 'short' ? prefs.short : prefs.long);
    return minutes * 60 * 1000;
  }

  function startTimer() {
    if (state.running) return;
    const now = Date.now();
    if (state.pausedRemaining != null) {
      state.startedAt = now;
      state.endsAt = now + state.pausedRemaining;
      state.pausedRemaining = null;
    } else if (!state.startedAt) {
      const dur = getModeMs(state.mode);
      state.startedAt = now;
      state.endsAt = now + dur;
    }
    state.running = true;
    saveState();
    startTicking();
    updateUI();
  }

  function pauseTimer() {
    if (!state.running) return;
    state.running = false;
    state.pausedRemaining = Math.max(0, state.endsAt - Date.now());
    stopTicking();
    saveState();
    updateUI();
  }

  function resetTimer() {
    state.running = false;
    state.startedAt = null;
    state.endsAt = null;
    state.pausedRemaining = getModeMs(state.mode);
    stopTicking();
    saveState();
    updateUI();
  }

  function completeCurrent(skipped = false) {
    // record history if completed a work session (not if skipped from work before finishing)
    const finishedWork = state.mode === 'work' && !skipped;
    if (finishedWork) {
      incrementHistoryForToday(1);
      state.todayPomodoros = getTodayPomodoros();
      // advance cycle
      state.cycleIndex = (state.cycleIndex % prefs.longEvery) + 1;
    }

    // next mode
    let nextMode;
    if (state.mode === 'work') {
      nextMode = (state.cycleIndex === 1) ? 'long' : 'short';
    } else {
      nextMode = 'work';
    }

    setMode(nextMode, false);
    notify(`${capitalize(nextMode)} started`, `Next interval: ${labelFor(nextMode)}.`);
    playChime(nextMode === 'work' ? 'work' : 'break');
    saveState();
    updateUI();
  }

  function labelFor(mode){
    if (mode === 'work') return `${prefs.work} min Work`;
    if (mode === 'short') return `${prefs.short} min Short Break`;
    return `${prefs.long} min Long Break`;
  }

  function startTicking() {
    if (tickInterval) return;
    tickInterval = setInterval(() => {
      const remaining = getRemainingMs();
      if (remaining <= 0) {
        // finish interval
        stopTicking();
        notify('Time’s up!', `Completed: ${labelFor(state.mode)}`);
        playChime('end');
        completeCurrent(false);
        return;
      }
      renderTime(remaining);
    }, 250); // 4x per second for smoothness on resume
  }
  function stopTicking() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function getRemainingMs() {
    if (state.running && state.endsAt) return Math.max(0, state.endsAt - Date.now());
    if (state.pausedRemaining != null) return state.pausedRemaining;
    if (!state.startedAt) return getModeMs(state.mode);
    return Math.max(0, (state.endsAt || 0) - Date.now());
  }

  function reconcileTimer() {
    if (!state.startedAt || !state.endsAt) return;
    const remaining = state.endsAt - Date.now();
    if (remaining <= 0) {
      // The interval finished while away
      // Count it as completed if it was a work session
      if (state.mode === 'work') {
        incrementHistoryForToday(1);
        state.todayPomodoros = getTodayPomodoros();
        state.cycleIndex = (state.cycleIndex % prefs.longEvery) + 1;
      }
      // Next mode as per normal rule
      const next = (state.mode === 'work')
        ? (state.cycleIndex === 1 ? 'long' : 'short')
        : 'work';
      setMode(next, false);
      // Not auto-starting next on resume; keep paused
      state.running = false;
      saveState();
    }
  }

  function updateUI() {
    // Timer text
    renderTime(getRemainingMs());
    // Cycle label
    cycleLabelEl.textContent = `${state.cycleIndex} / ${prefs.longEvery}`;
    // Today count
    state.todayPomodoros = getTodayPomodoros();
    todayCountEl.textContent = state.todayPomodoros.toString();
    // Buttons states
    startBtn.disabled = state.running;
    pauseBtn.disabled = !state.running;
    // Settings inputs
    workMinsEl.value = prefs.work;
    shortMinsEl.value = prefs.short;
    longMinsEl.value = prefs.long;
    longEveryEl.value = prefs.longEvery;
    soundLevelEl.value = prefs.sound;
    notifyToggleEl.checked = !!prefs.notify;

    updateHistoryUI();
    drawChart();
  }

  function renderTime(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    countdownEl.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    // Set document title to glance on tab
    document.title = `${countdownEl.textContent} • ${capitalize(state.mode)} • Pomodoro`;
  }

  // ---------- Persistence ----------
  function saveState() {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function savePrefs() {
    localStorage.setItem(LS_PREF, JSON.stringify(prefs));
    // apply CSS brand
    document.documentElement.style.setProperty('--brand', prefs.themeColor || defaultPrefs.themeColor);
  }
  function loadPrefs() {
    let p = defaultPrefs;
    try {
      const raw = localStorage.getItem(LS_PREF);
      if (raw) p = { ...p, ...JSON.parse(raw) };
    } catch {}
    return p;
  }

  function applyPrefsToUI() {
    workMinsEl.value = prefs.work;
    shortMinsEl.value = prefs.short;
    longMinsEl.value = prefs.long;
    longEveryEl.value = prefs.longEvery;
    soundLevelEl.value = prefs.sound;
    notifyToggleEl.checked = !!prefs.notify;
    themeColorEl.value = prefs.themeColor || defaultPrefs.themeColor;
    logoUrlEl.value = prefs.logoUrl || '';
  }

  function applyBranding() {
    document.documentElement.style.setProperty('--brand', prefs.themeColor || defaultPrefs.themeColor);
    if (prefs.logoUrl) {
      brandLogoImg.src = prefs.logoUrl;
      brandLogoImg.style.display = 'inline-block';
    } else {
      brandLogoImg.removeAttribute('src');
      brandLogoImg.style.display = 'none';
    }
  }

  // ---------- Notifications & Sound ----------
  function ensureNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function notify(title, body) {
    if (!prefs.notify || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }

  // Web Audio chime (no external file)
  let audioCtx;
  function playChime(type = 'end') {
    if (prefs.sound === 'off') return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      const gain = audioCtx.createGain();
      const osc = audioCtx.createOscillator();

      const volume = (prefs.sound === 'quiet') ? 0.04 : (prefs.sound === 'loud' ? 0.18 : 0.09);
      gain.gain.setValueAtTime(volume, now);

      // different motif for end/work/break
      const pattern = (type === 'work')
        ? [660, 880, 660]
        : (type === 'break')
          ? [523, 659]
          : [880, 784, 698, 659];

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      let t = now;
      pattern.forEach((freq, i) => {
        osc.frequency.setValueAtTime(freq, t);
        t += 0.12 + (i * 0.02);
      });
      // quick fade out
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.start(now);
      osc.stop(t + 0.06);
    } catch { /* ignore */ }
  }

  // ---------- History & Chart ----------
  function getHistory() {
    try {
      const raw = localStorage.getItem(LS_HISTORY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function setHistory(hist) {
    localStorage.setItem(LS_HISTORY, JSON.stringify(hist));
  }
  function dateKey(d = new Date()) {
    // yyyy-mm-dd local
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function incrementHistoryForToday(n) {
    const hist = getHistory();
    const key = dateKey();
    hist[key] = (hist[key] || 0) + n;
    setHistory(hist);
  }
  function getTodayPomodoros() {
    const hist = getHistory();
    return hist[dateKey()] || 0;
  }

  function updateHistoryUI() {
    const todayPomos = getTodayPomodoros();
    todayCountEl.textContent = String(todayPomos);
    todayMinutesEl.textContent = String(todayPomos * prefs.work);
    const week = lastNDays(7).map(k => getHistory()[k] || 0);
    weekTotalEl.textContent = String(week.reduce((a,b)=>a+b,0));
  }

  function lastNDays(n) {
    const keys = [];
    const now = new Date();
    for (let i = n-1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      keys.push(dateKey(d));
    }
    return keys;
  }

  function drawChart() {
    const ctx = weekChart.getContext('2d');
    const w = weekChart.width;
    const h = weekChart.height;
    // clear
    ctx.clearRect(0,0,w,h);
    // bg grid
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0,0,w,h);

    const labels = lastNDays(7);
    const values = labels.map(k => (getHistory()[k] || 0));

    const max = Math.max(4, ...values);
    const pad = 28;
    const chartW = w - pad*2;
    const chartH = h - pad*2;

    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.stroke();

    // bars
    const gap = 12;
    const barW = (chartW - gap * (values.length - 1)) / values.length;
    const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#4f46e5';
    values.forEach((v, i) => {
      const x = pad + i * (barW + gap);
      const barH = (v / max) * (chartH - 8);
      const y = (h - pad) - barH;
      // bar
      ctx.fillStyle = brand;
      ctx.fillRect(x, y, barW, barH);
      // label
      ctx.fillStyle = 'rgba(230,233,245,0.85)';
      ctx.font = '12px system-ui, sans-serif';
      const day = labels[i].slice(5); // mm-dd
      ctx.fillText(day, x, h - pad + 16);
      if (v > 0) ctx.fillText(String(v), x, y - 6);
    });
  }

  function exportCSV() {
    const hist = getHistory();
    const rows = [['date','pomodoros']];
    Object.keys(hist).sort().forEach(k => rows.push([k, hist[k]]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pomodoro_history.csv';
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
      URL.revokeObjectURL(url);
      a.remove();
    });
  }

  // ---------- Helpers ----------
  function clampInt(v, min, max) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }
  function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  // Initial draw
  drawChart();

})();
