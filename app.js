(function (root) {
  "use strict";
  const NOTIFICATION_THRESHOLDS = [15, 5, 1];
  const APP_STORAGE_KEY = "kaoyan-reward-plan-v1";
  const ALL_DATA_CLEAR_MESSAGE = "将清空学习记录、奖励、任务、娱乐额度、娱乐会话和作息记录，并恢复为空白计划。此操作无法撤销，建议先导出 JSON 备份。";

  function localDateString(nowValue) {
    const date = new Date(nowValue === undefined ? Date.now() : nowValue);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function isEntertainmentDateToday(selectedDate, nowValue) {
    return typeof selectedDate === "string" && selectedDate === localDateString(nowValue);
  }

  function validInsightDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function addInsightDateDays(value, days) {
    if (!validInsightDate(value)) return "";
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function sanitizedInsightsState(currentState) {
    const source = currentState && typeof currentState === "object" ? currentState : {};
    const validEntries = (collection) => Object.fromEntries(
      Object.entries(collection && typeof collection === "object" ? collection : {})
        .filter(([date]) => validInsightDate(date))
    );
    return {
      ...source,
      records: (Array.isArray(source.records) ? source.records : []).filter((record) => record && validInsightDate(record.date)),
      sessions: (Array.isArray(source.sessions) ? source.sessions : []).filter((session) => session && validInsightDate(session.date)),
      allowances: validEntries(source.allowances),
      sleepRecords: validEntries(source.sleepRecords)
    };
  }

  function buildBoundedInsights(currentState, today, planStart) {
    const I = root.RewardInsights || globalThis.RewardInsights;
    if (!I || !validInsightDate(today)) return [];
    const sanitized = sanitizedInsightsState(currentState);
    const earliest = addInsightDateDays(today, -179);
    const requestedStart = validInsightDate(planStart) && planStart <= today ? planStart : today;
    const start = requestedStart < earliest ? earliest : requestedStart;
    return I.buildDailyInsights(sanitized, start, today);
  }

  function buildHistoryInsights(currentState, records) {
    const I = root.RewardInsights || globalThis.RewardInsights;
    if (!I) return [];
    const sanitized = sanitizedInsightsState(currentState);
    const dates = Array.from(new Set(
      (Array.isArray(records) ? records : [])
        .map((record) => record && record.date)
        .filter(validInsightDate)
    )).sort();
    return dates.map((date) => I.buildDailyInsights(sanitized, date, date)[0]);
  }

  function notificationStateForStart(sessions, date, initialRemainingSeconds) {
    const sameDayNotified = new Set();
    (Array.isArray(sessions) ? sessions : []).forEach((session) => {
      if (session && session.date === date && Array.isArray(session.notifiedAt)) {
        session.notifiedAt.forEach((minutes) => sameDayNotified.add(Number(minutes)));
      }
    });
    return {
      notifiedAt: NOTIFICATION_THRESHOLDS.filter((minutes) => sameDayNotified.has(minutes)),
      previousRemainingSeconds: Math.max(0, Number(initialRemainingSeconds) || 0)
    };
  }

  function crossedNotificationThresholds({ previousRemainingSeconds, remainingSeconds, notifiedAt }) {
    const previous = Math.max(0, Number(previousRemainingSeconds) || 0);
    const remaining = Math.max(0, Number(remainingSeconds) || 0);
    const notified = new Set(Array.isArray(notifiedAt) ? notifiedAt.map(Number) : []);
    return NOTIFICATION_THRESHOLDS.filter((minutes) => {
      const thresholdSeconds = minutes * 60;
      return previous > thresholdSeconds && remaining <= thresholdSeconds && !notified.has(minutes);
    });
  }

  function advanceNotificationProgress(session, remainingSeconds) {
    const remaining = Math.max(0, Number(remainingSeconds) || 0);
    const crossed = crossedNotificationThresholds({
      previousRemainingSeconds: session && session.previousRemainingSeconds,
      remainingSeconds: remaining,
      notifiedAt: session && session.notifiedAt
    });
    const priorNotified = session && Array.isArray(session.notifiedAt) ? session.notifiedAt : [];
    const notifiedAt = NOTIFICATION_THRESHOLDS.filter((minutes) => priorNotified.includes(minutes) || crossed.includes(minutes));
    return {
      session: { ...(session || {}), notifiedAt, previousRemainingSeconds: remaining },
      crossed
    };
  }

  function notificationStateForRestore(session, sessions, date, fallbackRemainingSeconds) {
    const inherited = notificationStateForStart(sessions, date, fallbackRemainingSeconds);
    const sessionNotified = session && Array.isArray(session.notifiedAt) ? session.notifiedAt : [];
    const notifiedAt = NOTIFICATION_THRESHOLDS.filter((minutes) => inherited.notifiedAt.includes(minutes) || sessionNotified.includes(minutes));
    const savedPrevious = Number(session && session.previousRemainingSeconds);
    const legacyStarting = Number(session && session.startingRemainingSeconds);
    const previousRemainingSeconds = Number.isFinite(savedPrevious)
      ? Math.max(0, savedPrevious)
      : Number.isFinite(legacyStarting)
        ? Math.max(0, legacyStarting)
        : inherited.previousRemainingSeconds;
    return { notifiedAt, previousRemainingSeconds };
  }

  function validTime(value) {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(":").map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  }

  function timeMinutes(value) {
    if (!validTime(value)) return NaN;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function addLocalDateDays(dateValue, days) {
    const [year, month, day] = String(dateValue).split("-").map(Number);
    const date = new Date(year, month - 1, day + days);
    return localDateString(date);
  }

  function routineSettingsAreValid(settings) {
    if (!settings || ![settings.reminderTime, settings.cutoffTime, settings.sleepTarget, settings.wakeTarget].every(validTime)) return false;
    const reminder = timeMinutes(settings.reminderTime);
    const cutoff = timeMinutes(settings.cutoffTime);
    let sleep = timeMinutes(settings.sleepTarget);
    let wake = timeMinutes(settings.wakeTarget) + 1440;
    if (sleep < cutoff) sleep += 1440;
    if (wake <= sleep) wake += 1440;
    return reminder < cutoff && cutoff <= sleep && sleep < wake && wake - sleep <= 18 * 60;
  }

  function routineSettingsSnapshot(settings) {
    if (!routineSettingsAreValid(settings)) return null;
    return {
      reminderTime: settings.reminderTime,
      cutoffTime: settings.cutoffTime,
      sleepTarget: settings.sleepTarget,
      wakeTarget: settings.wakeTarget
    };
  }

  function safeReminderForCutoff(preferred, cutoffTime) {
    const cutoff = timeMinutes(cutoffTime);
    if (validTime(preferred) && timeMinutes(preferred) < cutoff) return preferred;
    if (timeMinutes("22:15") < cutoff) return "22:15";
    const reminder = Math.max(0, cutoff - 1);
    return `${String(Math.floor(reminder / 60)).padStart(2, "0")}:${String(reminder % 60).padStart(2, "0")}`;
  }

  function settingsForDateState(currentState, date) {
    const defaults = { reminderTime: "22:15", cutoffTime: "22:30", sleepTarget: "23:00", wakeTarget: "07:00" };
    const active = routineSettingsSnapshot({ ...defaults, ...((currentState && currentState.settings) || {}) }) || defaults;
    const sleepRecord = currentState && currentState.sleepRecords && currentState.sleepRecords[date];
    if (sleepRecord) {
      const saved = routineSettingsSnapshot(sleepRecord.settingsSnapshot);
      if (saved) return saved;
      const legacyCutoff = validTime(sleepRecord.cutoffTime) ? sleepRecord.cutoffTime : active.cutoffTime;
      return {
        reminderTime: safeReminderForCutoff(active.reminderTime, legacyCutoff),
        cutoffTime: legacyCutoff,
        sleepTarget: validTime(sleepRecord.sleepTarget) ? sleepRecord.sleepTarget : active.sleepTarget,
        wakeTarget: validTime(sleepRecord.wakeTarget) ? sleepRecord.wakeTarget : active.wakeTarget
      };
    }
    const allowance = currentState && currentState.allowances && currentState.allowances[date];
    const allowanceSnapshot = routineSettingsSnapshot(allowance && allowance.settingsSnapshot);
    if (allowanceSnapshot) return allowanceSnapshot;
    const sessions = Array.isArray(currentState && currentState.sessions) ? currentState.sessions : [];
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      const session = sessions[index];
      if (session && session.date === date) {
        const sessionSnapshot = routineSettingsSnapshot(session.settingsSnapshot);
        if (sessionSnapshot) return sessionSnapshot;
      }
    }
    let historical = null;
    (Array.isArray(currentState && currentState.changeLogs) ? currentState.changeLogs : []).forEach((entry) => {
      if (!entry || entry.type !== "routine-settings-effective" || !entry.effectiveDate || entry.effectiveDate > date) return;
      const snapshot = routineSettingsSnapshot(entry.settingsSnapshot);
      if (snapshot && (!historical || entry.effectiveDate >= historical.effectiveDate)) {
        historical = { effectiveDate: entry.effectiveDate, snapshot };
      }
    });
    const resolved = historical ? historical.snapshot : active;
    const legacyCutoff = allowance && validTime(allowance.cutoffTime)
      ? allowance.cutoffTime
      : (() => {
          for (let index = sessions.length - 1; index >= 0; index -= 1) {
            const session = sessions[index];
            if (session && session.date === date && validTime(session.cutoffTime)) return session.cutoffTime;
          }
          return null;
        })();
    return legacyCutoff
      ? { ...resolved, reminderTime: safeReminderForCutoff(resolved.reminderTime, legacyCutoff), cutoffTime: legacyCutoff }
      : resolved;
  }

  function settingsEffectiveLog(effectiveDate, settings) {
    return {
      type: "routine-settings-effective",
      effectiveDate,
      settingsSnapshot: { ...settings },
      createdAt: new Date().toISOString()
    };
  }

  function activateNextSettingsState(currentState, date) {
    const stateSettings = currentState && currentState.settings ? currentState.settings : {};
    const queued = stateSettings.nextSettings;
    if (!queued || !queued.effectiveDate || date < queued.effectiveDate || !routineSettingsAreValid(queued)) return currentState;
    const nextSettings = {
      ...stateSettings,
      reminderTime: queued.reminderTime,
      cutoffTime: queued.cutoffTime,
      sleepTarget: queued.sleepTarget,
      wakeTarget: queued.wakeTarget,
      effectiveDate: queued.effectiveDate,
      nextSettings: null
    };
    const logs = Array.isArray(currentState.changeLogs) ? currentState.changeLogs : [];
    return {
      ...currentState,
      settings: nextSettings,
      changeLogs: logs.concat(settingsEffectiveLog(queued.effectiveDate, routineSettingsSnapshot(queued)))
    };
  }

  function saveRoutineSettingsState(currentState, date, proposed) {
    if (!routineSettingsAreValid(proposed)) return { ok: false, state: currentState, reason: "时间设置无效，请确认提醒早于截止，并检查作息时间。" };
    const values = {
      reminderTime: proposed.reminderTime,
      cutoffTime: proposed.cutoffTime,
      sleepTarget: proposed.sleepTarget,
      wakeTarget: proposed.wakeTarget
    };
    const logs = Array.isArray(currentState.changeLogs) ? currentState.changeLogs : [];
    const hasSessionToday = (Array.isArray(currentState.sessions) ? currentState.sessions : []).some((session) => session && session.date === date);
    if (hasSessionToday) {
      const effectiveDate = addLocalDateDays(date, 1);
      const activeSnapshot = routineSettingsSnapshot({
        reminderTime: currentState.settings && currentState.settings.reminderTime || "22:15",
        cutoffTime: currentState.settings && currentState.settings.cutoffTime || "22:30",
        sleepTarget: currentState.settings && currentState.settings.sleepTarget || "23:00",
        wakeTarget: currentState.settings && currentState.settings.wakeTarget || "07:00"
      });
      return {
        ok: true,
        appliesTomorrow: true,
        state: {
          ...currentState,
          settings: {
            ...currentState.settings,
            nextSettings: { ...values, queuedOnDate: date, effectiveDate }
          },
          changeLogs: logs
            .concat(settingsEffectiveLog(currentState.settings && currentState.settings.effectiveDate || date, activeSnapshot))
            .concat(settingsEffectiveLog(effectiveDate, values))
        }
      };
    }
    return {
      ok: true,
      appliesTomorrow: false,
      state: {
        ...currentState,
        allowances: currentState.allowances && currentState.allowances[date] && !currentState.allowances[date].expired
          ? { ...currentState.allowances, [date]: { ...currentState.allowances[date], cutoffTime: values.cutoffTime, settingsSnapshot: { ...values } } }
          : currentState.allowances,
        settings: { ...currentState.settings, ...values, effectiveDate: date, nextSettings: null },
        changeLogs: logs.concat(settingsEffectiveLog(date, values))
      }
    };
  }

  function cutoffDateFor(date, cutoffTime) {
    const [year, month, day] = String(date).split("-").map(Number);
    const [hours, minutes] = String(cutoffTime || "22:30").split(":").map(Number);
    return new Date(year, month - 1, day, hours, minutes, 0, 0);
  }

  function cutoffStoppedMessage(cutoffTime) {
    return `已到 ${validTime(cutoffTime) ? cutoffTime : "22:30"}，娱乐计时自动停止。`;
  }

  function applyDailyCutoffState(currentState, nowValue) {
    const X = root.EntertainmentEngine || globalThis.EntertainmentEngine;
    const now = nowValue instanceof Date ? new Date(nowValue) : new Date(nowValue);
    const date = localDateString(now);
    const settings = currentState.settings || {};
    let nextState = currentState;
    let changeLogs = Array.isArray(currentState.changeLogs) ? currentState.changeLogs : [];
    let reminderDue = false;
    let changed = false;
    const reminderAlreadyLogged = changeLogs.some((item) => item && item.type === "entertainment-reminder" && item.date === date);
    if (X.isAtOrAfterCutoff(now, settings.reminderTime || "22:15") && !reminderAlreadyLogged) {
      reminderDue = true;
      changed = true;
      changeLogs = changeLogs.concat({ type: "entertainment-reminder", date, createdAt: now.toISOString() });
      nextState = { ...nextState, changeLogs };
    }

    const allowances = { ...(nextState.allowances || {}) };
    const sessions = Array.isArray(nextState.sessions) ? nextState.sessions.slice() : [];
    let cutoffApplied = false;

    sessions.forEach((session, index) => {
      if (!session || session.endedAt || !session.date) return;
      const savedAllowance = allowances[session.date];
      const sessionSettings = routineSettingsSnapshot(session.settingsSnapshot)
        || routineSettingsSnapshot(savedAllowance && savedAllowance.settingsSnapshot)
        || settingsForDateState(nextState, session.date);
      const sessionCutoff = validTime(session.cutoffTime)
        ? session.cutoffTime
        : savedAllowance && validTime(savedAllowance.cutoffTime)
          ? savedAllowance.cutoffTime
          : session.date === date
            ? (settings.cutoffTime || "22:30")
            : "22:30";
      const cutoffDate = cutoffDateFor(session.date, sessionCutoff);
      if (now.getTime() < cutoffDate.getTime()) return;
      const allowance = savedAllowance || {
        date: session.date,
        unlockedMinutes: 0,
        usedSeconds: 0,
        expired: false,
        cutoffTime: sessionCutoff
      };
      const stopped = {
        ...X.stopSession(session, cutoffDate.toISOString(), "cutoff"),
        cutoffTime: sessionCutoff,
        settingsSnapshot: { ...sessionSettings, cutoffTime: sessionCutoff }
      };
      const accountedSeconds = Math.min(stopped.durationSeconds, X.remainingSeconds(allowance));
      sessions[index] = stopped;
      allowances[session.date] = {
        ...allowance,
        cutoffTime: sessionCutoff,
        settingsSnapshot: { ...sessionSettings, cutoffTime: sessionCutoff },
        usedSeconds: allowance.usedSeconds + accountedSeconds,
        expired: true
      };
      changed = true;
      cutoffApplied = true;
    });

    const todayCutoff = settings.cutoffTime || "22:30";
    if (X.isAtOrAfterCutoff(now, todayCutoff)) {
      const todaySettings = routineSettingsSnapshot(settings);
      const todayAllowance = allowances[date] || {
        date,
        unlockedMinutes: 0,
        usedSeconds: 0,
        expired: false,
        cutoffTime: todayCutoff
      };
      if (!todayAllowance.expired || !allowances[date]) {
        allowances[date] = {
          ...todayAllowance,
          cutoffTime: todayAllowance.cutoffTime || todayCutoff,
          ...(routineSettingsSnapshot(todayAllowance.settingsSnapshot) || todaySettings
            ? { settingsSnapshot: routineSettingsSnapshot(todayAllowance.settingsSnapshot) || todaySettings }
            : {}),
          expired: true
        };
        changed = true;
      }
      cutoffApplied = true;
    }
    if (changed) nextState = { ...nextState, allowances, sessions };
    return { state: nextState, reminderDue, changed, cutoffApplied };
  }

  function sleepOnTime(actual, target) {
    if (!validTime(actual) || !validTime(target)) return false;
    let actualMinutes = timeMinutes(actual);
    let targetMinutes = timeMinutes(target);
    if (targetMinutes < 12 * 60) targetMinutes += 1440;
    if (actualMinutes < 12 * 60) actualMinutes += 1440;
    return actualMinutes <= targetMinutes;
  }

  function stopDelayMinutesForDate(currentState, date, cutoffTime) {
    const cutoffMs = cutoffDateFor(date, cutoffTime).getTime();
    return (Array.isArray(currentState.sessions) ? currentState.sessions : [])
      .filter((session) => session && session.date === date && session.endedAt)
      .reduce((maximum, session) => {
        const endedMs = Date.parse(session.endedAt);
        const delay = Number.isFinite(endedMs) ? Math.max(0, Math.ceil((endedMs - cutoffMs) / 60000)) : 0;
        return Math.max(maximum, delay);
      }, 0);
  }

  function routineReason({ hasSleep, hasWake, stopDelayMinutes, sleepOnTime: sleepOk, wakeOnTime: wakeOk, routinePercent }) {
    if (!hasSleep && !hasWake) return "尚未记录实际入睡和次日起床时间，作息项暂计 0%。";
    if (!hasSleep) return "缺少实际入睡时间，作息项计 0%。";
    if (!hasWake) return "缺少次日起床时间，作息项暂计 0%。";
    if (stopDelayMinutes > 30) return `娱乐停止超过截止 ${stopDelayMinutes} 分钟，作息项计 0%。`;
    if (routinePercent === 100) return "按时停止娱乐，且入睡和起床均按计划，作息项计 100%。";
    const reasons = [];
    if (stopDelayMinutes > 0) reasons.push(`娱乐停止晚了 ${stopDelayMinutes} 分钟`);
    if (!sleepOk) reasons.push("入睡晚于计划");
    if (!wakeOk) reasons.push("起床晚于计划");
    return `${reasons.join("、") || "作息部分达标"}，作息项计 50%。`;
  }

  function saveSleepRecordState(currentState, date, input) {
    if (!validTime(input && input.sleepTime) && !validTime(input && input.wakeTime)) return currentState;
    const E = root.RewardEngine || globalThis.RewardEngine;
    const X = root.EntertainmentEngine || globalThis.EntertainmentEngine;
    const existing = currentState.sleepRecords && currentState.sleepRecords[date];
    const settingsSnapshot = settingsForDateState(currentState, date);
    const sleepTarget = settingsSnapshot.sleepTarget;
    const wakeTarget = settingsSnapshot.wakeTarget;
    const cutoffTime = settingsSnapshot.cutoffTime;
    const sleepTime = validTime(input && input.sleepTime) ? input.sleepTime : "";
    const wakeTime = validTime(input && input.wakeTime) ? input.wakeTime : "";
    const hasSleep = Boolean(sleepTime);
    const hasWake = Boolean(wakeTime);
    const sleepOk = sleepOnTime(sleepTime, sleepTarget);
    const wakeOk = hasWake && timeMinutes(wakeTime) <= timeMinutes(wakeTarget);
    const stopDelayMinutes = stopDelayMinutesForDate(currentState, date, cutoffTime);
    const compliance = X.routinePercent({
      stopDelayMinutes,
      sleepOnTime: sleepOk,
      wakeOnTime: wakeOk,
      hasSleep,
      hasWake
    });
    const record = {
      date,
      sleepTime,
      wakeTime,
      sleepTarget,
      wakeTarget,
      cutoffTime,
      settingsSnapshot,
      sleepOnTime: sleepOk,
      wakeOnTime: wakeOk,
      cutoffCompliant: stopDelayMinutes <= 0,
      stopDelayMinutes,
      routinePercent: compliance,
      reason: routineReason({ hasSleep, hasWake, stopDelayMinutes, sleepOnTime: sleepOk, wakeOnTime: wakeOk, routinePercent: compliance }),
      updatedAt: new Date().toISOString()
    };
    const records = (Array.isArray(currentState.records) ? currentState.records : []).map((studyRecord) => {
      if (!studyRecord || studyRecord.date !== date) return studyRecord;
      return { ...E.withDerivedRoutine(studyRecord, compliance), routineCompliance: compliance };
    });
    return {
      ...currentState,
      records,
      sleepRecords: { ...(currentState.sleepRecords || {}), [date]: record }
    };
  }

  function recordWithRoutineForDate(currentState, draft, date) {
    const E = root.RewardEngine || globalThis.RewardEngine;
    const sleepRecord = currentState.sleepRecords && currentState.sleepRecords[date];
    if (sleepRecord && Number.isFinite(Number(sleepRecord.routinePercent))) {
      const compliance = Number(sleepRecord.routinePercent);
      return { ...E.withDerivedRoutine(draft, compliance), routineCompliance: compliance };
    }
    const existing = (Array.isArray(currentState.records) ? currentState.records : []).find((record) => record && record.date === date);
    if (existing && Number.isFinite(Number(existing.routineCompliance))) {
      const compliance = Number(existing.routineCompliance);
      return { ...E.withDerivedRoutine(draft, compliance), routineCompliance: compliance };
    }
    if (existing) {
      const legacy = E.withDerivedRoutine(draft, existing.routine);
      delete legacy.routineCompliance;
      return legacy;
    }
    return { ...E.withDerivedRoutine(draft, 0), routineCompliance: 0 };
  }

  function prepareInsightCanvas(canvas) {
    if (!canvas || typeof canvas.getContext !== "function") return null;
    const width = Math.floor(Number(canvas.offsetWidth) || 0);
    const height = Math.floor(Number(canvas.offsetHeight) || 0);
    if (width <= 0 || height <= 0) return null;
    const ratio = Math.max(1, Number(root.devicePixelRatio) || 1);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return null;
    if (typeof context.setTransform === "function") context.setTransform(ratio, 0, 0, ratio, 0, 0);
    else if (typeof context.scale === "function") context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  }

  function dateLabel(value) {
    const parts = String(value || "").split("-");
    return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : "";
  }

  function drawInsightFrame(canvas, points, options) {
    const prepared = prepareInsightCanvas(canvas);
    if (!prepared) return false;
    const { context: ctx, width, height } = prepared;
    const source = Array.isArray(points) ? points : [];
    const padding = { left: 44, right: 16, top: 18, bottom: 32 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    ctx.font = "10px Microsoft YaHei";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const hasSeriesValue = source.some((point) => options.series.some((series) => numberOrNullForChart(point && point[series.key]) !== null));
    if (!source.length || !hasSeriesValue) {
      ctx.fillStyle = "#6c7772";
      ctx.textAlign = "center";
      ctx.fillText(options.emptyText, width / 2, height / 2);
      return true;
    }

    ctx.strokeStyle = "#e5e8e2";
    ctx.fillStyle = "#88918d";
    ctx.lineWidth = 1;
    options.ticks.forEach((tick) => {
      const bounded = Math.min(options.max, Math.max(options.min, tick));
      const y = padding.top + chartHeight - (bounded - options.min) / (options.max - options.min || 1) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillText(options.tickLabel(tick), 4, y + 3);
    });
    const xAt = (index) => source.length === 1
      ? padding.left + chartWidth / 2
      : padding.left + index / (source.length - 1) * chartWidth;
    const yAt = (value) => padding.top + chartHeight - (value - options.min) / (options.max - options.min || 1) * chartHeight;

    options.series.forEach((series) => {
      let drawing = false;
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      source.forEach((point, index) => {
        const value = numberOrNullForChart(point && point[series.key]);
        if (value === null) { drawing = false; return; }
        const x = xAt(index);
        const y = yAt(Math.min(options.max, Math.max(options.min, value)));
        if (drawing) ctx.lineTo(x, y); else { ctx.moveTo(x, y); drawing = true; }
      });
      ctx.stroke();
      source.forEach((point, index) => {
        const value = numberOrNullForChart(point && point[series.key]);
        if (value === null) return;
        ctx.beginPath();
        ctx.fillStyle = "#fffefa";
        ctx.strokeStyle = series.color;
        ctx.arc(xAt(index), yAt(Math.min(options.max, Math.max(options.min, value))), 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    });

    ctx.fillStyle = "#88918d";
    ctx.textAlign = "center";
    const labelIndexes = source.length === 1
      ? [0]
      : Array.from(new Set([0, Math.floor((source.length - 1) / 2), source.length - 1]));
    labelIndexes.forEach((index) => ctx.fillText(dateLabel(source[index] && source[index].date), xAt(index), height - 9));
    return true;
  }

  function drawEntertainmentChart(canvas, points) {
    const values = (Array.isArray(points) ? points : [])
      .map((point) => numberOrNullForChart(point && point.usedMinutes))
      .filter((value) => value !== null);
    const maximum = Math.max(90, values.length ? Math.ceil(Math.max(...values) / 30) * 30 : 90);
    return drawInsightFrame(canvas, points, {
      min: 0,
      max: maximum,
      ticks: [0, maximum / 3, maximum * 2 / 3, maximum],
      tickLabel: (value) => `${Math.round(value)}分`,
      emptyText: "暂无娱乐使用记录",
      series: [{ key: "usedMinutes", color: "#5a83a5" }]
    });
  }

  function numberOrNullForChart(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function chartClockLabel(totalMinutes) {
    const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  }

  function drawSleepChart(canvas, points) {
    const values = (Array.isArray(points) ? points : []).flatMap((point) => [
      numberOrNullForChart(point && point.sleepMinutes),
      numberOrNullForChart(point && point.wakeMinutes)
    ]).filter((value) => value !== null);
    const minimum = Math.min(22 * 60, values.length ? Math.floor(Math.min(...values) / 60) * 60 : 22 * 60);
    const maximum = Math.max(34 * 60, values.length ? Math.ceil(Math.max(...values) / 60) * 60 : 34 * 60);
    const interval = (maximum - minimum) / 3;
    return drawInsightFrame(canvas, points, {
      min: minimum,
      max: maximum,
      ticks: [minimum, minimum + interval, minimum + interval * 2, maximum],
      tickLabel: chartClockLabel,
      emptyText: "暂无入睡和起床记录",
      series: [
        { key: "sleepMinutes", color: "#2d725e" },
        { key: "wakeMinutes", color: "#e7a83e" }
      ]
    });
  }

  function filterHistoryByCompliance(records, points, filter) {
    const source = Array.isArray(records) ? records : [];
    if (filter !== "ontime" && filter !== "overtime") return source.slice();
    const byDate = new Map((Array.isArray(points) ? points : []).map((point) => [point.date, point.overtime]));
    const wanted = filter === "overtime";
    return source.filter((record) => byDate.get(record && record.date) === wanted);
  }

  function buildImportPreview(imported) {
    const source = imported && typeof imported === "object" ? imported : {};
    const records = Array.isArray(source.records) ? source.records.length : 0;
    const taskDates = source.dailyTasks && typeof source.dailyTasks === "object" ? Object.keys(source.dailyTasks).length : 0;
    const sessions = Array.isArray(source.sessions) ? source.sessions.length : 0;
    const sleepDates = source.sleepRecords && typeof source.sleepRecords === "object" ? Object.keys(source.sleepRecords).length : 0;
    return `版本 ${source.version || "未知"}；学习记录 ${records} 条；任务日期 ${taskDates} 天；娱乐会话 ${sessions} 段；作息记录 ${sleepDates} 天。确认后才会覆盖当前本地数据。`;
  }

  function importStateAfterDecision(currentState, importedState, confirmed) {
    return confirmed ? importedState : currentState;
  }

  function commitReplacementState(currentState, nextState, confirmed, save) {
    if (!confirmed) return { ok: true, cancelled: true, state: currentState };
    if (typeof save !== "function") return { ok: false, state: currentState, error: new TypeError("缺少保存函数") };
    const saved = save(APP_STORAGE_KEY, nextState);
    return saved && saved.ok
      ? { ok: true, cancelled: false, state: nextState }
      : { ok: false, cancelled: false, state: currentState, error: saved && saved.error };
  }

  function auditValuesEqual(before, after) {
    if (Object.is(before, after)) return true;
    if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
    if (Array.isArray(before) !== Array.isArray(after)) return false;
    const beforeKeys = Object.keys(before).sort();
    const afterKeys = Object.keys(after).sort();
    if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key, index) => key !== afterKeys[index])) return false;
    return beforeKeys.every((key) => auditValuesEqual(before[key], after[key]));
  }

  function auditUnlockedChangeState(currentState, date, field, before, after, changedAt) {
    const allowance = currentState && currentState.allowances && currentState.allowances[date];
    if (!(allowance && Number(allowance.unlockedMinutes) > 0) || auditValuesEqual(before, after)) return currentState;
    const storageApi = root.RewardStorage || globalThis.RewardStorage;
    return storageApi.appendChangeLog(currentState, { date, field, before, after, changedAt });
  }

  function isIdentifiableDemoState(currentState) {
    const records = currentState && Array.isArray(currentState.records) ? currentState.records : [];
    const settings = currentState && currentState.settings;
    const storageApi = root.RewardStorage || globalThis.RewardStorage;
    const defaultSettings = storageApi && storageApi.DEFAULT_SETTINGS;
    const emptyMap = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
    const emptyList = (value) => Array.isArray(value) && value.length === 0;
    const baseDemo = records.length > 0
      && records.every((record) => record && typeof record.id === "string" && /^sample-\d+$/.test(record.id))
      && currentState.examCompleted === false
      && currentState.targetReached === false
      && emptyList(currentState.overrideLogs)
      && emptyList(currentState.changeLogs)
      && Boolean(settings && defaultSettings && auditValuesEqual(settings, defaultSettings));
    if (!baseDemo) return false;
    const legacyDemo = emptyMap(currentState.dailyTasks)
      && emptyMap(currentState.allowances)
      && emptyList(currentState.sessions)
      && emptyMap(currentState.sleepRecords);
    if (legacyDemo) return true;
    if (currentState.sampleData !== "kaoyan-v2-two-week" || records.length !== 13) return false;

    const sampleDates = new Set(records.map((record) => record.date));
    if (sampleDates.size !== records.length || records.some((record) => record.sample !== true)) return false;
    const datedEntriesAreSample = (map, idPattern) => {
      if (!map || typeof map !== "object" || Array.isArray(map)) return false;
      return Object.entries(map).every(([date, value]) => sampleDates.has(date)
        && value && value.date === date && value.sample === true && idPattern.test(value.id || ""));
    };
    const taskDates = currentState.dailyTasks && typeof currentState.dailyTasks === "object"
      ? Object.keys(currentState.dailyTasks) : [];
    const tasksAreSample = taskDates.length === sampleDates.size
      && taskDates.every((date) => sampleDates.has(date)
        && Array.isArray(currentState.dailyTasks[date])
        && currentState.dailyTasks[date].length === 3
        && currentState.dailyTasks[date].every((task) => task && task.date === date && task.sample === true
          && /^sample-task-\d+-\d+$/.test(task.id || "")));
    const allowancesAreSample = Object.keys(currentState.allowances || {}).length === sampleDates.size
      && datedEntriesAreSample(currentState.allowances, /^sample-allowance-\d+$/);
    const sleepIsSample = datedEntriesAreSample(currentState.sleepRecords, /^sample-sleep-\d+$/);
    const sessionsAreSample = Array.isArray(currentState.sessions)
      && currentState.sessions.every((session) => session && sampleDates.has(session.date)
        && session.sample === true && /^sample-session-\d+$/.test(session.id || ""));
    if (!(tasksAreSample && allowancesAreSample && sleepIsSample && sessionsAreSample)) return false;
    const engineApi = root.RewardEngine || globalThis.RewardEngine;
    const lastDate = Array.from(sampleDates).sort().at(-1);
    if (!engineApi || typeof engineApi.createSampleData !== "function" || !lastDate) return false;
    try {
      return auditValuesEqual(currentState, engineApi.createSampleData(engineApi.parseLocalDate(lastDate)));
    } catch (_) {
      return false;
    }
  }

  function clearedLocalState(currentState, now, confirmed) {
    const storageApi = root.RewardStorage || globalThis.RewardStorage;
    return {
      key: APP_STORAGE_KEY,
      shouldClear: Boolean(confirmed),
      state: confirmed ? storageApi.createEmptyData(now) : currentState
    };
  }

  root.KaoyanAppTest = Object.freeze({
    isEntertainmentDateToday,
    notificationStateForStart,
    crossedNotificationThresholds,
    advanceNotificationProgress,
    notificationStateForRestore,
    applyDailyCutoffState,
    saveSleepRecordState,
    recordWithRoutineForDate,
    saveRoutineSettingsState,
    activateNextSettingsState,
    cutoffStoppedMessage,
    settingsForDateState,
    drawEntertainmentChart,
    drawSleepChart,
    filterHistoryByCompliance,
    buildBoundedInsights,
    buildHistoryInsights,
    buildImportPreview,
    importStateAfterDecision,
    commitReplacementState,
    auditUnlockedChangeState,
    isIdentifiableDemoState,
    clearedLocalState,
    allDataClearMessage: () => ALL_DATA_CLEAR_MESSAGE
  });
  if (!root.document) return;

  const E = root.RewardEngine;
  const X = root.EntertainmentEngine;
  const S = root.RewardStorage;
  const I = root.RewardInsights;
  const STORAGE_KEY = APP_STORAGE_KEY;
  const CORE_TASK_COUNT = 3;
  const qualityConfig = [
    { key: "review", label: "错题复盘", weight: 15, descriptions: ["未完成", "部分完成", "完整复盘"] },
    { key: "exercise", label: "适度运动", weight: 10, descriptions: ["未运动", "简单活动", "达到计划"] },
    { key: "honesty", label: "诚信记录", weight: 10, descriptions: ["需核对", "基本属实", "完全如实"] }
  ];
  const qualityValues = { review: 100, exercise: 50, honesty: 100 };
  let state = loadData();
  let plan = E.calculatePlan(state);
  let confirmAction = null;
  let toastTimer = null;
  let entertainmentTimer = null;
  let replacingImportedState = false;

  function $(selector) { return document.querySelector(selector); }
  function $all(selector) { return Array.from(document.querySelectorAll(selector)); }
  function money(value, decimals) {
    return `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals === 2 ? 2 : 0 })}`;
  }
  function loadData() {
    const loaded = S.load(STORAGE_KEY, new Date());
    if (loaded.ok && !loaded.empty) return loaded.data;

    const sample = S.migrate(E.createSampleData(), new Date());
    if (loaded.ok) {
      S.save(STORAGE_KEY, sample);
    }
    return sample;
  }
  function persist(nextState, message) {
    const saved = S.save(STORAGE_KEY, nextState);
    if (!saved.ok) {
      showToast("数据保存失败，当前修改未生效");
      return false;
    }
    state = nextState;
    plan = E.calculatePlan(nextState);
    renderAll();
    if (message) showToast(message);
    return true;
  }
  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }
  function askConfirm(title, message, action) {
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    confirmAction = action;
    $("#confirmModal").classList.add("show");
    $("#confirmModal").setAttribute("aria-hidden", "false");
  }
  function closeConfirm() {
    $("#confirmModal").classList.remove("show");
    $("#confirmModal").setAttribute("aria-hidden", "true");
    confirmAction = null;
  }

  function currentDailyDate() {
    return $("#checkinDate") && $("#checkinDate").value ? $("#checkinDate").value : plan.today;
  }

  function defaultDailyTask(date, index) {
    return { id: `${date}-task-${index + 1}`, text: `核心任务 ${index + 1}`, completed: false, outcome: "" };
  }

  function dailyTasksFor(date) {
    const saved = Array.isArray(state.dailyTasks[date]) ? state.dailyTasks[date] : [];
    return Array.from({ length: CORE_TASK_COUNT }, (_, index) => {
      const task = saved[index] || defaultDailyTask(date, index);
      return {
        id: task.id || `${date}-task-${index + 1}`,
        text: typeof task.text === "string" ? task.text : `核心任务 ${index + 1}`,
        completed: Boolean(task.completed && String(task.outcome || "").trim()),
        outcome: typeof task.outcome === "string" ? task.outcome : ""
      };
    });
  }

  function saveQuietly(nextState) {
    const saved = S.save(STORAGE_KEY, nextState);
    if (!saved.ok) {
      showToast("数据保存失败，当前修改未生效");
      return false;
    }
    state = nextState;
    plan = E.calculatePlan(state);
    return true;
  }

  function estimatedDailyScore() {
    return $("#checkinDate") ? E.calculateDailyScore(formRecord()).score : 0;
  }

  function reconciledAllowance(date, tasks, currentAllowance) {
    const completedTaskCount = tasks.filter((task) => task.completed && task.outcome.trim()).length;
    const entitledMinutes = X.entitlementFor({ completedTaskCount, estimatedScore: estimatedDailyScore() });
    const settingsSnapshot = routineSettingsSnapshot(currentAllowance && currentAllowance.settingsSnapshot)
      || settingsForDateState(state, date);
    return X.reconcileAllowance(currentAllowance, {
      date,
      entitledMinutes,
      afterCutoff: X.isAtOrAfterCutoff(new Date(), settingsSnapshot.cutoffTime),
      cutoffTime: currentAllowance && currentAllowance.cutoffTime || settingsSnapshot.cutoffTime,
      settingsSnapshot
    });
  }

  function reconcileAllowanceForCurrentDate() {
    if (replacingImportedState) return;
    if (!$("#checkinDate") || !$("#checkinDate").value) return;
    const date = currentDailyDate();
    if (!isEntertainmentDateToday(date, Date.now())) return;
    const tasks = dailyTasksFor(date);
    const allowance = reconciledAllowance(date, tasks, state.allowances[date]);
    const nextState = { ...state, allowances: { ...state.allowances, [date]: allowance } };
    if (saveQuietly(nextState) && $("#allowanceMinutes")) renderAllowance();
  }

  function saveDailyTasks(date, tasks) {
    const existingTasks = Array.isArray(state.dailyTasks[date]) ? state.dailyTasks[date] : [];
    const audited = auditUnlockedChangeState(
      state,
      date,
      "dailyTasks",
      existingTasks,
      tasks,
      new Date().toISOString()
    );
    if (!isEntertainmentDateToday(date, Date.now())) {
      saveQuietly({ ...audited, dailyTasks: { ...audited.dailyTasks, [date]: tasks } });
      return;
    }
    const allowance = reconciledAllowance(date, tasks, state.allowances[date]);
    const nextState = {
      ...audited,
      dailyTasks: { ...audited.dailyTasks, [date]: tasks },
      allowances: { ...audited.allowances, [date]: allowance }
    };
    if (saveQuietly(nextState)) renderAllowance();
  }

  function renderDailyTasks(date) {
    const tasks = dailyTasksFor(date);
    $("#dailyTasks").innerHTML = tasks.map((task, index) => `
      <div class="daily-task-row" data-task-index="${index}">
        <label class="daily-task-check" for="dailyTaskDone${index}" title="标记任务完成"><input id="dailyTaskDone${index}" type="checkbox" ${task.completed ? "checked" : ""} aria-label="任务 ${index + 1} 已完成" /></label>
        <div class="daily-task-field"><label for="dailyTaskText${index}">任务 ${index + 1}</label><input id="dailyTaskText${index}" class="daily-task-text" value="${escapeHtml(task.text)}" maxlength="80" /></div>
        <div class="daily-task-field"><label for="dailyTaskOutcome${index}">成果或证据</label><input id="dailyTaskOutcome${index}" class="daily-task-outcome" value="${escapeHtml(task.outcome)}" maxlength="120" placeholder="例如：完成真题 2 篇并订正" /><small class="task-error">请先填写成果或证据，再标记完成。</small></div>
      </div>`).join("");
    $("#dailyTaskProgress").textContent = `${tasks.filter((task) => task.completed).length} / ${CORE_TASK_COUNT}`;

    $all(".daily-task-row").forEach((row) => {
      const index = Number(row.dataset.taskIndex);
      const checkbox = row.querySelector('input[type="checkbox"]');
      const textInput = row.querySelector(".daily-task-text");
      const outcomeInput = row.querySelector(".daily-task-outcome");
      const error = row.querySelector(".task-error");
      textInput.addEventListener("input", () => {
        tasks[index].text = textInput.value;
        saveDailyTasks(date, tasks);
      });
      outcomeInput.addEventListener("input", () => {
        tasks[index].outcome = outcomeInput.value;
        if (!outcomeInput.value.trim() && tasks[index].completed) {
          tasks[index].completed = false;
          checkbox.checked = false;
          error.classList.add("show");
        } else {
          error.classList.remove("show");
        }
        $("#dailyTaskProgress").textContent = `${tasks.filter((task) => task.completed).length} / ${CORE_TASK_COUNT}`;
        saveDailyTasks(date, tasks);
      });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked && !outcomeInput.value.trim()) {
          checkbox.checked = false;
          tasks[index].completed = false;
          error.classList.add("show");
        } else {
          tasks[index].completed = checkbox.checked;
          error.classList.remove("show");
        }
        $("#dailyTaskProgress").textContent = `${tasks.filter((task) => task.completed).length} / ${CORE_TASK_COUNT}`;
        saveDailyTasks(date, tasks);
      });
    });
  }

  function activeEntertainmentSession() {
    return state.sessions.slice().reverse().find((session) => !session.endedAt) || null;
  }

  function elapsedSessionSeconds(session, nowMs) {
    const startedMs = Date.parse(session.startedAt);
    return Number.isFinite(startedMs) ? Math.max(0, Math.floor(((nowMs || Date.now()) - startedMs) / 1000)) : 0;
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = seconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function cutoffTimeMs(date, cutoffTime) {
    const dateParts = String(date).split("-").map(Number);
    const timeParts = String(cutoffTime || state.settings.cutoffTime || "22:30").split(":").map(Number);
    return new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1], 0, 0).getTime();
  }

  function cutoffCountdown(now) {
    const current = now || new Date();
    const today = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    return Math.max(0, Math.floor((cutoffTimeMs(today) - current.getTime()) / 1000));
  }

  function showEntertainmentNotice(message) {
    const notice = $("#entertainmentNotice");
    notice.textContent = message;
    notice.classList.add("show");
  }

  function applyDailyCutoff(nowValue) {
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue === undefined ? Date.now() : nowValue);
    const date = localDateString(now);
    const activated = activateNextSettingsState(state, date);
    const result = applyDailyCutoffState(activated, now);
    const stoppedByCutoff = (Array.isArray(result.state.sessions) ? result.state.sessions : []).find((session) => {
      const prior = (Array.isArray(activated.sessions) ? activated.sessions : []).find((item) => item && item.id === session.id);
      return prior && !prior.endedAt && session.endReason === "cutoff";
    });
    if ((activated !== state || result.changed) && !saveQuietly(result.state)) return result;
    if (result.reminderDue) {
      const message = "已到娱乐收尾时间，请准备结束游戏、小说或视频。";
      showEntertainmentNotice(message);
      if ("Notification" in window && Notification.permission === "granted") new Notification("研途奖励册", { body: message });
    }
    if (stoppedByCutoff) showEntertainmentNotice(cutoffStoppedMessage(stoppedByCutoff.cutoffTime));
    return result;
  }

  function announceNotificationThresholds(crossed) {
    crossed.forEach((minutes) => {
      const message = `娱乐额度剩余 ${minutes} 分钟，请准备收尾。`;
      showEntertainmentNotice(message);
      if ("Notification" in window && Notification.permission === "granted") new Notification("研途奖励册", { body: message });
    });
  }

  function sessionWithRecordedThresholds(session, remainingSeconds) {
    return advanceNotificationProgress(session, remainingSeconds);
  }

  function notifyRemainingThresholds(session, remainingSeconds) {
    const update = sessionWithRecordedThresholds(session, remainingSeconds);
    const sessions = state.sessions.map((item) => item.id === session.id ? update.session : item);
    const priorRemaining = Number(session.previousRemainingSeconds);
    const remainingRose = Number.isFinite(priorRemaining) && remainingSeconds > priorRemaining;
    if (update.crossed.length) announceNotificationThresholds(update.crossed);
    if (update.crossed.length || remainingRose || !Number.isFinite(priorRemaining)) {
      saveQuietly({ ...state, sessions });
    } else {
      state = { ...state, sessions };
    }
  }

  function nextTierText(tasks, score) {
    const completed = tasks.filter((task) => task.completed).length;
    if (!completed) return "完成至少 1 项核心任务可解锁 30 分钟。";
    if (score < 80) return `当前 30 分钟；今日评分再提高 ${Math.ceil(80 - score)} 分可到 60 分钟。`;
    if (score < 90) return `当前 60 分钟；今日评分再提高 ${Math.ceil(90 - score)} 分可到 90 分钟。`;
    return "今日已解锁最高 90 分钟额度。";
  }

  function renderAllowance() {
    const nowMs = Date.now();
    if (!replacingImportedState) applyDailyCutoff(new Date(nowMs));
    const date = currentDailyDate();
    const tasks = dailyTasksFor(date);
    const allowance = state.allowances[date] || reconciledAllowance(date, tasks, null);
    const activeSession = activeEntertainmentSession();
    const selectedDateIsToday = isEntertainmentDateToday(date, nowMs);
    const activeElapsed = activeSession ? elapsedSessionSeconds(activeSession, nowMs) : 0;
    const activeAllowance = activeSession ? state.allowances[activeSession.date] : null;
    const activeRemaining = activeAllowance ? Math.max(0, X.remainingSeconds(activeAllowance) - activeElapsed) : 0;

    if (activeSession && activeRemaining <= 0) {
      pauseEntertainment("quota");
      return;
    }
    if (activeSession) notifyRemainingThresholds(activeSession, activeRemaining);

    const selectedElapsed = activeSession && activeSession.date === date ? activeElapsed : 0;
    const remaining = Math.max(0, X.remainingSeconds(allowance) - selectedElapsed);
    $("#allowanceMinutes").textContent = `${allowance.unlockedMinutes} 分钟`;
    $("#allowanceUsed").textContent = formatDuration(allowance.usedSeconds + selectedElapsed);
    $("#allowanceRemaining").textContent = formatDuration(remaining);
    $("#currentSession").textContent = activeSession ? formatDuration(activeElapsed) : "00:00:00";
    $("#cutoffTimeLabel").textContent = state.settings.cutoffTime || "22:30";
    $("#cutoffCountdown").textContent = formatDuration(cutoffCountdown(new Date(nowMs)));
    $("#nextTierCondition").textContent = selectedDateIsToday
      ? nextTierText(tasks, estimatedDailyScore())
      : "历史或未来日期仅可查看、编辑任务；娱乐计时只能绑定本地今天。";
    $("#startEntertainment").disabled = !selectedDateIsToday || Boolean(activeSession) || remaining <= 0 || allowance.expired || X.isAtOrAfterCutoff(new Date(nowMs), state.settings.cutoffTime);
    $("#pauseEntertainment").disabled = !activeSession;
  }

  function startEntertainment() {
    const date = currentDailyDate();
    if (!isEntertainmentDateToday(date, Date.now())) {
      showEntertainmentNotice("娱乐计时只能绑定本地今天；历史或未来日期仅可查看、编辑任务。");
      renderAllowance();
      return;
    }
    const tasks = dailyTasksFor(date);
    const allowance = reconciledAllowance(date, tasks, state.allowances[date]);
    const nextState = { ...state, allowances: { ...state.allowances, [date]: allowance } };
    if (!saveQuietly(nextState)) return;
    if (activeEntertainmentSession() || X.remainingSeconds(allowance) <= 0 || allowance.expired) {
      showEntertainmentNotice("当前没有可开始的娱乐额度。");
      renderAllowance();
      return;
    }
    const startedAt = new Date(Date.now()).toISOString();
    const notificationState = notificationStateForStart(state.sessions, date, X.remainingSeconds(allowance));
    const session = {
      ...X.startSession({
        id: `session-${Date.now()}`,
        date,
        deviceLabel: "手机浏览器",
        startedAt,
        cutoffTime: allowance.cutoffTime || state.settings.cutoffTime,
        settingsSnapshot: routineSettingsSnapshot(allowance.settingsSnapshot) || settingsForDateState(state, date)
      }),
      notifiedAt: notificationState.notifiedAt,
      previousRemainingSeconds: notificationState.previousRemainingSeconds
    };
    if (saveQuietly({ ...state, sessions: state.sessions.concat(session) })) {
      showEntertainmentNotice("娱乐计时已开始，系统会按真实时间戳计算。");
      renderAllowance();
    }
  }

  function pauseEntertainment(reason) {
    const activeSession = activeEntertainmentSession();
    if (!activeSession) return;
    const nowMs = Date.now();
    const storedAllowance = state.allowances[activeSession.date];
    const sessionCutoff = activeSession.cutoffTime
      || storedAllowance && storedAllowance.cutoffTime
      || (isEntertainmentDateToday(activeSession.date, nowMs) ? state.settings.cutoffTime : "22:30");
    const cutoffMs = cutoffTimeMs(activeSession.date, sessionCutoff);
    const effectiveReason = nowMs >= cutoffMs ? "cutoff" : (reason || "manual");
    const endedMs = effectiveReason === "cutoff" ? Math.min(nowMs, cutoffMs) : nowMs;
    const stopped = X.stopSession(activeSession, new Date(endedMs).toISOString(), effectiveReason);
    const allowance = storedAllowance || X.reconcileAllowance(null, {
      date: activeSession.date,
      entitledMinutes: 0,
      afterCutoff: false,
      cutoffTime: sessionCutoff
    });
    const accountedSeconds = Math.min(stopped.durationSeconds, X.remainingSeconds(allowance));
    const settledAllowance = {
      ...allowance,
      cutoffTime: allowance.cutoffTime || sessionCutoff,
      usedSeconds: allowance.usedSeconds + accountedSeconds,
      expired: allowance.expired || effectiveReason === "cutoff"
    };
    const remainingAfterUsage = Math.max(0, allowance.unlockedMinutes * 60 - settledAllowance.usedSeconds);
    const notificationUpdate = sessionWithRecordedThresholds(stopped, remainingAfterUsage);
    announceNotificationThresholds(notificationUpdate.crossed);
    const sessions = state.sessions.map((session) => session.id === activeSession.id ? notificationUpdate.session : session);
    const nextState = { ...state, sessions, allowances: { ...state.allowances, [activeSession.date]: settledAllowance } };
    if (saveQuietly(nextState)) {
      const messages = { cutoff: cutoffStoppedMessage(sessionCutoff), quota: "今日娱乐额度已用完。", hidden: "页面进入后台，娱乐计时已自动暂停。" };
      showEntertainmentNotice(messages[effectiveReason] || "娱乐计时已暂停并保存。");
      renderAllowance();
    }
  }

  function restoreActiveSession() {
    const activeSession = activeEntertainmentSession();
    if (!activeSession) return;
    const actualToday = S.createEmptyData(new Date()).startDate;
    if (activeSession.date !== actualToday) {
      pauseEntertainment("restore-date");
      return;
    }
    const allowance = state.allowances[activeSession.date];
    const fallbackPreviousRemaining = allowance ? X.remainingSeconds(allowance) : 0;
    const restored = notificationStateForRestore(activeSession, state.sessions, activeSession.date, fallbackPreviousRemaining);
    if (JSON.stringify(activeSession.notifiedAt || []) !== JSON.stringify(restored.notifiedAt) || activeSession.previousRemainingSeconds !== restored.previousRemainingSeconds) {
      const sessions = state.sessions.map((session) => session.id === activeSession.id ? { ...session, ...restored } : session);
      saveQuietly({ ...state, sessions });
    }
    renderAllowance();
  }

  function renderSleepRecord(date) {
    if (!$("#sleepTime") || !$("#wakeTime")) return;
    const sleepRecord = state.sleepRecords && state.sleepRecords[date];
    $("#sleepTime").value = sleepRecord && sleepRecord.sleepTime ? sleepRecord.sleepTime : "";
    $("#wakeTime").value = sleepRecord && sleepRecord.wakeTime ? sleepRecord.wakeTime : "";
    $("#routineReason").textContent = sleepRecord && sleepRecord.reason
      ? sleepRecord.reason
      : "补全实际入睡和次日起床时间后，系统会自动计算作息项；起床时间归入所选入睡日期。";
  }

  function saveSleepRecord(date, input) {
    const before = state.sleepRecords && state.sleepRecords[date] || null;
    let nextState = saveSleepRecordState(state, date, input);
    if (nextState === state) return showToast("请至少填写实际入睡或次日起床时间");
    const changedAt = new Date().toISOString();
    const after = nextState.sleepRecords[date];
    nextState = auditUnlockedChangeState(nextState, date, "sleepRecords.sleepTime", before && before.sleepTime || "", after.sleepTime, changedAt);
    nextState = auditUnlockedChangeState(nextState, date, "sleepRecords.wakeTime", before && before.wakeTime || "", after.wakeTime, changedAt);
    const sleepRecord = nextState.sleepRecords[date];
    if (persist(nextState, `作息记录已保存：${sleepRecord.routinePercent}%`)) {
      renderSleepRecord(date);
      setForm(state.records.find((record) => record.date === date) || formRecord());
    }
  }

  function renderRoutineSettings() {
    const settings = state.settings || {};
    const displayed = settings.nextSettings || settings;
    $("#reminderTimeSetting").value = displayed.reminderTime || "22:15";
    $("#cutoffTimeSetting").value = displayed.cutoffTime || "22:30";
    $("#sleepTargetSetting").value = displayed.sleepTarget || "23:00";
    $("#wakeTargetSetting").value = displayed.wakeTarget || "07:00";
    if (settings.nextSettings) {
      $("#routineSettingsStatus").textContent = `已有新设置排队，将于 ${settings.nextSettings.effectiveDate} 生效。`;
    } else {
      $("#routineSettingsStatus").textContent = `当前设置自 ${settings.effectiveDate || "现在"} 起生效。`;
    }
  }

  function auditValueText(value) {
    if (value === null || value === undefined || value === "") return "空";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function renderChangeLogs() {
    const container = $("#recentChangeLogs");
    if (!container) return;
    const labels = {
      dailyTasks: "核心任务",
      "record.studyHours": "学习时长",
      "record.taskRate": "任务完成率",
      "record.review": "错题复盘",
      "record.routine": "规律作息",
      "record.exercise": "运动",
      "record.honesty": "诚信记录",
      "record.notes": "学习备注",
      "sleepRecords.sleepTime": "实际入睡时间",
      "sleepRecords.wakeTime": "次日起床时间"
    };
    const logs = (Array.isArray(state.changeLogs) ? state.changeLogs : [])
      .filter((entry) => entry && entry.field && entry.changedAt)
      .slice(-8)
      .reverse();
    container.innerHTML = logs.length
      ? logs.map((entry) => `<div class="change-log-item"><strong>${escapeHtml(entry.date)} · ${escapeHtml(labels[entry.field] || entry.field)}</strong><span>${escapeHtml(auditValueText(entry.before))} → ${escapeHtml(auditValueText(entry.after))}</span><small>${escapeHtml(new Date(entry.changedAt).toLocaleString("zh-CN"))}</small></div>`).join("")
      : '<p class="empty-log">暂无解锁后的关键修改记录。</p>';
  }

  function initializeQualityFields() {
    $("#qualityFields").innerHTML = qualityConfig.map((item) => `
      <div class="quality-item" data-quality="${item.key}">
        <div class="quality-head"><strong>${item.label}</strong><span>${item.weight} 分</span></div>
        <div class="segment" role="group" aria-label="${item.label}">
          ${[0, 50, 100].map((value, index) => `<button type="button" data-value="${value}" class="${qualityValues[item.key] === value ? "active" : ""}">${item.descriptions[index]}</button>`).join("")}
        </div>
      </div>`).join("");
    $all(".quality-item .segment button").forEach((button) => {
      button.addEventListener("click", () => {
        const item = button.closest(".quality-item");
        qualityValues[item.dataset.quality] = Number(button.dataset.value);
        item.querySelectorAll("button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
        updateLiveScore();
      });
    });
  }

  function formRecord() {
    const date = $("#checkinDate").value;
    return recordWithRoutineForDate(state, {
      date: $("#checkinDate").value,
      studyHours: Number($("#studyHours").value),
      taskRate: Number($("#taskRate").value),
      review: qualityValues.review,
      exercise: qualityValues.exercise,
      honesty: qualityValues.honesty,
      notes: $("#notes").value.trim()
    }, date);
  }
  function scoreLevel(score) {
    if (score >= 90) return ["非常出色", "今天的节奏与质量都很扎实，记得把状态延续到整周。"];
    if (score >= 85) return ["状态很好", "距离满额周奖励很近，再检查一项可改进的细节。"];
    if (score >= 75) return ["稳步推进", "基础奖励比例已达 75%，补齐短板会更接近目标。"];
    if (score >= 60) return ["仍可补强", "先守住核心任务，再从复盘与作息中找回节奏。"];
    return ["及时调整", "如实记录就是重新出发的第一步，明天从一个小目标开始。"];
  }
  function updateLiveScore() {
    const record = formRecord();
    const result = E.calculateDailyScore(record);
    const position = E.getPosition(record.date || plan.today, state.startDate);
    const estimate = E.dailyRewardEstimate(result.score, position.week);
    const level = scoreLevel(result.score);
    $("#taskValue").textContent = `${record.taskRate}%`;
    $("#noteCount").textContent = $("#notes").value.length;
    $("#liveScore").textContent = Math.round(result.score);
    $("#liveRing").style.setProperty("--score", result.score);
    $("#liveLevel").textContent = level[0];
    $("#liveMessage").textContent = level[1];
    $("#liveReward").textContent = money(estimate, 2);
    const labels = { study: "学习时长", task: "任务完成", review: "错题复盘", routine: "规律作息", exercise: "适度运动", honesty: "诚信记录" };
    const maxima = { study: 25, task: 30, review: 15, routine: 10, exercise: 10, honesty: 10 };
    $("#scoreBreakdown").innerHTML = Object.keys(labels).map((key) => `<div class="break-row"><span>${labels[key]}</span><div class="microbar"><span style="width:${result.parts[key] / maxima[key] * 100}%"></span></div><strong>${result.parts[key]}</strong></div>`).join("");
    reconcileAllowanceForCurrentDate();
  }

  function setForm(record) {
    const target = record || { date: plan.today, studyHours: 8, taskRate: 85, review: 100, routine: 100, exercise: 50, honesty: 100, notes: "" };
    $("#checkinDate").value = target.date;
    $("#studyHours").value = target.studyHours;
    $("#taskRate").value = target.taskRate;
    $("#notes").value = target.notes || "";
    qualityConfig.forEach((item) => {
      qualityValues[item.key] = Number(target[item.key]);
      const container = document.querySelector(`[data-quality="${item.key}"]`);
      if (container) container.querySelectorAll("button").forEach((button) => button.classList.toggle("active", Number(button.dataset.value) === qualityValues[item.key]));
    });
    renderSleepRecord(target.date);
    updateLiveScore();
  }

  function goTo(viewName) {
    $all(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
    $all(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
    const titles = {
      dashboard: "把每一天的努力，变成看得见的奖励。",
      checkin: "今天的记录，会成为明天的底气。",
      stages: "看清节奏，也守住每一阶段的预算。",
      history: "复盘每一天，找到真正有效的进步。",
      settings: "规则透明，奖励才更有力量。"
    };
    $("#pageTitle").textContent = titles[viewName];
    document.body.classList.remove("menu-open");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (viewName === "dashboard") requestAnimationFrame(drawScoreChart);
    if (viewName === "history") requestAnimationFrame(drawHistoryCharts);
  }

  function renderHeader() {
    const pos = plan.currentPosition;
    const formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
    $("#todayLabel").textContent = formatter.format(new Date());
    $("#phaseChip strong").textContent = `第 ${pos.stage.id} 阶段 · 第 ${pos.weekInStage} 周`;
    const spent = plan.projectedTotal;
    $("#sideProgress").style.width = `${Math.min(spent / E.TOTAL_BUDGET * 100, 100)}%`;
    $("#sideBudgetText").textContent = `已计入 ${money(spent)} · 剩余 ${money(plan.remainingBudget)}`;
  }

  function renderDashboard() {
    const todayRecord = plan.records.find((record) => record.date === plan.today);
    const todayScore = todayRecord ? todayRecord.score : 0;
    const dailyEstimate = todayRecord ? E.dailyRewardEstimate(todayScore, plan.currentPosition.week) : 0;
    const currentWeek = plan.currentWeek;
    const currentStage = plan.stages[plan.currentPosition.stage.id - 1];
    $("#todayReward").textContent = dailyEstimate.toFixed(2);
    $("#todayStatus").textContent = todayRecord ? "已完成打卡" : "尚未打卡";
    $("#todayRewardHint").textContent = todayRecord ? `今日 ${todayScore} 分，已纳入本周奖励预估。` : "完成今天的记录，即可看到本周奖励贡献。";
    $("#todayScore").textContent = todayRecord ? Math.round(todayScore) : "—";
    $("#scoreRing").style.setProperty("--score", todayScore);
    const level = scoreLevel(todayScore);
    $("#scoreTitle").textContent = todayRecord ? level[0] : "等待记录";
    $("#scoreHint").textContent = todayRecord ? level[1] : "评分由学习时长、任务、复盘、作息、运动和诚信六项构成。";

    $("#weekReward").textContent = money(currentWeek ? currentWeek.totalReward : 0);
    $("#weekMeta").textContent = currentWeek && currentWeek.days ? `${currentWeek.days} 天打卡 · 平均 ${currentWeek.average} 分` : "本周尚无记录";
    $("#weekBar").style.width = `${currentWeek ? Math.min(currentWeek.totalReward / currentWeek.weeklyBudget * 100, 100) : 0}%`;
    $("#earnedTotal").textContent = money(plan.projectedTotal);
    $("#earnedMeta").textContent = `已结算 ${money(plan.settledTotal)}，含本周预估`;
    $("#earnedBar").style.width = `${plan.projectedTotal / E.TOTAL_BUDGET * 100}%`;
    $("#recoveryTotal").textContent = money(plan.totalPool);
    $("#recoveryMeta").textContent = plan.totalPool ? "后续优秀周可解锁" : "当前没有待补救奖励";
    $("#recoveryBar").style.width = `${Math.min(plan.totalPool / 300 * 100, 100)}%`;
    $("#remainingTotal").textContent = money(plan.remainingBudget);
    $("#remainingMeta").textContent = plan.remainingBudget < 400 ? "预算进入最后 20%" : "总预算安全";
    $("#remainingBar").style.width = `${plan.remainingBudget / E.TOTAL_BUDGET * 100}%`;

    $("#currentStageName").textContent = currentStage.stage.name;
    $("#currentWeekLabel").textContent = `第 ${plan.currentPosition.week} 周`;
    $("#stageEarned").textContent = money(currentStage.projectedEarned);
    $("#stageBudget").textContent = `/ ${money(currentStage.stage.budget)}`;
    $("#stagePercent").textContent = `${Math.round(currentStage.progress * 100)}%`;
    $("#stageBar").style.width = `${Math.min(currentStage.progress * 100, 100)}%`;
    $("#currentWeekScore").textContent = currentWeek && currentWeek.days ? currentWeek.average : "—";
    $("#currentWeekDays").textContent = `${currentWeek ? currentWeek.days : 0} / 7 天`;
    $("#currentStagePool").textContent = money(currentStage.projectedPool);
    $("#recoveryHint").textContent = currentWeek && currentWeek.eligible
      ? `本周已满足补救条件，预计额外释放 ${money(currentWeek.release)}。`
      : "本周达到 90 分且打卡至少 6 天，可释放补救池。";
    renderAlerts(currentStage);
    renderOvertimeReminder();
    renderRecentWeeks();
    requestAnimationFrame(drawScoreChart);
  }

  function renderAlerts(currentStage) {
    const alerts = [];
    if (plan.remainingBudget <= 400) alerts.push({ type: "", text: `提醒：总预算仅剩 ${money(plan.remainingBudget)}，请核对考试奖与目标奖状态。` });
    if (currentStage.remaining <= currentStage.stage.budget * 0.2) alerts.push({ type: "", text: `当前阶段预算剩余 ${money(currentStage.remaining)}，已进入最后 20%。` });
    if (!alerts.length) alerts.push({ type: "info", text: "数据仅保存在这台设备的当前浏览器中，建议每周导出一次 JSON 备份。" });
    $("#alertArea").innerHTML = alerts.map((alert) => `<div class="budget-alert ${alert.type}"><span>${alert.text}</span><button type="button" aria-label="关闭提醒">×</button></div>`).join("");
    $all("#alertArea button").forEach((button) => button.addEventListener("click", () => button.parentElement.remove()));
  }

  function renderRecentWeeks() {
    const end = Math.min(plan.currentPosition.week, 16);
    const start = Math.max(1, end - 3);
    const recent = plan.weeks.slice(start - 1, end);
    $("#recentWeeks").innerHTML = recent.map((week) => `<div class="week-mini ${week.status === "current" ? "current" : ""}"><div class="week-line"><span>第 ${week.week} 周</span><span>${week.status === "closed" ? "已结算" : "进行中"}</span></div><strong>${money(week.totalReward)}</strong><small>${week.days ? `均分 ${week.average} · ${week.days} 天` : "暂无打卡"}</small></div>`).join("");
  }

  function allInsightPoints() {
    return buildBoundedInsights(state, plan.today, state.startDate);
  }

  function recentInsightPoints() {
    return allInsightPoints().slice(-14);
  }

  function renderOvertimeReminder() {
    const reminder = $("#overtimeReminder");
    if (!reminder) return;
    const evidenced = allInsightPoints();
    while (evidenced.length && evidenced[evidenced.length - 1].overtime === null) evidenced.pop();
    const count = I.consecutiveOvertimeDays(evidenced);
    reminder.className = "overtime-reminder";
    reminder.textContent = "";
    if (count >= 3) {
      reminder.classList.add("prominent");
      reminder.innerHTML = `<strong>连续 ${count} 天娱乐超时，需要立即调整</strong><span>今晚请提前 15 分钟收尾，并把手机放到卧室外或够不到的位置。提醒只用于复盘，不会扣除美元奖励或娱乐额度。</span>`;
    } else if (count >= 1) {
      reminder.classList.add("reflection");
      reminder.innerHTML = `<strong>最近连续 ${count} 天娱乐超时</strong><span>花一分钟回想失控的触发点，今晚在收尾提醒响起时立刻结束。此提示不会改变奖励或额度。</span>`;
    }
  }

  function drawScoreChart() {
    const canvas = $("#scoreChart");
    if (!canvas || !canvas.offsetWidth) return;
    const ctx = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.offsetWidth, height = canvas.offsetHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
    const padding = { left: 34, right: 14, top: 12, bottom: 30 };
    const chartW = width - padding.left - padding.right, chartH = height - padding.top - padding.bottom;
    ctx.font = "10px Microsoft YaHei"; ctx.fillStyle = "#88918d"; ctx.strokeStyle = "#e5e8e2"; ctx.lineWidth = 1;
    [0, 20, 40, 60, 80, 100].forEach((value) => {
      const y = padding.top + chartH - value / 100 * chartH;
      ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
      ctx.fillText(String(value), 7, y + 3);
    });
    const dates = [];
    for (let i = 13; i >= 0; i -= 1) dates.push(E.toDateString(E.addDays(plan.today, -i)));
    const points = dates.map((date) => {
      const record = plan.records.find((item) => item.date === date);
      return record ? record.score : null;
    });
    const xAt = (index) => padding.left + index / (dates.length - 1) * chartW;
    const yAt = (score) => padding.top + chartH - score / 100 * chartH;
    ctx.save(); ctx.setLineDash([5, 5]); ctx.strokeStyle = "#e2aa47"; ctx.beginPath(); ctx.moveTo(padding.left, yAt(80)); ctx.lineTo(width - padding.right, yAt(80)); ctx.stroke(); ctx.restore();
    let drawing = false; ctx.strokeStyle = "#2d725e"; ctx.lineWidth = 2.4; ctx.lineJoin = "round"; ctx.beginPath();
    points.forEach((score, index) => { if (score === null) { drawing = false; return; } const x = xAt(index), y = yAt(score); if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y); }); ctx.stroke();
    points.forEach((score, index) => { if (score === null) return; ctx.beginPath(); ctx.fillStyle = "#fffefa"; ctx.strokeStyle = "#2d725e"; ctx.lineWidth = 2; ctx.arc(xAt(index), yAt(score), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
    ctx.fillStyle = "#88918d"; [0, 4, 9, 13].forEach((index) => { const date = E.parseLocalDate(dates[index]); ctx.fillText(`${date.getMonth() + 1}/${date.getDate()}`, xAt(index) - 10, height - 8); });
  }

  function drawHistoryCharts() {
    const points = recentInsightPoints();
    drawEntertainmentChart($("#entertainmentChart"), points);
    drawSleepChart($("#sleepChart"), points);
  }

  function renderStages() {
    $("#stageSummary").innerHTML = plan.stages.map((item) => {
      const isCurrent = item.stage.id === plan.currentPosition.stage.id;
      return `<article class="stage-card ${isCurrent ? "current" : ""}" style="--stage-color:${item.stage.color}"><div class="stage-top"><span>阶段 ${item.stage.id}</span><span>${item.completed ? "已结束" : isCurrent ? "进行中" : "待开始"}</span></div><h3>${item.stage.name}</h3><p>${item.stage.subtitle}</p><div class="budget-pair"><strong>${money(item.projectedEarned)}</strong><small>/ ${money(item.stage.budget)}</small></div><div class="microbar"><span style="width:${Math.min(item.progress * 100, 100)}%;background:${item.stage.color}"></span></div><div class="pool-label"><span>补救池</span><strong>${money(item.projectedPool)}</strong></div></article>`;
    }).join("");
    $("#weeklyTable").innerHTML = plan.weeks.map((week) => {
      const status = week.status === "future" ? ["待开始", ""] : week.status === "current" ? ["进行中", "warn"] : ["已结算", "good"];
      return `<tr><td><strong>第 ${week.week} 周</strong><br><small>${week.start.slice(5)} — ${week.end.slice(5)}</small></td><td>${week.stageName}</td><td>${week.days} 天</td><td>${week.days ? week.average : "—"}</td><td>${week.status === "future" ? "—" : `${Math.round(week.rate * week.coverage * 100)}%`}</td><td><strong>${money(week.baseReward)}</strong></td><td>${week.release ? `<strong>+${money(week.release)}</strong>` : "—"}</td><td><span class="status-tag ${status[1]}">${status[0]}</span></td></tr>`;
    }).join("");
    $("#examCompleted").checked = Boolean(state.examCompleted);
    $("#targetReached").checked = Boolean(state.targetReached);
  }

  function renderHistory() {
    const search = $("#historySearch").value.trim().toLowerCase();
    const stageFilter = $("#historyStage").value;
    const scoreFilter = $("#historyScore").value;
    const complianceFilter = $("#historyCompliance").value;
    const insightPoints = buildHistoryInsights(state, plan.records);
    const insightByDate = new Map(insightPoints.map((point) => [point.date, point]));
    const complianceFiltered = filterHistoryByCompliance(plan.records, insightPoints, complianceFilter);
    const filtered = complianceFiltered.filter((record) => {
      const stage = E.getPosition(record.date, state.startDate).stage.id;
      const searchOk = !search || (record.notes || "").toLowerCase().includes(search);
      const stageOk = stageFilter === "all" || Number(stageFilter) === stage;
      let scoreOk = true;
      if (scoreFilter === "90") scoreOk = record.score >= 90;
      if (scoreFilter === "80") scoreOk = record.score >= 80 && record.score < 90;
      if (scoreFilter === "below80") scoreOk = record.score < 80;
      return searchOk && stageOk && scoreOk;
    }).sort((a, b) => b.date.localeCompare(a.date));
    $("#historyList").innerHTML = filtered.map((record) => {
      const scoreClass = record.score >= 85 ? "" : record.score >= 70 ? "mid" : "low";
      const pos = E.getPosition(record.date, state.startDate);
      const insight = insightByDate.get(record.date) || { usedMinutes: null, overtime: null };
      const sleepRecord = state.sleepRecords && state.sleepRecords[record.date];
      const usedText = insight.usedMinutes === null ? "未记录" : `${insight.usedMinutes} 分钟`;
      const complianceText = insight.overtime === true ? "超时" : insight.overtime === false ? "按时" : "未记录";
      const complianceClass = insight.overtime === true ? "overtime" : insight.overtime === false ? "ontime" : "missing";
      const sleepText = sleepRecord && validTime(sleepRecord.sleepTime) ? sleepRecord.sleepTime : "未记录";
      const wakeText = sleepRecord && validTime(sleepRecord.wakeTime) ? sleepRecord.wakeTime : "未记录";
      return `<div class="history-item"><div class="history-date"><strong>${record.date.slice(5).replace("-", "月")}日</strong><small>第 ${pos.week} 周</small></div><div class="history-score ${scoreClass}">${Math.round(record.score)}</div><div class="history-note" title="${escapeHtml(record.notes || "无备注")}">${escapeHtml(record.notes || "无备注")}</div><div class="history-insight-grid"><div class="history-stat"><span>娱乐实际使用</span><strong>${usedText}</strong></div><div class="history-stat"><span>截止状态</span><strong class="compliance-text ${complianceClass}">${complianceText}</strong></div><div class="history-stat"><span>入睡</span><strong>${sleepText}</strong></div><div class="history-stat"><span>次日起床</span><strong>${wakeText}</strong></div></div><div class="history-actions"><button class="icon-button edit-record" data-id="${record.id}">编辑</button><button class="icon-button delete delete-record" data-id="${record.id}">删除</button></div></div>`;
    }).join("");
    $("#historyEmpty").style.display = filtered.length ? "none" : "block";
    $all(".edit-record").forEach((button) => button.addEventListener("click", () => editRecord(button.dataset.id)));
    $all(".delete-record").forEach((button) => button.addEventListener("click", () => deleteRecord(button.dataset.id)));
    requestAnimationFrame(drawHistoryCharts);
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
  function editRecord(id) { const record = state.records.find((item) => item.id === id); if (record) { setForm(record); goTo("checkin"); } }
  function deleteRecord(id) {
    const record = state.records.find((item) => item.id === id);
    if (!record) return;
    askConfirm("删除这条记录？", `${record.date} 的打卡将被删除，奖励统计也会重新计算。`, () => {
      if (persist({ ...state, records: state.records.filter((item) => item.id !== id) }, "记录已删除，奖励已重新计算")) closeConfirm();
    });
  }

  function renderAll() {
    $("#planStartDate").value = state.startDate;
    const endDate = E.toDateString(E.addDays(state.startDate, 111));
    $("#checkinDate").min = state.startDate;
    $("#checkinDate").max = endDate;
    renderRoutineSettings();
    renderHeader(); renderDashboard(); renderStages(); renderHistory();
    renderDailyTasks(currentDailyDate());
    renderSleepRecord(currentDailyDate());
    renderAllowance();
    renderChangeLogs();
    const clearSampleButton = $("#clearSampleData");
    if (clearSampleButton) clearSampleButton.hidden = !isIdentifiableDemoState(state);
  }

  function submitCheckin(event) {
    event.preventDefault();
    const record = formRecord();
    if (!record.date) return showToast("请选择打卡日期");
    const calculated = E.calculateDailyScore(record);
    const existingIndex = state.records.findIndex((item) => item.date === record.date);
    const saved = Object.assign({}, record, { id: existingIndex >= 0 ? state.records[existingIndex].id : `record-${Date.now()}`, updatedAt: new Date().toISOString() });
    const records = state.records.slice();
    if (existingIndex >= 0) records[existingIndex] = saved; else records.push(saved);
    let nextState = { ...state, records };
    if (existingIndex >= 0) {
      const existing = state.records[existingIndex];
      const changedAt = new Date().toISOString();
      for (const field of ["studyHours", "taskRate", "review", "routine", "exercise", "honesty", "notes"]) {
        nextState = auditUnlockedChangeState(nextState, record.date, `record.${field}`, existing[field], saved[field], changedAt);
      }
    }
    if (persist(nextState, `已保存：今日 ${calculated.score} 分`)) {
      setForm(saved);
      goTo("dashboard");
    }
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function replaceAndRenderOnce(nextState, message) {
    const replacement = commitReplacementState(state, nextState, true, (key, value) => S.save(key, value));
    if (!replacement.ok) {
      showToast("数据保存失败，当前数据未被替换");
      return false;
    }
    state = replacement.state;
    plan = E.calculatePlan(state);
    replacingImportedState = true;
    try {
      const todayRecord = state.records.find((record) => record && record.date === plan.today);
      setForm(todayRecord || undefined);
      renderAll();
    } finally {
      replacingImportedState = false;
    }
    if (message) showToast(message);
    return true;
  }

  function exportCsv() {
    downloadFile(`研途学习娱乐分析-${plan.today}.csv`, S.toCsvRows(state, plan), "text/csv;charset=utf-8");
    showToast("分析 CSV 已导出；完整恢复请使用 JSON 备份");
  }
  function exportJson() { downloadFile(`研途奖励册完整备份-${plan.today}.json`, JSON.stringify(state, null, 2), "application/json;charset=utf-8"); showToast("完整 JSON 备份已导出"); }
  function importJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        const validation = S.validateImport(imported);
        if (!validation.ok) throw new Error(validation.reason);
        askConfirm("确认导入完整备份？", `${buildImportPreview(validation.data)} 建议先备份当前数据。`, () => {
          if (replaceAndRenderOnce(validation.data, "完整数据导入成功")) closeConfirm();
        });
      } catch (error) { showToast(`无法导入：${error && error.message ? error.message : "文件格式不正确"}`); }
      $("#importJson").value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  function bindEvents() {
    $all(".nav-item").forEach((item) => item.addEventListener("click", () => goTo(item.dataset.view)));
    $all("[data-go]").forEach((button) => button.addEventListener("click", () => goTo(button.dataset.go)));
    $("#menuButton").addEventListener("click", () => document.body.classList.toggle("menu-open"));
    $("#taskRate").addEventListener("input", updateLiveScore); $("#studyHours").addEventListener("input", updateLiveScore); $("#notes").addEventListener("input", updateLiveScore);
    $("#checkinDate").addEventListener("change", () => {
      const date = $("#checkinDate").value;
      const existing = state.records.find((item) => item.date === date);
      setForm(existing || Object.assign(formRecord(), { date, notes: "" }));
      renderDailyTasks(date);
      renderAllowance();
    });
    $("#resetForm").addEventListener("click", () => setForm({ date: $("#checkinDate").value || plan.today, studyHours: 8, taskRate: 85, review: 100, routine: 100, exercise: 50, honesty: 100, notes: "" }));
    $("#checkinForm").addEventListener("submit", submitCheckin);
    $("#startEntertainment").addEventListener("click", startEntertainment);
    $("#pauseEntertainment").addEventListener("click", () => pauseEntertainment("manual"));
    $("#saveSleepRecord").addEventListener("click", () => saveSleepRecord(currentDailyDate(), {
      sleepTime: $("#sleepTime").value,
      wakeTime: $("#wakeTime").value
    }));
    $("#enableNotifications").addEventListener("click", async () => {
      if (!("Notification" in window)) return showEntertainmentNotice("当前浏览器不支持系统通知，仍会显示页面内提醒。");
      if (Notification.permission === "granted") return showEntertainmentNotice("提醒已经开启。");
      const permission = await Notification.requestPermission();
      showEntertainmentNotice(permission === "granted" ? "提醒已开启。" : "未获得通知权限，将只显示页面内提醒。");
    });
    $("#saveRoutineSettings").addEventListener("click", () => {
      const proposed = {
        reminderTime: $("#reminderTimeSetting").value,
        cutoffTime: $("#cutoffTimeSetting").value,
        sleepTarget: $("#sleepTargetSetting").value,
        wakeTarget: $("#wakeTargetSetting").value
      };
      const saved = saveRoutineSettingsState(state, localDateString(), proposed);
      if (!saved.ok) {
        $("#routineSettingsStatus").textContent = saved.reason;
        showToast("时间设置无效，原设置未改变");
        return;
      }
      const message = saved.appliesTomorrow ? "今天已有娱乐记录，新设置将从明天生效" : "时间设置已立即生效";
      if (persist(saved.state, message)) renderRoutineSettings();
    });
    ["historySearch","historyStage","historyScore","historyCompliance"].forEach((id) => $("#" + id).addEventListener(id === "historySearch" ? "input" : "change", renderHistory));
    $("#clearFilters").addEventListener("click", () => { $("#historySearch").value = ""; $("#historyStage").value = "all"; $("#historyScore").value = "all"; $("#historyCompliance").value = "all"; renderHistory(); });
    $("#examCompleted").addEventListener("change", (event) => {
      if (!persist({ ...state, examCompleted: event.target.checked }, event.target.checked ? "考试完成奖已计入" : "考试完成奖已取消")) event.target.checked = state.examCompleted;
    });
    $("#targetReached").addEventListener("change", (event) => {
      if (!persist({ ...state, targetReached: event.target.checked }, event.target.checked ? "目标达成奖已计入" : "目标达成奖已取消")) event.target.checked = state.targetReached;
    });
    $("#exportCsv").addEventListener("click", exportCsv); $("#exportJson").addEventListener("click", exportJson); $("#importJson").addEventListener("change", (event) => importJson(event.target.files[0]));
    $("#saveStartDate").addEventListener("click", () => {
      const nextDate = $("#planStartDate").value;
      if (!nextDate || nextDate === state.startDate) return showToast("起始日期没有变化");
      askConfirm("修改计划起始日期？", "所有现有记录的周次和阶段归属都会重新计算。", () => {
        if (persist({ ...state, startDate: nextDate }, "计划起始日期已更新")) closeConfirm();
      });
    });
    $("#clearSampleData").addEventListener("click", () => {
      if (!isIdentifiableDemoState(state)) return showToast("当前不是可识别的示例数据，未执行清空");
      askConfirm("清空示例数据？", "将移除系统示例并创建空白计划；不会删除浏览器内其他网站的数据。", () => {
        const cleared = clearedLocalState(state, new Date(), true);
        if (replaceAndRenderOnce(cleared.state, "示例数据已清空，可以开始正式计划")) closeConfirm();
      });
    });
    $("#clearAllData").addEventListener("click", () => askConfirm("清空全部本地数据？", ALL_DATA_CLEAR_MESSAGE, () => {
      const cleared = clearedLocalState(state, new Date(), true);
      if (replaceAndRenderOnce(cleared.state, "全部研途奖励册本地数据已清空")) closeConfirm();
    }));
    $("#restoreSample").addEventListener("click", () => askConfirm("恢复示例数据？", "当前记录将被系统示例替换。建议先导出 JSON 备份。", () => {
      const sample = S.migrate(E.createSampleData(), new Date());
      if (replaceAndRenderOnce(sample, "已恢复示例数据")) closeConfirm();
    }));
    $("#confirmCancel").addEventListener("click", closeConfirm); $("#confirmOk").addEventListener("click", () => { if (confirmAction) confirmAction(); });
    $("#confirmModal").addEventListener("click", (event) => { if (event.target === $("#confirmModal")) closeConfirm(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeConfirm(); document.body.classList.remove("menu-open"); } });
    document.addEventListener("visibilitychange", () => { if (document.hidden && activeEntertainmentSession()) pauseEntertainment("hidden"); });
    let resizeTimer; window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawScoreChart(); drawHistoryCharts(); }, 120); });
  }

  function boot() {
    initializeQualityFields();
    bindEvents();
    const activated = activateNextSettingsState(state, localDateString());
    if (activated !== state) saveQuietly(activated);
    applyDailyCutoff(new Date());
    const endDate = E.toDateString(E.addDays(state.startDate, 111));
    $("#checkinDate").min = state.startDate; $("#checkinDate").max = endDate;
    const todayExisting = state.records.find((record) => record.date === plan.today);
    setForm(todayExisting || undefined);
    renderAll();
    restoreActiveSession();
    entertainmentTimer = window.setInterval(renderAllowance, 1000);
  }
  boot();
})(typeof window !== "undefined" ? window : globalThis);
