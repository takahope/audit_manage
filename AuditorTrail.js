/**
 * AuditorTrail.js — 駐站稽核人員軌跡（純函式，node 可測）
 *
 * 「稽核人員」＝實際執行稽核的人；「登錄人」＝按下登錄的操作者（見 GLOSSARY.md）。
 * 本檔只處理稽核人員的規則與欄位轉換，不碰任何 GAS API。
 */

const AUDITOR_NAME_SEPARATOR = '、';
const AUDITOR_EMAIL_SEPARATOR = ',';

/**
 * 稽核人員是否為必填：當年度（含之後）的紀錄必填，過去年度補登可留空（常不知人員）。
 * 未來年度不比當年度寬鬆。
 */
function isAuditorRequiredForYear_(year, currentYear) {
  return Number(year) >= Number(currentYear);
}

/** 信箱清單正規化：去空白、轉小寫、去重、略過空值；非陣列回空陣列。 */
function normalizeAuditorEmails_(emails) {
  if (!Array.isArray(emails)) return [];
  const seen = {};
  const result = [];
  emails.forEach(function (email) {
    const normalized = String(email === null || email === undefined ? '' : email).trim().toLowerCase();
    if (!normalized || seen[normalized]) return;
    seen[normalized] = true;
    result.push(normalized);
  });
  return result;
}

/**
 * 把勾選的信箱解析為稽核人員。只能選現行名單（不開放自由輸入）；
 * 唯一例外：補記時，該紀錄「原本已記載」的人即使已離開名單也可保留，沿用當時姓名，
 * 避免補記其他人時把已離職的稽核人員默默刪掉。
 *
 * @param {string[]} emails - 勾選的信箱
 * @param {Array<{name, email}>} roster - 現行稽核人員名單（email 為小寫）
 * @param {Array<{name, email}>} carriedOver - 該紀錄原本已記載的稽核人員（新登錄傳空陣列）
 * @returns {{auditors: Array<{name, email}>, unknownEmails: string[]}}
 */
function resolveAuditorSelection_(emails, roster, carriedOver) {
  const rosterByEmail = {};
  (roster || []).forEach(function (a) { rosterByEmail[String(a.email).toLowerCase()] = a; });
  const carriedByEmail = {};
  (carriedOver || []).forEach(function (a) { carriedByEmail[String(a.email).toLowerCase()] = a; });

  const auditors = [];
  const unknownEmails = [];
  normalizeAuditorEmails_(emails).forEach(function (email) {
    const found = rosterByEmail[email] || carriedByEmail[email];
    if (found) auditors.push({ name: found.name, email: email });
    else unknownEmails.push(email);
  });
  return { auditors: auditors, unknownEmails: unknownEmails };
}

/** 必填檢查：通過回空字串，不通過回錯誤訊息。 */
function checkAuditorRequirement_(year, currentYear, auditors) {
  if (isAuditorRequiredForYear_(year, currentYear) && (!auditors || auditors.length === 0)) {
    return '當年度（' + year + '）的稽核紀錄須至少記載一位稽核人員';
  }
  return '';
}

/** 稽核人員 → 寫入試算表的兩個欄位（姓名頓號分隔、信箱逗號分隔）。 */
function buildAuditorFields_(auditors) {
  const list = auditors || [];
  return {
    auditorNames: list.map(function (a) { return a.name; }).join(AUDITOR_NAME_SEPARATOR),
    auditorEmails: list.map(function (a) { return a.email; }).join(AUDITOR_EMAIL_SEPARATOR),
  };
}

/**
 * 還原已儲存的兩個欄位為稽核人員清單。
 * 以信箱為準：沒有信箱就無法比對（回空）；姓名與信箱數量對不上時不冒險逐一配對，
 * 姓名退回信箱，避免把人名錯配到別人的信箱。
 */
function parseStoredAuditors_(namesText, emailsText) {
  const emails = String(emailsText || '').split(AUDITOR_EMAIL_SEPARATOR)
    .map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  if (emails.length === 0) return [];
  const names = String(namesText || '').split(AUDITOR_NAME_SEPARATOR)
    .map(function (n) { return n.trim(); }).filter(Boolean);
  const canPair = names.length === emails.length;
  return emails.map(function (email, index) {
    return { name: canPair ? names[index] : email, email: email };
  });
}

// 供 node 本機測試使用；GAS 環境無 module 物件，此區塊不會執行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AUDITOR_NAME_SEPARATOR, AUDITOR_EMAIL_SEPARATOR,
    isAuditorRequiredForYear_, normalizeAuditorEmails_, resolveAuditorSelection_,
    checkAuditorRequirement_, buildAuditorFields_, parseStoredAuditors_,
  };
}
