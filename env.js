/**
 * env.js — 環境設定與欄位索引集中定義
 *
 * 黃金規則：任何讀寫試算表的程式碼，必須透過此處的 COL 索引物件操作，
 * 禁止在其他檔案直接使用 row[8] 等硬編碼索引。
 */

const ENV = {
  /**
   * HR_managerv3(claude) 專案的試算表 ID。
   * 取得方式：開啟該試算表，網址中 /d/ 與 /edit 之間的字串即為 ID。
   * 例：https://docs.google.com/spreadsheets/d/【這一段】/edit
   */
  HR_SPREADSHEET_ID: 'YOUR_HR_SPREADSHEET_ID_HERE',

  /**
   * 稽核紀錄試算表 ID。
   * 留空 = 使用本 GAS 專案綁定的容器試算表（建議做法）。
   * 若為獨立指令碼，請新建一個空白試算表並填入其 ID。
   */
  AUDIT_SPREADSHEET_ID: '',

  /**
   * 認證駐站紀錄試算表 ID（外部維護，本系統只讀）。
   * 此表以「指定時間～換掉時間」區間記錄每家駐站的認證任期，作為認證身分的真相來源：
   * 換掉時間為空 = 當前認證站；指定時間的年份 = 認證生效年度（certifiedSince）。
   * 留空 = 退回組織架構樹 I 欄 'V' 判定（生效年未知，兩年輪不過濾，等同舊版行為）。
   */
  ISO_STATION_SPREADSHEET_ID: '',

  /**
   * 三年週期錨定起始年的「預設值」（西元）。
   * 使用者可在前端「週期設定」中變更，實際生效值存於
   * Script Properties（key 見 CYCLE_START_YEAR_PROPERTY_KEY），此值僅在未設定時使用。
   */
  CYCLE_START_YEAR: 2026,
  CYCLE_LENGTH_YEARS: 3,

  /**
   * 認證駐站的「排程輪」長度（西元年）。
   * 認證駐站每年只稽核部分家數，實際以兩年為一輪（每年約半數）走完所有認證站。
   * 此值僅用於認證站的排程狀態與年度建議；覆蓋率仍以 CYCLE_LENGTH_YEARS 的三年總覽
   * 計算（認證站併入、每家只計一次），見 AuditCycle.js buildCycleSummary。
   */
  CERTIFIED_CYCLE_LENGTH_YEARS: 2,

  /** 補登歷史稽核紀錄的年度下限，防止誤植（如 226）汙染資料 */
  MIN_AUDIT_YEAR: 2000,

  /** 認證駐站名單的應有家數（認證駐站管理：更新時須剛好選滿此數） */
  CERTIFIED_STATION_COUNT: 6,

  /**
   * 稽核排程同步的 Google Calendar ID。
   * 留空 = 使用部署者的預設行事曆。
   * 指定行事曆：Calendar 設定 → 該行事曆「整合日曆」區塊的日曆 ID
   * （形如 xxx@group.calendar.google.com），部署者需有該行事曆的編輯權限。
   */
  CALENDAR_ID: '',

  /** 組織架構樹 I 欄標記此值（不分大小寫）即視為 ISO 認證駐站 */
  CERTIFIED_MARK: 'V',

  /** 駐站節點的代碼前綴（與 HR 專案 isStationOrgCode_ 的判定一致） */
  STATION_CODE_PREFIX: 'GRP-CO-',

  /**
   * 稽核人員的判定條件：人員職務配置中
   * C 欄（所屬組別代碼）= ORG_CODE 且 E 欄（職稱）= MEMBER_TITLE。
   */
  AUDIT_TEAM: {
    ORG_CODE: 'TF-ISPI-GRP-AUDIT',
    MEMBER_TITLE: '稽核員',
  },

  /** HR 資料快取秒數（駐站清單異動頻率低，5 分鐘內重複讀取走快取） */
  CACHE_TTL_SEC: 300,
};

const SHEET_NAMES = {
  // HR_managerv3 試算表內的工作表
  ORG: '組織架構樹',
  ASSIGNMENT: '人員職務配置',
  // 本系統自有的工作表
  AUDIT_RECORDS: '稽核紀錄',
  AUDIT_PLANS: '稽核分派',
  CENTER_RECORDS: '中心稽核紀錄',
  CENTER_PLANS: '中心稽核排程',
  TRIGGER_EVENTS: '稽核觸發事件',
  STATION_STATUS_NOTE: '駐站現況備註',
  // 外部認證駐站紀錄表（ISO_STATION_SPREADSHEET_ID 指向的試算表內）
  CERT_RECORDS: '認證駐站紀錄',
};

const CACHE_KEYS = {
  STATIONS: 'audit_stations_v1',
  MEMBERS: 'audit_members_v1',
  AUDITORS: 'audit_auditors_v1',
  CERT_TENURES: 'audit_cert_tenures_v1',
};

/**
 * 週期計算模式（存於 Script Properties key 'CYCLE_MODE'，全域生效）：
 * - FIXED：固定三年區段（2026–2028、2029–2031……）
 * - ROLLING：滾動式，每站以「上次稽核年＋3」為到期年
 */
const CYCLE_MODES = { FIXED: 'FIXED', ROLLING: 'ROLLING' };
const CYCLE_MODE_PROPERTY_KEY = 'CYCLE_MODE';

/**
 * 使用者角色（權限控管，由 DataService.getUserRole_ 依人員職務配置判定）：
 * - AUDITOR：TF-ISPI-GRP-AUDIT 組且職稱稽核員，擁有全部讀寫權限。
 * - FORBIDDEN：GRP-CO-* 駐站人員，不可存取本系統（避免受稽者自評）。
 * - VIEWER：其他人，僅能檢視、不能操作。
 */
const USER_ROLES = { AUDITOR: 'AUDITOR', FORBIDDEN: 'FORBIDDEN', VIEWER: 'VIEWER' };

/** 固定模式錨定起始年的 Script Properties key（未設定時退回 ENV.CYCLE_START_YEAR） */
const CYCLE_START_YEAR_PROPERTY_KEY = 'CYCLE_START_YEAR';

/**
 * 欄位索引（0-based，沿用 HR 專案 SheetColumns.js 慣例）。
 * ORG 的 A–H 欄與 HR 專案相同；ISO_FLAG 為該表第 I 欄（HR 專案未定義，本系統擴充讀取）。
 */
const COL = {
  ORG: {
    TYPE: 0,
    LEVEL: 1,
    CODE: 2,
    NAME: 3,
    ALIAS: 4,
    PARENT_CODE: 5,
    MANAGER_EMAIL: 6,
    MANAGER_NAME: 7,
    ISO_FLAG: 8, // I 欄：'V' = ISO 認證駐站
  },
  ASSIGNMENT: {
    EMAIL: 0,
    NAME: 1,
    ORG_CODE: 2,
    ORG_NAME: 3,
    TITLE: 4,
    MANAGER_EMAIL: 5,
    MANAGER_NAME: 6,
  },
  AUDIT: {
    STATION_CODE: 0,
    STATION_NAME: 1,
    YEAR: 2,
    RECORDER: 3,
    RECORDED_AT: 4,
    NOTE: 5,
    AUDIT_DATE: 6,     // yyyy/MM/dd；舊資料此欄空 = 僅知年度
  },
  PLAN: {
    STATION_CODE: 0,
    STATION_NAME: 1,
    YEAR: 2,
    AUDITOR_NAMES: 3,  // 頓號分隔，供人工檢視
    AUDITOR_EMAILS: 4, // 逗號分隔，供程式比對
    PLANNED_DATE: 5,   // yyyy/MM/dd
    RECORDER: 6,
    RECORDED_AT: 7,
    CALENDAR_EVENT_ID: 8, // Google Calendar 事件 ID，取消/重排時據此同步
  },
  CENTER_RECORD: {
    TYPE_ID: 0,
    TYPE_NAME: 1,
    AUDIT_DATE: 2,     // yyyy/MM/dd
    AUDITOR_NAMES: 3,
    REASON: 4,         // 事由說明（類型 7/8 用）
    RECORDER: 5,
    RECORDED_AT: 6,
    NOTE: 7,
  },
  CENTER_PLAN: {
    TYPE_ID: 0,
    TYPE_NAME: 1,
    PLANNED_DATE: 2,   // yyyy/MM/dd
    AUDITOR_NAMES: 3,
    AUDITOR_EMAILS: 4,
    REASON: 5,
    RECORDER: 6,
    RECORDED_AT: 7,
    CALENDAR_EVENT_ID: 8, // Google Calendar 事件 ID，取消/重排/完成時據此同步
  },
  TRIGGER: {
    EVENT_ID: 0,       // 時間戳生成的唯一鍵
    EVENT_DATE: 1,     // yyyy/MM/dd
    CATEGORY: 2,
    DESCRIPTION: 3,
    RECORDER: 4,
    RECORDED_AT: 5,
  },
  STATUS_NOTE: {
    STATION_CODE: 0,
    STATION_NAME: 1,
    RECORDED_AT: 2,
    RECORDER: 3,
    NOTE: 4,
  },
  // 外部「認證駐站紀錄」表：以區間（指定～換掉）記錄每家認證任期，本系統只讀
  CERT_RECORD: {
    RECORD_ID: 0,        // A 欄：紀錄ID（CERT-… UUID）
    STATION_CODE: 1,     // B 欄：駐站代碼（GRP-CO-…）
    STATION_NAME: 2,     // C 欄：駐站名稱
    ASSIGNED_DATE: 3,    // D 欄：指定時間（認證任期起始；年份 = certifiedSince）
    REMOVED_DATE: 4,     // E 欄：換掉時間（空 = 仍在認證）
    ASSIGNER_EMAIL: 5,   // F 欄：指定人 Email
    ASSIGNER_NAME: 6,    // G 欄：指定人姓名
    REMOVER_EMAIL: 7,    // H 欄：換站操作人 Email
    REMOVER_NAME: 8,     // I 欄：換站操作人姓名
    BATCH_ID: 9,         // J 欄：批次ID
  },
};
