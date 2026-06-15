/**
 * CsvUtil.js — CSV 序列化／解析與匯入合併（純函式，node 可測）
 *
 * 不碰任何 GAS API：序列化、RFC 4180 解析、合併去重全部在此，
 * 讓匯出/匯入的格式正確性可在本機用 node 驗證（test/csv-util.test.js）。
 * code.js 只負責讀寫試算表與組裝下載 blob。
 */

/**
 * 匯出欄位定義：header 為 CSV 表頭、key 為紀錄物件屬性。
 * 匯入時以 header 比對檔案表頭，再用 key 還原為紀錄物件。
 */
const STATION_CSV_COLUMNS = [
  { header: '駐站代碼', key: 'stationCode' },
  { header: '駐站名稱', key: 'stationName' },
  { header: '稽核年度', key: 'year' },
  { header: '稽核日期', key: 'auditDate' },
  { header: '登錄人', key: 'recorder' },
  { header: '備註', key: 'note' },
];

const CENTER_CSV_COLUMNS = [
  { header: '項目代碼', key: 'typeId' },
  { header: '項目名稱', key: 'typeName' },
  { header: '稽核日期', key: 'auditDate' },
  { header: '稽核人員', key: 'auditorNames' },
  { header: '事由', key: 'reason' },
  { header: '備註', key: 'note' },
];

/** 單一欄位 escape：含逗號／雙引號／換行時以雙引號包覆，內部雙引號倍寫 */
function escapeCsvField(value) {
  const text = (value === null || value === undefined) ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/**
 * 二維字串陣列 → CSV 文字（以 CRLF 分行，符合 Excel 慣例）。
 * @param {Array<Array>} rows2d
 * @returns {string}
 */
function toCsv(rows2d) {
  return rows2d.map(row => row.map(escapeCsvField).join(',')).join('\r\n');
}

/**
 * 紀錄物件陣列 → 含表頭的二維陣列（供 toCsv）。
 * @param {Array<Object>} records
 * @param {Array<{header, key}>} columns
 * @returns {Array<Array>}
 */
function recordsToRows(records, columns) {
  const header = columns.map(c => c.header);
  const body = records.map(rec => columns.map(c => {
    const v = rec[c.key];
    return (v === null || v === undefined) ? '' : v;
  }));
  return [header].concat(body);
}

/**
 * RFC 4180 CSV 解析（純函式，與 GAS Utilities.parseCsv 行為一致但可在 node 測試）。
 * 處理引號包覆、引號倍寫、欄內逗號與換行；忽略 UTF-8 BOM。
 *
 * @param {string} text
 * @returns {Array<Array<string>>}
 */
function parseCsv(text) {
  const input = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; } // CRLF 的 CR 略過，由 \n 收列
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // 收尾最後一欄/列（檔案未必以換行結束）
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * 將解析後的 CSV 列（含表頭）轉為紀錄物件，依欄位定義對應。
 * 表頭順序不需與定義相同——以 header 名稱定位欄位索引，缺欄回空字串。
 *
 * @param {Array<Array<string>>} rows - parseCsv 結果（首列為表頭）
 * @param {Array<{header, key}>} columns
 * @returns {{records: Array<Object>, missingHeaders: string[]}}
 */
function rowsToRecords(rows, columns) {
  if (!rows || rows.length === 0) return { records: [], missingHeaders: columns.map(c => c.header) };
  const headerRow = rows[0].map(h => String(h).trim());
  const indexByKey = {};
  const missingHeaders = [];
  columns.forEach(function (col) {
    const idx = headerRow.indexOf(col.header);
    if (idx === -1) missingHeaders.push(col.header);
    else indexByKey[col.key] = idx;
  });

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && String(cells[0]).trim() === '') continue; // 略過空行
    const rec = {};
    columns.forEach(function (col) {
      const idx = indexByKey[col.key];
      rec[col.key] = (idx === undefined || idx >= cells.length) ? '' : String(cells[idx]).trim();
    });
    records.push(rec);
  }
  return { records: records, missingHeaders: missingHeaders };
}

/**
 * 合併去重：把 incoming 中「現有資料未有、且同批未重複」的紀錄挑出。
 * 純函式——不寫入任何儲存，只回報該新增與該跳過的清單。
 *
 * @param {Array<Object>} existing - 現有紀錄
 * @param {Array<Object>} incoming - 待匯入紀錄
 * @param {function(Object): string} keyFn - 去重鍵（駐站＝代碼+年度；中心＝類型+日期）
 * @returns {{toAdd: Array<Object>, skipped: Array<Object>}}
 */
function mergeImport(existing, incoming, keyFn) {
  const seen = {};
  existing.forEach(function (rec) { seen[keyFn(rec)] = true; });

  const toAdd = [];
  const skipped = [];
  incoming.forEach(function (rec) {
    const key = keyFn(rec);
    if (seen[key]) { skipped.push(rec); return; }
    seen[key] = true; // 同批內也去重
    toAdd.push(rec);
  });
  return { toAdd: toAdd, skipped: skipped };
}

// 供 node 本機測試使用；GAS 環境無 module 物件，此區塊不會執行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATION_CSV_COLUMNS, CENTER_CSV_COLUMNS,
    escapeCsvField, toCsv, recordsToRows, parseCsv, rowsToRecords, mergeImport,
  };
}
