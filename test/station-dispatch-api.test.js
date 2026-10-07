/**
 * test/station-dispatch-api.test.js — 儀表板與駐站調派快照 API 測試
 * 執行：node test/station-dispatch-api.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const envCode = fs.readFileSync(path.join(__dirname, '..', 'env.js'), 'utf8');
const stationDispatchCode = fs.readFileSync(path.join(__dirname, '..', 'StationDispatch.js'), 'utf8');
const centerAuditCode = fs.readFileSync(path.join(__dirname, '..', 'CenterAudit.js'), 'utf8');
const codeCode = fs.readFileSync(path.join(__dirname, '..', 'code.js'), 'utf8');

function setupApiContext(options = {}) {
  let currentUserEmail = options.email || 'auditor@example.com';
  let currentUserRole = options.role || 'AUDITOR';
  const snapshotCalls = [];

  let snapshotImpl = options.snapshotImpl || function (year, forceRefresh) {
    return {
      year: year,
      state: 'ready',
      loadedYears: [2024, 2025, 2026],
      missingYears: [],
      fetchedAt: '2026-10-07T08:00:00.000Z',
      dispatches: [
        {
          id: 'D-2026-001',
          sourceYear: 2026,
          stationCode: 'S01',
          stationName: '台北站',
          dispatchDate: '2026/03/15',
          duration: '全天',
          primaryStaff: '王大明',
          primaryLeader: '陳主任',
          supportStaff: '李小美',
          supportLeader: '林組長',
          audited: '否'
        }
      ]
    };
  };

  const sandbox = {
    console: console,
    TRIGGER_CATEGORIES: ['設置許可展延', '設置許可變更', '倫理委員會組成變動', '資料庫人員異動', '其他'],
    Session: {
      getActiveUser: function () {
        return {
          getEmail: function () {
            return currentUserEmail;
          }
        };
      }
    },
    Utilities: {
      formatDate: function (date, tz, format) {
        if (format === 'yyyy') return '2026';
        if (format === 'MM') return '10';
        return '2026-10-07';
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(envCode, sandbox);
  sandbox.USER_ROLES = vm.runInContext('USER_ROLES', sandbox);
  vm.runInContext(stationDispatchCode, sandbox);
  vm.runInContext(centerAuditCode, sandbox);
  vm.runInContext(codeCode, sandbox);

  // 替身函式：在 code.js 載入後覆蓋，避免被原始宣告覆寫
  sandbox.getUserRole_ = function (email) {
    return currentUserRole;
  };
  sandbox.getYearStationDispatchSnapshot_ = function (year, forceRefresh) {
    snapshotCalls.push({ year, forceRefresh });
    return snapshotImpl(year, forceRefresh);
  };
  sandbox.buildStationDashboardCore_ = function () {
    return {
      currentYear: 2026,
      mode: 'NORMAL',
      cycleStartYear: 2024,
      cycle: { cycleStartYear: 2024, currentCycleYear: 3 },
      certifiedCycle: { cycleStartYear: 2025, currentCycleYear: 2 },
      evaluated: [
        { code: 'S01', name: '台北站', isCertified: false, isOutsourced: false },
        { code: 'S02', name: '台中站', isCertified: true, isOutsourced: false },
        { code: 'S03', name: '外包站', isCertified: false, isOutsourced: true }
      ],
      summary: { total: 3, audited: 1, plannedThisYear: 1, auditedThisYear: 1 }
    };
  };
  sandbox.buildCenterDashboard_ = function (today, cycleStartYear, mode) {
    return {
      types: [{ id: 2, name: '年度中心稽核' }],
      summary: { total: 1, compliant: 1 }
    };
  };
  sandbox.getAuditors = function () {
    return [{ name: '測試稽核員', email: 'auditor@example.com' }];
  };

  return {
    sandbox,
    USER_ROLES: sandbox.USER_ROLES,
    snapshotCalls,
    setUser: (email, role) => {
      currentUserEmail = email;
      currentUserRole = role;
    },
    setSnapshotImpl: (impl) => {
      snapshotImpl = impl;
    }
  };
}

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    throw err;
  }
}

// -------------------------------------------------------------
// 測試項目
// -------------------------------------------------------------

test('1. FORBIDDEN 使用者呼叫 getStationDispatchSnapshot 應回傳 ok:false 且不觸發讀取', () => {
  const { sandbox, snapshotCalls, setUser, USER_ROLES } = setupApiContext();
  assert.strictEqual(typeof sandbox.getStationDispatchSnapshot, 'function', 'getStationDispatchSnapshot 必須已定義');
  setUser('forbidden@example.com', USER_ROLES.FORBIDDEN);

  const rawRes = sandbox.getStationDispatchSnapshot(2026, false);
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, false, 'FORBIDDEN 角色呼叫應回傳 ok: false');
  assert.strictEqual(res.error, '權限不足', '錯誤訊息應為權限不足');
  assert.strictEqual(snapshotCalls.length, 0, '權限被擋下時不得觸發讀取');
});

test('2. AUDITOR 呼叫 getStationDispatchSnapshot(2026, true) 得 ok:true 且收到 forceRefresh:true', () => {
  const { sandbox, snapshotCalls, setUser } = setupApiContext();
  assert.strictEqual(typeof sandbox.getStationDispatchSnapshot, 'function', 'getStationDispatchSnapshot 必須已定義');
  setUser('auditor@example.com', sandbox.USER_ROLES.AUDITOR);

  const rawRes = sandbox.getStationDispatchSnapshot(2026, true);
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, true, 'AUDITOR 呼叫應回傳 ok: true');
  assert(res.data, '應有 data');
  assert.strictEqual(res.data.year, 2026, '資料年度應為 2026');
  assert.strictEqual(res.data.state, 'ready');
  assert.strictEqual(snapshotCalls.length, 1, '應呼叫一次底層快照讀取');
  assert.strictEqual(snapshotCalls[0].year, 2026, '傳入年度應為數字 2026');
  assert.strictEqual(snapshotCalls[0].forceRefresh, true, '傳入 forceRefresh 應為 true');
});

test('3. VIEWER 角色呼叫 getStationDispatchSnapshot(2026) 亦可唯讀讀取，未傳 forceRefresh 時為 false', () => {
  const { sandbox, snapshotCalls, setUser } = setupApiContext();
  assert.strictEqual(typeof sandbox.getStationDispatchSnapshot, 'function', 'getStationDispatchSnapshot 必須已定義');
  setUser('viewer@example.com', sandbox.USER_ROLES.VIEWER);

  const rawRes = sandbox.getStationDispatchSnapshot('2026');
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, true, 'VIEWER 呼叫應回傳 ok: true');
  assert.strictEqual(snapshotCalls.length, 1);
  assert.strictEqual(snapshotCalls[0].year, 2026);
  assert.strictEqual(snapshotCalls[0].forceRefresh, false, 'forceRefresh 預設應為 false');
});

test('4. 非法年度呼叫 getStationDispatchSnapshot 應回傳 ok:false 且不觸發讀取', () => {
  const { sandbox, snapshotCalls, setUser } = setupApiContext();
  assert.strictEqual(typeof sandbox.getStationDispatchSnapshot, 'function', 'getStationDispatchSnapshot 必須已定義');
  setUser('auditor@example.com', sandbox.USER_ROLES.AUDITOR);

  const invalidYears = [1999, 2101, 'abc', null, undefined, '', 2026.5];
  invalidYears.forEach(year => {
    snapshotCalls.length = 0;
    const rawRes = sandbox.getStationDispatchSnapshot(year, false);
    const res = JSON.parse(rawRes);
    assert.strictEqual(res.ok, false, `非法年度 ${year} 應回傳 ok: false`);
    assert.strictEqual(res.error, '調派查詢年度須為 2000–2100', `非法年度 ${year} 錯誤訊息不符`);
    assert.strictEqual(snapshotCalls.length, 0, `非法年度 ${year} 不得呼叫底層讀取`);
  });
});

test('5. 底層拋出未預期例外時，getStationDispatchSnapshot 回傳 ok:false 與優雅錯誤訊息', () => {
  const { sandbox, setSnapshotImpl, setUser } = setupApiContext();
  assert.strictEqual(typeof sandbox.getStationDispatchSnapshot, 'function', 'getStationDispatchSnapshot 必須已定義');
  setUser('auditor@example.com', sandbox.USER_ROLES.AUDITOR);
  setSnapshotImpl(() => {
    throw new Error('試算表服務嚴重逾時');
  });

  const rawRes = sandbox.getStationDispatchSnapshot(2026, false);
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, false, '底層拋錯時應回傳 ok: false');
  assert.strictEqual(res.error, '調派資料暫不可用', '錯誤訊息應為調派資料暫不可用');
});

test('6. getAuditDashboard 正常回應應包含 dispatchSnapshot 且保留既有儀表板欄位', () => {
  const { sandbox, snapshotCalls, setUser } = setupApiContext();
  setUser('auditor@example.com', sandbox.USER_ROLES.AUDITOR);

  const rawRes = sandbox.getAuditDashboard();
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, true, 'getAuditDashboard 應回傳 ok: true');
  assert(res.data, '應有 data');
  assert.strictEqual(res.data.currentYear, 2026);
  assert.strictEqual(res.data.summary.total, 3, '原有 summary 應存在');
  assert(Array.isArray(res.data.normalStations), 'normalStations 應存在');
  assert(Array.isArray(res.data.certifiedStations), 'certifiedStations 應存在');
  assert(Array.isArray(res.data.outsourcedStations), 'outsourcedStations 應存在');
  assert(res.data.dispatchSnapshot, 'data 應包含 dispatchSnapshot');
  assert.strictEqual(res.data.dispatchSnapshot.year, 2026);
  assert.strictEqual(res.data.dispatchSnapshot.state, 'ready');
  assert.strictEqual(res.data.dispatchSnapshot.dispatches.length, 1);
  assert.strictEqual(snapshotCalls.length, 1, '儀表板載入應呼叫一次快照');
  assert.strictEqual(snapshotCalls[0].year, 2026);
  assert.strictEqual(snapshotCalls[0].forceRefresh, false, '儀表板載入 forceRefresh 應為 false');
});

test('7. 來源回傳 state:unavailable 時，getAuditDashboard 仍 ok:true 且原有 summary 存在', () => {
  const { sandbox, setSnapshotImpl, setUser } = setupApiContext();
  setUser('auditor@example.com', sandbox.USER_ROLES.AUDITOR);
  setSnapshotImpl((year) => ({
    year: year,
    state: 'unavailable',
    loadedYears: [],
    missingYears: [],
    fetchedAt: '',
    dispatches: []
  }));

  const rawRes = sandbox.getAuditDashboard();
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, true, '來源不可用時 getAuditDashboard 仍應 ok: true');
  assert(res.data.summary, '原有 summary 仍應存在');
  assert.strictEqual(res.data.summary.total, 3);
  assert(res.data.dispatchSnapshot, 'dispatchSnapshot 應存在');
  assert.strictEqual(res.data.dispatchSnapshot.state, 'unavailable');
  assert.deepStrictEqual(res.data.dispatchSnapshot.dispatches, []);
});

test('8. 底層拋出非預期例外時，getAuditDashboard 局部 catch 並降級為 unavailable，不中斷儀表板', () => {
  const { sandbox, setSnapshotImpl, setUser } = setupApiContext();
  setUser('auditor@example.com', sandbox.USER_ROLES.AUDITOR);
  setSnapshotImpl(() => {
    throw new Error('未預期的致命網路錯誤');
  });

  const rawRes = sandbox.getAuditDashboard();
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, true, '例外拋出時 getAuditDashboard 仍應成功');
  assert(res.data.summary, '原有 summary 仍應存在');
  assert(res.data.dispatchSnapshot, 'dispatchSnapshot 應存在');
  assert.strictEqual(res.data.dispatchSnapshot.state, 'unavailable');
  assert.strictEqual(res.data.dispatchSnapshot.year, 2026);
  assert.deepStrictEqual(res.data.dispatchSnapshot.loadedYears, []);
  assert.deepStrictEqual(res.data.dispatchSnapshot.missingYears, []);
  assert.deepStrictEqual(res.data.dispatchSnapshot.dispatches, []);
});

test('9. FORBIDDEN 使用者呼叫 getAuditDashboard 仍受既有角色閘阻擋', () => {
  const { sandbox, snapshotCalls, setUser } = setupApiContext();
  setUser('forbidden@example.com', sandbox.USER_ROLES.FORBIDDEN);

  const rawRes = sandbox.getAuditDashboard();
  const res = JSON.parse(rawRes);

  assert.strictEqual(res.ok, false, 'FORBIDDEN 呼叫儀表板應 ok: false');
  assert.strictEqual(snapshotCalls.length, 0, '被擋下時不呼叫調派讀取');
});

console.log(`\n全數測試通過 (${passCount}/${passCount}) ✓`);
