/**
 * station-dispatch-data.test.js — DataService 駐站調派快照讀取與快取測試
 * 執行：node test/station-dispatch-data.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const envCode = fs.readFileSync(path.join(__dirname, '..', 'env.js'), 'utf8');
const dispatchCode = fs.readFileSync(path.join(__dirname, '..', 'StationDispatch.js'), 'utf8');
const dataServiceCode = fs.readFileSync(path.join(__dirname, '..', 'DataService.js'), 'utf8');

function setupTestEnvironment(config = {}) {
  const cacheStore = new Map();
  let putCalls = 0;
  let getCalls = 0;

  const cacheMock = {
    get: function (key) {
      getCalls++;
      return cacheStore.has(key) ? cacheStore.get(key) : null;
    },
    put: function (key, value, ttl) {
      putCalls++;
      cacheStore.set(key, String(value));
    },
    remove: function (key) {
      cacheStore.delete(key);
    },
    _store: cacheStore,
    getPutCalls: () => putCalls,
    getGetCalls: () => getCalls,
    resetCallCounts: () => {
      putCalls = 0;
      getCalls = 0;
    }
  };

  const propertiesStore = new Map(Object.entries(config.properties || {}));
  const propertiesMock = {
    getScriptProperties: function () {
      return {
        getProperty: function (key) {
          return propertiesStore.has(key) ? propertiesStore.get(key) : null;
        },
        setProperty: function (key, val) {
          propertiesStore.set(key, String(val));
        },
        deleteProperty: function (key) {
          propertiesStore.delete(key);
        }
      };
    }
  };

  const sheetsData = config.sheets || [];
  const sheetValueCallCounts = {};

  const sheetObjects = sheetsData.map(function (sheetDef) {
    sheetValueCallCounts[sheetDef.name] = 0;
    return {
      getName: function () {
        return sheetDef.name;
      },
      getLastRow: function () {
        if (sheetDef.throwOnLastRow) throw new Error('Sheet getLastRow error: ' + sheetDef.name);
        return (sheetDef.rows ? sheetDef.rows.length : 0) + 1; // row 1 is header
      },
      getRange: function (startRow, startCol, numRows, numCols) {
        if (sheetDef.throwOnGetRange) throw new Error('Sheet getRange error: ' + sheetDef.name);
        return {
          getValues: function () {
            sheetValueCallCounts[sheetDef.name]++;
            const rows = sheetDef.rows || [];
            return rows.map(function (rowVal) {
              return [rowVal];
            });
          }
        };
      }
    };
  });

  const spreadsheetAppMock = {
    openById: function (id) {
      if (config.openByIdThrows) {
        throw new Error('SpreadsheetApp.openById failed: Permission denied or not found');
      }
      return {
        getSheets: function () {
          return sheetObjects;
        },
        getSheetByName: function (name) {
          if (config.throwOnGetSheetByName && config.throwOnGetSheetByName === name) {
            throw new Error('getSheetByName failed: ' + name);
          }
          const found = sheetObjects.find(function (s) {
            return s.getName() === name;
          });
          return found || null;
        }
      };
    }
  };

  const utilitiesMock = {
    formatDate: function (date, timeZone, format) {
      const d = new Date(date);
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).formatToParts(d);
      const m = Object.fromEntries(parts.map(function (p) { return [p.type, p.value]; }));
      return m.year + '-' + m.month + '-' + m.day + ' ' + m.hour + ':' + m.minute + ':' + m.second;
    },
    newBlob: function (text) {
      return {
        getBytes: function () {
          return Buffer.from(String(text), 'utf8');
        }
      };
    }
  };

  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    SpreadsheetApp: spreadsheetAppMock,
    CacheService: {
      getScriptCache: function () {
        return cacheMock;
      }
    },
    PropertiesService: propertiesMock,
    Utilities: utilitiesMock,
    Session: {
      getScriptTimeZone: () => 'Asia/Taipei'
    },
    Date: Date,
    Math: Math,
    JSON: JSON,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    Boolean: Boolean,
    RegExp: RegExp,
    Error: Error,
    TypeError: TypeError
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(envCode + '\n' + dispatchCode + '\n' + dataServiceCode, context);

  return {
    context: context,
    cache: cacheMock,
    sheetValueCallCounts: sheetValueCallCounts,
    properties: propertiesStore
  };
}

// -------------------------------------------------------------
// 測試案例
// -------------------------------------------------------------

console.log('--- 測試 1: 正常讀取跨年度紀錄、測試表過濾、去重與 ready 狀態 ---');
{
  const rawD1 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    originalStationCode: 'GRP-CO-B01',
    startDate: '2024-12-30',
    endDate: '2026-01-03',
    nurseName: '王小美',
    assignmentStatus: '已指派'
  };

  const rawD2 = {
    id: 'd2',
    status: '有效',
    stationCode: 'GRP-CO-A02',
    startDate: '2025-06-01',
    endDate: '2025-06-30', // 不與 2026 重疊
    nurseName: '陳大文',
    assignmentStatus: '已指派'
  };

  const rawD3 = {
    id: 'd3',
    status: '有效',
    stationCode: 'GRP-CO-A03',
    startDate: '2026-03-01',
    endDate: '2026-03-10',
    nurseName: '待指派',
    assignmentStatus: '待指派',
    demandCount: 2
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '工作表1', rows: ['{}'] },
      { name: '測試表', rows: ['{}'] },
      { name: '調派紀錄_2024', rows: [JSON.stringify(rawD1)] },
      { name: '調派紀錄_2025', rows: [JSON.stringify(rawD2)] },
      { name: '調派紀錄_2026', rows: [JSON.stringify(rawD3)] },
      { name: '調派紀錄_測試', rows: ['{}'] }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'ready', '完整年度且無損毀列時狀態應為 ready');
  assert.deepStrictEqual(Array.from(snapshot.loadedYears), [2024, 2025, 2026], 'loadedYears 應為 [2024, 2025, 2026]');
  assert.deepStrictEqual(Array.from(snapshot.missingYears), [], 'missingYears 應為空陣列');
  assert.strictEqual(snapshot.dispatches.filter(r => r.id === 'd1').length, 1, '跨到 2026 的 d1 應存在');
  assert.strictEqual(snapshot.dispatches[0].endDate, '2026-01-03', 'd1 的 endDate 應為 2026-01-03');
  assert.strictEqual(snapshot.dispatches.filter(r => r.id === 'd2').length, 0, '僅涵蓋 2025 的 d2 不應出現在 2026 快照');
  assert.strictEqual(snapshot.dispatches.filter(r => r.id === 'd3').length, 1, '2026 當年度的 d3 應存在');
  assert.ok(snapshot.fetchedAt, 'fetchedAt 應有值');
}

console.log('--- 測試 2: 未設定試算表 ID 時回傳 notConfigured ---');
{
  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: ''
    },
    sheets: []
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'notConfigured');
  assert.deepStrictEqual(Array.from(snapshot.loadedYears), []);
  assert.deepStrictEqual(Array.from(snapshot.missingYears), []);
  assert.deepStrictEqual(Array.from(snapshot.dispatches), []);
  assert.strictEqual(snapshot.fetchedAt, '');
}

console.log('--- 測試 3: 來源試算表 openById 拋錯時回傳 unavailable ---');
{
  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'invalid-or-unauthorized-id'
    },
    openByIdThrows: true
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'unavailable');
  assert.deepStrictEqual(Array.from(snapshot.loadedYears), []);
  assert.deepStrictEqual(Array.from(snapshot.missingYears), []);
  assert.deepStrictEqual(Array.from(snapshot.dispatches), []);
}

console.log('--- 測試 4: 中間年度缺表得 partial 與 missingYears ---');
{
  const rawD1 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2024-12-30',
    endDate: '2026-01-03',
    nurseName: '王小美',
    assignmentStatus: '已指派'
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2024', rows: [JSON.stringify(rawD1)] },
      // 缺 2025
      { name: '調派紀錄_2026', rows: [] }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'partial', '缺 2025 表應為 partial');
  assert.deepStrictEqual(Array.from(snapshot.missingYears), [2025], 'missingYears 應包含 2025');
  assert.deepStrictEqual(Array.from(snapshot.loadedYears), [2024, 2026], 'loadedYears 應為 [2024, 2026]');
}

console.log('--- 測試 5: 單列壞 JSON 或無效資料得 partial ---');
{
  const rawValid = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2026-01-01',
    endDate: '2026-01-02'
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      {
        name: '調派紀錄_2026',
        rows: [
          JSON.stringify(rawValid),
          'INVALID_JSON_{{{',
          JSON.stringify({ id: 'bad1', status: '有效' }) // 缺日期與 stationCode，normalize 回傳 null
        ]
      }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'partial', '有損毀列或無效列時狀態應為 partial');
  assert.strictEqual(snapshot.dispatches.length, 1, '合法紀錄仍應回傳');
  assert.strictEqual(snapshot.dispatches[0].id, 'd1');
}

console.log('--- 測試 6: 快取與 forceRefresh 行為 ---');
{
  const rawD1 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2026-01-01',
    endDate: '2026-01-02'
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2026', rows: [JSON.stringify(rawD1)] }
    ]
  });

  // 第一次讀取：未快取，呼叫 getValues
  const snap1 = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snap1.state, 'ready');
  assert.strictEqual(env.sheetValueCallCounts['調派紀錄_2026'], 1, '第一次應呼叫 1 次 getValues');
  assert.strictEqual(env.cache.getPutCalls(), 1, '第一次應寫入快取 1 次');

  // 第二次讀取：forceRefresh = false，快取命中，不再呼叫 getValues
  const snap2 = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snap2.state, 'ready');
  assert.strictEqual(env.sheetValueCallCounts['調派紀錄_2026'], 1, '快取命中時不應再次呼叫 getValues');

  // 第三次讀取：forceRefresh = true，略過快取，重新呼叫 getValues
  const snap3 = env.context.getYearStationDispatchSnapshot(2026, true);
  assert.strictEqual(snap3.state, 'ready');
  assert.strictEqual(env.sheetValueCallCounts['調派紀錄_2026'], 2, 'forceRefresh = true 應再次呼叫 getValues');
  assert.strictEqual(env.cache.getPutCalls(), 2, 'forceRefresh = true 應再次更新快取');
}

console.log('--- 測試 7: 超過 100 KB 的年度資料仍正常回傳且不呼叫 cache.put ---');
{
  // 建立大於 100 KB 的年度資料
  const bigRows = [];
  for (let i = 0; i < 500; i++) {
    bigRows.push(JSON.stringify({
      id: 'big_' + i,
      status: '有效',
      stationCode: 'GRP-CO-A01',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      note: 'X'.repeat(250) // 每列約 300+ bytes，500 列超過 150 KB
    }));
  }

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2026', rows: bigRows }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'ready');
  assert.strictEqual(snapshot.dispatches.length, 500, '500 筆資料應全數回傳');
  assert.strictEqual(env.cache.getPutCalls(), 0, '超過 100 KB 時不得呼叫 cache.put');
}

console.log('--- 測試 8: 個別工作表讀取失敗得 partial ---');
{
  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2025', rows: [] },
      { name: '調派紀錄_2026', rows: [], throwOnLastRow: true }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'partial', '個別工作表讀取失敗時狀態應為 partial');
  assert.deepStrictEqual(Array.from(snapshot.loadedYears), [2025], '成功讀取的年度應在 loadedYears');
}

console.log('--- 測試 9: 非法年度查詢拋錯 ---');
{
  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: []
  });

  assert.throws(
    () => env.context.getYearStationDispatchSnapshot(1999, false),
    /調派查詢年度須為 2000–2100/,
    '1999 應拋出年度邊界錯誤'
  );
  assert.throws(
    () => env.context.getYearStationDispatchSnapshot('abc', false),
    /調派查詢年度須為 2000–2100/,
    '非數字年度應拋出錯誤'
  );
}

console.log('--- 測試 10: 無任何符合命名之年度表時回傳 partial 與 missingYears: [year] ---');
{
  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '工作表1', rows: [] },
      { name: '測試表_2026', rows: [] }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'partial', '無任何符合命名之年度表時狀態應為 partial');
  assert.deepStrictEqual(Array.from(snapshot.missingYears), [2026]);
  assert.deepStrictEqual(Array.from(snapshot.loadedYears), []);
  assert.deepStrictEqual(Array.from(snapshot.dispatches), []);
}

console.log('--- 測試 11: fetchedAt 取所用年度中最早的取得時間 ---');
{
  const rawD1 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2024-01-01',
    endDate: '2026-12-31'
  };
  const rawD2 = {
    id: 'd2',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2025-01-01',
    endDate: '2026-12-31'
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2024', rows: [JSON.stringify(rawD1)] },
      { name: '調派紀錄_2025', rows: [JSON.stringify(rawD2)] }
    ]
  });

  // 手動先在快取中放入 2024，時間為較早的 2026-10-07 08:00:00
  env.cache.put(
    'audit_station_dispatch_v1_sheet-twcohort-123_2024',
    JSON.stringify({
      records: [env.context.normalizeStationDispatchRecord(rawD1)],
      invalidRows: 0,
      fetchedAt: '2026-10-07 08:00:00'
    }),
    300
  );

  const snapshot = env.context.getYearStationDispatchSnapshot(2025, false);
  assert.strictEqual(snapshot.state, 'ready');
  assert.strictEqual(snapshot.fetchedAt, '2026-10-07 08:00:00', '快照 fetchedAt 應取最早取得時間');
}

console.log('--- 測試 12: 跨年度相同 id 紀錄去重 ---');
{
  const rawD1_2024 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2024-01-01',
    endDate: '2026-12-31',
    note: '2024 版本'
  };
  const rawD1_2025 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2024-01-01',
    endDate: '2026-12-31',
    note: '2025 更新版'
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2024', rows: [JSON.stringify(rawD1_2024)] },
      { name: '調派紀錄_2025', rows: [JSON.stringify(rawD1_2025)] }
    ]
  });

  const snapshot = env.context.getYearStationDispatchSnapshot(2025, false);
  assert.strictEqual(snapshot.state, 'ready');
  assert.strictEqual(snapshot.dispatches.length, 1, '同 id 應被去重為 1 筆');
  assert.strictEqual(snapshot.dispatches[0].id, 'd1');
  assert.strictEqual(snapshot.dispatches[0].note, '2025 更新版', '後讀取年度應覆蓋前年度同 id');
}

console.log('--- 測試 13: 損毀快取降級重新讀取工作表 ---');
{
  const rawD1 = {
    id: 'd1',
    status: '有效',
    stationCode: 'GRP-CO-A01',
    startDate: '2026-01-01',
    endDate: '2026-01-02'
  };

  const env = setupTestEnvironment({
    properties: {
      TWCOHORT_SPREADSHEET_ID: 'sheet-twcohort-123'
    },
    sheets: [
      { name: '調派紀錄_2026', rows: [JSON.stringify(rawD1)] }
    ]
  });

  // 塞入損毀的快取（不合法 JSON 或缺少必要欄位）
  env.cache.put('audit_station_dispatch_v1_sheet-twcohort-123_2026', 'CORRUPTED_CACHE_JSON', 300);

  const snapshot = env.context.getYearStationDispatchSnapshot(2026, false);
  assert.strictEqual(snapshot.state, 'ready', '損毀快取應重新自工作表讀取並成功解析');
  assert.strictEqual(snapshot.dispatches.length, 1);
  assert.strictEqual(snapshot.dispatches[0].id, 'd1');
  assert.strictEqual(env.sheetValueCallCounts['調派紀錄_2026'], 1, '應降級呼叫工作表 getValues');
}

console.log('✓ All station-dispatch-data tests defined and passed.');
