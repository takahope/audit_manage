/**
 * AuditCycle.js — 三年稽核週期的核心計算邏輯
 *
 * 設計原則：本檔案全部是純函式，不碰 SpreadsheetApp / CacheService，
 * 因此可以直接用 node 在本機跑邊界測試（見 test/audit-cycle.test.js）。
 *
 * 業務規則：
 * - 一般駐站：固定三年區段（CYCLE_START_YEAR 為錨點，2026–2028、2029–2031…），
 *   區段內有任一筆紀錄即視為本輪完成。
 * - ISO 認證駐站：兩年排程輪（每年只稽部分家數），輪內每家稽一次；覆蓋率仍併入
 *   三年總覽、每家只計一次（去重），第三年不重複計入。見 evaluateStationFor_。
 * - 認證身分帶「生效年度」（certifiedSince）：升認證前（還是一般站時）的稽核只進
 *   三年總覽、不進兩年排程輪——身分是隨時間改變的事實，而非套用到全部歷史的快照。
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
 * 認證／一般駐站在此採同一套「本輪覆蓋」判定，差異只在呼叫端傳入的 cycle 長度
 * （認證站傳兩年排程輪、一般站傳三年週期），不再有「每年必稽」特例。
 *
 * @param {{code: string, isCertified: boolean}} station
 * @param {number[]} auditYears - 該站所有稽核紀錄的年份（不需排序）
 * @param {number} currentYear
 * @param {{start: number, end: number, years: number[]}} cycle - getCycleForYear 的結果
 * @param {string} [mode='FIXED'] - 'FIXED' 固定區段 / 'ROLLING' 滾動式
 * @param {number} [validityYears=3] - 滾動模式的到期年距（認證站排程傳 2）
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
function evaluateStation(station, auditYears, currentYear, cycle, mode, validityYears) {
  if (mode === 'ROLLING') {
    return evaluateStationRolling_(station, auditYears, currentYear, validityYears);
  }

  const cycleAuditYears = auditYears
    .filter(y => y >= cycle.start && y <= cycle.end)
    .sort((a, b) => a - b);

  const auditedThisYear = auditYears.indexOf(currentYear) !== -1;
  // 「計入週期」= 本輪內最早的一筆；同一輪內重複稽核不再計入（去重）
  const countedYear = cycleAuditYears.length > 0 ? cycleAuditYears[0] : null;
  const countedInCycle = countedYear !== null;

  // 認證與一般共用：本輪稽核過一次即完成本輪
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
 * 依駐站類型套用對應週期，產出供前端／summary 消費的單一 evaluation。
 *
 * - 一般站：只用三年總覽週期；scheduleCovered 等同 countedInCycle。
 * - 認證站：算兩份 —— 三年總覽（取 countedInCycle/countedYear 供覆蓋率，去重，用全部紀錄）＋
 *   兩年排程輪（取 status/isCandidate/dueYear 供卡片狀態與建議）。
 *   如此認證站在三年週期內已稽過就算覆蓋（第三年不重複），
 *   但兩年新一輪仍會被排入年度建議。
 *   兩年排程輪只納入 station.certifiedSince（含）起的稽核紀錄，升認證前的不算；
 *   certifiedSince 為 0/未定義時不過濾（生效年未知 fallback，等同現狀）。
 *
 * @param {{code: string, isCertified: boolean, certifiedSince?: number}} station
 * @param {number[]} auditYears
 * @param {number} currentYear
 * @param {{start, end}} normalCycle - 三年總覽週期
 * @param {{start, end}} certifiedCycle - 兩年排程輪
 * @param {string} [mode='FIXED']
 * @returns {Object} 單一 evaluation，含 countedInCycle（三年）與 scheduleCovered（排程輪）
 */
function evaluateStationFor_(station, auditYears, currentYear, normalCycle, certifiedCycle, mode) {
  if (station.isOutsourced) {
    const auditedThisYear = auditYears.indexOf(currentYear) !== -1;
    return {
      status: auditedThisYear ? STATION_STATUS.AUDITED_THIS_YEAR : STATION_STATUS.NOT_AUDITED,
      countedInCycle: false,
      countedYear: null,
      scheduleCovered: false,
      lastAuditYear: auditYears.length > 0 ? Math.max.apply(null, auditYears) : null
    };
  }
  const triEval = evaluateStation(station, auditYears, currentYear, normalCycle, mode, 3);
  if (!station.isCertified) {
    triEval.scheduleCovered = triEval.countedInCycle;
    return triEval;
  }
  // 兩年排程輪只認可「認證生效年度起」的稽核紀錄；升認證前（還是一般站時）的紀錄
  // 只進三年總覽、不進兩年輪。certifiedSince 為 0/未定義時不過濾（生效年未知 fallback，等同現狀）。
  const certifiedSince = station.certifiedSince || 0;
  const certYears = auditYears.filter(y => y >= certifiedSince);
  const biEval = evaluateStation(station, certYears, currentYear, certifiedCycle, mode, 2);
  // 卡片狀態／候選／到期年用兩年排程輪；覆蓋率欄位用三年總覽（去重）
  biEval.countedInCycle = triEval.countedInCycle;
  biEval.countedYear = triEval.countedYear;
  biEval.scheduleCovered = (biEval.status === STATION_STATUS.AUDITED_THIS_YEAR || biEval.status === STATION_STATUS.CYCLE_DONE);
  return biEval;
}

/**
 * 滾動模式的駐站狀態計算。
 *
 * 規則：每站以「上次稽核年＋效期」為到期年（一般站 +3、認證站排程 +2）；
 * 從未稽核過 = 立即候選。認證／一般採同一套邏輯，差異只在 validityYears。
 *
 * countedInCycle 在滾動模式下的語意是「目前在效期內」
 * （近 validityYears 年含今年有紀錄），供覆蓋率與建議數共用同一欄位名稱，
 * 讓前端與 summary 不需要分流。
 *
 * @param {{code: string, isCertified: boolean}} station
 * @param {number[]} auditYears
 * @param {number} currentYear
 * @param {number} [validityYears=3] - 到期年距（認證站排程傳 2）
 * @returns {Object} 結構與 evaluateStation 固定模式相同，另含 dueYear
 */
function evaluateStationRolling_(station, auditYears, currentYear, validityYears) {
  if (station.isOutsourced) {
    const auditedThisYear = auditYears.indexOf(currentYear) !== -1;
    return {
      status: auditedThisYear ? STATION_STATUS.AUDITED_THIS_YEAR : STATION_STATUS.NOT_AUDITED,
      countedInCycle: false,
      countedYear: null,
      scheduleCovered: false,
      dueYear: null,
      lastAuditYear: auditYears.length > 0 ? Math.max.apply(null, auditYears) : null
    };
  }
  const validity = validityYears || 3;
  const sorted = auditYears.slice().sort((a, b) => a - b);
  const auditedThisYear = auditYears.indexOf(currentYear) !== -1;
  const lastAuditYear = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const dueYear = lastAuditYear !== null ? lastAuditYear + validity : null;
  // 效期內 = 上次稽核距今未滿 validity 年（含今年稽核）
  const withinValidity = lastAuditYear !== null && currentYear < dueYear;
  const recentYears = sorted.filter(y => y > currentYear - validity && y <= currentYear);

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
 * 兩個維度分離：
 * - **覆蓋率**（countedTotal / coveragePercent）：所有站（含認證）併入同一個三年總覽，
 *   以各站 evaluation.countedInCycle（三年口徑、每家只計一次）計算。
 * - **年度建議**：一般站以三年週期攤平、認證站以兩年排程輪攤平（各自 ceil 剩餘 / 剩餘年數），
 *   認證站用 evaluation.scheduleCovered（兩年口徑）判定本輪是否已覆蓋。
 *
 * 建議數量採「剩餘平均」而非「總數除以週期長度」：若前期落後，最後一年自動補足到全部剩餘，
 * 確保任何時間點照建議執行都能在該輪結束前完成。
 *
 * 滾動模式下沒有「週期結束年」概念：建議＝今年已到期者全部（不攤平），remainingYears 回 null。
 *
 * @param {Array<{isCertified: boolean, evaluation: Object}>} evaluatedStations
 * @param {number} currentYear
 * @param {{start: number, end: number}} normalCycle - 一般站三年總覽週期
 * @param {{start: number, end: number}} certifiedCycle - 認證站兩年排程輪
 * @param {string} [mode='FIXED']
 * @returns {Object} 摘要物件，供前端週期總覽列使用
 */
function buildCycleSummary(evaluatedStations, currentYear, normalCycle, certifiedCycle, mode) {
  const isRolling = mode === 'ROLLING';
  const certified = evaluatedStations.filter(s => s.isCertified && !s.isOutsourced);
  const normal = evaluatedStations.filter(s => !s.isCertified && !s.isOutsourced);

  // 覆蓋率：全站三年總覽口徑（認證去重，每家一次）
  const countedTotal = evaluatedStations.filter(s => s.evaluation.countedInCycle).length;
  const remainingNormal = normal.filter(s => !s.evaluation.countedInCycle).length;
  // 認證建議：兩年排程輪口徑（scheduleCovered=false 表本輪未稽）
  const certifiedRemaining = certified.filter(s => !s.evaluation.scheduleCovered).length;
  // 今年仍待稽的認證家數（統計顯示用）
  const certifiedPendingThisYear = certified.filter(s => !s.evaluation.auditedThisYear).length;

  // 固定模式：剩餘年數至少為 1（當年度本身），避免除以零；滾動模式無此概念
  const remainingYears = isRolling ? null : Math.max(1, normalCycle.end - currentYear + 1);
  const certifiedRemainingYears = isRolling ? null : Math.max(1, certifiedCycle.end - currentYear + 1);
  const suggestedNormal = isRolling ? remainingNormal : Math.ceil(remainingNormal / remainingYears);
  const suggestedCertified = isRolling ? certifiedRemaining : Math.ceil(certifiedRemaining / certifiedRemainingYears);

  return {
    totalStations: evaluatedStations.length,
    certifiedCount: certified.length,
    normalCount: normal.length,
    countedInCycle: countedTotal,
    remainingNormal: remainingNormal,
    certifiedRemaining: certifiedRemaining,
    certifiedPendingThisYear: certifiedPendingThisYear,
    remainingYears: remainingYears,
    suggestedNormal: suggestedNormal,
    suggestedCertified: suggestedCertified,
    suggestedTotal: suggestedNormal + suggestedCertified,
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

/**
 * 計算單一駐站有效的「認證次數」（規格 4.3）。
 *
 * 一段認證任期（since～until 區間，until 為 null/未定義視為至今）內，
 * 必須至少有一筆稽核紀錄的年度落在區間內，才算一次「有效認證」。
 * 與本系統認證有效性的核心精神一致——認證需有稽核佐證，空有任期不計次。
 *
 * @param {Array<{since: number, until: (number|null)}>} tenures - 認證任期清單
 * @param {number[]} auditYears - 該站所有稽核年份（不需排序）
 * @returns {number} 有效認證次數
 */
function countValidCertifications_(tenures, auditYears) {
  if (!Array.isArray(tenures) || tenures.length === 0) return 0;
  const years = Array.isArray(auditYears) ? auditYears : [];
  return tenures.filter(function (t) {
    const since = Number(t.since) || 0;
    const until = (t.until === null || t.until === undefined) ? Infinity : Number(t.until);
    return years.some(function (y) { return y >= since && y <= until; });
  }).length;
}

// 供 node 本機測試使用；GAS 環境無 module 物件，此區塊不會執行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getCycleForYear, evaluateStation, evaluateStationFor_, buildCycleSummary, buildAuditHistory, countValidCertifications_, STATION_STATUS };
}
