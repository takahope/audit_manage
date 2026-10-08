/** 駐站卡片收案人力與零常態人員區間。執行：node test/station-staffing-view.test.js */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi));
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', textContent: '', innerHTML: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }
  });
  return elements.get(id);
}
const context = {
  console, Set, Map, Date, Intl, TextEncoder, btoa, URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: cb => setTimeout(cb, 0),
  document: { getElementById: element, querySelectorAll() { return []; }, querySelector() { return null; } },
  window: {}, location: { search: '' }
};
vm.createContext(context);
['AuditCycle.js', 'CenterAudit.js', 'CsvUtil.js'].forEach(file =>
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
vm.runInContext(scripts[1][1], context);

const roster = [
  { name: '甲', email: 'a@example.com', title: '收案人員' },
  { name: '乙', email: 'b@example.com', title: '收案人員' },
  { name: '丙', email: 'c@example.com', title: '駐站管理員' },
  { name: '丁', email: 'd@example.com', title: '收案人員 ' }
];
const station = {
  code: 'S01', name: '測試站', managerName: '測試', isCertified: false, isOutsourced: false,
  members: roster, assignment: null, lastAuditDisplay: '',
  history: { auditCount: 0, isOverdue: true },
  evaluation: { status: 'CANDIDATE', auditedThisYear: false }
};
context.testDashboard = { mode: 'FIXED', currentYear: 2026, certifiedStations: [], normalStations: [station], outsourcedStations: [] };
vm.runInContext('dashboard = testDashboard; selectedDispatchDate = "2026-10-02";', context);

const ready = {
  year: 2026, state: 'ready', fetchedAt: '2026-10-01T00:00:00Z', dispatches: [
    { id: 'in1', stationCode: 'S01', originalStationCode: 'S02', startDate: '2026-10-01', endDate: '2026-10-03', isPending: false, isTemporary: true, nurseEmail: 'IN@example.com', startTime: '08:00', endTime: '12:00' },
    { id: 'in2', stationCode: 'S01', originalStationCode: 'S02', startDate: '2026-10-02', endDate: '2026-10-02', isPending: false, isTemporary: true, nurseEmail: 'in@example.com' },
    { id: 'out1', stationCode: 'S02', originalStationCode: 'S01', startDate: '2026-10-02', endDate: '2026-10-02', isPending: false, isTemporary: true, nurseEmail: 'b@example.com' },
    { id: 'pending', stationCode: 'S01', originalStationCode: 'S01', startDate: '2026-10-02', endDate: '2026-10-05', isPending: true, demandCount: 2, shiftName: '早班' },
    { id: 'regular', stationCode: 'S01', originalStationCode: 'S01', startDate: '2026-10-06', endDate: '2026-10-07', isPending: false, isTemporary: false, nurseEmail: 'r@example.com', startTime: '09:00', endTime: '17:00' },
    { id: 'later', stationCode: 'S01', originalStationCode: 'S02', startDate: '2026-12-31', endDate: '2027-01-02', isPending: false, isTemporary: true, nurseEmail: 'z@example.com' }
  ]
};
context.ready = ready;
vm.runInContext('dispatchSnapshotsByYear.set(2026, ready);', context);

// 若把所有職稱都算入常態、未去重調入或把待指派加入實際值，此測試會失敗。
assert.strictEqual(typeof context.getStationStaffing_, 'function', '應提供卡片人力計算');
const summary = context.getStationStaffing_(station, '2026-10-02');
assert.strictEqual(summary.normal, 2);
assert.strictEqual(summary.planned, 4);
assert.strictEqual(summary.actual, 2);
const duplicateRoster = Object.assign({}, station, { members: roster.concat({ name: '甲', email: 'A@example.com', title: '收案人員' }) });
assert.strictEqual(context.getStationStaffing_(duplicateRoster, '2026-10-02').normal, 2,
  '同一收案人員重複出現在 HR 名單時只計一人');
const priorDay = context.getStationStaffing_(station, '2026-10-01');
assert.strictEqual(priorDay.planned, 2, '預計人數須跟隨卡片檢視日期');
assert.strictEqual(priorDay.actual, 3, '調出尚未發生時實際推算人數應不同');
let card = context.buildStationCard(station);
assert(card.includes('常態收案人員 2 人'), '卡片須標明常態收案人員');
assert(card.includes('預計收案人數 4 人'), '卡片須顯示常態加待指派需求');
assert(card.includes('實際收案人數 2 人'), '卡片須顯示常態加調入減調出');

// 有紀錄 ID 卻沒有姓名／Email 的紀錄，不能當作一名已指派人員。
context.anonymous = { year: 2026, state: 'ready', dispatches: [
  { id: 'unknown', stationCode: 'S01', originalStationCode: 'S02', startDate: '2026-10-02', endDate: '2026-10-02', isPending: false, isTemporary: true }
] };
vm.runInContext('dispatchSnapshotsByYear.set(2026, anonymous);', context);
const unidentified = context.getStationStaffing_(Object.assign({}, station, { members: [] }), '2026-10-02');
assert.strictEqual(unidentified.actual, null, '沒有可識別人員的調入紀錄不得推算確定實際人數');
assert.strictEqual(unidentified.state, 'unidentified');
assert.strictEqual(context.getZeroStaffCoverage_('S01', 2026).state, 'unidentified', '未具名紀錄不得被當成全年無人');
vm.runInContext('dispatchSnapshotsByYear.set(2026, ready);', context);

// 非 ready 狀態不得由空陣列推論人數；常態人數仍可由 HR 顯示。
context.partial = { year: 2026, state: 'partial', fetchedAt: '', dispatches: [] };
vm.runInContext('dispatchSnapshotsByYear.set(2026, partial);', context);
card = context.buildStationCard(station);
assert(card.includes('常態收案人員 2 人'));
assert(card.includes('預計收案人數 —'));
assert(card.includes('實際收案人數 —'));
assert(card.includes('資料未完整'));

// 常態為零時，逐日期優先顯示已指派；待指派只補上沒有已指派的日期。
vm.runInContext('dispatchSnapshotsByYear.set(2026, ready);', context);
const emptyStation = Object.assign({}, station, { members: [{ name: '主管', title: '駐站管理員' }] });
const coverage = context.getZeroStaffCoverage_('S01', 2026);
assert.deepStrictEqual(JSON.parse(JSON.stringify(coverage.intervals.map(x => [x.kind, x.startDate, x.endDate]))), [
  ['assigned', '2026-10-01', '2026-10-03'],
  ['pending', '2026-10-04', '2026-10-05'],
  ['assigned', '2026-10-06', '2026-10-07'],
  ['assigned', '2026-12-31', '2026-12-31']
]);
card = context.buildStationCard(emptyStation);
assert(card.includes('常態收案人員 0 人'), '只有其他職稱時仍屬於零常態收案人員');
assert(card.includes('10/01–10/03 已指派'), '卡片須顯示已指派人員日期區間');
assert(card.includes('10/04–10/05 預計指派 2 人'), '卡片須顯示未被已指派覆蓋的需求日期區間');
assert(card.includes('08:00 ~ 12:00') || card.includes('多時段'), '卡片須提供有紀錄的工作時段');

// 年度資料不完整時，零常態區間不可宣稱完整。
vm.runInContext('dispatchSnapshotsByYear.set(2026, partial);', context);
card = context.buildStationCard(emptyStation);
assert(card.includes('區間資料未完整'));
assert(!card.includes('尚無已登錄或待指派人力資訊'));

console.log('✓ 駐站卡片收案人力與零常態人員區間測試通過');
