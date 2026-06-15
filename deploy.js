/**
 * deploy.js — 後端工作表初始化
 *
 * 新環境部署或升級後，在 GAS 編輯器手動執行 deployAllSheets() 一次。
 * 已存在的工作表不會被覆蓋，重複執行安全。
 */

const SHEET_BLUEPRINTS = [
  {
    name: SHEET_NAMES.AUDIT_RECORDS,
    headers: ['駐站代碼', '駐站名稱', '稽核年度', '登錄人', '登錄時間', '備註', '稽核日期'],
    notes: [
      'FK → 組織架構樹.代碼（GRP-CO- 開頭）',
      '冗餘欄，提高人工檢視可讀性',
      '西元年，如 2026',
      '執行登錄操作者的 Email',
      'yyyy/MM/dd HH:mm:ss',
      '選填',
      'yyyy/MM/dd；空值 = 僅知年度（早期資料）',
    ],
    headerColor: '#1f3a2e',
    // 欄位格式：駐站代碼強制文字、年度強制整數，避免 Sheets 自動轉型
    textColumns: [COL.AUDIT.STATION_CODE, COL.AUDIT.AUDIT_DATE],
    integerColumns: [COL.AUDIT.YEAR],
  },
  {
    name: SHEET_NAMES.AUDIT_PLANS,
    headers: ['駐站代碼', '駐站名稱', '稽核年度', '稽核人員姓名', '稽核人員信箱', '預計稽核日期', '分派人', '分派時間', '行事曆事件ID'],
    notes: [
      'FK → 組織架構樹.代碼（GRP-CO- 開頭）',
      '冗餘欄，提高人工檢視可讀性',
      '西元年，如 2026',
      '多人以頓號（、）分隔',
      '多人以逗號（,）分隔，供程式比對',
      'yyyy/MM/dd',
      '執行分派操作者的 Email',
      'yyyy/MM/dd HH:mm:ss',
      'Google Calendar 事件 ID，系統同步用，請勿手動修改',
    ],
    headerColor: '#2c4a66',
    textColumns: [COL.PLAN.STATION_CODE, COL.PLAN.PLANNED_DATE],
    integerColumns: [COL.PLAN.YEAR],
  },
  {
    name: SHEET_NAMES.CENTER_RECORDS,
    headers: ['項目代碼', '項目名稱', '稽核日期', '稽核人員姓名', '事由說明', '登錄人', '登錄時間', '備註'],
    notes: [
      'AUDIT_TYPE_DEFS 的 id（RECRUIT / WITHDRAW / DEIDENT / INFOSEC / DBUSE / ORG / ADHOC）',
      '冗餘欄，提高人工檢視可讀性',
      'yyyy/MM/dd（實際執行稽核的日期）',
      '多人以頓號（、）分隔',
      '類型 7（組織與人員）/ 8（不定期）填寫稽核事由',
      '執行登錄操作者的 Email',
      'yyyy/MM/dd HH:mm:ss',
      '選填',
    ],
    headerColor: '#1f3a2e',
    textColumns: [COL.CENTER_RECORD.TYPE_ID, COL.CENTER_RECORD.AUDIT_DATE],
    integerColumns: [],
  },
  {
    name: SHEET_NAMES.CENTER_PLANS,
    headers: ['項目代碼', '項目名稱', '預定日期', '稽核人員姓名', '稽核人員信箱', '事由說明', '分派人', '分派時間', '行事曆事件ID'],
    notes: [
      'AUDIT_TYPE_DEFS 的 id；每類型同時只保留一筆有效排程',
      '冗餘欄，提高人工檢視可讀性',
      'yyyy/MM/dd',
      '多人以頓號（、）分隔',
      '多人以逗號（,）分隔，供程式比對',
      '類型 7 / 8 填寫排定事由',
      '執行排定操作者的 Email',
      'yyyy/MM/dd HH:mm:ss',
      'Google Calendar 事件 ID，系統同步用，請勿手動修改',
    ],
    headerColor: '#2c4a66',
    textColumns: [COL.CENTER_PLAN.TYPE_ID, COL.CENTER_PLAN.PLANNED_DATE],
    integerColumns: [],
  },
  {
    name: SHEET_NAMES.TRIGGER_EVENTS,
    headers: ['事件ID', '事件日期', '事由類別', '說明', '登錄人', '登錄時間'],
    notes: [
      '系統生成的唯一鍵，請勿手動修改',
      'yyyy/MM/dd（事由發生日）',
      '設置許可展延／設置許可變更／倫理委員會組成變動／資料庫人員異動／其他',
      '事由補充說明',
      '執行登記操作者的 Email',
      'yyyy/MM/dd HH:mm:ss',
    ],
    headerColor: '#b98a2f',
    textColumns: [COL.TRIGGER.EVENT_ID, COL.TRIGGER.EVENT_DATE],
    integerColumns: [],
  },
];

/**
 * 依藍圖建立所有後端工作表（含表頭、欄位註解、格式設定）。
 * 在 GAS 編輯器中手動執行。
 */
function deployAllSheets() {
  const ss = getAuditSpreadsheet_();
  SHEET_BLUEPRINTS.forEach(function (blueprint) {
    createSheetFromBlueprint_(ss, blueprint);
  });
}

/**
 * 升級既有工作表：補上新版藍圖中缺漏的表頭欄位（v5 起新增
 * 「稽核日期」「行事曆事件ID」）。既有資料列不受影響，新欄位留空。
 * 從舊版升級時在 GAS 編輯器手動執行一次；重複執行安全。
 */
function upgradeSheets() {
  const ss = getAuditSpreadsheet_();
  SHEET_BLUEPRINTS.forEach(function (blueprint) {
    const sheet = ss.getSheetByName(blueprint.name);
    if (!sheet) {
      createSheetFromBlueprint_(ss, blueprint); // 全新環境直接建立
      return;
    }
    const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    blueprint.headers.forEach(function (header, colIndex) {
      if (existingHeaders[colIndex] === header) return;
      const cell = sheet.getRange(1, colIndex + 1);
      cell.setValue(header);
      cell.setBackground(blueprint.headerColor);
      cell.setFontColor('#ffffff');
      cell.setFontWeight('bold');
      cell.setNote(blueprint.notes[colIndex] || '');
      Logger.log('[upgrade] ' + blueprint.name + '：補上表頭「' + header + '」（第 ' + (colIndex + 1) + ' 欄）');
    });
  });
  Logger.log('[upgrade] 工作表升級完成');
}

function createSheetFromBlueprint_(ss, blueprint) {
  if (ss.getSheetByName(blueprint.name)) {
    Logger.log('[deploy] 工作表「' + blueprint.name + '」已存在，略過建立');
    return;
  }

  const sheet = ss.insertSheet(blueprint.name);
  const headerRange = sheet.getRange(1, 1, 1, blueprint.headers.length);
  headerRange.setValues([blueprint.headers]);
  headerRange.setBackground(blueprint.headerColor);
  headerRange.setFontColor('#ffffff');
  headerRange.setFontWeight('bold');
  headerRange.setNotes([blueprint.notes]);
  sheet.setFrozenRows(1);

  const bodyRows = sheet.getMaxRows() - 1;
  (blueprint.textColumns || []).forEach(function (colIndex) {
    sheet.getRange(2, colIndex + 1, bodyRows, 1).setNumberFormat('@');
  });
  (blueprint.integerColumns || []).forEach(function (colIndex) {
    sheet.getRange(2, colIndex + 1, bodyRows, 1).setNumberFormat('0');
  });

  Logger.log('[deploy] 工作表「' + blueprint.name + '」建立完成');
}
