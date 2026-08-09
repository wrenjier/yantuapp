(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RewardStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    reminderTime: "22:15",
    cutoffTime: "22:30",
    sleepTarget: "23:00",
    wakeTarget: "07:00",
    nextSettings: null
  };
  const CSV_HEADERS = [
    "日期", "周次", "阶段", "学习时长", "任务完成率", "错题复盘", "规律作息", "运动", "诚信",
    "得分", "日奖励预估", "核心任务", "娱乐已解锁分钟", "娱乐已用分钟", "是否超时", "入睡时间", "起床时间", "备注"
  ];
  const OBJECT_MAP_COLLECTIONS = ["dailyTasks", "allowances", "sleepRecords"];
  const LIST_COLLECTIONS = ["sessions", "overrideLogs", "changeLogs"];
  const NUMERIC_RECORD_FIELDS = [
    "studyHours", "taskRate", "review", "routine", "routineCompliance", "exercise", "honesty", "score", "week"
  ];

  function dateString(now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function createEmptyData(now) {
    return {
      version: 2,
      startDate: dateString(now),
      records: [],
      examCompleted: false,
      targetReached: false,
      dailyTasks: {},
      allowances: {},
      sessions: [],
      sleepRecords: {},
      overrideLogs: [],
      changeLogs: [],
      settings: { ...DEFAULT_SETTINGS }
    };
  }

  function isLocalDate(value) {
    if (typeof value !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      || Boolean(prototype && prototype.constructor && prototype.constructor.name === "Object");
  }

  function hasOwn(raw, key) {
    return Object.prototype.hasOwnProperty.call(raw, key);
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function validTime(value) {
    if (typeof value !== "string") return false;
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
  }

  function timeMinutes(value) {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function validRoutineSettings(value, allowExtra) {
    if (!isPlainObject(value)) return false;
    const fields = ["reminderTime", "cutoffTime", "sleepTarget", "wakeTarget"];
    if (!fields.every((field) => hasOwn(value, field) && validTime(value[field]))) return false;
    if (!allowExtra && Object.keys(value).some((key) => !fields.includes(key))) return false;
    const reminder = timeMinutes(value.reminderTime);
    const cutoff = timeMinutes(value.cutoffTime);
    let sleep = timeMinutes(value.sleepTarget);
    let wake = timeMinutes(value.wakeTarget) + 1440;
    if (sleep < cutoff) sleep += 1440;
    if (wake <= sleep) wake += 1440;
    return reminder < cutoff && cutoff <= sleep && sleep < wake && wake - sleep <= 18 * 60;
  }

  function validIsoTimestamp(value) {
    if (typeof value !== "string") return false;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    return Boolean(match
      && isLocalDate(match[1])
      && Number(match[2]) <= 23
      && Number(match[3]) <= 59
      && (match[4] === undefined || Number(match[4]) <= 59)
      && Number.isFinite(Date.parse(value)));
  }

  function safeJsonValue(value, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    const visited = seen || new Set();
    if (visited.has(value)) return false;
    visited.add(value);
    let valid;
    if (Array.isArray(value)) valid = value.every((item) => safeJsonValue(item, visited));
    else valid = isPlainObject(value) && Object.keys(value).every((key) => safeJsonValue(value[key], visited));
    visited.delete(value);
    return valid;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function copyAuditValue(value) {
    return value === undefined ? null : cloneJson(value);
  }

  function failure(reason) {
    return { ok: false, reason };
  }

  function validateRecord(record) {
    if (!isPlainObject(record)) return "学习记录格式不正确";
    if (!isLocalDate(record.date)) return "学习记录日期格式不正确";
    for (const field of NUMERIC_RECORD_FIELDS) {
      if (hasOwn(record, field) && !isFiniteNumber(record[field])) return `学习记录 ${field} 必须是有限数字`;
    }
    for (const field of ["id", "notes"]) {
      if (hasOwn(record, field) && typeof record[field] !== "string") return `学习记录 ${field} 格式不正确`;
    }
    if (hasOwn(record, "updatedAt") && !validIsoTimestamp(record.updatedAt)) return "学习记录更新时间戳格式不正确";
    return null;
  }

  function validateDateMapKeys(map, label) {
    for (const date of Object.keys(map)) {
      if (!isLocalDate(date)) return `${label}包含无效日期键`;
    }
    return null;
  }

  function validateDailyTasks(map) {
    for (const [date, tasks] of Object.entries(map)) {
      if (!Array.isArray(tasks)) return `${date} 的核心任务必须是列表`;
      for (const task of tasks) {
        if (!isPlainObject(task)) return `${date} 的核心任务格式不正确`;
        if (hasOwn(task, "date") && (!isLocalDate(task.date) || task.date !== date)) return "核心任务日期不一致";
        if (typeof task.id !== "string" || !task.id.trim()) return "核心任务 id 为必填字符串";
        if (typeof task.text !== "string" || !task.text.trim()) return "核心任务内容为必填字符串";
        if (typeof task.completed !== "boolean") return "核心任务完成状态为必填布尔值";
        if (typeof task.outcome !== "string") return "核心任务成果为必填字符串";
        if (task.completed && !task.outcome.trim()) return "已完成核心任务必须填写成果";
        if (hasOwn(task, "completedAt") && task.completedAt !== null && !validIsoTimestamp(task.completedAt)) return "核心任务完成时间戳格式不正确";
      }
    }
    return null;
  }

  function validateSettingsSnapshot(snapshot) {
    return validRoutineSettings(snapshot, false) ? null : "时间设置快照必须完整且连贯";
  }

  function validateAllowances(map) {
    for (const [date, allowance] of Object.entries(map)) {
      if (!isPlainObject(allowance)) return `${date} 的娱乐额度格式不正确`;
      if (!isLocalDate(allowance.date) || allowance.date !== date) return "娱乐额度日期不一致";
      if (![0, 30, 60, 90].includes(allowance.unlockedMinutes)) return "娱乐解锁额度必须是 0、30、60 或 90 分钟";
      if (!isFiniteNumber(allowance.usedSeconds) || allowance.usedSeconds < 0) return "娱乐已使用秒数必须是非负有限数字";
      if (typeof allowance.expired !== "boolean") return "娱乐额度过期状态格式不正确";
      if (hasOwn(allowance, "cutoffTime") && !validTime(allowance.cutoffTime)) return "娱乐截止时间格式不正确";
      if (hasOwn(allowance, "settingsSnapshot")) {
        const error = validateSettingsSnapshot(allowance.settingsSnapshot);
        if (error) return error;
      }
    }
    return null;
  }

  function validateSessions(sessions) {
    let activeCount = 0;
    for (const session of sessions) {
      if (!isPlainObject(session)) return "娱乐会话格式不正确";
      if (typeof session.id !== "string" || !session.id) return "娱乐会话 id 格式不正确";
      if (!isLocalDate(session.date)) return "娱乐会话日期格式不正确";
      if (!validIsoTimestamp(session.startedAt)) return "娱乐会话开始时间戳格式不正确";
      if (dateString(new Date(session.startedAt)) !== session.date) return "娱乐会话开始时间与所属日期不一致";
      if (!isFiniteNumber(session.durationSeconds) || session.durationSeconds < 0) return "娱乐会话持续秒数必须是非负有限数字";
      const active = session.endedAt === null || session.endedAt === undefined;
      if (active) {
        activeCount += 1;
        if (session.durationSeconds !== 0) return "未结束娱乐会话的持续秒数必须为 0";
      } else {
        if (!validIsoTimestamp(session.endedAt)) return "娱乐会话结束时间戳格式不正确";
        const started = Date.parse(session.startedAt);
        const ended = Date.parse(session.endedAt);
        if (ended < started) return "娱乐会话结束时间不能早于开始时间";
        const actualSeconds = Math.floor((ended - started) / 1000);
        if (Math.abs(actualSeconds - session.durationSeconds) > 1) return "娱乐会话持续时间与时间戳不一致";
      }
      if (hasOwn(session, "deviceLabel") && typeof session.deviceLabel !== "string") return "娱乐会话设备名称格式不正确";
      if (hasOwn(session, "endReason") && session.endReason !== null && typeof session.endReason !== "string") return "娱乐会话结束原因格式不正确";
      if (hasOwn(session, "cutoffTime") && !validTime(session.cutoffTime)) return "娱乐会话截止时间格式不正确";
      if (hasOwn(session, "previousRemainingSeconds") && (!isFiniteNumber(session.previousRemainingSeconds) || session.previousRemainingSeconds < 0)) return "娱乐会话剩余秒数格式不正确";
      if (hasOwn(session, "notifiedAt") && session.notifiedAt !== null
        && (!Array.isArray(session.notifiedAt) || session.notifiedAt.some((value) => ![15, 5, 1].includes(value)))) return "娱乐会话提醒记录格式不正确";
      if (hasOwn(session, "settingsSnapshot")) {
        const error = validateSettingsSnapshot(session.settingsSnapshot);
        if (error) return error;
      }
    }
    return activeCount > 1 ? "不能同时存在多个未结束娱乐会话" : null;
  }

  function validateSleepRecords(map) {
    for (const [date, record] of Object.entries(map)) {
      if (!isPlainObject(record)) return `${date} 的作息记录格式不正确`;
      if (hasOwn(record, "date") && (!isLocalDate(record.date) || record.date !== date)) return "作息记录日期不一致";
      if (!hasOwn(record, "sleepTime") || !hasOwn(record, "wakeTime")
        || typeof record.sleepTime !== "string" || typeof record.wakeTime !== "string") return "作息记录必须包含入睡和起床时间字段";
      if (!record.sleepTime && !record.wakeTime) return "作息记录至少需要一个实际时间";
      for (const field of ["sleepTime", "wakeTime"]) {
        if (record[field] !== "" && !validTime(record[field])) return `作息记录 ${field} 时间格式不正确`;
      }
      for (const field of ["sleepTarget", "wakeTarget", "cutoffTime"]) {
        if (hasOwn(record, field) && !validTime(record[field])) return `作息记录 ${field} 时间格式不正确`;
      }
      for (const field of ["stopDelayMinutes", "routinePercent"]) {
        if (hasOwn(record, field) && (!isFiniteNumber(record[field]) || record[field] < 0)) return `作息记录 ${field} 必须是非负有限数字`;
      }
      for (const field of ["sleepOnTime", "wakeOnTime", "cutoffCompliant"]) {
        if (hasOwn(record, field) && typeof record[field] !== "boolean") return `作息记录 ${field} 格式不正确`;
      }
      if (hasOwn(record, "reason") && typeof record.reason !== "string") return "作息记录原因格式不正确";
      if (hasOwn(record, "updatedAt") && !validIsoTimestamp(record.updatedAt)) return "作息记录更新时间戳格式不正确";
      if (hasOwn(record, "settingsSnapshot")) {
        const error = validateSettingsSnapshot(record.settingsSnapshot);
        if (error) return error;
      }
    }
    return null;
  }

  function validateLogDateFields(entry, label) {
    for (const field of ["date", "effectiveDate", "queuedOnDate"]) {
      if (hasOwn(entry, field) && !isLocalDate(entry[field])) return `${label} ${field} 日期格式不正确`;
    }
    for (const field of ["createdAt", "changedAt", "updatedAt"]) {
      if (hasOwn(entry, field) && !validIsoTimestamp(entry[field])) return `${label} ${field} 时间戳格式不正确`;
    }
    return null;
  }

  function validateOverrideLogs(logs) {
    for (const entry of logs) {
      if (!isPlainObject(entry)) return "临时解锁日志格式不正确";
      const dateError = validateLogDateFields(entry, "临时解锁日志");
      if (dateError) return dateError;
      if (typeof entry.id !== "string" || !entry.id.trim()) return "临时解锁日志 id 为必填字符串";
      if (!isLocalDate(entry.date)) return "临时解锁日志日期为必填本地日期";
      if (typeof entry.reason !== "string" || !entry.reason.trim()) return "临时解锁日志原因不能为空";
      if (!validIsoTimestamp(entry.createdAt)) return "临时解锁日志创建时间戳为必填项";
      for (const field of ["durationMinutes", "unlockedMinutes"]) {
        if (hasOwn(entry, field) && (!isFiniteNumber(entry[field]) || entry[field] < 0)) return `临时解锁日志 ${field} 必须是非负有限数字`;
      }
      if (!hasOwn(entry, "durationMinutes") && !hasOwn(entry, "unlockedMinutes")) return "临时解锁日志必须包含持续或解锁分钟数";
    }
    return null;
  }

  function validateChangeLogs(logs) {
    for (const entry of logs) {
      if (!isPlainObject(entry)) return "修改日志格式不正确";
      const dateError = validateLogDateFields(entry, "修改日志");
      if (dateError) return dateError;
      if (entry.type === "routine-settings-effective") {
        if (!isLocalDate(entry.effectiveDate)) return "设置生效日志日期格式不正确";
        const error = validateSettingsSnapshot(entry.settingsSnapshot);
        if (error) return error;
        if (!validIsoTimestamp(entry.createdAt)) return "设置生效日志时间戳格式不正确";
      } else if (hasOwn(entry, "field") || hasOwn(entry, "changedAt")) {
        if (typeof entry.id !== "string" || !entry.id || !isLocalDate(entry.date)) return "审计修改日志标识或日期格式不正确";
        if (typeof entry.field !== "string" || !entry.field || !validIsoTimestamp(entry.changedAt)) return "审计修改日志字段或时间戳格式不正确";
        if (!hasOwn(entry, "before") || !hasOwn(entry, "after")) return "审计修改日志缺少修改前后值";
      } else if (["entertainment-reminder", "sleep-record-updated"].includes(entry.type)) {
        if (!isLocalDate(entry.date) || !validIsoTimestamp(entry.createdAt)) return "修改日志系统事件缺少日期或时间戳";
      } else {
        return "修改日志不符合支持的审计或系统事件契约";
      }
    }
    return null;
  }

  function validateSettings(settings) {
    if (!isPlainObject(settings)) return "设置格式不正确";
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    if (!validRoutineSettings(merged, true)) return "时间设置不连贯";
    if (hasOwn(settings, "effectiveDate") && !isLocalDate(settings.effectiveDate)) return "设置生效日期格式不正确";
    if (merged.nextSettings !== null) {
      if (!isPlainObject(merged.nextSettings) || !validRoutineSettings(merged.nextSettings, true)) return "次日时间设置不连贯";
      if (!isLocalDate(merged.nextSettings.queuedOnDate) || !isLocalDate(merged.nextSettings.effectiveDate)) return "次日设置日期格式不正确";
      if (merged.nextSettings.effectiveDate < merged.nextSettings.queuedOnDate) return "次日设置生效日期不能早于排队日期";
    }
    return null;
  }

  function migrate(raw, now) {
    if (!raw || !Array.isArray(raw.records) || !isLocalDate(raw.startDate)) throw new Error("记录列表格式不正确");
    const copied = cloneJson(raw);
    return {
      ...createEmptyData(now),
      ...copied,
      version: 2,
      dailyTasks: isPlainObject(copied.dailyTasks) ? copied.dailyTasks : {},
      allowances: isPlainObject(copied.allowances) ? copied.allowances : {},
      sessions: Array.isArray(copied.sessions) ? copied.sessions : [],
      sleepRecords: isPlainObject(copied.sleepRecords) ? copied.sleepRecords : {},
      overrideLogs: Array.isArray(copied.overrideLogs) ? copied.overrideLogs : [],
      changeLogs: Array.isArray(copied.changeLogs) ? copied.changeLogs : [],
      settings: { ...DEFAULT_SETTINGS, ...(isPlainObject(copied.settings) ? copied.settings : {}) }
    };
  }

  function validateImport(raw) {
    if (!isPlainObject(raw)) return failure("导入数据顶层格式不正确");
    if (hasOwn(raw, "version") && ![1, 2].includes(raw.version)) return failure("仅支持版本 1 或版本 2 数据");
    if (!isLocalDate(raw.startDate) || !Array.isArray(raw.records)) return failure("记录列表格式不正确");
    for (const record of raw.records) {
      const error = validateRecord(record);
      if (error) return failure(error);
    }
    for (const flag of ["examCompleted", "targetReached"]) {
      if (hasOwn(raw, flag) && typeof raw[flag] !== "boolean") return failure(`${flag} 必须是布尔值`);
    }
    for (const key of OBJECT_MAP_COLLECTIONS) {
      if (hasOwn(raw, key) && !isPlainObject(raw[key])) return failure("记录列表格式不正确");
    }
    for (const key of LIST_COLLECTIONS) {
      if (hasOwn(raw, key) && !Array.isArray(raw[key])) return failure("记录列表格式不正确");
    }

    const dailyTasks = raw.dailyTasks || {};
    const allowances = raw.allowances || {};
    const sleepRecords = raw.sleepRecords || {};
    for (const [map, label] of [[dailyTasks, "核心任务"], [allowances, "娱乐额度"], [sleepRecords, "作息记录"]]) {
      const error = validateDateMapKeys(map, label);
      if (error) return failure(error);
    }
    const validators = [
      () => validateDailyTasks(dailyTasks),
      () => validateAllowances(allowances),
      () => validateSessions(raw.sessions || []),
      () => validateSleepRecords(sleepRecords),
      () => validateOverrideLogs(raw.overrideLogs || []),
      () => validateChangeLogs(raw.changeLogs || []),
      () => validateSettings(hasOwn(raw, "settings") ? raw.settings : {})
    ];
    for (const validator of validators) {
      const error = validator();
      if (error) return failure(error);
    }
    if (!safeJsonValue(raw)) return failure("导入数据包含不能安全保存的字段");
    return { ok: true, data: migrate(raw) };
  }

  function appendChangeLog(state, entry) {
    if (!isPlainObject(state) || !isPlainObject(entry)) throw new TypeError("修改日志参数格式不正确");
    if (!isLocalDate(entry.date) || typeof entry.field !== "string" || !entry.field || !validIsoTimestamp(entry.changedAt)) {
      throw new TypeError("修改日志日期、字段或时间戳格式不正确");
    }
    const normalized = {
      id: typeof entry.id === "string" && entry.id
        ? entry.id
        : `change-${entry.date}-${entry.field}-${entry.changedAt}`,
      date: entry.date,
      field: entry.field,
      before: copyAuditValue(entry.before),
      after: copyAuditValue(entry.after),
      changedAt: entry.changedAt
    };
    return { ...state, changeLogs: (Array.isArray(state.changeLogs) ? state.changeLogs : []).concat(normalized) };
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    text = text.replace(/^(\s*)([=+\-@])/, "$1'$2");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function scoreRate(score) {
    if (score >= 90) return 1;
    if (score >= 85) return 0.9;
    if (score >= 75) return 0.75;
    if (score >= 60) return 0.5;
    return 0;
  }

  function csvWeekForDate(plan, date) {
    return (Array.isArray(plan && plan.weeks) ? plan.weeks : []).find((week) => week && week.start <= date && date <= week.end) || null;
  }

  function csvTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : []).map((task) => {
      const text = task && typeof task.text === "string" && task.text.trim() ? task.text.trim() : "未命名任务";
      const result = task && task.completed && typeof task.outcome === "string" && task.outcome.trim() ? task.outcome.trim() : "未完成";
      return `${text}：${result}`;
    }).join("；");
  }

  function csvOvertime(date, data, sessions, sleepRecord) {
    if (sleepRecord && (sleepRecord.cutoffCompliant === false || Number(sleepRecord.stopDelayMinutes) > 0)) return "是";
    let evidence = false;
    for (const session of sessions) {
      if (!session || !session.endedAt) continue;
      const cutoff = session.cutoffTime
        || session.settingsSnapshot && session.settingsSnapshot.cutoffTime
        || data.allowances && data.allowances[date] && data.allowances[date].cutoffTime;
      if (!validTime(cutoff)) continue;
      evidence = true;
      const [year, month, day] = date.split("-").map(Number);
      const [hours, minutes] = cutoff.split(":").map(Number);
      if (Date.parse(session.endedAt) > new Date(year, month - 1, day, hours, minutes).getTime()) return "是";
    }
    if (sleepRecord || evidence) return "否";
    return "未记录";
  }

  function toCsvRows(data, plan) {
    const source = isPlainObject(data) ? data : {};
    const dates = new Set();
    (Array.isArray(source.records) ? source.records : []).forEach((record) => record && isLocalDate(record.date) && dates.add(record.date));
    for (const key of ["dailyTasks", "allowances", "sleepRecords"]) {
      Object.keys(isPlainObject(source[key]) ? source[key] : {}).forEach((date) => isLocalDate(date) && dates.add(date));
    }
    (Array.isArray(source.sessions) ? source.sessions : []).forEach((session) => session && isLocalDate(session.date) && dates.add(session.date));
    const rows = Array.from(dates).sort().map((date) => {
      const original = (Array.isArray(source.records) ? source.records : []).find((record) => record && record.date === date) || {};
      const planned = (Array.isArray(plan && plan.records) ? plan.records : []).find((record) => record && record.date === date) || original;
      const week = csvWeekForDate(plan, date);
      const allowance = source.allowances && source.allowances[date] || {};
      const sessions = (Array.isArray(source.sessions) ? source.sessions : []).filter((session) => session && session.date === date);
      const sleepRecord = source.sleepRecords && source.sleepRecords[date] || null;
      const usedSeconds = isFiniteNumber(allowance.usedSeconds)
        ? allowance.usedSeconds
        : sessions.filter((session) => session.endedAt).reduce((sum, session) => sum + (isFiniteNumber(session.durationSeconds) ? session.durationSeconds : 0), 0);
      const dailyEstimate = week && isFiniteNumber(planned.score)
        ? Math.round((Number(week.weeklyBudget || 0) / 7 * scoreRate(planned.score) + Number.EPSILON) * 100) / 100
        : "";
      return [
        date, week ? week.week : "", week ? week.stageName : "", original.studyHours, original.taskRate,
        original.review, original.routine, original.exercise, original.honesty, planned.score, dailyEstimate,
        csvTasks(source.dailyTasks && source.dailyTasks[date]), allowance.unlockedMinutes,
        Math.round(usedSeconds / 6) / 10, csvOvertime(date, source, sessions, sleepRecord),
        sleepRecord && sleepRecord.sleepTime, sleepRecord && sleepRecord.wakeTime, original.notes || ""
      ];
    });
    return `\ufeff${[CSV_HEADERS].concat(rows).map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  }

  function load(key, now, storage) {
    try {
      const target = storage || globalThis.localStorage;
      const saved = target.getItem(key);
      return saved
        ? { ok: true, data: migrate(JSON.parse(saved), now) }
        : { ok: true, data: createEmptyData(now), empty: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function save(key, data, storage) {
    try {
      const target = storage || globalThis.localStorage;
      target.setItem(key, JSON.stringify(data));
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  return {
    DEFAULT_SETTINGS, CSV_HEADERS, createEmptyData, migrate, validateImport,
    appendChangeLog, toCsvRows, load, save
  };
});
