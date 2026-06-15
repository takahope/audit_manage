/**
 * AuditCycle.js — 三年稽核週期的核心計算邏輯
 *
 * 設計原則：本檔案全部是純函式，不碰 SpreadsheetApp / CacheService，
 * 因此可以直接用 node 在本機跑邊界測試（見 test/audit-cycle.test.js）。
 *
 * 業務規則：
 * - 週期為「固定三年區段」：以 CYCLE_START_YEAR 為錨點，2026–2028 一輪、2029–2031 下一輪。
 * - ISO 認證駐站每年必稽，但在每輪週期中只有「第一筆」紀錄計入週期覆蓋；
 *   之後年度的稽核照常執行，只是不重複計算。
 * - 一般駐站在週期內有任一筆紀錄即視為本輪完成。
 */

/**
 * 計算指定年份所屬的固定週期區段。
 *
 * 用 floor 取整而非逐年比對，是為了讓任何年份（含錨點之前的回填資料）
 * 都能映射到正確的區段，不依賴列舉。
 *
 * @param {number} year - 西元年
 * @param {number} cycleStartYear - 週期錨定起始年（如 2026）
 * @param {number} cycleLengthYears - 週期長度（固定 3）
 * @returns {{start: number, end: number, years: number[]}}
 */
function getCycleForYear(year, cycleStartYear, cycleLengthYears) {
  const offset = Math.floor((year - cycleStartYear) / cycleLengthYears);
  const start = cycleStartYear + offset * cycleLengthYears;
  const years = [];
  for (let y = start; y < start + cycleLengthYears; y++) years.push(y);
  return { start: start, end: start + cycleLengthYears - 1, years: years };
}

/** 駐站在當年度的狀態鍵，前端據此渲染標籤與色條 */
const STATION_STATUS = {
  AUDITED_THIS_YEAR: 'AUDITED_THIS_YEAR', // 今年已稽核
  PENDING_AUDIT: 'PENDING_AUDIT',         // 待稽核（已分派人員與日期，尚未稽核）
  CANDIDATE: 'CANDIDATE',                 // 今年候選（可安排稽核）
  CYCLE_DONE: 'CYCLE_DONE',               // 固定模式：本週期已完成／滾動模式：三年效期內
};

/**
 * 計算單一駐站在「當年度 × 當週期」下的完整狀態。
 *
 * 認證駐站與一般駐站的差異全部集中在這裡，
 * 前端與 API 層只消費結果，不重複實作規則。
 *
 * @param {{code: string, isCertified: boolean}} station
 * @param {number[]} auditYears - 該站所有稽核紀錄的年份（不需排序）
 * @param {number} currentYear
 * @param {{start: number, end: number, years: number[]}} cycle - getCycleForYear 的結果
 * @param {string} [mode='FIXED'] - 'FIXED' 固定區段 / 'ROLLING' 滾動式
 * @returns {{
 *   auditedThisYear: boolean,
 *   countedInCycle: boolean,
 *   countedYear: number|null,
 *   dueYear: number|null,
 *   isCandidate: boolean,
 *   status: string,
 *   cycleAuditYears: number[]
 * }}
 */
function evaluateStation(station, auditYears, currentYear, cycle, mode) {
  if (mode === 'ROLLING') {
    return evaluateStationRolling_(station, auditYears, currentYear);
  }

  const cycleAuditYears = auditYears
    .filter(y => y >= cycle.start && y <= cycle.end)
    .sort((a, b) => a - b);

  const auditedThisYear = auditYears.indexOf(currentYear) !== -1;
  // 「計入週期」= 週期內最早的一筆；認證駐站之後年度的紀錄不再計入
  const countedYear = cycleAuditYears.length > 0 ? cycleAuditYears[0] : null;
  const countedInCycle = countedYear !== null;

  if (station.isCertified) {
    // 認證駐站：每年必稽，今年沒稽核就是候選，與週期覆蓋無關
    return {
      auditedThisYear: auditedThisYear,
      countedInCycle: countedInCycle,
      countedYear: countedYear,
      dueYear: null,
      isCandidate: !auditedThisYear,
      status: auditedThisYear ? STATION_STATUS.AUDITED_THIS_YEAR : STATION_STATUS.CANDIDATE,
      cycleAuditYears: cycleAuditYears,
    };
  }

  // 一般駐站：週期內稽核過一次即完成本輪
  let status;
  if (auditedThisYear) status = STATION_STATUS.AUDITED_THIS_YEAR;
  else if (countedInCycle) status = STATION_STATUS.CYCLE_DONE;
  else status = STATION_STATUS.CANDIDATE;

  return {
    auditedThisYear: auditedThisYear,
    countedInCycle: countedInCycle,
    countedYear: countedYear,
    dueYear: null,
    isCandidate: !countedInCycle,
    status: status,
    cycleAuditYears: cycleAuditYears,
  };
}

/**
 * 滾動模式的駐站狀態計算。
 *
 * 規則：每站以「上次稽核年＋3」為到期年（2026 稽核 → 2029 起再次成為候選）；
 * 從未稽核過 = 立即候選。認證駐站不受模式影響，仍為每年必稽。
 *
 * countedInCycle 在滾動模式下的語意是「目前在三年效期內」
 * （近三年含今年有紀錄），供覆蓋率與建議數共用同一欄位名稱，
 * 讓前端與 summary 不需要分流。
 *
 * @param {{code: string, isCertified: boolean}} station
 * @param {number[]} auditYears
 * @param {number} currentYear
 * @returns {Object} 結構與 evaluateStation 固定模式相同，另含 dueYear
 */
function evaluateStationRolling_(station, auditYears, currentYear) {
  const sorted = auditYears.slice().sort((a, b) => a - b);
  const auditedThisYear = auditYears.indexOf(currentYear) !== -1;
  const lastAuditYear = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const dueYear = lastAuditYear !== null ? lastAuditYear + 3 : null;
  // 三年效期內 = 上次稽核距今未滿 3 年（含今年稽核）
  const withinValidity = lastAuditYear !== null && currentYear < dueYear;
  const recentYears = sorted.filter(y => y > currentYear - 3 && y <= currentYear);

  if (station.isCertified) {
    return {
      auditedThisYear: auditedThisYear,
      countedInCycle: withinValidity,
      countedYear: lastAuditYear,
      dueYear: dueYear,
      isCandidate: !auditedThisYear,
      status: auditedThisYear ? STATION_STATUS.AUDITED_THIS_YEAR : STATION_STATUS.CANDIDATE,
      cycleAuditYears: recentYears,
    };
  }

  let status;
  if (auditedThisYear) status = STATION_STATUS.AUDITED_THIS_YEAR;
  else if (withinValidity) status = STATION_STATUS.CYCLE_DONE;
  else status = STATION_STATUS.CANDIDATE;

  return {
    auditedThisYear: auditedThisYear,
    countedInCycle: withinValidity,
    countedYear: lastAuditYear,
    dueYear: dueYear,
    isCandidate: !withinValidity,
    status: status,
    cycleAuditYears: recentYears,
  };
}

/**
 * 彙整全體駐站的週期進度與年度建議數量。
 *
 * 建議數量採「剩餘平均」而非「總數除以三」：
 * 若前兩年進度落後，第三年的建議數會自動補足到全部剩餘，
 * 確保任何時間點照建議執行都能在週期結束前完成。
 *
 * 滾動模式下沒有「週期結束年」的概念：countedInCycle 的語意是「三年效期內」，
 * 建議數＝今年已到期的一般駐站全部（不攤平），remainingYears 回傳 null 供前端隱藏。
 *
 * @param {Array<{isCertified: boolean, evaluation: Object}>} evaluatedStations
 * @param {number} currentYear
 * @param {{start: number, end: number}} cycle
 * @param {string} [mode='FIXED']
 * @returns {Object} 摘要物件，供前端週期總覽列使用
 */
function buildCycleSummary(evaluatedStations, currentYear, cycle, mode) {
  const isRolling = mode === 'ROLLING';
  const certified = evaluatedStations.filter(s => s.isCertified);
  const normal = evaluatedStations.filter(s => !s.isCertified);

  const countedTotal = evaluatedStations.filter(s => s.evaluation.countedInCycle).length;
  const remainingNormal = normal.filter(s => !s.evaluation.countedInCycle).length;
  const certifiedPendingThisYear = certified.filter(s => !s.evaluation.auditedThisYear).length;

  // 固定模式：剩餘年數至少為 1（當年度本身），避免除以零；滾動模式無此概念
  const remainingYears = isRolling ? null : Math.max(1, cycle.end - currentYear + 1);
  const suggestedNormal = isRolling ? remainingNormal : Math.ceil(remainingNormal / remainingYears);

  return {
    totalStations: evaluatedStations.length,
    certifiedCount: certified.length,
    normalCount: normal.length,
    countedInCycle: countedTotal,
    remainingNormal: remainingNormal,
    certifiedPendingThisYear: certifiedPendingThisYear,
    remainingYears: remainingYears,
    suggestedNormal: suggestedNormal,
    suggestedTotal: suggestedNormal + certifiedPendingThisYear,
    coveragePercent: evaluatedStations.length === 0
      ? 0
      : Math.round((countedTotal / evaluatedStations.length) * 100),
  };
}

/**
 * 計算單一駐站的稽核履歷摘要：累計次數、上次稽核年、是否逾期。
 *
 * 「逾期」= 從未稽核，或距上次稽核已滿三年（currentYear - lastAuditYear >= 3）。
 * 邊界與滾動模式的到期年（上次＋3）一致；此為事實陳述，
 * 與週期計算模式無關，兩種模式下都顯示。
 *
 * @param {number[]} auditYears - 該站所有稽核紀錄的年份（不需排序）
 * @param {number} currentYear
 * @returns {{auditCount: number, lastAuditYear: number|null, yearsSinceLast: number|null, isOverdue: boolean}}
 */
function buildAuditHistory(auditYears, currentYear) {
  const auditCount = auditYears.length;
  if (auditCount === 0) {
    return { auditCount: 0, lastAuditYear: null, yearsSinceLast: null, isOverdue: true };
  }
  const lastAuditYear = Math.max.apply(null, auditYears);
  const yearsSinceLast = currentYear - lastAuditYear;
  return {
    auditCount: auditCount,
    lastAuditYear: lastAuditYear,
    yearsSinceLast: yearsSinceLast,
    isOverdue: yearsSinceLast >= 3,
  };
}

// 供 node 本機測試使用；GAS 環境無 module 物件，此區塊不會執行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getCycleForYear, evaluateStation, buildCycleSummary, buildAuditHistory, STATION_STATUS };
}
