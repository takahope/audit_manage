/**
 * audit-cycle.test.js — AuditCycle 純函式邊界測試
 * 執行：node test/audit-cycle.test.js
 */
const { getCycleForYear, evaluateStation, evaluateStationFor_, buildCycleSummary, buildAuditHistory, countValidCertifications_, STATION_STATUS } = require('../AuditCycle.js');

// 各年度的（三年總覽、兩年排程輪）週期組，錨點 2026
function cyclesFor(year) {
  return { tri: getCycleForYear(year, 2026, 3), bi: getCycleForYear(year, 2026, 2) };
}

let passed = 0, failed = 0;
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error('✗ ' + label + '\n  期望 ' + e + '\n  實際 ' + a); }
}

// ===== 週期區段計算 =====
assertEqual(getCycleForYear(2026, 2026, 3), { start: 2026, end: 2028, years: [2026, 2027, 2028] }, '錨點年屬於第一輪');
assertEqual(getCycleForYear(2028, 2026, 3).start, 2026, '週期末年仍屬同一輪');
assertEqual(getCycleForYear(2029, 2026, 3), { start: 2029, end: 2031, years: [2029, 2030, 2031] }, '交界年 2029 進入下一輪');
assertEqual(getCycleForYear(2025, 2026, 3).start, 2023, '錨點之前的年份（回填資料）映射到前一輪');

const cycle = getCycleForYear(2027, 2026, 3); // 2026–2028，當年 2027

// ===== 認證駐站（兩年排程輪 ＋ 三年總覽去重）=====
const iso = { code: 'GRP-CO-X', isCertified: true };

// 2026 稽過、今年 2027（兩年輪 2026–2027）：本輪已稽 → 本輪完成、今年非候選
let cy = cyclesFor(2027);
let ev = evaluateStationFor_(iso, [2026], 2027, cy.tri, cy.bi);
assertEqual(ev.status, STATION_STATUS.CYCLE_DONE, '認證駐站：兩年輪本輪已稽 → CYCLE_DONE（非每年必稽）');
assertEqual(ev.isCandidate, false, '認證駐站：本兩年輪已稽 → 今年非候選');
assertEqual(ev.scheduleCovered, true, '認證駐站：兩年輪已覆蓋');
assertEqual(ev.countedInCycle, true, '認證駐站：三年總覽已計入');
assertEqual(ev.countedYear, 2026, '認證駐站：三年總覽計入年份為最早一筆');

// 本兩年輪今年才稽 → 今年已稽核
ev = evaluateStationFor_(iso, [2027], 2027, cy.tri, cy.bi);
assertEqual(ev.status, STATION_STATUS.AUDITED_THIS_YEAR, '認證駐站：今年稽核 → AUDITED_THIS_YEAR');

// 本兩年輪未稽（只有更早紀錄）→ 今年候選、排程未覆蓋
ev = evaluateStationFor_(iso, [2024, 2025], 2027, cy.tri, cy.bi);
assertEqual(ev.status, STATION_STATUS.CANDIDATE, '認證駐站：本兩年輪無紀錄 → 候選');
assertEqual(ev.scheduleCovered, false, '認證駐站：本兩年輪未覆蓋');

// 關鍵：第三年（2028）跨入新兩年輪，但三年總覽不重複計算已稽過的認證站
cy = cyclesFor(2028); // tri 2026–2028、bi 2028–2029
ev = evaluateStationFor_(iso, [2026, 2027], 2028, cy.tri, cy.bi);
assertEqual(ev.countedInCycle, true, '認證駐站：2028 在三年總覽(2026–2028)內已稽過 → 覆蓋率算已覆蓋（不重複）');
assertEqual(ev.scheduleCovered, false, '認證駐站：2028 新兩年輪尚未稽 → 排程列入建議');
assertEqual(ev.status, STATION_STATUS.CANDIDATE, '認證駐站：2028 新一輪 → 重新候選');

// ===== 認證生效年度（certifiedSince）：升認證前的稽核只進三年總覽、不進兩年輪 =====
// late 站 2027 才升認證；2026 當一般站時稽過一次
const late = { code: 'GRP-CO-Z', isCertified: true, certifiedSince: 2027 };
cy = cyclesFor(2027); // tri 2026–2028、bi 2026–2027
ev = evaluateStationFor_(late, [2026], 2027, cy.tri, cy.bi);
assertEqual(ev.countedInCycle, true, 'certifiedSince：升認證前(2026)的稽核仍計入三年總覽');
assertEqual(ev.countedYear, 2026, 'certifiedSince：三年總覽計入年份用全部紀錄(2026)');
assertEqual(ev.scheduleCovered, false, 'certifiedSince：升認證前(2026)的稽核不算兩年輪覆蓋');
assertEqual(ev.status, STATION_STATUS.CANDIDATE, 'certifiedSince：兩年輪無認證後紀錄 → 候選');

// 升認證前(2026)+認證後(2027)都有：三年總覽取最早 2026；兩年輪只看認證後(2027=今年) → 今年已稽核
ev = evaluateStationFor_(late, [2026, 2027], 2027, cy.tri, cy.bi);
assertEqual(ev.countedYear, 2026, 'certifiedSince：三年總覽仍取最早一筆(2026，含升認證前)');
assertEqual(ev.status, STATION_STATUS.AUDITED_THIS_YEAR, 'certifiedSince：認證後當年(2027)有稽核 → 今年已稽核');
assertEqual(ev.scheduleCovered, true, 'certifiedSince：認證後的紀錄正常計入兩年輪覆蓋');

// certifiedSince=0（生效年未知 fallback）：不過濾，行為等同未帶 certifiedSince（現狀回歸保護）
const legacyIso = { code: 'GRP-CO-W', isCertified: true, certifiedSince: 0 };
ev = evaluateStationFor_(legacyIso, [2026], 2027, cy.tri, cy.bi);
assertEqual(ev.scheduleCovered, true, 'certifiedSince=0：不過濾，兩年輪含 2026（等同現狀）');
assertEqual(ev.status, STATION_STATUS.CYCLE_DONE, 'certifiedSince=0：本兩年輪已稽 → CYCLE_DONE');

// ===== 一般駐站 =====
const normal = { code: 'GRP-CO-Y', isCertified: false };

ev = evaluateStation(normal, [], 2027, cycle);
assertEqual(ev.status, STATION_STATUS.CANDIDATE, '一般駐站：本輪無紀錄 → 候選');

ev = evaluateStation(normal, [2026], 2027, cycle);
assertEqual(ev.status, STATION_STATUS.CYCLE_DONE, '一般駐站：去年稽核過 → 本輪完成、今年非候選');
assertEqual(ev.isCandidate, false, '一般駐站：本輪完成後不再是候選');

ev = evaluateStation(normal, [2027], 2027, cycle);
assertEqual(ev.status, STATION_STATUS.AUDITED_THIS_YEAR, '一般駐站：今年稽核 → 今年已稽核');

ev = evaluateStation(normal, [2023], 2027, cycle);
assertEqual(ev.isCandidate, true, '一般駐站：只有上一輪紀錄 → 本輪仍是候選');

// 一般站經 evaluateStationFor_：scheduleCovered 等同 countedInCycle
ev = evaluateStationFor_(normal, [2026], 2027, cyclesFor(2027).tri, cyclesFor(2027).bi);
assertEqual(ev.scheduleCovered, ev.countedInCycle, '一般駐站：scheduleCovered = countedInCycle（三年口徑）');

// ===== 建議數量 =====
// 認證站走兩年排程輪、一般站走三年總覽；覆蓋率全站以三年口徑計（認證去重）
function makeStations(certifiedSpecs, normalSpecs, year) {
  const c = cyclesFor(year);
  const list = [];
  certifiedSpecs.forEach(function (years, i) {
    const st = { code: 'C' + i, isCertified: true };
    list.push({ isCertified: true, evaluation: evaluateStationFor_(st, years, year, c.tri, c.bi) });
  });
  normalSpecs.forEach(function (years, i) {
    const st = { code: 'N' + i, isCertified: false };
    list.push({ isCertified: false, evaluation: evaluateStationFor_(st, years, year, c.tri, c.bi) });
  });
  return list;
}

// 2026 年初：6 認證全未稽（兩年輪 ceil(6/2)=3）＋ 9 一般全未稽（三年 ceil(9/3)=3）→ 建議 6
let c = cyclesFor(2026);
let summary = buildCycleSummary(
  makeStations([[], [], [], [], [], []], [[], [], [], [], [], [], [], [], []], 2026),
  2026, c.tri, c.bi
);
assertEqual(summary.suggestedCertified, 3, '認證第一年：ceil(6/2)=3');
assertEqual(summary.suggestedNormal, 3, '一般第一年：ceil(9/3)=3');
assertEqual(summary.suggestedTotal, 6, '週期第一年：建議 = 3 + 3 = 6');
assertEqual(summary.coveragePercent, 0, '週期第一年初始覆蓋率 0%');

// 2027 年：認證已稽 3 家（2026），剩 3 家、兩年輪剩 1 年 → ceil(3/1)=3
c = cyclesFor(2027);
summary = buildCycleSummary(
  makeStations([[2026], [2026], [2026], [], [], []], [], 2027),
  2027, c.tri, c.bi
);
assertEqual(summary.certifiedRemaining, 3, '認證 2027：本兩年輪剩 3 家未稽');
assertEqual(summary.suggestedCertified, 3, '認證 2027：ceil(3/1)=3');

// 2028 年：認證 6 家在 2026–2027 已稽 → 三年總覽全覆蓋、不重複；但新兩年輪(2028–2029)全未稽 → 建議 ceil(6/2)=3
c = cyclesFor(2028);
summary = buildCycleSummary(
  makeStations([[2026], [2026], [2026], [2027], [2027], [2027]], [], 2028),
  2028, c.tri, c.bi
);
assertEqual(summary.countedInCycle, 6, '2028：6 認證在三年總覽(2026–2028)內均已覆蓋（每家一次、不重複）');
assertEqual(summary.coveragePercent, 100, '2028：認證三年覆蓋率 100%');
assertEqual(summary.suggestedCertified, 3, '2028：新兩年輪 ceil(6/2)=3（排程照常，與覆蓋率分離）');

// 2028 年（最後一年）：一般剩 5 間未稽 → 三年剩 1 年，建議補足全部 5 間
c = cyclesFor(2028);
summary = buildCycleSummary(
  makeStations([[2028]], [[], [], [], [], []], 2028),
  2028, c.tri, c.bi
);
assertEqual(summary.remainingYears, 1, '週期最後一年：剩餘年數 = 1');
assertEqual(summary.suggestedNormal, 5, '週期最後一年：一般建議數 = 全部剩餘');
assertEqual(summary.suggestedCertified, 0, '認證今年已稽 → 本兩年輪已覆蓋、不列入建議');

// ===== 滾動模式（ROLLING）=====
const ROLLING = 'ROLLING';

// 一般駐站：從未稽核 → 立即候選
ev = evaluateStation(normal, [], 2027, cycle, ROLLING);
assertEqual(ev.isCandidate, true, '滾動：從未稽核 → 立即候選');
assertEqual(ev.status, STATION_STATUS.CANDIDATE, '滾動：從未稽核 → CANDIDATE');
assertEqual(ev.dueYear, null, '滾動：從未稽核無到期年');

// 一般駐站：2026 稽核 → 2027、2028 效期內，2029 起到期成為候選
ev = evaluateStation(normal, [2026], 2027, cycle, ROLLING);
assertEqual(ev.status, STATION_STATUS.CYCLE_DONE, '滾動：上次稽核未滿三年 → 效期內');
assertEqual(ev.dueYear, 2029, '滾動：到期年 = 上次稽核年 + 3');
assertEqual(ev.countedInCycle, true, '滾動：效期內 countedInCycle = true');

ev = evaluateStation(normal, [2026], 2028, getCycleForYear(2028, 2026, 3), ROLLING);
assertEqual(ev.isCandidate, false, '滾動：到期前一年仍在效期內');

ev = evaluateStation(normal, [2026], 2029, getCycleForYear(2029, 2026, 3), ROLLING);
assertEqual(ev.isCandidate, true, '滾動：滿三年（2029）到期 → 候選');
assertEqual(ev.status, STATION_STATUS.CANDIDATE, '滾動：到期年狀態為 CANDIDATE');

// 一般駐站：多筆紀錄以最近一次起算
ev = evaluateStation(normal, [2023, 2026], 2029, getCycleForYear(2029, 2026, 3), ROLLING);
assertEqual(ev.dueYear, 2029, '滾動：多筆紀錄以最近一次（2026）起算到期年');

// 一般駐站：今年稽核 → 今年已稽核
ev = evaluateStation(normal, [2027], 2027, cycle, ROLLING);
assertEqual(ev.status, STATION_STATUS.AUDITED_THIS_YEAR, '滾動：今年稽核 → AUDITED_THIS_YEAR');

// 認證駐站：滾動模式排程效期為兩年（上次 + 2 到期）
let rc = cyclesFor(2027);
ev = evaluateStationFor_(iso, [2026], 2027, rc.tri, rc.bi, ROLLING);
assertEqual(ev.status, STATION_STATUS.CYCLE_DONE, '滾動：認證上次稽核未滿兩年 → 效期內');
assertEqual(ev.dueYear, 2028, '滾動：認證到期年 = 上次稽核年 + 2');
ev = evaluateStationFor_(iso, [2025], 2027, rc.tri, rc.bi, ROLLING);
assertEqual(ev.status, STATION_STATUS.CANDIDATE, '滾動：認證滿兩年（2025→2027）到期 → 候選');
ev = evaluateStationFor_(iso, [2027], 2027, rc.tri, rc.bi, ROLLING);
assertEqual(ev.status, STATION_STATUS.AUDITED_THIS_YEAR, '滾動：認證今年已稽核');

// 滾動 summary：建議數 = 今年到期的一般駐站全部 + 排程到期的認證駐站全部（不攤平）
function makeRollingStations(certifiedSpecs, normalSpecs, year) {
  const c = cyclesFor(year);
  const list = [];
  certifiedSpecs.forEach(function (years, i) {
    list.push({ isCertified: true, evaluation: evaluateStationFor_({ code: 'C' + i, isCertified: true }, years, year, c.tri, c.bi, ROLLING) });
  });
  normalSpecs.forEach(function (years, i) {
    list.push({ isCertified: false, evaluation: evaluateStationFor_({ code: 'N' + i, isCertified: false }, years, year, c.tri, c.bi, ROLLING) });
  });
  return list;
}

// 2027 年：認證 2 間（C0 今年稽=覆蓋、C1 2025=排程滿兩年到期）、一般 4 間（2026 ×2 效期內；2024、從未 = 到期）
rc = cyclesFor(2027);
summary = buildCycleSummary(
  makeRollingStations([[2027], [2025]], [[2026], [2026], [2024], []], 2027),
  2027, rc.tri, rc.bi, ROLLING
);
assertEqual(summary.remainingNormal, 2, '滾動 summary：今年到期的一般駐站數');
assertEqual(summary.suggestedNormal, 2, '滾動 summary：一般建議 = 到期數全部（不攤平）');
assertEqual(summary.certifiedRemaining, 1, '滾動 summary：認證排程到期 1 間');
assertEqual(summary.suggestedCertified, 1, '滾動 summary：認證建議 = 排程到期全部（不攤平）');
assertEqual(summary.suggestedTotal, 3, '滾動 summary：建議總數 = 2 + 1');
assertEqual(summary.remainingYears, null, '滾動 summary：無週期剩餘年數概念');
// 三年總覽效期內：認證 C0(2027)+C1(2025，三年內) + 一般 2026×2 = 4
assertEqual(summary.countedInCycle, 4, '滾動 summary：三年總覽效期內站數');

// PENDING_AUDIT 狀態鍵存在（code.js 狀態覆寫依賴此鍵）
assertEqual(typeof STATION_STATUS.PENDING_AUDIT, 'string', 'PENDING_AUDIT 狀態鍵已定義');

// ===== 稽核履歷（buildAuditHistory）=====
assertEqual(
  buildAuditHistory([], 2026),
  { auditCount: 0, lastAuditYear: null, yearsSinceLast: null, isOverdue: true },
  '履歷：從未稽核 → 次數 0、逾期'
);
assertEqual(
  buildAuditHistory([2025], 2026),
  { auditCount: 1, lastAuditYear: 2025, yearsSinceLast: 1, isOverdue: false },
  '履歷：去年稽核 → 不逾期'
);
assertEqual(buildAuditHistory([2023], 2026).isOverdue, true, '履歷：滿三年整（2023→2026）→ 逾期');
assertEqual(buildAuditHistory([2024], 2026).isOverdue, false, '履歷：差一年滿三年（2024→2026）→ 不逾期');
assertEqual(buildAuditHistory([2026], 2026).isOverdue, false, '履歷：今年稽核 → 不逾期');

const multiHistory = buildAuditHistory([2020, 2024, 2018], 2026);
assertEqual(multiHistory.auditCount, 3, '履歷：多筆紀錄次數正確');
assertEqual(multiHistory.lastAuditYear, 2024, '履歷：多筆紀錄取最近年（不需排序輸入）');
assertEqual(multiHistory.yearsSinceLast, 2, '履歷：距上次稽核年數');

// ===== 認證次數判定（規格 4.3：任期內須至少一筆稽核年度才算一次有效認證）=====
assertEqual(
  countValidCertifications_([{ since: 2020, until: 2022 }], [2021]),
  1, '認證次數：任期內有稽核 → 計 1 次'
);
assertEqual(
  countValidCertifications_([{ since: 2020, until: 2022 }], [2024]),
  0, '認證次數：任期內無稽核（紀錄落在區間外）→ 不計次'
);
assertEqual(
  countValidCertifications_([{ since: 2024, until: null }], [2025]),
  1, '認證次數：開放任期（until=null 視為至今）內有稽核 → 計 1 次'
);
assertEqual(
  countValidCertifications_([{ since: 2024, until: null }], [2023]),
  0, '認證次數：開放任期，稽核年度早於生效年 → 不計次'
);
assertEqual(
  countValidCertifications_(
    [{ since: 2016, until: 2018 }, { since: 2022, until: null }],
    [2017, 2023]
  ),
  2, '認證次數：兩段任期各有稽核 → 計 2 次'
);
assertEqual(
  countValidCertifications_(
    [{ since: 2016, until: 2018 }, { since: 2022, until: null }],
    [2023]
  ),
  1, '認證次數：兩段任期僅一段有稽核 → 計 1 次'
);
assertEqual(countValidCertifications_([], [2024]), 0, '認證次數：無任期 → 0');
assertEqual(countValidCertifications_([{ since: 2024, until: null }], []), 0, '認證次數：有任期但無稽核 → 0');
assertEqual(
  countValidCertifications_([{ since: 2020, until: 2022 }], [2020, 2022]),
  1, '認證次數：稽核落在任期端點（含邊界）→ 計 1 次'
);

// ===== 委外駐站（獨立案件，不計入週期計算）=====
const outsourcedStation = { code: 'GRP-CO-EX-1', isCertified: false, isOutsourced: true };
const evalOutsourced = evaluateStationFor_(outsourcedStation, [2025], 2026, {start: 2026, end: 2028}, {start: 2026, end: 2027}, 'FIXED');
assertEqual(evalOutsourced.status, STATION_STATUS.NOT_AUDITED, 'Outsourced station should skip cycle and just show not audited this year');
assertEqual(evalOutsourced.countedInCycle, false, 'Outsourced station should not count in cycle');

if (failed === 0) {
  console.log('\n✅ AuditCycle: 所有測試通過 (' + passed + ')');
  process.exit(0);
} else {
  console.error('\n❌ AuditCycle: 失敗 ' + failed + ' 項 (總共 ' + (passed + failed) + ')');
  process.exit(1);
}
