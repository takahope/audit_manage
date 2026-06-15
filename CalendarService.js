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
 * 刪除稽核事件。事件已不存在（手動刪除過）視為成功，不丟錯。
 *
 * @param {string} eventId
 */
function deleteAuditCalendarEvent(eventId) {
  if (!String(eventId || '').trim()) return;
  const event = getAuditCalendar_().getEventById(eventId);
  if (event) event.deleteEvent();
}
