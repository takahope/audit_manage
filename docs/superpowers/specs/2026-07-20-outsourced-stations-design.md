# Outsourced Stations (委外駐站) Design Specification

## Overview
Currently, the Resident Audit (駐站收案稽核) page categorizes stations into "Certified Resident" (認證駐站) and "General Resident" (一般駐站). Outsourced resident stations (委外駐站), which have codes starting with `GRP-CO-EX-`, are currently included in the "General Resident" category and are factored into the 3-year audit cycle. 
However, outsourced stations are unstable and might not be contracted every year. Therefore, they should be separated into a new "Outsourced Resident" (委外駐站) category, treated as independent cases, and excluded from the 3-year cycle calculation and the suggested annual audit targets.

## Data Layer (`DataService.js` / `code.js`)
*   **Identification**: During station processing, if a `station.code` starts with `'GRP-CO-EX-'`, we will assign a new boolean flag `isOutsourced = true`.
*   **Backend Output**: The API payload (`core.evaluated` / `evaluated`) sent to the frontend will now split stations into three distinct arrays instead of two:
    *   `certifiedStations`: `isCertified === true && !isOutsourced` (or simply `isCertified === true` since outsourced aren't certified)
    *   `normalStations`: `!isCertified && !isOutsourced`
    *   `outsourcedStations`: `isOutsourced === true`

## Logic Layer (`AuditCycle.js`)
*   **Status Evaluation**: Modify `evaluateStationFor_` (Fixed mode) and `evaluateStationRolling_` (Rolling mode).
    *   If `isOutsourced` is true, the station will bypass the cycle requirements.
    *   It will only evaluate whether there is an audit in the current year (`currentYear`).
    *   Its status will map directly to `STATION_STATUS.AUDITED_THIS_YEAR` or `STATION_STATUS.NOT_AUDITED`.
    *   Cycle metrics like `countedInCycle` and `scheduleCovered` will be forced to `false` so it does not affect any coverage rate.
*   **Dashboard Summary**: Modify `buildCycleSummary`. Outsourced stations will not be counted in `totalStations`, `suggestedNormal`, or any coverage denominator.

## View Layer (`index.html`)
*   **UI Classification**: Update `filteredStationGroups_` to also process and return an `outsourced` array based on the `dashboard.outsourcedStations`.
*   **New Section**: Render a new UI section via `buildSection('委外駐站', 'outsourced', groups.outsourced, '每年不固定簽約，獨立案件不計入三年週期。')`.
*   **Card Rendering**: Adjust the card UI logic so that outsourced station cards do not display "remaining cycle years" (週期剩餘) or "due year" logic. The status text will simply be "今年已稽核" or "未稽核".
*   **Global Dashboard Stats**: Ensure the top bar statistics correctly exclude outsourced stations, presenting only "一般駐站 X 間 ＋ 認證駐站 Y 間".

## Testing Strategy
*   Add a test case in `test/audit-cycle.test.js` or a relevant node test file to verify that an outsourced station is ignored in the 3-year coverage cycle calculation.
*   Preview `index.html` locally using mock data to ensure the new "委外駐站" section appears correctly and the target counts are accurate.
