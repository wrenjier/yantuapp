(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RewardEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STAGES = [
    { id: 1, name: "建立节奏", subtitle: "基础复习与稳定习惯", budget: 300, color: "#4f8a73" },
    { id: 2, name: "强化补弱", subtitle: "专项突破与阶段测试", budget: 450, color: "#d89a35" },
    { id: 3, name: "真题模考", subtitle: "真题训练与完整复盘", budget: 550, color: "#547f9f" },
    { id: 4, name: "冲刺稳定", subtitle: "查漏补缺与健康作息", budget: 500, color: "#cf715b" }
  ];
  const TOTAL_BUDGET = 2000;
  const EXAM_BONUS = 100;
  const TARGET_BONUS = 100;
  const DAY_MS = 86400000;

  function pad(value) { return String(value).padStart(2, "0"); }
  function toDateString(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
  function parseLocalDate(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const parts = String(value).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  function addDays(value, days) { const date = parseLocalDate(value); date.setDate(date.getDate() + days); return date; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
  function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
  function startOfToday(now) { const date = now ? new Date(now) : new Date(); return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }

  function calculateDailyScore(record) {
    const parts = {
      study: clamp(record.studyHours, 0, 8) / 8 * 25,
      task: clamp(record.taskRate, 0, 100) / 100 * 30,
      review: clamp(record.review, 0, 100) / 100 * 15,
      routine: clamp(record.routine, 0, 100) / 100 * 10,
      exercise: clamp(record.exercise, 0, 100) / 100 * 10,
      honesty: clamp(record.honesty, 0, 100) / 100 * 10
    };
    Object.keys(parts).forEach((key) => { parts[key] = Math.round(parts[key] * 10) / 10; });
    const score = Math.round(Object.values(parts).reduce((sum, value) => sum + value, 0) * 10) / 10;
    return { score, parts };
  }

  function withDerivedRoutine(record, compliance) {
    return Object.assign({}, record, { routine: clamp(compliance, 0, 100) });
  }

  function scoreRate(score) {
    if (score >= 90) return 1;
    if (score >= 85) return 0.9;
    if (score >= 75) return 0.75;
    if (score >= 60) return 0.5;
    return 0;
  }

  function getWeekNumber(dateValue, startDate) {
    const diff = Math.floor((parseLocalDate(dateValue) - parseLocalDate(startDate)) / DAY_MS);
    return Math.floor(diff / 7) + 1;
  }

  function getStageForWeek(weekNumber) {
    const safeWeek = clamp(weekNumber, 1, 16);
    return STAGES[Math.floor((safeWeek - 1) / 4)];
  }

  function getPosition(dateValue, startDate) {
    const rawWeek = getWeekNumber(dateValue, startDate);
    const week = clamp(rawWeek, 1, 16);
    return { rawWeek, week, stage: getStageForWeek(week), weekInStage: ((week - 1) % 4) + 1 };
  }

  function dailyRewardEstimate(score, weekNumber) {
    const stage = getStageForWeek(weekNumber);
    const weeklyBudget = stage.budget / 4;
    return roundMoney(weeklyBudget / 7 * scoreRate(score));
  }

  function calculatePlan(data, nowValue) {
    const today = startOfToday(nowValue);
    const todayString = toDateString(today);
    const startDate = data.startDate || todayString;
    const currentPosition = getPosition(todayString, startDate);
    const records = (data.records || []).map((record) => {
      const scoredRecord = Number.isFinite(Number(record.routineCompliance))
        ? withDerivedRoutine(record, record.routineCompliance)
        : record;
      const calculated = calculateDailyScore(scoredRecord);
      return Object.assign({}, scoredRecord, calculated, { week: getWeekNumber(record.date, startDate) });
    });
    const weeks = [];
    const stageState = STAGES.map((stage) => ({
      stage,
      settledEarned: 0,
      projectedEarned: 0,
      pool: 0,
      projectedPool: 0,
      released: 0,
      projectedReleased: 0
    }));

    for (let week = 1; week <= 16; week += 1) {
      const stage = getStageForWeek(week);
      const state = stageState[stage.id - 1];
      const weeklyBudget = stage.budget / 4;
      const weekStart = addDays(startDate, (week - 1) * 7);
      const weekEnd = addDays(weekStart, 6);
      const status = weekEnd < today ? "closed" : weekStart > today ? "future" : "current";
      const weekRecords = records.filter((record) => record.week === week);
      const days = weekRecords.length;
      const average = days ? Math.round(weekRecords.reduce((sum, record) => sum + record.score, 0) / days * 10) / 10 : 0;
      const rate = scoreRate(average);
      const coverage = Math.min(days / 5, 1);
      const baseReward = status === "future" ? 0 : roundMoney(weeklyBudget * rate * coverage);
      const eligible = average >= 90 && days >= 6;
      const availablePool = state.pool;
      const release = status === "future" || !eligible ? 0 : roundMoney(Math.min(availablePool, weeklyBudget * 0.25));
      const shortfall = roundMoney(weeklyBudget - baseReward);
      const totalReward = roundMoney(baseReward + release);

      if (status === "closed") {
        state.pool = roundMoney(Math.max(0, state.pool - release) + shortfall);
        state.projectedPool = state.pool;
        state.settledEarned = roundMoney(state.settledEarned + totalReward);
        state.projectedEarned = state.settledEarned;
        state.released = roundMoney(state.released + release);
        state.projectedReleased = state.released;
      } else if (status === "current") {
        state.projectedPool = roundMoney(Math.max(0, state.pool - release));
        state.projectedEarned = roundMoney(state.settledEarned + totalReward);
        state.projectedReleased = roundMoney(state.released + release);
      }

      weeks.push({
        week, stageId: stage.id, stageName: stage.name, weekInStage: ((week - 1) % 4) + 1,
        start: toDateString(weekStart), end: toDateString(weekEnd), status, records: weekRecords,
        days, average, rate, coverage, weeklyBudget, baseReward, release, shortfall, totalReward, eligible
      });
    }

    stageState.forEach((state) => {
      state.remaining = roundMoney(state.stage.budget - state.projectedEarned);
      state.progress = state.stage.budget ? state.projectedEarned / state.stage.budget : 0;
      const stageEnd = addDays(startDate, state.stage.id * 28 - 1);
      state.completed = stageEnd < today;
      state.lockedPool = state.completed ? state.pool : 0;
    });

    const bonusEarned = (data.examCompleted ? EXAM_BONUS : 0) + (data.targetReached ? TARGET_BONUS : 0);
    const settledProcess = roundMoney(stageState.reduce((sum, state) => sum + state.settledEarned, 0));
    const projectedProcess = roundMoney(stageState.reduce((sum, state) => sum + state.projectedEarned, 0));
    const totalPool = roundMoney(stageState.reduce((sum, state) => sum + state.projectedPool, 0));
    const settledTotal = roundMoney(settledProcess + bonusEarned);
    const projectedTotal = roundMoney(projectedProcess + bonusEarned);
    const remainingBudget = roundMoney(TOTAL_BUDGET - projectedTotal);
    const currentWeek = weeks.find((week) => week.status === "current") || weeks[currentPosition.week - 1];
    return {
      today: todayString, startDate, records, weeks, stages: stageState, currentPosition, currentWeek,
      bonusEarned, settledProcess, projectedProcess, settledTotal, projectedTotal, totalPool,
      remainingBudget, totalBudget: TOTAL_BUDGET
    };
  }

  function createSampleData(nowValue) {
    const today = startOfToday(nowValue);
    const startDate = toDateString(addDays(today, -12));
    const samples = [
      [5.0,60,50,100,50,100,"第一天重新整理计划，核心任务完成得不够稳定。"],
      [6.0,70,50,100,50,100,"完成数学基础题，找出两个容易混淆的公式。"],
      [6.5,75,100,100,100,100,"英语阅读正确率回升，长难句仍需复盘。"],
      [7.0,80,100,100,50,100,"专业课完成一章框架整理，按时结束娱乐。"],
      [5.0,60,50,50,0,100,"临时有事，只保住了一项核心任务。"],
      [7.0,80,100,100,50,100,"完成阶段小测，晚间娱乐略微超过截止时间。"],
      [6.5,75,50,100,50,100,"第一周复盘完成，明确了下周三个薄弱点。"],
      [8.0,100,100,100,100,100,"数学专项训练全部完成，错题已按原因分类。"],
      [8.0,100,100,100,100,100,"英语真题精读两篇，并复述每段主旨。"],
      [8.0,100,100,100,100,100,"专业课背诵与默写均达标，晚上没有娱乐。"],
      [8.0,100,100,50,100,100,"三项任务完成，但刷视频超过了约定截止时间。"],
      [8.0,100,100,50,100,100,"完成限时套题，晚间看小说忘记了时间。"],
      [8.0,100,100,50,100,100,"周复盘与补弱清单完成，游戏仍玩到了截止后。"]
    ];
    const completedCounts = [0, 1, 2, 3, 1, 2, 1, 3, 3, 3, 3, 3, 3];
    const unlockedMinutes = [0, 30, 60, 60, 30, 60, 30, 90, 90, 90, 90, 90, 90];
    const sessionTimes = [
      null, ["20:10", "20:30", "manual"], null, ["21:30", "22:30", "manual"],
      ["21:40", "22:05", "manual"], ["21:45", "22:35", "overtime"],
      ["20:20", "20:40", "manual"], ["20:30", "21:15", "manual"],
      ["20:50", "21:50", "manual"], null,
      ["21:50", "22:40", "overtime"], ["21:40", "22:38", "overtime"],
      ["21:55", "22:42", "overtime"]
    ];
    const defaultSettings = {
      reminderTime: "22:15", cutoffTime: "22:30", sleepTarget: "23:00", wakeTarget: "07:00"
    };
    function localIso(dateValue, time) {
      const date = parseLocalDate(dateValue);
      const parts = time.split(":").map(Number);
      date.setHours(parts[0], parts[1], 0, 0);
      return date.toISOString();
    }
    const records = samples.map((values, index) => ({
      id: `sample-${index + 1}`,
      date: toDateString(addDays(startDate, index)),
      studyHours: values[0], taskRate: values[1], review: values[2], routine: values[3],
      routineCompliance: values[3], exercise: values[4], honesty: values[5], notes: values[6],
      updatedAt: localIso(toDateString(addDays(startDate, index)), "20:00"), sample: true
    }));
    const dailyTasks = {};
    const allowances = {};
    const sessions = [];
    const sleepRecords = {};
    const taskTemplates = [
      ["数学核心训练", "完成 30 道题并订正 5 道错题"],
      ["英语阅读精练", "精读 2 篇文章并整理生词与长难句"],
      ["专业课框架复述", "闭卷复述 1 章框架并补齐遗漏知识点"]
    ];

    records.forEach((record, index) => {
      dailyTasks[record.date] = taskTemplates.map((template, taskIndex) => {
        const completed = taskIndex < completedCounts[index];
        return {
          id: `sample-task-${index + 1}-${taskIndex + 1}`,
          date: record.date,
          text: template[0],
          completed,
          outcome: completed ? template[1] : "",
          completedAt: completed ? localIso(record.date, `${18 + taskIndex}:00`) : null,
          sample: true
        };
      });

      const sessionSpec = sessionTimes[index];
      let usedSeconds = 0;
      if (sessionSpec) {
        const startedAt = localIso(record.date, sessionSpec[0]);
        const endedAt = localIso(record.date, sessionSpec[1]);
        usedSeconds = Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
        sessions.push({
          id: `sample-session-${index + 1}`,
          date: record.date,
          deviceLabel: "手机手动账本",
          startedAt,
          endedAt,
          durationSeconds: usedSeconds,
          endReason: sessionSpec[2],
          cutoffTime: "22:30",
          settingsSnapshot: { ...defaultSettings },
          previousRemainingSeconds: Math.max(0, unlockedMinutes[index] * 60 - usedSeconds),
          notifiedAt: [],
          sample: true
        });
      }
      allowances[record.date] = {
        id: `sample-allowance-${index + 1}`,
        date: record.date,
        unlockedMinutes: unlockedMinutes[index],
        usedSeconds,
        expired: true,
        cutoffTime: "22:30",
        settingsSnapshot: { ...defaultSettings },
        sample: true
      };

      if (index !== 2) {
        const partialSleep = index === 4;
        const partialWake = index === 6;
        const overtime = index >= 10;
        sleepRecords[record.date] = {
          id: `sample-sleep-${index + 1}`,
          date: record.date,
          sleepTime: partialWake ? "" : overtime ? "23:35" : index === 5 ? "23:10" : "22:55",
          wakeTime: partialSleep ? "" : overtime ? "07:20" : "06:55",
          cutoffTime: "22:30",
          sleepTarget: "23:00",
          wakeTarget: "07:00",
          cutoffCompliant: !overtime && index !== 5,
          stopDelayMinutes: overtime ? [10, 8, 12][index - 10] : index === 5 ? 5 : 0,
          sleepOnTime: !overtime && index !== 5 && !partialWake,
          wakeOnTime: !overtime && !partialSleep,
          routinePercent: record.routineCompliance,
          reason: partialSleep || partialWake ? "示例：尚有一项作息时间待补录" : overtime ? "示例：娱乐截止后仍继续使用手机" : "示例：按计划结束并完成作息记录",
          updatedAt: localIso(record.date, "23:50"),
          settingsSnapshot: { ...defaultSettings },
          sample: true
        };
      }
    });

    return {
      version: 2,
      sampleData: "kaoyan-v2-two-week",
      startDate,
      records,
      examCompleted: false,
      targetReached: false,
      dailyTasks,
      allowances,
      sessions,
      sleepRecords,
      overrideLogs: [],
      changeLogs: [],
      settings: { ...defaultSettings, nextSettings: null }
    };
  }

  return {
    STAGES, TOTAL_BUDGET, EXAM_BONUS, TARGET_BONUS,
    toDateString, parseLocalDate, addDays, calculateDailyScore, withDerivedRoutine, scoreRate, getWeekNumber,
    getStageForWeek, getPosition, dailyRewardEstimate, calculatePlan, createSampleData, roundMoney
  };
});
