/**
 * station-dispatch.test.js — StationDispatch 純函式單元測試
 * 執行：node test/station-dispatch.test.js
 */
const assert = require('assert');
const {
  normalizeStationDispatchRecord,
  isStationDispatchYear,
  overlapsStationDispatchYear
} = require('../StationDispatch.js');

// 基本有效資料
const raw = {
  id: 'd1',
  status: '有效',
  stationCode: ' grp-co-a01 ',
  originalStationCode: 'grp-co-b01',
  startDate: '2024-12-30',
  endDate: '2026-01-03',
  nurseName: '待指派',
  assignmentStatus: '待指派',
  demandCount: 2
};

const record = normalizeStationDispatchRecord(raw);
assert.ok(record, '應該成功正規化有效紀錄');
assert.strictEqual(record.id, 'd1');
assert.strictEqual(record.stationCode, 'GRP-CO-A01');
assert.strictEqual(record.originalStationCode, 'GRP-CO-B01');
assert.strictEqual(record.startDate, '2024-12-30');
assert.strictEqual(record.endDate, '2026-01-03');
assert.strictEqual(record.isPending, true);
assert.strictEqual(record.demandCount, 2);
assert.strictEqual(record.isTemporary, true, '原站與目標站不同時 isTemporary 應為 true');

// 跨年度重疊檢查
assert.strictEqual(overlapsStationDispatchYear(record, 2024), true, '2024 年末重疊');
assert.strictEqual(overlapsStationDispatchYear(record, 2025), true, '2025 全年涵蓋');
assert.strictEqual(overlapsStationDispatchYear(record, 2026), true, '2026 年初重疊');
assert.strictEqual(overlapsStationDispatchYear(record, 2023), false, '2023 年未重疊');
assert.strictEqual(overlapsStationDispatchYear(record, 2027), false, '2027 年未重疊');

// 非有效狀態過濾
assert.strictEqual(normalizeStationDispatchRecord({ ...raw, status: '已取消' }), null, '已取消狀態應回傳 null');
assert.strictEqual(normalizeStationDispatchRecord({ ...raw, status: '草稿' }), null, '非有效狀態應回傳 null');
assert.strictEqual(normalizeStationDispatchRecord(null), null, 'null raw 應回傳 null');

// 日期區間不合法（迄日早於起日）
assert.strictEqual(normalizeStationDispatchRecord({ ...raw, endDate: '2024-01-01' }), null, 'endDate < startDate 應回傳 null');

// 無效日期（不存在的 2 月 30 日）
assert.strictEqual(
  normalizeStationDispatchRecord({ ...raw, startDate: '2026-02-30', endDate: '2026-02-30' }),
  null,
  '2026-02-30 不合法日期應回傳 null'
);

// 缺少 ID 或 stationCode
assert.strictEqual(normalizeStationDispatchRecord({ ...raw, id: '   ' }), null, '缺少 id 應回傳 null');
assert.strictEqual(normalizeStationDispatchRecord({ ...raw, stationCode: '' }), null, '缺少 stationCode 應回傳 null');

// workDate fallback
const fallbackRaw = {
  id: 'd2',
  status: '有效',
  stationCode: 'GRP-CO-A02',
  workDate: '2026-05-15',
  nurseName: '王小美',
  assignmentStatus: '已指派'
};
const fallbackRecord = normalizeStationDispatchRecord(fallbackRaw);
assert.ok(fallbackRecord, 'workDate fallback 應成功解析');
assert.strictEqual(fallbackRecord.startDate, '2026-05-15');
assert.strictEqual(fallbackRecord.endDate, '2026-05-15', '缺 endDate 時應退回 startDate');
assert.strictEqual(fallbackRecord.isPending, false, '非待指派時 isPending 應為 false');
assert.strictEqual(fallbackRecord.demandCount, 1, '缺 demandCount 應預設為 1');
assert.strictEqual(fallbackRecord.isTemporary, false, '未提供 originalStationCode 時 isTemporary 應為 false');

// 來源站等於目標站
const sameStationRaw = {
  ...fallbackRaw,
  id: 'd3',
  originalStationCode: 'GRP-CO-A02'
};
const sameStationRecord = normalizeStationDispatchRecord(sameStationRaw);
assert.strictEqual(sameStationRecord.isTemporary, false, '原站與目標站相同時 isTemporary 應為 false');

// demandCount 缺值或小於 1
const invalidDemandRecord = normalizeStationDispatchRecord({
  ...fallbackRaw,
  id: 'd4',
  demandCount: 0
});
assert.strictEqual(invalidDemandRecord.demandCount, 1, 'demandCount 為 0 時 Math.max(1, ...) 應為 1');

// 年度檢查 isStationDispatchYear
assert.strictEqual(isStationDispatchYear(2026), true, '2026 應為合法年度');
assert.strictEqual(isStationDispatchYear('2026'), true, '字串 2026 應為合法年度');
assert.strictEqual(isStationDispatchYear(2000), true, '2000 邊界應合法');
assert.strictEqual(isStationDispatchYear(2100), true, '2100 邊界應合法');
assert.strictEqual(isStationDispatchYear(1999), false, '1999 應超出邊界');
assert.strictEqual(isStationDispatchYear(2101), false, '2101 應超出邊界');
assert.strictEqual(isStationDispatchYear('abc'), false, '非數字應不合法');
assert.strictEqual(isStationDispatchYear('2026.5'), false, '小數應不合法');
assert.strictEqual(isStationDispatchYear(''), false, '空字串應不合法');
assert.strictEqual(isStationDispatchYear(null), false, 'null 應不合法');

// nurseName 與 assignmentStatus 空白防禦性 trim
const paddedPendingRecord1 = normalizeStationDispatchRecord({
  ...fallbackRaw,
  id: 'd_pad1',
  nurseName: ' 待指派 ',
  assignmentStatus: ' 已指派 '
});
assert.strictEqual(paddedPendingRecord1.isPending, true, 'nurseName 帶空白的待指派應使 isPending 為 true');
assert.strictEqual(paddedPendingRecord1.nurseName, '待指派');

const paddedPendingRecord2 = normalizeStationDispatchRecord({
  ...fallbackRaw,
  id: 'd_pad2',
  nurseName: ' 王小美 ',
  assignmentStatus: ' 待指派 '
});
assert.strictEqual(paddedPendingRecord2.isPending, true, 'assignmentStatus 帶空白的待指派應使 isPending 為 true');
assert.strictEqual(paddedPendingRecord2.nurseName, '王小美');

console.log('✓ All station-dispatch tests passed successfully.');
