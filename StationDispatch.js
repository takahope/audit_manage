/**
 * StationDispatch.js — twCohort 駐站調派紀錄的正規化與日期契約
 *
 * 設計原則：本檔案全部是純函式，不碰 SpreadsheetApp / CacheService，
 * 可直接用 node 在本機跑單元測試（見 test/station-dispatch.test.js）。
 */

/**
 * 驗證是否為合法四位數西元年度（2000–2100）
 *
 * @param {string|number} value - 待驗證年度
 * @returns {boolean}
 */
function isStationDispatchYear(value) {
  return Number.isInteger(Number(value)) && /^\d{4}$/.test(String(value)) && Number(value) >= 2000 && Number(value) <= 2100;
}

/**
 * 驗證 ISO 8601 日期格式（YYYY-MM-DD）且符合真實日曆日
 *
 * @private
 * @param {string} value - 待驗證日期字串
 * @returns {boolean}
 */
function validDispatchDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 正規化單筆駐站調派紀錄
 *
 * @param {Object} raw - 來源物件（twCohort C 欄 JSON 解析後）
 * @returns {Object|null} 正規化後的紀錄物件，若資料不合法或非「有效」則回傳 null
 */
function normalizeStationDispatchRecord(raw) {
  if (!raw || raw.status !== '有效' || !String(raw.id || '').trim()) return null;
  const startDate = String(raw.startDate || raw.workDate || '').trim();
  const endDate = String(raw.endDate || startDate).trim();
  const stationCode = String(raw.stationCode || '').trim().toUpperCase();
  const originalStationCode = String(raw.originalStationCode || '').trim().toUpperCase();
  if (!stationCode || !validDispatchDate_(startDate) || !validDispatchDate_(endDate) || endDate < startDate) return null;
  const nurseName = String(raw.nurseName || '').trim();
  const assignmentStatus = String(raw.assignmentStatus || '').trim();
  return {
    id: String(raw.id).trim(),
    stationCode: stationCode,
    originalStationCode: originalStationCode,
    startDate: startDate,
    endDate: endDate,
    nurseName: nurseName,
    nurseEmail: String(raw.nurseEmail || '').trim(),
    startTime: String(raw.startTime || '').trim(),
    endTime: String(raw.endTime || '').trim(),
    shiftName: String(raw.shiftName || '').trim(),
    hours: Number(raw.hours) || 0,
    note: String(raw.note || '').trim(),
    demandCount: Math.max(1, Number(raw.demandCount) || 1),
    isPending: assignmentStatus === '待指派' || nurseName === '待指派',
    isTemporary: Boolean(originalStationCode && originalStationCode !== stationCode)
  };
}

/**
 * 檢查調派紀錄區間是否與指定年度重疊
 *
 * @param {Object} record - 正規化後的調派紀錄
 * @param {number|string} year - 檢查年度（西元年）
 * @returns {boolean}
 */
function overlapsStationDispatchYear(record, year) {
  return record.startDate <= year + '-12-31' && record.endDate >= year + '-01-01';
}

// 供 node 本機測試使用；GAS 環境無 module 物件，此區塊不會執行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeStationDispatchRecord,
    isStationDispatchYear,
    overlapsStationDispatchYear
  };
}
