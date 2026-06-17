/**
 * code.js — Web App 入口與前端 API
 *
 * 所有 API 一律回傳 JSON 字串（google.script.run 對 Date/巢狀物件的
 * 序列化不可靠，統一字串化由前端 JSON.parse）。
 */

// =============================================
// Web App 入口
// =============================================

function doGet() {
  // 駐站人員（受稽者）不得進入系統；身分判定異常時 fail-open 載入頁面，
  // 真正的防護仍由 getAuditDashboard 與各寫入 API 把關（縱深防禦）。
  let role = USER_ROLES.VIEWER;
  try {
    role = getUserRole_(Session.getActiveUser().getEmail() || '');
  } catch (error) {
    role = USER_ROLES.VIEWER;
  }
  if (role === USER_ROLES.FORBIDDEN) return forbiddenPage_();

  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('稽核駐站分配')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 權限不足頁面：駐站人員開啟系統時顯示，不載入任何資料。 */
function forbiddenPage_() {
  const html =
    '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>權限不足</title>' +
    '<style>body{margin:0;font-family:"Noto Sans TC",-apple-system,sans-serif;background:#f6f4ee;color:#1c1c1c;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.box{background:#fffdf9;border:1px solid #d9d4c8;border-top:3px solid #a13c2f;padding:48px 40px;max-width:440px;' +
    'text-align:center;box-shadow:0 18px 48px rgba(31,58,46,.12)}' +
    '.box h1{font-family:"Noto Serif TC",serif;font-size:22px;margin:0 0 12px;color:#1f3a2e}' +
    '.box p{font-size:14px;line-height:1.7;color:#6f6b62;margin:8px 0}</style></head><body>' +
    '<div class="box"><h1>權限不足</h1>' +
    '<p>稽核駐站分配系統僅供稽核人員使用。</p>' +
    '<p>駐站人員無法存取本系統，如有疑問請聯絡稽核小組。</p></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('權限不足');
}

/**
 * 寫入操作的權限閘：非稽核員一律擋下。
 * 即使前端已隱藏按鈕，仍須於 API 層攔截直接呼叫，防止繞過前端限制。
 * @throws {Error} 角色非 AUDITOR 時拋錯（由各 API 的 try/catch 轉成 errorResponse_）
 */
function requireAuditor_() {
  const email = Session.getActiveUser().getEmail() || '';
  if (getUserRole_(email) !== USER_ROLES.AUDITOR) {
    throw new Error('權限不足：僅稽核員可執行此操作');
  }
}

// =============================================
// API：儀表板資料
// =============================================

/**
 * 取得儀表板完整資料：週期資訊、進度摘要、駐站清單（含候選狀態與成員）。
 *
 * 一次回傳所有渲染所需資料，前端只需一個 round-trip——
 * GAS 的 google.script.run 每次呼叫延遲約 1–2 秒，分次載入體驗更差。
 *
 * @returns {string} JSON 回應
 */
function getAuditDashboard() {
  try {
    const userEmail = Session.getActiveUser().getEmail() || '';
    const userRole = getUserRole_(userEmail);
    if (userRole === USER_ROLES.FORBIDDEN) {
      return errorResponse_('權限不足：駐站人員無法存取稽核駐站分配系統');
    }

    const core = buildStationDashboardCore_();
    const byName = function (a, b) {
      return String(a.name || a.code).localeCompare(String(b.name || b.code), 'zh-Hant');
    };

    // ---- 中心稽核項目（類型 2～8）----
    const currentMonth = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM'));
    const center = buildCenterDashboard_({ year: core.currentYear, month: currentMonth }, core.cycleStartYear, core.mode);

    return successResponse_({
      currentYear: core.currentYear,
      mode: core.mode,
      cycleStartYear: core.cycleStartYear,
      cycle: core.cycle,
      certifiedCycle: core.certifiedCycle,
      summary: core.summary,
      auditors: getAuditors(),
      certifiedStations: core.evaluated.filter(s => s.isCertified).sort(byName),
      normalStations: core.evaluated.filter(s => !s.isCertified).sort(byName),
      centerTypes: center.types,
      centerSummary: center.summary,
      triggerCategories: TRIGGER_CATEGORIES,
      userEmail: userEmail,
      userRole: userRole,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 組裝駐站儀表板核心：逐站評估 + 週期摘要。
 * 由 getAuditDashboard（全量）與各儲存 API 的部分更新（stationDeltaFor_）共用，
 * 確保單卡刷新與整頁刷新走同一套評估邏輯。
 *
 * @returns {{currentYear, mode, cycleStartYear, cycle, certifiedCycle, evaluated: Array, summary: Object}}
 */
function buildStationDashboardCore_() {
  const currentYear = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy'));
  const mode = getCycleMode_();
  const cycleStartYear = getCycleStartYear_();
  const cycle = getCycleForYear(currentYear, cycleStartYear, ENV.CYCLE_LENGTH_YEARS);
  // 認證站排程輪（兩年）：僅供認證站的卡片狀態與年度建議；覆蓋率仍以三年 cycle 計
  const certifiedCycle = getCycleForYear(currentYear, cycleStartYear, ENV.CERTIFIED_CYCLE_LENGTH_YEARS);

  const stations = getStations();
  const membersMap = getStationMembersMap();
  const records = getAuditRecords();

  // 駐站代碼 → 該站所有稽核年份／完整紀錄
  const yearsByStation = {};
  const recordsByStation = {};
  records.forEach(r => {
    if (!yearsByStation[r.stationCode]) yearsByStation[r.stationCode] = [];
    yearsByStation[r.stationCode].push(r.year);
    if (!recordsByStation[r.stationCode]) recordsByStation[r.stationCode] = [];
    recordsByStation[r.stationCode].push(r);
  });

  // 駐站代碼 → 今年的稽核分派
  const assignmentByStation = {};
  getAssignments().forEach(plan => {
    if (plan.year === currentYear) assignmentByStation[plan.stationCode] = plan;
  });

  const evaluated = stations.map(station => {
    const auditYears = yearsByStation[station.code] || [];
    const evaluation = evaluateStationFor_(station, auditYears, currentYear, cycle, certifiedCycle, mode);
    const assignment = assignmentByStation[station.code] || null;

    // 狀態優先序：今年已稽核 > 待稽核（已分派）> 候選/效期內
    if (assignment && evaluation.status !== STATION_STATUS.AUDITED_THIS_YEAR) {
      evaluation.status = STATION_STATUS.PENDING_AUDIT;
    }

    const auditView = buildStationAuditView_(recordsByStation[station.code] || []);
    return {
      code: station.code,
      name: station.name,
      alias: station.alias,
      managerName: station.managerName,
      managerEmail: station.managerEmail,
      isCertified: station.isCertified,
      certifiedSince: station.certifiedSince || 0,
      certifiedTenures: station.certifiedTenures || [],
      members: membersMap[station.code] || [],
      allAuditYears: auditYears.slice().sort(function (a, b) { return a - b; }),
      auditRecords: auditView.auditRecords,
      lastAuditDisplay: auditView.lastAuditDisplay,
      assignment: assignment && {
        auditorNames: assignment.auditorNames,
        auditorEmails: assignment.auditorEmails,
        plannedDate: assignment.plannedDate,
      },
      history: buildAuditHistory(auditYears, currentYear),
      evaluation: evaluation,
    };
  });

  const summary = buildCycleSummary(evaluated, currentYear, cycle, certifiedCycle, mode);
  // 統計卡片：已預計 = 今年有分派的站數；已稽核 = 今年有稽核紀錄的站數
  summary.plannedThisYear = Object.keys(assignmentByStation).length;
  summary.auditedThisYear = evaluated.filter(s => s.evaluation.auditedThisYear).length;

  return {
    currentYear: currentYear,
    mode: mode,
    cycleStartYear: cycleStartYear,
    cycle: cycle,
    certifiedCycle: certifiedCycle,
    evaluated: evaluated,
    summary: summary,
  };
}

/**
 * 部分更新用：重算後取出指定駐站的最新卡片資料與整體摘要。
 * 寫入 API 成功後呼叫，將結果折疊進回應，前端即可只替換該卡片、更新摘要列，
 * 不必再 round-trip 取整份儀表板。
 *
 * @param {string[]} codes - 受影響的駐站代碼
 * @returns {{stations: Array, summary: Object}}
 */
function stationDeltaFor_(codes) {
  const core = buildStationDashboardCore_();
  const wanted = {};
  codes.forEach(c => { wanted[String(c).trim()] = true; });
  return {
    stations: core.evaluated.filter(s => wanted[s.code]),
    summary: core.summary,
  };
}

/**
 * 部分更新用：重算後取出指定中心稽核項目的最新卡片資料與中心摘要。
 *
 * @param {string} typeId
 * @returns {{centerType: (Object|null), centerSummary: Object}}
 */
function centerDeltaFor_(typeId) {
  const currentYear = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy'));
  const currentMonth = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM'));
  const center = buildCenterDashboard_({ year: currentYear, month: currentMonth }, getCycleStartYear_(), getCycleMode_());
  return {
    centerType: center.types.find(t => t.id === typeId) || null,
    centerSummary: center.summary,
  };
}

// =============================================
// API：認證駐站管理（維護精確 N 家的認證名單）
// =============================================

/**
 * 讀取認證駐站管理所需資料：目前認證名單、所有可選駐站、應有家數。
 * 各站附帶任期（tenures）與稽核年份（auditYears），供前端計算「認證次數」（規格 4.3）。
 *
 * @returns {string} JSON 回應
 */
function getCertifiedStationData() {
  try {
    requireAuditor_();
    const stations = getStations();
    const yearsByStation = {};
    getAuditRecords().forEach(r => {
      if (!yearsByStation[r.stationCode]) yearsByStation[r.stationCode] = [];
      yearsByStation[r.stationCode].push(r.year);
    });
    const byName = function (a, b) {
      return String(a.name || a.code).localeCompare(String(b.name || b.code), 'zh-Hant');
    };
    const options = stations.map(function (s) {
      const auditYears = (yearsByStation[s.code] || []).slice().sort(function (a, b) { return a - b; });
      const tenures = s.certifiedTenures || [];
      return {
        code: s.code,
        name: s.name,
        managerName: s.managerName || '',
        isCertified: !!s.isCertified,
        certifiedSince: s.certifiedSince || 0,
        // 認證次數於後端計算（規格 4.3）——純函式僅後端可用，前端只顯示結果
        certCount: countValidCertifications_(tenures, auditYears),
      };
    }).sort(byName);

    return successResponse_({
      expectedCount: ENV.CERTIFIED_STATION_COUNT,
      externalTableReady: !!String(ENV.ISO_STATION_SPREADSHEET_ID || '').trim(),
      currentCertified: options.filter(s => s.isCertified),
      stationOptions: options,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 更新認證駐站名單：須剛好 ENV.CERTIFIED_STATION_COUNT 家，
 * 與目前名單比對算出新增／移除，寫入認證駐站紀錄表並同步 HR 組織架構樹 I 欄。
 *
 * @param {string[]} stationCodes - 選定的認證駐站代碼
 * @returns {string} JSON 回應
 */
function saveCertifiedStations(stationCodes) {
  try {
    requireAuditor_();
    if (!Array.isArray(stationCodes)) {
      return errorResponse_('參數格式錯誤：認證駐站代碼應為陣列');
    }
    // 去空白＋去重
    const codes = [];
    const seen = {};
    stationCodes.forEach(function (c) {
      const code = String(c || '').trim();
      if (code && !seen[code]) { seen[code] = true; codes.push(code); }
    });

    const expected = ENV.CERTIFIED_STATION_COUNT;
    if (codes.length !== expected) {
      return errorResponse_('認證駐站須剛好 ' + expected + ' 家，目前選了 ' + codes.length + ' 家');
    }

    const stationByCode = {};
    getStations().forEach(s => { stationByCode[s.code] = s; });
    const unknown = codes.filter(c => !stationByCode[c]);
    if (unknown.length > 0) {
      return errorResponse_('找不到駐站：' + unknown.join('、') + '，請重新整理後再試');
    }

    // 與目前名單比對算 added/removed
    const oldCertified = getStations().filter(s => s.isCertified).map(s => s.code);
    const newSet = {}; codes.forEach(c => { newSet[c] = true; });
    const oldSet = {}; oldCertified.forEach(c => { oldSet[c] = true; });
    const added = codes.filter(c => !oldSet[c]);
    const removed = oldCertified.filter(c => !newSet[c]);
    if (added.length === 0 && removed.length === 0) {
      return errorResponse_('認證名單沒有異動，無須更新');
    }

    commitCertifiedRoster_(added, removed, resolveActor_());

    return successResponse_({
      message: '已更新認證駐站名單（新增 ' + added.length + ' 家、移除 ' + removed.length + ' 家）',
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/** 取得目前操作人的 email 與姓名（姓名以稽核人員名單比對，取不到退回 email）。 */
function resolveActor_() {
  const email = String(Session.getActiveUser().getEmail() || '').trim();
  const auditor = getAuditors().find(a => a.email === email.toLowerCase());
  return { email: email, name: auditor ? auditor.name : email };
}

/**
 * 整理單一駐站的稽核紀錄視圖：倒序清單＋「上次稽核」顯示文字。
 * 早期紀錄只有年度（稽核日期欄空），顯示退回「YYYY 年」。
 *
 * @param {Array<{year, auditDate, recorder, note}>} stationRecords
 * @returns {{auditRecords: Array, lastAuditDisplay: string}}
 */
function buildStationAuditView_(stationRecords) {
  const sorted = stationRecords.slice().sort(function (a, b) {
    if (a.year !== b.year) return b.year - a.year;
    return String(b.auditDate || '').localeCompare(String(a.auditDate || ''));
  });
  const latest = sorted[0] || null;
  return {
    auditRecords: sorted.map(r => ({ year: r.year, auditDate: r.auditDate || '', recorder: r.recorder || '', note: r.note || '' })),
    lastAuditDisplay: latest ? (latest.auditDate || latest.year + ' 年') : '',
  };
}

/**
 * 組裝中心稽核項目（類型 2～8）的儀表板資料。
 *
 * @param {{year: number, month: number}} today
 * @param {number} anchorYear
 * @param {string} mode
 * @returns {{types: Array, summary: Object}}
 */
function buildCenterDashboard_(today, anchorYear, mode) {
  const centerRecords = getCenterRecords();
  const centerPlans = getCenterPlans();

  // 觸發事件銷案狀態：以類型 7 的稽核紀錄日期計算
  const orgAuditDates = centerRecords.filter(r => r.typeId === 'ORG').map(r => r.auditDate);
  const resolvedTriggers = resolveTriggerEvents(getTriggerEvents(), orgAuditDates)
    .sort(function (a, b) { return a.eventDate < b.eventDate ? 1 : -1; }); // 新事件在前
  const openTriggerCount = resolvedTriggers.filter(t => !t.resolved).length;

  const types = AUDIT_TYPE_DEFS
    .filter(t => t.frequency !== 'STATION')
    .map(function (typeDef) {
      const records = centerRecords
        .filter(r => r.typeId === typeDef.id)
        .sort(function (a, b) { return a.auditDate < b.auditDate ? 1 : -1; }); // 新紀錄在前
      const plan = centerPlans.find(p => p.typeId === typeDef.id) || null;
      const openCount = typeDef.id === 'ORG' ? openTriggerCount : 0;
      return {
        id: typeDef.id,
        order: typeDef.order,
        name: typeDef.name,
        frequency: typeDef.frequency,
        freqLabel: typeDef.freqLabel,
        records: records.map(r => ({
          auditDate: r.auditDate,
          periodLabel: getPeriodLabelForDate(typeDef, r.auditDate), // 依紀錄日期的「當時制度」歸屬期別
          auditorNames: r.auditorNames,
          reason: r.reason,
          note: r.note,
        })),
        plan: plan && { plannedDate: plan.plannedDate, auditorNames: plan.auditorNames, auditorEmails: plan.auditorEmails, reason: plan.reason },
        segmentSchedule: getSegmentScheduleForType(typeDef),
        triggers: typeDef.id === 'ORG' ? resolvedTriggers : null,
        openTriggerCount: openCount,
        evaluation: evaluateCenterType(typeDef, records.map(r => r.auditDate), plan, openCount, today, anchorYear, mode),
      };
    });

  return { types: types, summary: buildCenterSummary(types) };
}

// =============================================
// API：週期模式
// =============================================

/** 目前的週期計算模式，未設定時預設固定區段 */
function getCycleMode_() {
  const stored = PropertiesService.getScriptProperties().getProperty(CYCLE_MODE_PROPERTY_KEY);
  return CYCLE_MODES[stored] ? stored : CYCLE_MODES.FIXED;
}

/** 固定模式的錨定起始年：Script Properties 優先，未設定退回 ENV 預設 */
function getCycleStartYear_() {
  const stored = Number(PropertiesService.getScriptProperties().getProperty(CYCLE_START_YEAR_PROPERTY_KEY));
  return (!isNaN(stored) && stored > 0) ? stored : ENV.CYCLE_START_YEAR;
}

/**
 * 設定固定模式的錨定起始年（全域生效，所有使用者共用）。
 *
 * @param {number} year - 西元年，範圍 2020～明年
 * @returns {string} JSON 回應
 */
function setCycleStartYear(year) {
  try {
    requireAuditor_();
    const anchorYear = Number(year);
    const currentYear = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy'));
    if (isNaN(anchorYear) || anchorYear !== Math.floor(anchorYear) || anchorYear < 2020 || anchorYear > currentYear + 1) {
      return errorResponse_('起始年 ' + year + ' 超出可設定範圍（2020～' + (currentYear + 1) + '），請重新選擇');
    }
    PropertiesService.getScriptProperties().setProperty(CYCLE_START_YEAR_PROPERTY_KEY, String(anchorYear));
    const cycle = getCycleForYear(currentYear, anchorYear, ENV.CYCLE_LENGTH_YEARS);
    return successResponse_({
      cycleStartYear: anchorYear,
      message: '已將週期起始年設為 ' + anchorYear + '，目前週期為 ' + cycle.start + '–' + cycle.end,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 切換週期計算模式（全域生效，所有使用者共用）。
 *
 * @param {string} mode - 'FIXED' | 'ROLLING'
 * @returns {string} JSON 回應
 */
function setCycleMode(mode) {
  try {
    requireAuditor_();
    if (!CYCLE_MODES[mode]) {
      return errorResponse_('未知的週期模式：' + mode + '，僅支援固定區段（FIXED）與滾動式（ROLLING）');
    }
    PropertiesService.getScriptProperties().setProperty(CYCLE_MODE_PROPERTY_KEY, mode);
    return successResponse_({
      mode: mode,
      message: mode === CYCLE_MODES.ROLLING ? '已切換為滾動式三年模式' : '已切換為固定三年區段模式',
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

// =============================================
// API：稽核分派
// =============================================

/**
 * 儲存單一駐站的稽核分派——人員與日期可獨立設定（至少一項），每次呼叫立即寫入。
 *
 * 行事曆策略（複用同一筆預約）：
 * - 有日期：建立或更新同一事件（無人員時標題附「待指派人員」）。
 * - 無日期但既有事件存在（使用者清掉日期）：刪除事件、清空 eventId。
 * - 無日期且無事件（僅人員）：先只寫入試算表，待日期確定再進日曆。
 *
 * @param {string} stationCode
 * @param {number} year - 稽核年度（西元）
 * @param {string[]} auditorEmails - 可空
 * @param {string} plannedDate - yyyy/MM/dd，可空
 * @returns {string} JSON 回應
 */
function saveStationAssignment(stationCode, year, auditorEmails, plannedDate) {
  try {
    requireAuditor_();
    const auditYear = Number(year);
    if (!isValidAuditYear_(auditYear)) {
      return errorResponse_('稽核年度 ' + year + ' 超出可登錄範圍，請確認年度後重試');
    }
    const station = getStations().find(s => s.code === stationCode);
    if (!station) return errorResponse_('找不到駐站：' + stationCode + '，請重新整理後再試');

    const emails = Array.isArray(auditorEmails) ? auditorEmails.filter(e => String(e || '').trim()) : [];
    const dateText = String(plannedDate || '').trim();
    const hasDate = dateText !== '';
    if (emails.length === 0 && !hasDate) {
      return errorResponse_('請至少設定稽核人員或預計稽核日期其中一項');
    }
    if (hasDate && !isValidPlannedDate_(dateText)) {
      return errorResponse_('預計稽核日期格式錯誤，請使用 yyyy/MM/dd');
    }
    const auditors = emails.length > 0 ? lookupAuditors_(emails) : [];

    const oldPlan = getAssignments().find(p => p.stationCode === stationCode && p.year === auditYear);
    const oldEventId = oldPlan ? oldPlan.calendarEventId : '';

    // 行事曆同步
    const calendarWarnings = [];
    let calendarEventId = oldEventId || '';
    if (hasDate) {
      const sync = syncCalendarUpsert_(
        oldEventId,
        '【稽核】' + station.name + (auditors.length === 0 ? '（待指派人員）' : ''),
        dateText,
        '駐站代碼：' + station.code + '\n稽核年度：' + auditYear +
          '\n稽核人員：' + (auditors.length === 0 ? '（待指派）' : auditors.map(a => a.name).join('、')) +
          '\n（由稽核駐站分配系統建立）',
        auditors.map(a => a.email)
      );
      calendarEventId = sync.eventId;
      calendarWarnings.push(sync.warning);
    } else if (oldEventId) {
      // 既有事件但這次清掉日期 → 移除事件
      calendarWarnings.push(syncCalendarDelete_(oldEventId));
      calendarEventId = '';
    }

    saveAssignments([{
      stationCode: station.code,
      stationName: station.name,
      year: auditYear,
      auditorNames: auditors.map(a => a.name).join('、'),
      auditorEmails: auditors.map(a => a.email).join(','),
      plannedDate: hasDate ? dateText : '',
      calendarEventId: calendarEventId,
    }], Session.getActiveUser().getEmail() || '');

    let statusMsg;
    if (hasDate && auditors.length > 0) statusMsg = '已分派 ' + station.name + '：' + auditors.map(a => a.name).join('、') + ' 於 ' + dateText;
    else if (hasDate) statusMsg = '已為 ' + station.name + ' 排定 ' + dateText + '（待指派人員）';
    else statusMsg = '已為 ' + station.name + ' 指派人員（待定日期，尚未寫入行事曆）';

    const delta = stationDeltaFor_([station.code]);
    return successResponse_({
      message: statusMsg + (hasDate ? calendarSyncSuffix_(calendarWarnings) : ''),
      stations: delta.stations,
      summary: delta.summary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 取消指定駐站某年度的稽核分派。
 *
 * @param {string} stationCode
 * @param {number} year
 * @returns {string} JSON 回應
 */
function cancelAssignment(stationCode, year) {
  try {
    requireAuditor_();
    // 先取得行事曆事件 ID（刪列後就查不到了），同步刪除事件
    const plan = getAssignments().find(p => p.stationCode === stationCode && p.year === Number(year));
    const warning = plan && plan.calendarEventId ? syncCalendarDelete_(plan.calendarEventId) : '';

    const removed = removeAssignment(stationCode, Number(year));
    if (!removed) {
      return errorResponse_('找不到 ' + stationCode + ' 於 ' + year + ' 年的分派紀錄，可能已被取消');
    }
    const delta = stationDeltaFor_([stationCode]);
    return successResponse_({
      message: '已取消 ' + stationCode + ' 的 ' + year + ' 年稽核分派' + calendarSyncSuffix_([warning]),
      stations: delta.stations,
      summary: delta.summary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

// =============================================
// API：中心稽核項目（類型 2～8）
// =============================================

/** 取得非駐站類型的定義；不存在或為 STATION 時回 null */
function findCenterTypeDef_(typeId) {
  const typeDef = AUDIT_TYPE_DEFS.find(t => t.id === typeId);
  return (typeDef && typeDef.frequency !== 'STATION') ? typeDef : null;
}

/**
 * 排定中心稽核（每類型同時只有一筆有效排程，重新排定即覆蓋）。
 *
 * @param {string} typeId
 * @param {string[]} auditorEmails
 * @param {string} plannedDate - yyyy/MM/dd
 * @param {string} reason - 事由（類型 7/8 用，其餘選填）
 * @returns {string} JSON 回應
 */
function planCenterAudit(typeId, auditorEmails, plannedDate, reason) {
  try {
    requireAuditor_();
    const typeDef = findCenterTypeDef_(typeId);
    if (!typeDef) return errorResponse_('未知的稽核項目：' + typeId + '，請重新整理後再試');

    const emails = Array.isArray(auditorEmails) ? auditorEmails.filter(e => String(e || '').trim()) : [];
    const dateText = String(plannedDate || '').trim();
    const hasDate = dateText !== '';
    if (emails.length === 0 && !hasDate) {
      return errorResponse_('請至少設定稽核人員或預定日期其中一項');
    }
    if (hasDate && !isValidPlannedDate_(dateText)) {
      return errorResponse_('預定日期格式錯誤，請使用 yyyy/MM/dd');
    }
    const auditors = emails.length > 0 ? lookupAuditors_(emails) : [];

    const oldPlan = getCenterPlans().find(p => p.typeId === typeId);
    const oldEventId = oldPlan ? oldPlan.calendarEventId : '';

    // 行事曆同步（複用同一筆預約）
    const calendarWarnings = [];
    let calendarEventId = oldEventId || '';
    if (hasDate) {
      const sync = syncCalendarUpsert_(
        oldEventId,
        '【稽核】' + typeDef.name + (auditors.length === 0 ? '（待指派人員）' : ''),
        dateText,
        '稽核項目：' + typeDef.name + '（' + typeDef.freqLabel + '）' +
          '\n稽核人員：' + (auditors.length === 0 ? '（待指派）' : auditors.map(a => a.name).join('、')) +
          (reason ? '\n事由：' + reason : '') + '\n（由稽核駐站分配系統建立）',
        auditors.map(a => a.email)
      );
      calendarEventId = sync.eventId;
      calendarWarnings.push(sync.warning);
    } else if (oldEventId) {
      calendarWarnings.push(syncCalendarDelete_(oldEventId));
      calendarEventId = '';
    }

    saveCenterPlan({
      typeId: typeDef.id,
      typeName: typeDef.name,
      plannedDate: hasDate ? dateText : '',
      auditorNames: auditors.map(a => a.name).join('、'),
      auditorEmails: auditors.map(a => a.email).join(','),
      reason: reason || '',
      calendarEventId: calendarEventId,
    }, Session.getActiveUser().getEmail() || '');

    let statusMsg;
    if (hasDate && auditors.length > 0) statusMsg = '已排定「' + typeDef.name + '」於 ' + dateText + ' 稽核';
    else if (hasDate) statusMsg = '已為「' + typeDef.name + '」排定 ' + dateText + '（待指派人員）';
    else statusMsg = '已為「' + typeDef.name + '」指派人員（待定日期，尚未寫入行事曆）';

    const delta = centerDeltaFor_(typeDef.id);
    return successResponse_({
      message: statusMsg + (hasDate ? calendarSyncSuffix_(calendarWarnings) : ''),
      centerType: delta.centerType,
      centerSummary: delta.centerSummary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 取消中心稽核排程。
 * @returns {string} JSON 回應
 */
function cancelCenterPlan(typeId) {
  try {
    requireAuditor_();
    const typeDef = findCenterTypeDef_(typeId);
    if (!typeDef) return errorResponse_('未知的稽核項目：' + typeId);

    const plan = getCenterPlans().find(p => p.typeId === typeId);
    const warning = plan && plan.calendarEventId ? syncCalendarDelete_(plan.calendarEventId) : '';

    if (!removeCenterPlan(typeId)) {
      return errorResponse_('「' + typeDef.name + '」目前沒有排程，可能已被取消');
    }
    const delta = centerDeltaFor_(typeId);
    return successResponse_({
      message: '已取消「' + typeDef.name + '」的稽核排程' + calendarSyncSuffix_([warning]),
      centerType: delta.centerType,
      centerSummary: delta.centerSummary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 登錄中心稽核完成（含歷史補登）；寫入後自動清除該類型的排程。
 *
 * @param {string} typeId
 * @param {string} auditDate - 實際稽核日期 yyyy/MM/dd
 * @param {string[]} auditorEmails - 選填（補登歷史可能不知人員）
 * @param {string} reason
 * @param {string} note
 * @returns {string} JSON 回應
 */
function recordCenterAudit(typeId, auditDate, auditorEmails, reason, note) {
  try {
    requireAuditor_();
    const typeDef = findCenterTypeDef_(typeId);
    if (!typeDef) return errorResponse_('未知的稽核項目：' + typeId + '，請重新整理後再試');
    if (!isValidPlannedDate_(auditDate)) {
      return errorResponse_('稽核日期格式錯誤，請使用 yyyy/MM/dd');
    }
    const year = Number(auditDate.slice(0, 4));
    if (!isValidAuditYear_(year)) {
      return errorResponse_('稽核日期 ' + auditDate + ' 超出可登錄範圍（' + ENV.MIN_AUDIT_YEAR + ' 年起），請確認後重試');
    }

    const auditors = lookupAuditors_(auditorEmails || []);
    const added = appendCenterRecord({
      typeId: typeDef.id,
      typeName: typeDef.name,
      auditDate: auditDate,
      auditorNames: auditors.map(a => a.name).join('、'),
      reason: reason || '',
      note: note || '',
    }, Session.getActiveUser().getEmail() || '');

    if (!added) {
      return errorResponse_('「' + typeDef.name + '」於 ' + auditDate + ' 已有紀錄，請勿重複登錄');
    }
    // 完成後清除排程與其行事曆事件，狀態回歸由紀錄推導
    const plan = getCenterPlans().find(p => p.typeId === typeId);
    if (plan && plan.calendarEventId) syncCalendarDelete_(plan.calendarEventId);
    removeCenterPlan(typeId);
    const delta = centerDeltaFor_(typeDef.id);
    return successResponse_({
      message: '已登錄「' + typeDef.name + '」於 ' + auditDate + ' 完成稽核',
      centerType: delta.centerType,
      centerSummary: delta.centerSummary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 刪除中心稽核紀錄（登錄錯誤時的更正手段）。
 * @returns {string} JSON 回應
 */
function deleteCenterAuditRecord(typeId, auditDate) {
  try {
    requireAuditor_();
    const typeDef = findCenterTypeDef_(typeId);
    if (!typeDef) return errorResponse_('未知的稽核項目：' + typeId);
    if (!removeCenterRecord(typeId, auditDate)) {
      return errorResponse_('找不到「' + typeDef.name + '」於 ' + auditDate + ' 的紀錄，可能已被刪除');
    }
    const delta = centerDeltaFor_(typeId);
    return successResponse_({
      message: '已刪除「' + typeDef.name + '」於 ' + auditDate + ' 的稽核紀錄',
      centerType: delta.centerType,
      centerSummary: delta.centerSummary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 登記觸發事由（類型 7：展延／變更／倫委會組成／人員異動時需稽核）。
 *
 * @param {string} eventDate - yyyy/MM/dd
 * @param {string} category - TRIGGER_CATEGORIES 之一
 * @param {string} description
 * @returns {string} JSON 回應
 */
function addTriggerEvent(eventDate, category, description) {
  try {
    requireAuditor_();
    if (!isValidPlannedDate_(eventDate)) {
      return errorResponse_('事件日期格式錯誤，請使用 yyyy/MM/dd');
    }
    if (TRIGGER_CATEGORIES.indexOf(category) === -1) {
      return errorResponse_('未知的事由類別：' + category);
    }
    const eventId = appendTriggerEvent(
      { eventDate: eventDate, category: category, description: description || '' },
      Session.getActiveUser().getEmail() || ''
    );
    const delta = centerDeltaFor_('ORG');
    return successResponse_({
      eventId: eventId,
      message: '已登記觸發事由「' + category + '」，組織與人員項目產生待辦',
      centerType: delta.centerType,
      centerSummary: delta.centerSummary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 刪除觸發事由（登記錯誤時的更正手段）。
 * @returns {string} JSON 回應
 */
function deleteTriggerEvent(eventId) {
  try {
    requireAuditor_();
    if (!removeTriggerEvent(eventId)) {
      return errorResponse_('找不到此觸發事由，可能已被刪除');
    }
    const delta = centerDeltaFor_('ORG');
    return successResponse_({
      message: '已刪除觸發事由',
      centerType: delta.centerType,
      centerSummary: delta.centerSummary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 將信箱清單比對為稽核人員物件；任一信箱不在名單即丟錯。
 * 排定與登錄共用，確保寫入的姓名永遠來自 HR 名單。
 */
function lookupAuditors_(auditorEmails) {
  const auditorByEmail = {};
  getAuditors().forEach(a => { auditorByEmail[a.email] = a; });
  return auditorEmails.map(function (email) {
    const auditor = auditorByEmail[String(email || '').trim().toLowerCase()];
    if (!auditor) throw new Error('「' + email + '」不在稽核人員名單中，請重新整理後再試');
    return auditor;
  });
}

/** 預計稽核日期格式檢查：yyyy/MM/dd 且為有效日期 */
function isValidPlannedDate_(dateText) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(String(dateText || ''));
  if (!match) return false;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return parsed.getMonth() === Number(match[2]) - 1 && parsed.getDate() === Number(match[3]);
}

// =============================================
// 行事曆同步（優雅降級：失敗不阻擋 Sheet 寫入，只附註警告）
// =============================================

/** 建立行事曆事件；失敗時回空 eventId 與警告文字 */
function syncCalendarCreate_(title, dateText, description, guestEmails) {
  try {
    return { eventId: createAuditCalendarEvent(title, dateText, description, guestEmails), warning: '' };
  } catch (error) {
    return { eventId: '', warning: '（行事曆同步失敗：' + error.message + '）' };
  }
}

/**
 * 建立或更新行事曆事件（複用同一筆預約）。
 * 有 eventId 先嘗試更新；事件已不存在則改建立新事件；無 eventId 直接建立。
 * 失敗時回空 eventId 與警告文字（優雅降級，不阻擋 Sheet 寫入）。
 */
function syncCalendarUpsert_(eventId, title, dateText, description, guestEmails) {
  try {
    if (String(eventId || '').trim()) {
      const updated = updateAuditCalendarEvent(eventId, title, dateText, description, guestEmails);
      if (updated) return { eventId: updated, warning: '' };
      // 事件已被手動刪除 → fallback 建立新事件
    }
    return { eventId: createAuditCalendarEvent(title, dateText, description, guestEmails), warning: '' };
  } catch (error) {
    return { eventId: String(eventId || ''), warning: '（行事曆同步失敗：' + error.message + '）' };
  }
}

/** 刪除行事曆事件；失敗時回警告文字 */
function syncCalendarDelete_(eventId) {
  try {
    deleteAuditCalendarEvent(eventId);
    return '';
  } catch (error) {
    return '（行事曆事件刪除失敗：' + error.message + '）';
  }
}

/** 彙整同步警告：無警告時回「，已同步行事曆」，有則附第一則原因 */
function calendarSyncSuffix_(warnings) {
  const issues = warnings.filter(Boolean);
  return issues.length === 0 ? '，已同步行事曆' : '。' + issues[0];
}

// =============================================
// API：登錄與刪除稽核紀錄
// =============================================

/**
 * 批次登錄稽核紀錄。
 *
 * @param {string[]} stationCodes - 勾選的駐站代碼
 * @param {number} year - 稽核年度（西元）
 * @param {string} [auditDateText] - 實際稽核日期 yyyy/MM/dd（補登時由前端帶入；
 *   省略且 year 為今年時自動填當天，使「上次稽核」可顯示年月日）
 * @returns {string} JSON 回應
 */
function recordAudits(stationCodes, year, auditDateText) {
  try {
    requireAuditor_();
    if (!Array.isArray(stationCodes) || stationCodes.length === 0) {
      return errorResponse_('未選擇任何駐站，請先勾選要登錄的駐站');
    }
    const auditYear = Number(year);
    if (!isValidAuditYear_(auditYear)) {
      return errorResponse_('稽核年度 ' + year + ' 超出可登錄範圍，請確認年度後重試');
    }

    // 稽核日期：明確帶入時須與年度一致；未帶入且登錄今年時自動填當天
    let auditDate = String(auditDateText || '').trim();
    if (auditDate) {
      if (!isValidPlannedDate_(auditDate)) {
        return errorResponse_('稽核日期格式錯誤，請使用 yyyy/MM/dd');
      }
      if (Number(auditDate.slice(0, 4)) !== auditYear) {
        return errorResponse_('稽核日期 ' + auditDate + ' 與年度 ' + auditYear + ' 不一致，請重新選擇');
      }
    } else if (auditYear === Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy'))) {
      auditDate = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd');
    }

    // 以 HR 駐站清單驗證代碼，避免寫入不存在的駐站
    const stationByCode = {};
    getStations().forEach(s => { stationByCode[s.code] = s; });

    const unknown = stationCodes.filter(code => !stationByCode[code]);
    if (unknown.length > 0) {
      return errorResponse_('找不到駐站：' + unknown.join('、') + '，請重新整理後再試');
    }

    const entries = stationCodes.map(code => ({
      stationCode: code,
      stationName: stationByCode[code].name,
      year: auditYear,
      auditDate: auditDate,
      note: '',
    }));

    const result = appendAuditRecords(entries, Session.getActiveUser().getEmail() || '');

    // 完成登錄後清除該年度的排程與其行事曆事件（與中心稽核 recordCenterAudit 一致）。
    // 僅處理「實際寫入」的駐站（略過的代表早有紀錄，排程多半已清）；
    // 涵蓋單卡「登錄完成／補登」與批次動作列登錄兩條路徑，避免排程殘留。
    const recordedCodes = stationCodes.filter(code => result.skipped.indexOf(code) === -1);
    if (recordedCodes.length > 0) {
      const plansByCode = {};
      getAssignments()
        .filter(p => p.year === auditYear)
        .forEach(p => { plansByCode[p.stationCode] = p; });
      recordedCodes.forEach(code => {
        const plan = plansByCode[code];
        if (!plan) return;
        if (plan.calendarEventId) syncCalendarDelete_(plan.calendarEventId);
        removeAssignment(code, auditYear);
      });
    }

    const delta = stationDeltaFor_(stationCodes);
    return successResponse_({
      added: result.added,
      skipped: result.skipped,
      message: result.skipped.length > 0
        ? '已登錄 ' + result.added + ' 間；' + result.skipped.length + ' 間於 ' + auditYear + ' 年已有紀錄，自動略過'
        : '已登錄 ' + result.added + ' 間駐站為 ' + auditYear + ' 年已稽核',
      stations: delta.stations,
      summary: delta.summary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 刪除某駐站某年度的稽核紀錄（更正登錄錯誤用）。
 *
 * @param {string} stationCode
 * @param {number} year
 * @returns {string} JSON 回應
 */
function deleteAuditRecord(stationCode, year) {
  try {
    requireAuditor_();
    const removed = removeAuditRecord(stationCode, Number(year));
    if (!removed) {
      return errorResponse_('找不到 ' + stationCode + ' 於 ' + year + ' 年的稽核紀錄，可能已被刪除');
    }
    const delta = stationDeltaFor_([stationCode]);
    return successResponse_({
      message: '已刪除 ' + stationCode + ' 的 ' + year + ' 年稽核紀錄',
      stations: delta.stations,
      summary: delta.summary,
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 年度合理性檢查：開放歷史補登（下限 MIN_AUDIT_YEAR），上限為明年。
 * 防止前端傳入 0、NaN 或誤植的年份（如 226）汙染紀錄。
 */
function isValidAuditYear_(year) {
  if (isNaN(year)) return false;
  const currentYear = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy'));
  return year >= ENV.MIN_AUDIT_YEAR && year <= currentYear + 1;
}

// =============================================
// API：稽核紀錄匯出／匯入
// =============================================

/**
 * 匯出稽核紀錄為下載檔（CSV 或 Excel）。
 *
 * 回傳 base64 內容，前端轉 Blob 觸發下載——google.script.run 無法直接
 * 觸發瀏覽器下載，但前端的 Blob/URL.createObjectURL 不受 GAS sandbox 限制。
 *
 * @param {string} scope - 'station' | 'center'
 * @param {string} format - 'csv' | 'xlsx'
 * @returns {string} JSON：{ filename, mimeType, contentBase64 }
 */
function exportAuditRecords(scope, format) {
  try {
    const view = getExportView_(scope);
    const rows = recordsToRows(view.records, view.columns);
    const stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmm');
    const baseName = view.label + '稽核紀錄_' + stamp;

    if (format === 'xlsx') {
      const xlsx = buildXlsxFromRows_(rows, view.label + '稽核紀錄');
      return successResponse_({
        filename: baseName + '.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBase64: xlsx,
      });
    }

    // CSV：加 BOM 確保 Excel 開啟中文不亂碼
    const csv = '﻿' + toCsv(rows);
    return successResponse_({
      filename: baseName + '.csv',
      mimeType: 'text/csv',
      contentBase64: Utilities.base64Encode(csv, Utilities.Charset.UTF_8),
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 匯入稽核紀錄（CSV）；合併模式：新增不存在的紀錄、跳過重複，不刪除既有資料。
 *
 * @param {string} scope - 'station' | 'center'
 * @param {string} csvText - 上傳檔案的文字內容
 * @returns {string} JSON：{ added, skipped, invalid, message }
 */
function importAuditRecords(scope, csvText) {
  try {
    requireAuditor_();
    const view = getExportView_(scope);
    const parsed = rowsToRecords(parseCsv(csvText), view.columns);
    if (parsed.missingHeaders.length > 0) {
      return errorResponse_('CSV 缺少必要欄位：' + parsed.missingHeaders.join('、') + '，請使用匯出的檔案格式');
    }

    const checked = scope === 'center'
      ? validateCenterImport_(parsed.records)
      : validateStationImport_(parsed.records);

    const merged = mergeImport(view.records, checked.valid, view.keyFn);
    const added = view.writeFn(merged.toAdd);

    const parts = ['已匯入 ' + added + ' 筆'];
    if (merged.skipped.length > 0) parts.push('跳過重複 ' + merged.skipped.length + ' 筆');
    if (checked.invalid.length > 0) parts.push('格式錯誤略過 ' + checked.invalid.length + ' 筆');
    return successResponse_({
      added: added,
      skipped: merged.skipped.length,
      invalid: checked.invalid.length,
      message: parts.join('，'),
    });
  } catch (error) {
    return errorResponse_(error.message);
  }
}

/**
 * 依範圍提供匯出/匯入所需的紀錄、欄位、去重鍵與寫入函式。
 * 集中於此，匯出與匯入共用同一份範圍定義，不重複實作。
 */
function getExportView_(scope) {
  if (scope === 'center') {
    return {
      label: '中心',
      columns: CENTER_CSV_COLUMNS,
      records: getCenterRecords(),
      keyFn: r => r.typeId + '|' + r.auditDate,
      writeFn: function (toAdd) {
        const recorder = Session.getActiveUser().getEmail() || '';
        let added = 0;
        toAdd.forEach(function (r) { if (appendCenterRecord(r, recorder)) added++; });
        return added;
      },
    };
  }
  return {
    label: '駐站',
    columns: STATION_CSV_COLUMNS,
    records: getAuditRecords(),
    keyFn: r => r.stationCode + '|' + r.year,
    writeFn: function (toAdd) {
      const entries = toAdd.map(r => ({
        stationCode: r.stationCode,
        stationName: r.stationName,
        year: Number(r.year),
        auditDate: r.auditDate || '',
        note: r.note || '',
      }));
      return appendAuditRecords(entries, Session.getActiveUser().getEmail() || '').added;
    },
  };
}

/** 駐站匯入列驗證：年度合法；有日期則格式正確且與年度一致 */
function validateStationImport_(records) {
  const valid = [], invalid = [];
  records.forEach(function (r) {
    const year = Number(r.year);
    const dateOk = !r.auditDate || (isValidPlannedDate_(r.auditDate) && Number(r.auditDate.slice(0, 4)) === year);
    if (!r.stationCode || !isValidAuditYear_(year) || !dateOk) { invalid.push(r); return; }
    valid.push(r);
  });
  return { valid: valid, invalid: invalid };
}

/** 中心匯入列驗證：類型為已知非駐站類型；稽核日期格式正確 */
function validateCenterImport_(records) {
  const valid = [], invalid = [];
  records.forEach(function (r) {
    if (!findCenterTypeDef_(r.typeId) || !isValidPlannedDate_(r.auditDate)) { invalid.push(r); return; }
    valid.push(r);
  });
  return { valid: valid, invalid: invalid };
}

/**
 * 以二維陣列建立 XLSX，回傳 base64。
 * GAS 無原生 XLSX 寫出，改建暫存試算表 → 經 export?format=xlsx 取檔 → 刪暫存。
 */
function buildXlsxFromRows_(rows, sheetTitle) {
  const tempSs = SpreadsheetApp.create('【匯出暫存】' + sheetTitle);
  try {
    const sheet = tempSs.getSheets()[0];
    if (rows.length > 0) {
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      SpreadsheetApp.flush();
    }
    const url = 'https://docs.google.com/spreadsheets/d/' + tempSs.getId() + '/export?format=xlsx';
    const blob = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    }).getBlob();
    return Utilities.base64Encode(blob.getBytes());
  } finally {
    DriveApp.getFileById(tempSs.getId()).setTrashed(true); // 清除暫存檔
  }
}

// =============================================
// 回應格式
// =============================================

function successResponse_(data) {
  return JSON.stringify({ ok: true, data: data });
}

function errorResponse_(message) {
  return JSON.stringify({ ok: false, error: message });
}
