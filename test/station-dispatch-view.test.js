'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

console.log('--- 測試 Task 5: 卡片摘要與調派詳情邏輯 ---');

// 從 index.html 載入 script 內容並在 vm context 執行
const html = fs.readFileSync('index.html', 'utf8');
const scriptMatches = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi));
assert(scriptMatches.length >= 2, '應至少包含兩個 script 標籤');
const appScript = scriptMatches[1][1];

const elementRegistry = new Map();
function getOrCreateElement(id) {
  if (!elementRegistry.has(id)) {
    const classSet = new Set();
    elementRegistry.set(id, {
      id: id,
      classList: {
        add: function (cls) { classSet.add(cls); },
        remove: function (cls) { classSet.delete(cls); },
        toggle: function (cls) { classSet.has(cls) ? classSet.delete(cls) : classSet.add(cls); },
        contains: function (cls) { return classSet.has(cls); }
      },
      listeners: {},
      addEventListener: function (type, fn) { this.listeners[type] = fn; },
      querySelectorAll: function () { return []; },
      querySelector: function () { return null; },
      style: {},
      value: '',
      textContent: '',
      innerHTML: ''
    });
  }
  return elementRegistry.get(id);
}

// 建立模擬 context
const sandbox = {
  console: console,
  Set: Set,
  Map: Map,
  Number: Number,
  String: String,
  Array: Array,
  Date: Date,
  Intl: Intl,
  document: {
    getElementById: getOrCreateElement,
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; }
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  requestAnimationFrame: function (cb) { return setTimeout(cb, 0); },
  TextEncoder: TextEncoder,
  btoa: btoa,
  URLSearchParams: URLSearchParams,
  window: {},
  location: { search: '' }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('AuditCycle.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('CenterAudit.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('CsvUtil.js', 'utf8'), sandbox);
vm.runInContext(appScript, sandbox);

const {
  getStationDispatchView_,
  countDispatchPeople_,
  dispatchPrimary_,
  formatDispatchTime_,
  renderDispatchBadge_,
  stationForDispatch_,
  dispatchDetailItemHtml_,
  escapeHtml
} = sandbox;

assert(typeof getStationDispatchView_ === 'function', 'getStationDispatchView_ 應存在');
assert(typeof countDispatchPeople_ === 'function', 'countDispatchPeople_ 應存在');
assert(typeof dispatchPrimary_ === 'function', 'dispatchPrimary_ 應存在');
assert(typeof formatDispatchTime_ === 'function', 'formatDispatchTime_ 應存在');
assert(typeof renderDispatchBadge_ === 'function', 'renderDispatchBadge_ 應存在');
assert(typeof stationForDispatch_ === 'function', 'stationForDispatch_ 應存在');
assert(typeof dispatchDetailItemHtml_ === 'function', 'dispatchDetailItemHtml_ 應存在');

// 測試 1: formatDispatchTime_ 的三階回退
console.log('1. 測試 formatDispatchTime_ 三階回退');
assert.strictEqual(
  formatDispatchTime_({ startTime: '08:30', endTime: '17:30', shiftName: '正常班', hours: 8 }),
  '08:30 ~ 17:30',
  '起訖時間皆有時應為 startTime ~ endTime'
);
assert.strictEqual(
  formatDispatchTime_({ startTime: '09:00', endTime: '', shiftName: '正常班', hours: 8 }),
  '09:00 起',
  '僅有開始時間時應為 startTime 起'
);
assert.strictEqual(
  formatDispatchTime_({ startTime: '', endTime: '', shiftName: '早班', hours: 8 }),
  '早班 (8h)',
  '無起訖時間時應為 班別 (工時h)'
);
assert.strictEqual(
  formatDispatchTime_({ startTime: '', endTime: '', shiftName: '小夜班', hours: 0 }),
  '小夜班',
  '工時為 0 時不顯示 (0h)'
);
assert.strictEqual(
  formatDispatchTime_({ startTime: '', endTime: '', shiftName: '', hours: 0 }),
  '班別未填',
  '無班別與工時時退回 班別未填'
);
console.log('✓ formatDispatchTime_ 通過');

// 測試 2: countDispatchPeople_ 的去重與 fallback
console.log('2. 測試 countDispatchPeople_ 去重與 fallback');
const recordsWithEmail = [
  { id: '1', nurseEmail: 'nurse@example.com' },
  { id: '2', nurseEmail: 'NURSE@example.com ' }, // 大小寫與空白去重
  { id: '3', nurseEmail: 'other@example.com' }
];
assert.strictEqual(countDispatchPeople_(recordsWithEmail), 2, '相同 Email 應去重為 2 人');

const recordsWithoutEmail = [
  { id: '101', nurseEmail: '' },
  { id: '102', nurseEmail: null },
  { id: '101', nurseEmail: '' }
];
assert.strictEqual(countDispatchPeople_(recordsWithoutEmail), 2, '無 Email 應以 id 去重');
console.log('✓ countDispatchPeople_ 通過');

// 測試 3: dispatchPrimary_ 優先順序與狀態文字
console.log('3. 測試 dispatchPrimary_ 優先級與多態文字');
// 待指派需求優先 (加總 demandCount)
assert.strictEqual(
  dispatchPrimary_({
    state: 'ready',
    pending: [{ demandCount: 2 }, { demandCount: 1 }],
    incoming: [{ nurseEmail: 'a@ex.com' }],
    outgoing: [{ nurseEmail: 'b@ex.com' }],
    other: [{ id: '1' }]
  }),
  '⚠ 待指派需求 3 名'
);

// 調入優先於調出與其他
assert.strictEqual(
  dispatchPrimary_({
    state: 'ready',
    pending: [],
    incoming: [{ nurseEmail: 'a@ex.com' }, { nurseEmail: 'a@ex.com' }],
    outgoing: [{ nurseEmail: 'b@ex.com' }],
    other: [{ id: '1' }]
  }),
  '跨站調入 1 人'
);

// 調出優先於其他
assert.strictEqual(
  dispatchPrimary_({
    state: 'ready',
    pending: [],
    incoming: [],
    outgoing: [{ nurseEmail: 'b@ex.com' }, { nurseEmail: 'c@ex.com' }],
    other: [{ id: '1' }]
  }),
  '本站調出 2 人'
);

// 其他排班
assert.strictEqual(
  dispatchPrimary_({
    state: 'ready',
    pending: [],
    incoming: [],
    outgoing: [],
    other: [{ id: '1' }, { id: '2' }]
  }),
  '其他排班 2 筆'
);

// 零筆狀態
assert.strictEqual(
  dispatchPrimary_({ state: 'ready', pending: [], incoming: [], outgoing: [], other: [] }),
  '無已登錄調派'
);
assert.strictEqual(
  dispatchPrimary_({ state: 'partial', pending: [], incoming: [], outgoing: [], other: [] }),
  '資料未完整'
);
assert.strictEqual(
  dispatchPrimary_({ state: 'notConfigured', pending: [], incoming: [], outgoing: [], other: [] }),
  '未啟用'
);
assert.strictEqual(
  dispatchPrimary_({ state: 'unavailable', pending: [], incoming: [], outgoing: [], other: [] }),
  '資料暫不可用'
);
assert.strictEqual(
  dispatchPrimary_({ state: 'loading', pending: [], incoming: [], outgoing: [], other: [] }),
  '載入中'
);
console.log('✓ dispatchPrimary_ 通過');

// 測試 4: getStationDispatchView_ 分類與日期區間過濾
console.log('4. 測試 getStationDispatchView_ 日期過濾與分類');
const testSnapshot = {
  year: 2026,
  state: 'ready',
  dispatches: [
    // 待指派：目標站 A01，原站 A01
    { id: 'p1', stationCode: 'A01', originalStationCode: 'A01', startDate: '2026-10-07', endDate: '2026-10-07', isPending: true, demandCount: 2 },
    // 待指派：目標站 A02，原站 A01 (來源站 A01 不應計為調出！)
    { id: 'p2', stationCode: 'A02', originalStationCode: 'A01', startDate: '2026-10-07', endDate: '2026-10-07', isPending: true, demandCount: 1 },
    // 調入 A01，來源 B01
    { id: 'i1', stationCode: 'A01', originalStationCode: 'B01', startDate: '2026-10-05', endDate: '2026-10-09', isPending: false, isTemporary: true, nurseName: '王護', nurseEmail: 'wang@ex.com' },
    // 調出 A01 至 A02
    { id: 'o1', stationCode: 'A02', originalStationCode: 'A01', startDate: '2026-10-07', endDate: '2026-10-07', isPending: false, isTemporary: true, nurseName: '陳護', nurseEmail: 'chen@ex.com' },
    // A01 本站其他排班
    { id: 's1', stationCode: 'A01', originalStationCode: 'A01', startDate: '2026-10-07', endDate: '2026-10-07', isPending: false, isTemporary: false, nurseName: '林護', nurseEmail: 'lin@ex.com' },
    // 非當日紀錄（已過期）
    { id: 'past', stationCode: 'A01', originalStationCode: 'A01', startDate: '2026-10-01', endDate: '2026-10-06', isPending: false, isTemporary: false },
    // 非當日紀錄（未來）
    { id: 'future', stationCode: 'A01', originalStationCode: 'A01', startDate: '2026-10-08', endDate: '2026-10-10', isPending: false, isTemporary: false }
  ]
};

// 將 snapshot 塞入 sandbox 的 dispatchSnapshotsByYear
sandbox.testSnapshot = testSnapshot;
vm.runInContext('dispatchSnapshotsByYear.set(2026, testSnapshot);', sandbox);

const viewA01 = getStationDispatchView_('A01', '2026-10-07');
assert.strictEqual(viewA01.pending.length, 1, 'A01 應有 1 筆待指派 (p1)');
assert.strictEqual(viewA01.pending[0].demandCount, 2);
assert.strictEqual(viewA01.incoming.length, 1, 'A01 應有 1 筆調入 (i1)');
assert.strictEqual(viewA01.outgoing.length, 1, 'A01 應有 1 筆調出 (o1)');
assert.strictEqual(viewA01.other.length, 1, 'A01 應有 1 筆其他排班 (s1)');

// 驗證來源站 A01 不把待指派 p2 當作已調出
const viewA01OutgoingIds = viewA01.outgoing.map(r => r.id);
assert(!viewA01OutgoingIds.includes('p2'), '來源站不得將待指派需求視為已調出');

// 驗證目標站 A02 的 view
const viewA02 = getStationDispatchView_('A02', '2026-10-07');
assert.strictEqual(viewA02.pending.length, 1, 'A02 應有 1 筆待指派 (p2)');
assert.strictEqual(viewA02.incoming.length, 1, 'A02 應有 1 筆調入 (o1)');
assert.strictEqual(viewA02.outgoing.length, 0, 'A02 無調出');

// 驗證未有快照年度
const viewLoading = getStationDispatchView_('A01', '2030-01-01');
assert.strictEqual(viewLoading.state, 'loading');
assert.strictEqual(viewLoading.pending.length, 0);
console.log('✓ getStationDispatchView_ 通過');

// 測試 5: renderDispatchBadge_ 產生的按鈕與徽章文字
console.log('5. 測試 renderDispatchBadge_');
vm.runInContext('selectedDispatchDate = "2026-10-07";', sandbox);
const badgeA01 = renderDispatchBadge_({ code: 'A01' });
assert(badgeA01.includes('class="dispatch-badge"'), '應包含 class="dispatch-badge"');
assert(badgeA01.includes('data-action="dispatch-detail"'), '應包含 data-action="dispatch-detail"');
assert(badgeA01.includes('data-code="A01"'), '應包含 data-code="A01"');
assert(badgeA01.includes('⚠ 待指派需求 2 名 · 另 3 筆'), 'A01 應包含待指派且另 3 筆');

// 驗證 partial 狀態下有紀錄時附加「 · 資料未完整」
const partialSnapshot = {
  year: 2028,
  state: 'partial',
  dispatches: [
    { id: 'part1', stationCode: 'B01', originalStationCode: 'A01', startDate: '2028-05-01', endDate: '2028-05-01', isPending: false, isTemporary: true, nurseEmail: 'n@ex.com' }
  ]
};
sandbox.partialSnapshot = partialSnapshot;
vm.runInContext('dispatchSnapshotsByYear.set(2028, partialSnapshot); selectedDispatchDate = "2028-05-01";', sandbox);

const badgeB01 = renderDispatchBadge_({ code: 'B01' });
assert(badgeB01.includes('跨站調入 1 人 · 資料未完整'), 'partial 且有紀錄應加上 · 資料未完整');

// 驗證 partial 狀態下零筆只顯示「資料未完整」
const badgeB02 = renderDispatchBadge_({ code: 'B02' });
assert(badgeB02.includes('>資料未完整<'), 'partial 且零筆時應顯示 資料未完整');
assert(!badgeB02.includes('無已登錄調派'), 'partial 零筆絕不可顯示 無已登錄調派');
console.log('✓ renderDispatchBadge_ 通過');

// 測試 6: stationForDispatch_ 同時涵蓋 certified, normal 與 outsourced
console.log('6. 測試 stationForDispatch_');
sandbox.testDashboard = {
  mode: 'FIXED',
  certifiedStations: [
    { code: 'CERT-1', name: '認證站1', members: [] },
    { code: 'A01', name: '台北車站駐站', members: [{ name: '陳一', title: '駐站人員' }] }
  ],
  normalStations: [{ code: 'NORM-1', name: '一般站1', members: [] }],
  outsourcedStations: [{ code: 'OUT-1', name: '委外站1', members: [] }]
};
vm.runInContext('dashboard = testDashboard;', sandbox);

assert.strictEqual(stationForDispatch_('CERT-1').name, '認證站1');
assert.strictEqual(stationForDispatch_('NORM-1').name, '一般站1');
assert.strictEqual(stationForDispatch_('OUT-1').name, '委外站1');
assert.strictEqual(stationForDispatch_('UNKNOWN'), undefined);
const updatedOutsourced = { code: 'OUT-1', name: '委外站更新', isOutsourced: true, members: [] };
sandbox.replaceStationInDashboard_(updatedOutsourced);
assert.strictEqual(stationForDispatch_('OUT-1').name, '委外站更新', '委外站儲存後的單卡資料應更新於委外站清單');
assert.strictEqual(vm.runInContext('dashboard.normalStations.length', sandbox), 1, '委外站不得被加入一般站清單');
vm.runInContext('dashboard.outsourcedStations[0].name = "委外站1";', sandbox);
console.log('✓ stationForDispatch_ 通過');

// 測試 7: dispatchDetailItemHtml_ 轉義與備註
console.log('7. 測試 dispatchDetailItemHtml_');
const itemHtml1 = dispatchDetailItemHtml_({
  isPending: true,
  demandCount: 2,
  startDate: '2026-10-07',
  endDate: '2026-10-07',
  startTime: '09:00',
  endTime: '18:00',
  originalStationCode: 'A01',
  stationCode: 'A01',
  note: '<script>alert("xss")</script>'
});
assert(itemHtml1.includes('待指派 2 名'), '待指派文字正確');
assert(itemHtml1.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), '備註 XSS 字元應正確轉義');
assert(!itemHtml1.includes('<script>'), '不得有未轉義的 script');

const itemHtml2 = dispatchDetailItemHtml_({
  isPending: false,
  nurseName: '陳<護理師>',
  nurseEmail: 'chen@example.com',
  startDate: '2026-10-07',
  endDate: '2026-10-07',
  startTime: '08:00',
  endTime: '',
  originalStationCode: 'A01',
  stationCode: 'A02',
  note: ''
});
assert(itemHtml2.includes('陳&lt;護理師&gt;'), '姓名 XSS 字元應正確轉義');
assert(itemHtml2.includes('chen@example.com'), '應包含 email');
assert(itemHtml2.includes('A01 → A02'), '應包含 station 轉換路徑');
console.log('✓ dispatchDetailItemHtml_ 通過');

// 測試 8: buildStationCard 包含調派摘要按鈕且位於 assignmentHtml 之前
console.log('8. 測試 buildStationCard 結構');
const stationMock = {
  code: 'A01',
  name: '台北車站駐站',
  isCertified: true,
  isOutsourced: false,
  managerName: '王主任',
  lastAuditDisplay: '2026/03/15',
  evaluation: { status: 'AUDITED_THIS_YEAR', auditedThisYear: true },
  history: { auditCount: 1, isOverdue: false },
  members: [{ name: '陳一', title: '駐站人員' }],
  assignment: null
};
const cardHtml = sandbox.buildStationCard(stationMock);
assert(cardHtml.includes('class="dispatch-badge"'), '卡片 HTML 應包含 dispatch-badge 按鈕');
const badgeIndex = cardHtml.indexOf('class="dispatch-badge"');
const actionsIndex = cardHtml.indexOf('class="card-actions"');
assert(badgeIndex !== -1 && actionsIndex !== -1 && badgeIndex < actionsIndex, 'dispatch-badge 應位於 card-actions 之前');
console.log('✓ buildStationCard 通過');

// 測試 9: openDispatchDetail_ 與 closeDispatchDetail_
console.log('9. 測試 openDispatchDetail_ 與 closeDispatchDetail_');
let modalClasses = new Set();
let modalTitle = '';
let modalBody = '';
sandbox.document.getElementById = function (id) {
  if (id === 'dispatch-detail-overlay') {
    return {
      classList: {
        add: function (cls) { modalClasses.add(cls); },
        remove: function (cls) { modalClasses.delete(cls); },
        contains: function (cls) { return modalClasses.has(cls); }
      }
    };
  }
  if (id === 'dispatch-detail-title') {
    return {
      set textContent(val) { modalTitle = val; },
      get textContent() { return modalTitle; }
    };
  }
  if (id === 'dispatch-detail-body') {
    return {
      set innerHTML(val) { modalBody = val; },
      get innerHTML() { return modalBody; }
    };
  }
  return {
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    addEventListener: function () {},
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    style: {}
  };
};

sandbox.openDispatchDetail_('A01');
assert(modalClasses.has('open'), 'openDispatchDetail_ 應為 overlay 加上 open class');
assert(modalTitle.includes('台北車站駐站') || modalTitle.includes('A01'), '彈窗標題應包含駐站名或代碼');
assert(modalBody.includes('待指派需求'), '彈窗內應包含 待指派需求 區塊');
assert(modalBody.includes('調入本站'), '彈窗內應包含 調入本站 區塊');
assert(modalBody.includes('自本站調出'), '彈窗內應包含 自本站調出 區塊');
assert(modalBody.includes('本站其他排班'), '彈窗內應包含 本站其他排班 區塊');
assert(modalBody.includes('編制名單（供對照）'), '彈窗內應包含 編制名單 區塊');

sandbox.closeDispatchDetail_();
assert(!modalClasses.has('open'), 'closeDispatchDetail_ 應移除 open class');

// 驗證委外站也能正常開啟詳情
sandbox.openDispatchDetail_('OUT-1');
assert(modalClasses.has('open'), '委外站 OUT-1 應可正常開啟詳情');
assert(modalTitle.includes('委外站1'), '彈窗標題應包含委外站名稱');
sandbox.closeDispatchDetail_();
console.log('✓ openDispatchDetail_ / closeDispatchDetail_ 通過');

// 狀態未完成時，空分類不能被說成已確認「無調派」。
vm.runInContext('dispatchSnapshotsByYear.delete(2026); selectedDispatchDate = "2026-10-07";', sandbox);
sandbox.openDispatchDetail_('A01');
assert(modalBody.includes('載入中'), '未取得快照時詳情須顯示載入狀態');
assert(!modalBody.includes('無待指派需求'), '載入中不得宣稱沒有待指派需求');
vm.runInContext('dispatchSnapshotsByYear.set(2026, {year:2026,state:"unavailable",dispatches:[]});', sandbox);
sandbox.openDispatchDetail_('A01');
assert(modalBody.includes('資料暫不可用'), '來源失敗時詳情須顯示不可用狀態');
assert(!modalBody.includes('無跨站調入紀錄'), '來源失敗時不得宣稱沒有調入紀錄');
vm.runInContext('dispatchSnapshotsByYear.set(2026, testSnapshot);', sandbox);
vm.runInContext('dispatchSnapshotsByYear.set(2028, partialSnapshot); selectedDispatchDate = "2028-05-01";', sandbox);
sandbox.openDispatchDetail_('A01');
assert(modalBody.includes('資料未完整'), '部分年度缺失時詳情須明示資料未完整');
assert(!modalBody.includes('無跨站調入紀錄'), '資料未完整時不得宣稱沒有調入紀錄');
vm.runInContext('selectedDispatchDate = "2026-10-07";', sandbox);
sandbox.closeDispatchDetail_();

// 測試 10: 事件排除驗證（點擊摘要按鈕不得觸發歷年紀錄彈窗）
console.log('10. 測試事件排除（點擊摘要按鈕 vs 卡片背景）');
let historyModalOpened = false;
let dispatchDetailOpened = false;
const realOpenDispatchDetail = sandbox.openDispatchDetail_;
sandbox.openHistoryModal = function () { historyModalOpened = true; };
sandbox.openDispatchDetail_ = function () { dispatchDetailOpened = true; };

// 模擬 card DOM 結構
const fakeBadgeButton = {
  dataset: { action: 'dispatch-detail', code: 'A01' },
  listeners: {},
  addEventListener: function (type, fn) { this.listeners[type] = fn; },
  closest: function (sel) {
    if (sel.includes('button')) return this;
    return null;
  }
};
const fakeCard = {
  dataset: { code: 'A01' },
  listeners: {},
  addEventListener: function (type, fn) { this.listeners[type] = fn; },
  querySelectorAll: function (sel) {
    if (sel === '[data-action]') return [fakeBadgeButton];
    return [];
  }
};

sandbox.bindStationCardEvents(fakeCard);

// 模擬點擊 badge 按鈕
historyModalOpened = false;
dispatchDetailOpened = false;
fakeBadgeButton.listeners.click();
assert(dispatchDetailOpened, '點擊 badge 按鈕應觸發 openDispatchDetail_');

// 模擬按鈕事件冒泡至 card
fakeCard.listeners.click({ target: fakeBadgeButton });
assert(!historyModalOpened, '點擊 badge 按鈕冒泡至 card 時不得觸發 openHistoryModal');

// 模擬點擊卡片空白處
historyModalOpened = false;
const fakeEmptyDiv = {
  closest: function () { return null; }
};
fakeCard.listeners.click({ target: fakeEmptyDiv });
assert(historyModalOpened, '點擊卡片非互動區域應正常觸發 openHistoryModal');
sandbox.openDispatchDetail_ = realOpenDispatchDetail;
console.log('✓ 事件隔離通過');

// ==========================================
// Task 6: 分派彈窗連動、提示文案與儲存獨立性測試
// ==========================================
console.log('\n--- 測試 Task 6: 分派彈窗調派提示與連動 ---');
const {
  assignDispatchMessage_,
  renderAssignDispatchHint_,
  openAssignModal,
  closeAssignModal
} = sandbox;

assert(typeof assignDispatchMessage_ === 'function', 'assignDispatchMessage_ 應存在');
assert(typeof renderAssignDispatchHint_ === 'function', 'renderAssignDispatchHint_ 應存在');
assert(typeof openAssignModal === 'function', 'openAssignModal 應存在');
assert(typeof closeAssignModal === 'function', 'closeAssignModal 應存在');

// 測試 11: assignDispatchMessage_ 訊息文字與優先順序
console.log('11. 測試 assignDispatchMessage_ 多態訊息');
// 待指派需求優先
assert.strictEqual(
  assignDispatchMessage_({
    state: 'ready',
    pending: [{ demandCount: 2 }],
    incoming: [{ nurseEmail: 'a@ex.com' }],
    outgoing: [{ nurseEmail: 'b@ex.com' }],
    other: [{ id: '1' }]
  }),
  '該日有 2 名待指派需求，請核對人力安排。'
);

// 調入優先於調出與其他
assert.strictEqual(
  assignDispatchMessage_({
    state: 'ready',
    pending: [],
    incoming: [{ nurseEmail: 'a@ex.com' }],
    outgoing: [{ nurseEmail: 'b@ex.com' }],
    other: [{ id: '1' }]
  }),
  '該日有跨站調入支援，請查看時段。'
);

// 調出優先於其他
assert.strictEqual(
  assignDispatchMessage_({
    state: 'ready',
    pending: [],
    incoming: [],
    outgoing: [{ nurseEmail: 'b@ex.com' }],
    other: [{ id: '1' }]
  }),
  '該日有本站人員調出，請查看時段。'
);

// 其他排班
assert.strictEqual(
  assignDispatchMessage_({
    state: 'ready',
    pending: [],
    incoming: [],
    outgoing: [],
    other: [{ id: '1' }]
  }),
  '該日有已登錄排班，請查看詳情。'
);

// 零筆 ready 狀態
assert.strictEqual(
  assignDispatchMessage_({ state: 'ready', pending: [], incoming: [], outgoing: [], other: [] }),
  '該日無已登錄調派；此資訊不代表已確認出勤。'
);

// partial 狀態附帶提示，絕不顯示「該日無已登錄調派」
assert.strictEqual(
  assignDispatchMessage_({
    state: 'partial',
    pending: [{ demandCount: 1 }],
    incoming: [],
    outgoing: [],
    other: []
  }),
  '⚠ 待指派需求 1 名；資料未完整，請核對來源'
);
assert.strictEqual(
  assignDispatchMessage_({
    state: 'partial',
    pending: [],
    incoming: [{ nurseEmail: 'a@ex.com' }],
    outgoing: [],
    other: []
  }),
  '跨站調入 1 人；資料未完整，請核對來源'
);
assert.strictEqual(
  assignDispatchMessage_({ state: 'partial', pending: [], incoming: [], outgoing: [], other: [] }),
  '資料未完整；資料未完整，請核對來源'
);

// unavailable, notConfigured, loading 狀態
assert.strictEqual(
  assignDispatchMessage_({ state: 'unavailable', pending: [], incoming: [], outgoing: [], other: [] }),
  '資料暫不可用'
);
assert.strictEqual(
  assignDispatchMessage_({ state: 'notConfigured', pending: [], incoming: [], outgoing: [], other: [] }),
  '未啟用'
);
assert.strictEqual(
  assignDispatchMessage_({ state: 'loading', pending: [], incoming: [], outgoing: [], other: [] }),
  '載入中'
);
console.log('✓ assignDispatchMessage_ 通過');

// 測試 12: renderAssignDispatchHint_ 基本連動與 DOM 更新
// 測試 12: renderAssignDispatchHint_ 基本連動與 DOM 更新
console.log('12. 測試 renderAssignDispatchHint_ DOM 更新');
sandbox.document.getElementById = getOrCreateElement;
const assignDateEl = getOrCreateElement('assign-date');
const assignHintEl = getOrCreateElement('assign-dispatch-hint');
const assignOverlayEl = getOrCreateElement('assign-overlay');

// 設空日期時清空 hint
vm.runInContext('assigningCode = "A01";', sandbox);
assignDateEl.value = '';
renderAssignDispatchHint_();
assert.strictEqual(assignHintEl.textContent, '', '空日期時 hint 應清空');

// 設已有快照之日期 (2026-10-07)
assignDateEl.value = '2026-10-07';
renderAssignDispatchHint_();
assert.strictEqual(assignHintEl.textContent, '該日有 2 名待指派需求，請核對人力安排。', '已快照日期應立即顯示調派提示');

// 改為無調派之已快照日期
assignDateEl.value = '2026-10-15';
renderAssignDispatchHint_();
assert.strictEqual(assignHintEl.textContent, '該日無已登錄調派；此資訊不代表已確認出勤。', '無調派日期應顯示無調派提示');
console.log('✓ renderAssignDispatchHint_ 基本更新通過');

// 測試 13: 未載入年度跨年非同步載入、取消與延遲防禦
console.log('13. 測試跨年度非同步載入與遲到回應隔離');
let resolveSnapshot;
let rejectSnapshot;
const realEnsureDispatchSnapshot = sandbox.ensureDispatchSnapshot_;
sandbox.ensureDispatchSnapshot_ = function (year, force) {
  return new Promise(function (resolve, reject) {
    resolveSnapshot = resolve;
    rejectSnapshot = reject;
  });
};

// 選擇未載入年度 (2027-05-01)
assignDateEl.value = '2027-05-01';
renderAssignDispatchHint_();
assert.strictEqual(assignHintEl.textContent, '載入中', '未載入年度應先顯示「載入中」');

// 情境 A: 非同步成功回應且彈窗仍保持同一駐站與日期
const snapshot2027 = {
  year: 2027,
  state: 'ready',
  dispatches: [
    { id: '27-in', stationCode: 'A01', originalStationCode: 'B01', startDate: '2027-05-01', endDate: '2027-05-01', isPending: false, isTemporary: true, nurseEmail: 'in27@ex.com' }
  ]
};
sandbox._snapshot2027 = snapshot2027;
vm.runInContext('dispatchSnapshotsByYear.set(2027, _snapshot2027);', sandbox);
resolveSnapshot(snapshot2027);

return Promise.resolve().then(function () {
  assert.strictEqual(assignHintEl.textContent, '該日有跨站調入支援，請查看時段。', '非同步載入完成後應更新提示為跨站調入');

  // 情境 B: 彈窗關閉後遲到回應不更新 hint
  assignDateEl.value = '2030-01-01';
  renderAssignDispatchHint_();
  assert.strictEqual(assignHintEl.textContent, '載入中');

  // 使用者關閉彈窗
  closeAssignModal();
  assert.strictEqual(assignHintEl.textContent, '', 'closeAssignModal 應清空 hint');
  assert.strictEqual(vm.runInContext('assigningCode', sandbox), null, 'closeAssignModal 應將 assigningCode 置 null');

  // 延遲 resolve
  const snapshot2030 = { year: 2030, state: 'ready', dispatches: [] };
  sandbox._snapshot2030 = snapshot2030;
  vm.runInContext('dispatchSnapshotsByYear.set(2030, _snapshot2030);', sandbox);
  resolveSnapshot(snapshot2030);

  return Promise.resolve();
}).then(function () {
  assert.strictEqual(assignHintEl.textContent, '', '彈窗關閉後遲到回應不得更新 hint');

  // 情境 C: 使用者在載入期間變更日期，遲到回應不覆蓋新日期
  vm.runInContext('assigningCode = "A01";', sandbox);
  assignDateEl.value = '2031-01-01';
  renderAssignDispatchHint_();
  assert.strictEqual(assignHintEl.textContent, '載入中');

  // 使用者切換回 2026-10-07
  assignDateEl.value = '2026-10-07';
  renderAssignDispatchHint_();
  assert.strictEqual(assignHintEl.textContent, '該日有 2 名待指派需求，請核對人力安排。');

  // 2031 遲到 resolve
  resolveSnapshot({ year: 2031, state: 'ready', dispatches: [] });

  return Promise.resolve();
}).then(function () {
  assert.strictEqual(assignHintEl.textContent, '該日有 2 名待指派需求，請核對人力安排。', '已切換日期後，舊日期的非同步回應不得覆蓋當前提示');

  // 情境 D: 非同步載入失敗降級
  assignDateEl.value = '2032-01-01';
  renderAssignDispatchHint_();
  assert.strictEqual(assignHintEl.textContent, '載入中');
  rejectSnapshot(new Error('網路異常'));

  return Promise.resolve();
}).then(function () {
  assert.strictEqual(assignHintEl.textContent, '調派資料暫不可用', '非同步載入失敗應顯示調派資料暫不可用');
  console.log('✓ 跨年度非同步載入與遲到回應隔離通過');

  // 測試 14: openAssignModal 初始化連動
  console.log('14. 測試 openAssignModal 初始化連動');
  const stationWithAssign = {
    code: 'A01',
    name: '台北車站駐站',
    assignment: { plannedDate: '2026/10/07', auditorEmails: 'audit.chao@example.com' }
  };
  sandbox._testDashboard2 = {
    currentYear: 2026,
    auditors: [{ name: '趙', email: 'audit.chao@example.com' }],
    certifiedStations: [stationWithAssign],
    normalStations: [],
    outsourcedStations: []
  };
  vm.runInContext('dashboard = _testDashboard2;', sandbox);

  openAssignModal('A01');
  assert.strictEqual(assignDateEl.value, '2026-10-07', 'openAssignModal 應填入 yyyy-MM-dd 日期');
  assert.strictEqual(assignHintEl.textContent, '該日有 2 名待指派需求，請核對人力安排。', 'openAssignModal 應立即渲染初始日期的調派提示');
  assert(assignOverlayEl.classList.contains('open'), 'openAssignModal 應開啟 overlay');
  sandbox._testDashboard2.outsourcedStations = [{code:'OUT-1', name:'委外站1', assignment:{plannedDate:'2026/10/07', auditorEmails:''}}];
  sandbox.closeAssignModal();
  openAssignModal('OUT-1');
  assert.strictEqual(getOrCreateElement('assign-title').textContent, '排定稽核 — 委外站1', '委外站應可開啟稽核排定彈窗');
  assert(assignOverlayEl.classList.contains('open'), '委外站排定彈窗應開啟');
  assert.strictEqual(assignHintEl.textContent, '該日無已登錄調派；此資訊不代表已確認出勤。', '委外站應顯示該日調派提示');
  sandbox.closeAssignModal();
  openAssignModal('A01');
  console.log('✓ openAssignModal 初始化通過');

  // 測試 15: input / change 事件連動
  console.log('15. 測試 assign-date 事件監聽');
  assignDateEl.value = '2026-10-15';
  assignDateEl.listeners.input();
  assert.strictEqual(assignHintEl.textContent, '該日無已登錄調派；此資訊不代表已確認出勤。', 'input 事件應觸發提示更新');
  assignDateEl.value = '2026-10-07';
  assignDateEl.listeners.change();
  assert.strictEqual(assignHintEl.textContent, '該日有 2 名待指派需求，請核對人力安排。', 'change 事件應觸發提示更新');
  console.log('✓ assign-date input / change 事件通過');

  // 測試 16: 儲存分派不受調派提示影響
  console.log('16. 測試儲存分派不受調派提示影響');
  let saveAssignmentCalled = false;
  sandbox._mockCallServer = function (fn, code, year, checked, date) {
    if (fn === 'saveStationAssignment') {
      saveAssignmentCalled = true;
      assert.strictEqual(code, 'A01');
      assert.strictEqual(date, '2026/10/07');
      return Promise.resolve({ ok: true });
    }
  };
  vm.runInContext('callServer = _mockCallServer; runWrite = function (msg, call, cb) {};', sandbox);

  // 即便提示為「調派資料暫不可用」或「載入中」，只要人員或日期存在即可存檔
  assignHintEl.textContent = '調派資料暫不可用';
  // 模擬勾選稽核員
  getOrCreateElement('auditor-list').querySelectorAll = function () {
    return [{ value: 'audit.chao@example.com' }];
  };
  // 觸發儲存事件
  getOrCreateElement('assign-save').listeners.click();
  assert(saveAssignmentCalled, '儲存分派應成功呼叫，不被調派狀態阻擋');
  console.log('✓ 儲存獨立性驗證通過');

  // 強制重新整理失敗時，保留舊快照與時間，並在所有決策提示標為舊資料。
  vm.runInContext('dispatchSnapshotsByYear.set(2026, testSnapshot); selectedDispatchDate = "2026-10-07";', sandbox);
  testSnapshot.fetchedAt = '2026-10-07T08:00:00.000Z';
  sandbox.callServer = function (name, year, force) {
    assert.strictEqual(name, 'getStationDispatchSnapshot');
    assert.strictEqual(year, 2026);
    assert.strictEqual(force, true);
    return Promise.reject(new Error('來源暫時失敗'));
  };
  return realEnsureDispatchSnapshot(2026, true).then(function () {
    assert.strictEqual(vm.runInContext('dispatchSnapshotsByYear.get(2026)', sandbox), testSnapshot, '重新整理失敗須保留舊快照');
    sandbox.updateDispatchMeta_();
    assert(getOrCreateElement('station-dispatch-fetched-at').textContent.includes('2026-10-07T08:00:00.000Z'), '須顯示舊快照時間');
    assert(getOrCreateElement('station-dispatch-fetched-at').textContent.includes('重新整理失敗'), '須顯示重新整理失敗');
    assert(sandbox.renderDispatchBadge_({code:'A01'}).includes('舊資料'), '卡片須標示舊資料');
    assignDateEl.value = '2026-10-07';
    vm.runInContext('assigningCode = "A01";', sandbox);
    sandbox.renderAssignDispatchHint_();
    assert(assignHintEl.textContent.includes('舊資料'), '排定稽核提示須標示舊資料');
    sandbox.openDispatchDetail_('A01');
    assert(getOrCreateElement('dispatch-detail-body').innerHTML.includes('重新整理失敗，顯示舊資料'), '詳情須顯示舊資料警示');
    sandbox.callServer = function () { return Promise.resolve({year:2026,state:'ready',fetchedAt:'2026-10-07T09:00:00.000Z',dispatches:[]}); };
    return realEnsureDispatchSnapshot(2026, true);
  }).then(function () {
    sandbox.updateDispatchMeta_();
    assert(!getOrCreateElement('station-dispatch-fetched-at').textContent.includes('重新整理失敗'), '重新整理成功應清除失敗警示');
    assert(!sandbox.renderDispatchBadge_({code:'A01'}).includes('舊資料'), '重新整理成功應清除卡片舊資料標記');
    const freshSnapshot = vm.runInContext('dispatchSnapshotsByYear.get(2026)', sandbox);
    sandbox.callServer = function () { return Promise.resolve({year:2026,state:'unavailable',fetchedAt:'',dispatches:[]}); };
    return realEnsureDispatchSnapshot(2026, true).then(function () {
      assert.strictEqual(vm.runInContext('dispatchSnapshotsByYear.get(2026)', sandbox), freshSnapshot, '來源回傳不可用狀態時亦須保留舊快照');
      sandbox.updateDispatchMeta_();
      assert(getOrCreateElement('station-dispatch-fetched-at').textContent.includes('重新整理失敗'), '來源回傳不可用狀態須標記重新整理失敗');
    });
  });
}).then(function () {
  console.log('\n全數 Task 5 & Task 6 測試通過！✓');
});
