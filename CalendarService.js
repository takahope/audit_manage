/**
 * CalendarService.js — Google Calendar 同步服務
 *
 * 低耦合原則：全系統只有本檔接觸 CalendarApp。
 * API 層（code.js）以 try/catch 呼叫本檔函式——行事曆同步失敗
 * 不得阻擋 Sheet 寫入，僅在回應訊息中附註失敗原因。
 *
 * 更新策略：排程採 upsert（刪舊建新），行事曆事件跟隨同一模式
 * （刪舊事件、建新事件），guest 名單異動因此永遠正確。
 */

/**
 * 取得稽核排程同步的目標行事曆。
 * ENV.CALENDAR_ID 留空時使用部署者的預設行事曆。
 *
 * @returns {Calendar}
 */
function getAuditCalendar_() {
  const calendarId = String(ENV.CALENDAR_ID || '').trim();
  if (!calendarId) return CalendarApp.getDefaultCalendar();

  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error('找不到行事曆「' + calendarId + '」，請確認 env.js 的 CALENDAR_ID 與行事曆共用權限');
  }
  return calendar;
}

/**
 * 建立整日稽核事件並邀請稽核人員。
 *
 * @param {string} title - 事件標題（如「【稽核】台北車站駐站」）
 * @param {string} dateText - 預定日期 yyyy/MM/dd
 * @param {string} description - 事件說明
 * @param {string[]} guestEmails - 稽核人員信箱（Google 自動寄送邀請）
 * @returns {string} 事件 ID
 */
function createAuditCalendarEvent(title, dateText, description, guestEmails) {
  const parts = dateText.split('/');
  const eventDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const event = getAuditCalendar_().createAllDayEvent(title, eventDate, {
    description: description,
    guests: (guestEmails || []).join(','),
    sendInvites: true,
  });
  return event.getId();
}

/**
 * 更新既有稽核事件（複用同一筆預約：日期、標題、說明、與會者增修）。
 *
 * 用於「先訂日期、後補人員」的情境——受邀者收到的是事件更新而非取消＋新建。
 * 事件已不存在（被手動刪除）時回 null，由呼叫端 fallback 改為建立新事件。
 *
 * @param {string} eventId
 * @param {string} title
 * @param {string} dateText - 預定日期 yyyy/MM/dd
 * @param {string} description
 * @param {string[]} guestEmails - 目標與會者信箱（會與現有名單對帳增刪）
 * @returns {string|null} 事件 ID；找不到事件時回 null
 */
function updateAuditCalendarEvent(eventId, title, dateText, description, guestEmails) {
  if (!String(eventId || '').trim()) return null;
  const event = getAuditCalendar_().getEventById(eventId);
  if (!event) return null;

  event.setTitle(title);
  event.setDescription(description);

  const parts = dateText.split('/');
  const newDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  // setAllDayDate 會把事件重設為該日整日事件（日期不變時呼叫亦無副作用）
  event.setAllDayDate(newDate);

  // 與會者對帳：移除不在新名單者、補上缺少者（避免重建造成重複邀請）
  const want = {};
  (guestEmails || []).forEach(function (e) { want[String(e).trim().toLowerCase()] = true; });
  const have = {};
  event.getGuestList().forEach(function (g) {
    const email = String(g.getEmail()).trim().toLowerCase();
    have[email] = true;
    if (!want[email]) event.removeGuest(g.getEmail());
  });
  Object.keys(want).forEach(function (email) {
    if (!have[email]) event.addGuest(email);
  });

  return event.getId();
}

/**
 * 刪除稽核事件。事件已不存在（手動刪除過）視為成功，不丟錯。
 *
 * @param {string} eventId
 */
function deleteAuditCalendarEvent(eventId) {
  if (!String(eventId || '').trim()) return;
  const event = getAuditCalendar_().getEventById(eventId);
  if (event) event.deleteEvent();
}
