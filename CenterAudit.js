/**
 * CenterAudit.js — 中心層級稽核類型（類型 2～8）的週期與狀態計算
 *
 * 與 AuditCycle.js 相同原則：全部純函式、不碰 SpreadsheetApp，
 * 可用 node 直接測試（test/center-audit.test.js）。
 *
 * 八類稽核中只有類型 1（駐站收案作業）是逐駐站追蹤（AuditCycle.js 負責）；
 * 類型 2～8 為中心層級，每期執行一次，由本檔統一計算狀態。
 */

// node 測試環境需載入共用的週期函式；GAS 與瀏覽器預覽為全域共享，不會執行
if (typeof module !== 'undefined' && typeof getCycleForYear === 'undefined') {
  var getCycleForYear = require('./AuditCycle.js').getCycleForYear;
}

/**
 * 八類稽核類型定義。
 * frequency 決定 evaluateCenterType 的計算策略；STATION 由既有駐站儀表板處理。
 */
const AUDIT_TYPE_DEFS = [
  { id: 'STATION',  order: 1, name: '駐站收案作業',                                   frequency: 'STATION',   freqLabel: '每駐站三年一次' },
  { id: 'RECRUIT',  order: 2, name: '招募宣導及公眾溝通',                             frequency: 'TRIENNIAL', freqLabel: '每三年' },
  // 退出與再聯繫於 2024 年制度變更：2023 年（含）以前每半年、2024 年起每四個月。
  // eras 由新到舊排列；期別歸屬一律依「紀錄日期落在哪個年代」計算。
  { id: 'WITHDRAW', order: 3, name: '退出與再聯繫',                                   frequency: 'FOUR_MONTH', freqLabel: '每四個月',
    eras: [
      { fromYear: 2024, frequency: 'FOUR_MONTH' },
      { fromYear: null, frequency: 'HALF_YEAR' }, // null = 最早年代
    ] },
  { id: 'DEIDENT',  order: 4, name: '中心不可辨識個人之資料與檢體之處理作業及儲存',   frequency: 'YEARLY',    freqLabel: '每年' },
  { id: 'INFOSEC',  order: 5, name: '資安保護及其他資料庫管理事項',                   frequency: 'YEARLY',    freqLabel: '每年' },
  { id: 'DBUSE',    order: 6, name: '資料庫之運用',                                   frequency: 'YEARLY',    freqLabel: '每年' },
  { id: 'ORG',      order: 7, name: '組織與人員',                                     frequency: 'EVENT',     freqLabel: '事件觸發' },
  { id: 'ADHOC',    order: 8, name: '不定期稽核',                                     frequency: 'ADHOC',     freqLabel: '不定期' },
];

/** 觸發事由類別（類型 7 用） */
const TRIGGER_CATEGORIES = ['設置許可展延', '設置許可變更', '倫理委員會組成變動', '資料庫人員異動', '其他'];

/** 中心項目的本期狀態鍵 */
const CENTER_STATUS = {
  DONE: 'DONE',         // 本期已完成
  PLANNED: 'PLANNED',   // 已排定待稽核
  PENDING: 'PENDING',   // 本期應稽、尚未排定
  OVERDUE: 'OVERDUE',   // 已過期限仍未稽核
  UPCOMING: 'UPCOMING', // 尚未到期的未來期別（僅半年制子期別使用）
  NONE: 'NONE',         // 無待辦（事件觸發無未銷案、不定期）
};

/** 解析 'yyyy/MM/dd' 為 {year, month}；非法輸入回 null */
function parseDateParts(dateText) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(String(dateText || '').trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

/**
 * 解析觸發事件的銷案狀態。
 * 規則：存在「稽核日期 ≥ 事件日期」的類型 7 紀錄即視為已銷案
 * （yyyy/MM/dd 字串可直接以字典序比較）。
 *
 * @param {Array<{eventId, eventDate, category, description}>} triggerEvents
 * @param {string[]} auditDates - 類型 7 的稽核紀錄日期（yyyy/MM/dd）
 * @returns {Array} 各事件加上 {resolved, resolvedBy}
 */
function resolveTriggerEvents(triggerEvents, auditDates) {
  const sortedAudits = auditDates.slice().sort();
  return triggerEvents.map(function (event) {
    const resolvedBy = sortedAudits.find(d => d >= event.eventDate) || null;
    return Object.assign({}, event, { resolved: resolvedBy !== null, resolvedBy: resolvedBy });
  });
}

/**
 * 計算單一中心稽核類型的本期狀態。
 *
 * 所有頻率策略集中在此，回傳統一形狀的結果物件，
 * 前端用同一套卡片渲染器消費，不需依類型分流。
 *
 * @param {{id, frequency}} typeDef - AUDIT_TYPE_DEFS 成員
 * @param {string[]} recordDates - 該類型所有稽核紀錄日期（yyyy/MM/dd，不需排序）
 * @param {{plannedDate: string}|null} plan - 有效排程（每類型至多一筆）
 * @param {number} openTriggerCount - 未銷案觸發事件數（僅 EVENT 使用）
 * @param {{year: number, month: number}} today
 * @param {number} anchorYear - 固定模式錨定起始年（TRIENNIAL 用）
 * @param {string} mode - 'FIXED' | 'ROLLING'（TRIENNIAL 用）
 * @returns {{
 *   status: string, currentPeriodLabel: string, nextDueLabel: string,
 *   lastAuditDate: string|null, auditCount: number, countThisYear: number,
 *   periodsThisYear: Array|null, prevPeriodMissed: boolean,
 *   requiredThisYear: number, completedThisYear: number
 * }}
 */
function evaluateCenterType(typeDef, recordDates, plan, openTriggerCount, today, anchorYear, mode) {
  const sortedDates = recordDates.slice().sort();
  const lastAuditDate = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : null;
  const recordYears = sortedDates.map(d => parseDateParts(d)).filter(Boolean);
  const countThisYear = recordYears.filter(p => p.year === today.year).length;
  const planParts = plan ? parseDateParts(plan.plannedDate) : null;

  const base = {
    status: CENTER_STATUS.PENDING,
    currentPeriodLabel: today.year + ' 年',
    nextDueLabel: '',
    lastAuditDate: lastAuditDate,
    auditCount: sortedDates.length,
    countThisYear: countThisYear,
    periodsThisYear: null,
    prevPeriodMissed: false,
    requiredThisYear: 0,
    completedThisYear: countThisYear,
  };

  // 月份分段制（半年/四個月）共用同一套評估器，只差分段定義；
  // 頻率依「當年所屬年代」決定（如退出與再聯繫 2024 起改制）
  const effectiveFrequency = getFrequencyForYear(typeDef, today.year);
  if (MONTH_SEGMENTS[effectiveFrequency]) {
    return evaluateMonthSegments_(base, recordYears, planParts, today, MONTH_SEGMENTS[effectiveFrequency]);
  }

  const FREQUENCY_EVALUATORS = {
    YEARLY: evaluateYearly_,
    TRIENNIAL: evaluateTriennial_,
    EVENT: evaluateEvent_,
    ADHOC: evaluateAdhoc_,
  };
  const evaluator = FREQUENCY_EVALUATORS[typeDef.frequency];
  if (!evaluator) return base; // STATION 等不適用的類型

  return evaluator(base, recordYears, planParts, openTriggerCount, today, anchorYear, mode);
}

/**
 * 取得類型在指定年份的有效頻率。
 * 無 eras 的類型回傳固定頻率；有 eras 則取「fromYear ≤ year」中最新的年代
 * （fromYear 為 null 代表最早年代，涵蓋所有更早年份）。
 *
 * @param {{frequency: string, eras?: Array<{fromYear: number|null, frequency: string}>}} typeDef
 * @param {number} year
 * @returns {string} 頻率鍵
 */
function getFrequencyForYear(typeDef, year) {
  if (!typeDef.eras) return typeDef.frequency;
  const era = typeDef.eras.find(e => e.fromYear === null || year >= e.fromYear);
  return era ? era.frequency : typeDef.frequency;
}

/**
 * 計算單筆紀錄日期的期別歸屬標籤（依當時年代的分段制度）。
 * 例：WITHDRAW '2023/08/10' → '2023 下半年'；'2024/05/01' → '2024 第二期（5–8月）'。
 * 非分段制類型（每年/三年/事件/不定期）回傳 null。
 *
 * @param {Object} typeDef
 * @param {string} dateText - yyyy/MM/dd
 * @returns {string|null}
 */
function getPeriodLabelForDate(typeDef, dateText) {
  const parts = parseDateParts(dateText);
  if (!parts) return null;
  const segments = MONTH_SEGMENTS[getFrequencyForYear(typeDef, parts.year)];
  if (!segments) return null;
  const segment = segments.find(s => parts.month >= s.from && parts.month <= s.to);
  return segment ? parts.year + ' ' + segment.label : null;
}

/**
 * 展開類型的分段年代表（年代＋該年代的分段定義），供前端 modal
 * 即時計算所選日期的期別歸屬——GAS 部署環境前端沒有本檔，
 * 中繼資料須隨 dashboard 下發，確保前後端共用同一份規則。
 *
 * @param {Object} typeDef
 * @returns {Array<{fromYear: number|null, frequency: string, segments: Array}>|null} 非分段制回 null
 */
function getSegmentScheduleForType(typeDef) {
  const eras = typeDef.eras || [{ fromYear: null, frequency: typeDef.frequency }];
  const schedule = eras
    .filter(e => MONTH_SEGMENTS[e.frequency])
    .map(e => ({ fromYear: e.fromYear, frequency: e.frequency, segments: MONTH_SEGMENTS[e.frequency] }));
  return schedule.length > 0 ? schedule : null;
}

/** 年內分段定義：from/to 為月份（含）；新增分段頻率只需在此加定義 */
const MONTH_SEGMENTS = {
  HALF_YEAR: [
    { label: '上半年', from: 1, to: 6 },
    { label: '下半年', from: 7, to: 12 },
  ],
  FOUR_MONTH: [
    { label: '第一期（1–4月）', from: 1, to: 4 },
    { label: '第二期（5–8月）', from: 5, to: 8 },
    { label: '第三期（9–12月）', from: 9, to: 12 },
  ],
};

// ---- 每年 ----
function evaluateYearly_(base, recordYears, planParts, _triggers, today) {
  const doneThisYear = recordYears.some(p => p.year === today.year);
  const planThisYear = planParts && planParts.year === today.year;
  const hasOlderRecords = recordYears.some(p => p.year < today.year - 1);
  const doneLastYear = recordYears.some(p => p.year === today.year - 1);

  base.requiredThisYear = 1;
  base.completedThisYear = doneThisYear ? 1 : 0;
  // 曾有更早紀錄但去年漏稽才警示；全新導入（無任何歷史）不噪音
  base.prevPeriodMissed = hasOlderRecords && !doneLastYear;
  base.nextDueLabel = doneThisYear ? (today.year + 1) + ' 年' : today.year + ' 年內';
  base.status = doneThisYear ? CENTER_STATUS.DONE
    : planThisYear ? CENTER_STATUS.PLANNED
    : CENTER_STATUS.PENDING;
  return base;
}

// ---- 年內分段制（半年／四個月共用） ----
function evaluateMonthSegments_(base, recordYears, planParts, today, segments) {
  const currentIdx = segments.findIndex(s => today.month >= s.from && today.month <= s.to);
  const inSegment = (p, seg) => p.year === today.year && p.month >= seg.from && p.month <= seg.to;

  const periods = segments.map(function (seg, idx) {
    const done = recordYears.some(p => inSegment(p, seg));
    let status;
    if (done) status = CENTER_STATUS.DONE;
    else if (idx < currentIdx) status = CENTER_STATUS.OVERDUE;       // 已過的期別未稽
    else if (idx > currentIdx) status = CENTER_STATUS.UPCOMING;      // 還沒到的期別
    else status = (planParts && inSegment(planParts, seg)) ? CENTER_STATUS.PLANNED : CENTER_STATUS.PENDING;
    return { key: today.year + '-S' + (idx + 1), label: seg.label, status: status };
  });

  base.periodsThisYear = periods;
  base.requiredThisYear = segments.length;
  base.completedThisYear = periods.filter(p => p.status === CENTER_STATUS.DONE).length;
  base.currentPeriodLabel = today.year + ' 年' + segments[currentIdx].label;

  // 過期未稽優先呈現，避免「目前期別已完成」掩蓋先前期別漏稽
  const anyOverdue = periods.some(p => p.status === CENTER_STATUS.OVERDUE);
  base.status = anyOverdue ? CENTER_STATUS.OVERDUE : periods[currentIdx].status;

  if (periods[currentIdx].status === CENTER_STATUS.DONE) {
    base.nextDueLabel = currentIdx + 1 < segments.length
      ? today.year + ' 年' + segments[currentIdx + 1].label
      : (today.year + 1) + ' 年' + segments[0].label;
  } else {
    // 本期期限 = 當期最後一個月的最後一天（new Date(y, m, 0) 即 m 月底）
    const endMonth = segments[currentIdx].to;
    const lastDay = new Date(today.year, endMonth, 0).getDate();
    base.nextDueLabel = today.year + '/' + (endMonth < 10 ? '0' : '') + endMonth + '/' + lastDay + ' 前';
  }
  return base;
}

// ---- 每三年（跟隨全域模式與錨定年） ----
function evaluateTriennial_(base, recordYears, planParts, _triggers, today, anchorYear, mode) {
  const years = recordYears.map(p => p.year);
  const doneThisYear = years.indexOf(today.year) !== -1;

  if (mode === 'ROLLING') {
    const lastYear = years.length > 0 ? Math.max.apply(null, years) : null;
    const dueYear = lastYear !== null ? lastYear + 3 : null;
    const withinValidity = lastYear !== null && today.year < dueYear;
    base.currentPeriodLabel = '滾動三年';
    base.nextDueLabel = dueYear ? dueYear + ' 年前' : '尚未建立首次紀錄';
    base.requiredThisYear = withinValidity ? (doneThisYear ? 1 : 0) : 1;
    base.completedThisYear = doneThisYear ? 1 : 0;
    base.status = withinValidity ? CENTER_STATUS.DONE
      : planParts ? CENTER_STATUS.PLANNED
      : CENTER_STATUS.PENDING;
    return base;
  }

  const cycle = getCycleForYear(today.year, anchorYear, 3);
  const doneInCycle = years.some(y => y >= cycle.start && y <= cycle.end);
  const planInCycle = planParts && planParts.year >= cycle.start && planParts.year <= cycle.end;
  base.currentPeriodLabel = cycle.start + '–' + cycle.end;
  base.nextDueLabel = doneInCycle ? (cycle.end + 1) + '–' + (cycle.end + 3) : cycle.end + ' 年底前';
  base.requiredThisYear = doneInCycle ? (doneThisYear ? 1 : 0) : 1;
  base.completedThisYear = doneThisYear ? 1 : 0;
  base.status = doneInCycle ? CENTER_STATUS.DONE
    : planInCycle ? CENTER_STATUS.PLANNED
    : CENTER_STATUS.PENDING;
  return base;
}

// ---- 事件觸發 ----
function evaluateEvent_(base, recordYears, planParts, openTriggerCount, today) {
  base.requiredThisYear = openTriggerCount + base.completedThisYear;
  base.currentPeriodLabel = openTriggerCount > 0 ? '待辦 ' + openTriggerCount + ' 件' : '無待辦事由';
  base.nextDueLabel = openTriggerCount > 0 ? '有未銷案事由，需安排稽核' : '登記觸發事由後產生待辦';
  base.status = openTriggerCount === 0 ? CENTER_STATUS.NONE
    : planParts ? CENTER_STATUS.PLANNED
    : CENTER_STATUS.PENDING;
  return base;
}

// ---- 不定期 ----
function evaluateAdhoc_(base, recordYears, planParts, _triggers, today) {
  base.requiredThisYear = base.completedThisYear;
  base.currentPeriodLabel = '依指示執行';
  base.nextDueLabel = '無固定期限';
  base.status = planParts ? CENTER_STATUS.PLANNED : CENTER_STATUS.NONE;
  return base;
}

/**
 * 彙整中心稽核項目的年度統計（統計列四格）。
 *
 * @param {Array<{evaluation: Object, openTriggerCount: number}>} evaluatedTypes
 * @returns {{dueThisYear, doneThisYear, plannedCount, overdueOrTodoCount}}
 */
function buildCenterSummary(evaluatedTypes) {
  let dueThisYear = 0, doneThisYear = 0, plannedCount = 0, overdueOrTodoCount = 0;
  evaluatedTypes.forEach(function (t) {
    dueThisYear += t.evaluation.requiredThisYear;
    doneThisYear += t.evaluation.completedThisYear;
    if (t.evaluation.status === CENTER_STATUS.PLANNED) plannedCount++;
    if (t.evaluation.status === CENTER_STATUS.OVERDUE) overdueOrTodoCount++;
    overdueOrTodoCount += t.openTriggerCount || 0;
  });
  return {
    dueThisYear: dueThisYear,
    doneThisYear: doneThisYear,
    plannedCount: plannedCount,
    overdueOrTodoCount: overdueOrTodoCount,
  };
}

// 供 node 本機測試使用；GAS 環境無 module 物件，此區塊不會執行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AUDIT_TYPE_DEFS, TRIGGER_CATEGORIES, CENTER_STATUS,
    parseDateParts, resolveTriggerEvents, evaluateCenterType, buildCenterSummary,
    getFrequencyForYear, getPeriodLabelForDate, getSegmentScheduleForType,
  };
}
