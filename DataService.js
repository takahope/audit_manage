/**
 * DataService.js — 資料存取層
 *
 * 職責：
 * - 跨試算表讀取 HR_managerv3 的駐站清單（含 ISO 旗標）與駐站成員
 * - 讀取外部「認證駐站紀錄」表，彙整每家認證任期與生效年度（認證身分真相來源）
 * - 讀寫本系統的稽核紀錄工作表
 *
 * 規範：
 * - 讀取一律用 getDisplayValues()（避免 ID/年度被 Sheets 自動轉型、Date 序列化問題）
 * - 過濾關鍵欄為空的列（曾編輯後清除的殘留空行）
 * - 寫入後強制 SpreadsheetApp.flush()
 */

// =============================================
// 試算表取得
// =============================================

/**
 * 取得 HR_managerv3 試算表（駐站與人事資料來源）。
 * @returns {Spreadsheet}
 */
function getHrSpreadsheet_() {
  const id = String(ENV.HR_SPREADSHEET_ID || '').trim();
  if (!id || id === 'YOUR_HR_SPREADSHEET_ID_HERE') {
    throw new Error('尚未設定 HR 試算表 ID，請在 env.js 的 ENV.HR_SPREADSHEET_ID 填入 HR_managerv3 試算表 ID');
  }
  return SpreadsheetApp.openById(id);
}

/**
 * 取得稽核紀錄試算表。
 * 優先使用 env.js 指定的 ID，未設定則退回本專案綁定的容器試算表。
 * @returns {Spreadsheet}
 */
function getAuditSpreadsheet_() {
  const id = String(ENV.AUDIT_SPREADSHEET_ID || '').trim();
  if (id) return SpreadsheetApp.openById(id);

  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (!bound) {
    throw new Error('本專案未綁定試算表，且 env.js 的 ENV.AUDIT_SPREADSHEET_ID 為空。請新建一個空白試算表並填入其 ID');
  }
  return bound;
}

/**
 * 取得外部「認證駐站紀錄」試算表（認證身分真相來源）。
 * @returns {Spreadsheet|null} 未設定 ISO_STATION_SPREADSHEET_ID 時回 null（呼叫端退回 I 欄判定）
 */
function getCertSpreadsheet_() {
  const id = String(ENV.ISO_STATION_SPREADSHEET_ID || '').trim();
  if (!id) return null;
  return SpreadsheetApp.openById(id);
}

/**
 * 讀取工作表的資料列（去表頭、過濾關鍵欄為空的列）。
 *
 * @param {Spreadsheet} ss
 * @param {string} sheetName
 * @param {number} keyColIndex - 用來判斷空列的欄位索引（0-based）
 * @returns {string[][]}
 */
function getSheetRows_(ss, sheetName, keyColIndex) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('找不到工作表「' + sheetName + '」，請確認試算表 ID 與工作表名稱');
  }
  const rows = sheet.getDataRange().getDisplayValues();
  return rows.slice(1).filter(row => String(row[keyColIndex] || '').trim() !== '');
}

// =============================================
// HR 資料：駐站清單與成員（含快取）
// =============================================

/**
 * 取得所有駐站節點（含 ISO 認證旗標）。
 *
 * 駐站清單異動頻率低且跨試算表讀取較慢，使用 CacheService 快取
 * 以降低每次開啟頁面的延遲。
 *
 * @returns {Array<{code, name, alias, managerEmail, managerName, isCertified}>}
 */
function getStations() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.STATIONS);
  if (cached) return JSON.parse(cached);

  const rows = getSheetRows_(getHrSpreadsheet_(), SHEET_NAMES.ORG, COL.ORG.CODE);
  const stations = rows
    .filter(row => isStationCode_(row[COL.ORG.CODE]))
    .map(rowToStation_);

  // 認證身分真相來源：設定了外部認證紀錄表就以任期覆寫 I 欄判定並帶入生效年度；
  // 未設定則維持 rowToStation_ 的 I 欄 'V' 判定（certifiedSince=0，兩年輪不過濾）。
  if (String(ENV.ISO_STATION_SPREADSHEET_ID || '').trim()) {
    const tenures = getCertifiedTenures();
    stations.forEach(st => {
      const t = tenures[st.code];
      st.isCertified = !!(t && t.isCertified);
      st.certifiedSince = t ? t.certifiedSince : 0;
      st.certifiedTenures = t ? t.tenures : [];
    });
  }

  cache.put(CACHE_KEYS.STATIONS, JSON.stringify(stations), ENV.CACHE_TTL_SEC);
  return stations;
}

function isStationCode_(code) {
  return String(code || '').trim().toUpperCase().indexOf(ENV.STATION_CODE_PREFIX) === 0;
}

function rowToStation_(row) {
  return {
    code: String(row[COL.ORG.CODE]).trim(),
    name: row[COL.ORG.NAME] || '',
    alias: row[COL.ORG.ALIAS] || '',
    managerEmail: row[COL.ORG.MANAGER_EMAIL] || '',
    managerName: row[COL.ORG.MANAGER_NAME] || '',
    isCertified: isCertifiedMark_(row[COL.ORG.ISO_FLAG]),
    certifiedSince: 0, // 預設不過濾兩年輪；設定外部認證表時由 getStations 覆寫
  };
}

/**
 * I 欄判定統一入口：'V' / 'v' / 前後含空白皆視為認證。
 * 集中在此，未來若標記規則改變只需改這裡。
 */
function isCertifiedMark_(value) {
  return String(value || '').trim().toUpperCase() === String(ENV.CERTIFIED_MARK).toUpperCase();
}

/**
 * 從日期顯示字串抽出西元年；無法解析回 0。
 * getDisplayValues() 結果可能為 2025-01-01 / 2025/1/1 / 2025 等格式，一律取首個四位數年份。
 */
function parseYear_(value) {
  const m = String(value || '').match(/\d{4}/);
  return m ? Number(m[0]) : 0;
}

/**
 * 讀取外部「認證駐站紀錄」表，彙整每家駐站的認證任期（含快取）。
 *
 * 認證身分以「指定時間～換掉時間」區間記錄：換掉時間（E 欄）為空 = 當前認證站，
 * 指定時間（D 欄）年份 = 認證生效年度。同站多筆 = 多段任期（曾認證→取消→再認證），
 * 當前任期取換掉時間為空那筆（多筆開放取最新生效年）。
 *
 * 未設定 ISO_STATION_SPREADSHEET_ID 時回空物件（呼叫端退回 I 欄 'V' 判定）。
 *
 * @returns {Object} { 駐站代碼: { isCertified, certifiedSince, tenures: Array<{since, until}> } }
 */
function getCertifiedTenures() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.CERT_TENURES);
  if (cached) return JSON.parse(cached);

  const ss = getCertSpreadsheet_();
  const result = {};
  if (ss) {
    const rows = getSheetRows_(ss, SHEET_NAMES.CERT_RECORDS, COL.CERT_RECORD.STATION_CODE);
    rows.forEach(row => {
      const code = String(row[COL.CERT_RECORD.STATION_CODE] || '').trim();
      if (!code) return;
      const since = parseYear_(row[COL.CERT_RECORD.ASSIGNED_DATE]);
      const removedText = String(row[COL.CERT_RECORD.REMOVED_DATE] || '').trim();
      const until = removedText ? parseYear_(removedText) : null; // null = 仍在認證
      if (!result[code]) result[code] = { isCertified: false, certifiedSince: 0, tenures: [] };
      result[code].tenures.push({ since: since, until: until });
    });

    // 由任期推導當前身分：有一筆 until 為 null（仍在認證）即為當前認證站
    Object.keys(result).forEach(code => {
      const open = result[code].tenures.filter(t => t.until === null);
      if (open.length > 0) {
        result[code].isCertified = true;
        result[code].certifiedSince = Math.max.apply(null, open.map(t => t.since || 0));
      }
    });
  }

  cache.put(CACHE_KEYS.CERT_TENURES, JSON.stringify(result), ENV.CACHE_TTL_SEC);
  return result;
}

/**
 * 取得駐站成員對照表：{ 駐站代碼: [{name, email, title}] }。
 * @returns {Object}
 */
function getStationMembersMap() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.MEMBERS);
  if (cached) return JSON.parse(cached);

  const rows = getSheetRows_(getHrSpreadsheet_(), SHEET_NAMES.ASSIGNMENT, COL.ASSIGNMENT.EMAIL);
  const membersMap = {};
  rows.forEach(row => {
    const orgCode = String(row[COL.ASSIGNMENT.ORG_CODE] || '').trim();
    if (!isStationCode_(orgCode)) return;
    if (!membersMap[orgCode]) membersMap[orgCode] = [];
    membersMap[orgCode].push({
      name: row[COL.ASSIGNMENT.NAME] || '',
      email: row[COL.ASSIGNMENT.EMAIL] || '',
      title: row[COL.ASSIGNMENT.TITLE] || '',
    });
  });

  cache.put(CACHE_KEYS.MEMBERS, JSON.stringify(membersMap), ENV.CACHE_TTL_SEC);
  return membersMap;
}

/**
 * 取得稽核人員名單。
 *
 * 判定條件：人員職務配置中「所屬組別代碼 = TF-ISPI-GRP-AUDIT 且 職稱 = 稽核員」。
 * 條件集中於 isAuditor_，未來規則改變（如增列組長）只需改一處。
 *
 * @returns {Array<{name, email}>}
 */
function getAuditors() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.AUDITORS);
  if (cached) return JSON.parse(cached);

  const rows = getSheetRows_(getHrSpreadsheet_(), SHEET_NAMES.ASSIGNMENT, COL.ASSIGNMENT.EMAIL);
  const auditors = rows
    .filter(isAuditor_)
    .map(row => ({
      name: row[COL.ASSIGNMENT.NAME] || '',
      email: String(row[COL.ASSIGNMENT.EMAIL] || '').trim().toLowerCase(),
    }));

  cache.put(CACHE_KEYS.AUDITORS, JSON.stringify(auditors), ENV.CACHE_TTL_SEC);
  return auditors;
}

function isAuditor_(assignmentRow) {
  const orgCode = String(assignmentRow[COL.ASSIGNMENT.ORG_CODE] || '').trim().toUpperCase();
  const title = String(assignmentRow[COL.ASSIGNMENT.TITLE] || '').trim();
  return orgCode === ENV.AUDIT_TEAM.ORG_CODE && title === ENV.AUDIT_TEAM.MEMBER_TITLE;
}

// =============================================
// 稽核分派：讀取與寫入
// =============================================

/**
 * 取得所有稽核分派紀錄。
 * @returns {Array<{stationCode, stationName, year, auditorNames, auditorEmails, plannedDate, recorder, recordedAt}>}
 */
function getAssignments() {
  const rows = getSheetRows_(getAuditSpreadsheet_(), SHEET_NAMES.AUDIT_PLANS, COL.PLAN.STATION_CODE);
  return rows
    .map(row => ({
      stationCode: String(row[COL.PLAN.STATION_CODE]).trim(),
      stationName: row[COL.PLAN.STATION_NAME] || '',
      year: Number(row[COL.PLAN.YEAR]),
      auditorNames: row[COL.PLAN.AUDITOR_NAMES] || '',
      auditorEmails: row[COL.PLAN.AUDITOR_EMAILS] || '',
      plannedDate: row[COL.PLAN.PLANNED_DATE] || '',
      recorder: row[COL.PLAN.RECORDER] || '',
      recordedAt: row[COL.PLAN.RECORDED_AT] || '',
      calendarEventId: String(row[COL.PLAN.CALENDAR_EVENT_ID] || '').trim(),
    }))
    .filter(plan => !isNaN(plan.year) && plan.year > 0);
}

/**
 * 批次寫入稽核分派，同站同年採 upsert（先刪舊列再寫入＝重新分派即覆蓋）。
 *
 * 與 appendAuditRecords 相同，刪除與寫入必須在同一把鎖內完成，
 * 否則並發分派會留下重複列或互相覆蓋。
 *
 * @param {Array<{stationCode, stationName, year, auditorNames, auditorEmails, plannedDate}>} entries
 * @param {string} recorderEmail
 * @returns {{saved: number}}
 */
function saveAssignments(entries, recorderEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getAuditSpreadsheet_().getSheetByName(SHEET_NAMES.AUDIT_PLANS);
    if (!sheet) {
      throw new Error('找不到工作表「' + SHEET_NAMES.AUDIT_PLANS + '」，請先在 GAS 編輯器執行 deployAllSheets()');
    }

    // 先刪除同站同年的舊分派（由下往上刪，避免列號位移）
    const targetKeys = {};
    entries.forEach(e => { targetKeys[e.stationCode + '|' + e.year] = true; });
    const rows = sheet.getDataRange().getDisplayValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      const key = String(rows[i][COL.PLAN.STATION_CODE]).trim() + '|' + Number(rows[i][COL.PLAN.YEAR]);
      if (targetKeys[key]) sheet.deleteRow(i + 1);
    }

    const timestamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
    const newRows = entries.map(entry => [
      entry.stationCode,
      entry.stationName,
      entry.year,
      entry.auditorNames,
      entry.auditorEmails,
      entry.plannedDate,
      recorderEmail,
      timestamp,
      entry.calendarEventId || '',
    ]);

    if (newRows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
      SpreadsheetApp.flush();
    }
    return { saved: newRows.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 取消指定駐站某年度的稽核分派。
 *
 * @param {string} stationCode
 * @param {number} year
 * @returns {boolean} 是否實際刪除了一列
 */
function removeAssignment(stationCode, year) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getAuditSpreadsheet_().getSheetByName(SHEET_NAMES.AUDIT_PLANS);
    if (!sheet) return false;

    const rows = sheet.getDataRange().getDisplayValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      const sameStation = String(rows[i][COL.PLAN.STATION_CODE]).trim() === String(stationCode).trim();
      const sameYear = Number(rows[i][COL.PLAN.YEAR]) === Number(year);
      if (sameStation && sameYear) {
        sheet.deleteRow(i + 1);
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// =============================================
// 稽核紀錄：讀取與寫入
// =============================================

/**
 * 取得所有稽核紀錄。
 * @returns {Array<{stationCode, stationName, year, recorder, recordedAt, note}>}
 */
function getAuditRecords() {
  const rows = getSheetRows_(getAuditSpreadsheet_(), SHEET_NAMES.AUDIT_RECORDS, COL.AUDIT.STATION_CODE);
  return rows
    .map(row => ({
      stationCode: String(row[COL.AUDIT.STATION_CODE]).trim(),
      stationName: row[COL.AUDIT.STATION_NAME] || '',
      year: Number(row[COL.AUDIT.YEAR]),
      recorder: row[COL.AUDIT.RECORDER] || '',
      recordedAt: row[COL.AUDIT.RECORDED_AT] || '',
      note: row[COL.AUDIT.NOTE] || '',
      auditDate: String(row[COL.AUDIT.AUDIT_DATE] || '').trim(), // 空 = 早期僅知年度的紀錄
    }))
    .filter(record => !isNaN(record.year) && record.year > 0);
}

/**
 * 批次新增稽核紀錄，同站同年去重（已存在的組合直接略過）。
 *
 * 使用 LockService 防止多人同時登錄造成重複列；
 * 去重檢查與寫入必須在同一把鎖內完成，否則檢查結果可能過期。
 *
 * @param {Array<{stationCode, stationName, year, note}>} entries
 * @param {string} recorderEmail
 * @returns {{added: number, skipped: string[]}} skipped 為已存在而略過的駐站代碼
 */
function appendAuditRecords(entries, recorderEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const existing = getAuditRecords();
    const existingKeys = {};
    existing.forEach(r => { existingKeys[r.stationCode + '|' + r.year] = true; });

    const timestamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
    const skipped = [];
    const newRows = [];

    entries.forEach(entry => {
      const key = entry.stationCode + '|' + entry.year;
      if (existingKeys[key]) {
        skipped.push(entry.stationCode);
        return;
      }
      existingKeys[key] = true; // 同批次內也去重
      newRows.push([
        entry.stationCode,
        entry.stationName,
        entry.year,
        recorderEmail,
        timestamp,
        entry.note || '',
        entry.auditDate || '', // 空 = 僅知年度
      ]);
    });

    if (newRows.length > 0) {
      const sheet = getAuditSpreadsheet_().getSheetByName(SHEET_NAMES.AUDIT_RECORDS);
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
      SpreadsheetApp.flush();
    }
    return { added: newRows.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

// =============================================
// 中心稽核（類型 2～8）：紀錄、排程、觸發事件
// =============================================

/** 取得指定工作表；不存在時丟出導引使用者執行部署的錯誤 */
function getCenterSheet_(sheetName) {
  const sheet = getAuditSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('找不到工作表「' + sheetName + '」，請先在 GAS 編輯器執行 deployAllSheets()');
  }
  return sheet;
}

/**
 * 取得所有中心稽核紀錄。
 * @returns {Array<{typeId, typeName, auditDate, auditorNames, reason, recorder, recordedAt, note}>}
 */
function getCenterRecords() {
  const rows = getSheetRows_(getAuditSpreadsheet_(), SHEET_NAMES.CENTER_RECORDS, COL.CENTER_RECORD.TYPE_ID);
  return rows.map(row => ({
    typeId: String(row[COL.CENTER_RECORD.TYPE_ID]).trim(),
    typeName: row[COL.CENTER_RECORD.TYPE_NAME] || '',
    auditDate: String(row[COL.CENTER_RECORD.AUDIT_DATE] || '').trim(),
    auditorNames: row[COL.CENTER_RECORD.AUDITOR_NAMES] || '',
    reason: row[COL.CENTER_RECORD.REASON] || '',
    recorder: row[COL.CENTER_RECORD.RECORDER] || '',
    recordedAt: row[COL.CENTER_RECORD.RECORDED_AT] || '',
    note: row[COL.CENTER_RECORD.NOTE] || '',
  }));
}

/**
 * 新增一筆中心稽核紀錄；同類型同日期視為重複，直接略過。
 * @returns {boolean} 是否實際寫入
 */
function appendCenterRecord(record, recorderEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const duplicated = getCenterRecords()
      .some(r => r.typeId === record.typeId && r.auditDate === record.auditDate);
    if (duplicated) return false;

    const sheet = getCenterSheet_(SHEET_NAMES.CENTER_RECORDS);
    sheet.appendRow([
      record.typeId,
      record.typeName,
      record.auditDate,
      record.auditorNames || '',
      record.reason || '',
      recorderEmail,
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss'),
      record.note || '',
    ]);
    SpreadsheetApp.flush();
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** 刪除指定類型某日期的中心稽核紀錄 */
function removeCenterRecord(typeId, auditDate) {
  return deleteRowByMatch_(SHEET_NAMES.CENTER_RECORDS, function (row) {
    return String(row[COL.CENTER_RECORD.TYPE_ID]).trim() === typeId &&
           String(row[COL.CENTER_RECORD.AUDIT_DATE]).trim() === auditDate;
  });
}

/**
 * 取得所有中心稽核排程（每類型至多一筆有效排程）。
 * @returns {Array<{typeId, typeName, plannedDate, auditorNames, auditorEmails, reason}>}
 */
function getCenterPlans() {
  const rows = getSheetRows_(getAuditSpreadsheet_(), SHEET_NAMES.CENTER_PLANS, COL.CENTER_PLAN.TYPE_ID);
  return rows.map(row => ({
    typeId: String(row[COL.CENTER_PLAN.TYPE_ID]).trim(),
    typeName: row[COL.CENTER_PLAN.TYPE_NAME] || '',
    plannedDate: String(row[COL.CENTER_PLAN.PLANNED_DATE] || '').trim(),
    auditorNames: row[COL.CENTER_PLAN.AUDITOR_NAMES] || '',
    auditorEmails: row[COL.CENTER_PLAN.AUDITOR_EMAILS] || '',
    reason: row[COL.CENTER_PLAN.REASON] || '',
    calendarEventId: String(row[COL.CENTER_PLAN.CALENDAR_EVENT_ID] || '').trim(),
  }));
}

/**
 * 寫入中心稽核排程（upsert：同類型舊排程先刪再寫＝重新排定即覆蓋）。
 */
function saveCenterPlan(plan, recorderEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getCenterSheet_(SHEET_NAMES.CENTER_PLANS);
    deleteRowsInSheet_(sheet, row => String(row[COL.CENTER_PLAN.TYPE_ID]).trim() === plan.typeId);
    sheet.appendRow([
      plan.typeId,
      plan.typeName,
      plan.plannedDate,
      plan.auditorNames,
      plan.auditorEmails,
      plan.reason || '',
      recorderEmail,
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss'),
      plan.calendarEventId || '',
    ]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/** 取消指定類型的稽核排程 */
function removeCenterPlan(typeId) {
  return deleteRowByMatch_(SHEET_NAMES.CENTER_PLANS, function (row) {
    return String(row[COL.CENTER_PLAN.TYPE_ID]).trim() === typeId;
  });
}

/**
 * 取得所有觸發事件（類型 7 用）。
 * @returns {Array<{eventId, eventDate, category, description, recorder, recordedAt}>}
 */
function getTriggerEvents() {
  const rows = getSheetRows_(getAuditSpreadsheet_(), SHEET_NAMES.TRIGGER_EVENTS, COL.TRIGGER.EVENT_ID);
  return rows.map(row => ({
    eventId: String(row[COL.TRIGGER.EVENT_ID]).trim(),
    eventDate: String(row[COL.TRIGGER.EVENT_DATE] || '').trim(),
    category: row[COL.TRIGGER.CATEGORY] || '',
    description: row[COL.TRIGGER.DESCRIPTION] || '',
    recorder: row[COL.TRIGGER.RECORDER] || '',
    recordedAt: row[COL.TRIGGER.RECORDED_AT] || '',
  }));
}

/** 登記一筆觸發事件，回傳系統生成的事件 ID */
function appendTriggerEvent(event, recorderEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const eventId = 'TRG-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    getCenterSheet_(SHEET_NAMES.TRIGGER_EVENTS).appendRow([
      eventId,
      event.eventDate,
      event.category,
      event.description || '',
      recorderEmail,
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss'),
    ]);
    SpreadsheetApp.flush();
    return eventId;
  } finally {
    lock.releaseLock();
  }
}

/** 刪除指定 ID 的觸發事件（登記錯誤時的更正手段） */
function removeTriggerEvent(eventId) {
  return deleteRowByMatch_(SHEET_NAMES.TRIGGER_EVENTS, function (row) {
    return String(row[COL.TRIGGER.EVENT_ID]).trim() === eventId;
  });
}

/**
 * 通用單列刪除：在鎖內由下往上找第一個符合條件的資料列刪除。
 * 集中鎖與列號位移處理，避免各刪除函式重複同樣的樣板。
 *
 * @param {string} sheetName
 * @param {function(string[]): boolean} matchFn
 * @returns {boolean} 是否實際刪除了一列
 */
function deleteRowByMatch_(sheetName, matchFn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getAuditSpreadsheet_().getSheetByName(sheetName);
    if (!sheet) return false;
    return deleteRowsInSheet_(sheet, matchFn, true) > 0;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 刪除工作表內所有（或第一個）符合條件的資料列；由下往上避免列號位移。
 * 呼叫端需自行持有鎖。
 *
 * @returns {number} 刪除的列數
 */
function deleteRowsInSheet_(sheet, matchFn, onlyFirst) {
  const rows = sheet.getDataRange().getDisplayValues();
  let deleted = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (!matchFn(rows[i])) continue;
    sheet.deleteRow(i + 1);
    deleted++;
    if (onlyFirst) break;
  }
  if (deleted > 0) SpreadsheetApp.flush();
  return deleted;
}

/**
 * 刪除指定駐站某年度的稽核紀錄（登錄錯誤時的更正手段）。
 *
 * @param {string} stationCode
 * @param {number} year
 * @returns {boolean} 是否實際刪除了一列
 */
function removeAuditRecord(stationCode, year) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getAuditSpreadsheet_().getSheetByName(SHEET_NAMES.AUDIT_RECORDS);
    if (!sheet) return false;

    const rows = sheet.getDataRange().getDisplayValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      const sameStation = String(rows[i][COL.AUDIT.STATION_CODE]).trim() === String(stationCode).trim();
      const sameYear = Number(rows[i][COL.AUDIT.YEAR]) === Number(year);
      if (sameStation && sameYear) {
        sheet.deleteRow(i + 1);
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}
