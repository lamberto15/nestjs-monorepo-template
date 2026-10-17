---
'@nestjs-monorepo-template/api-client': minor
---

Org units are teams: `/v1/access/org-units` is `/v1/access/teams` (`TeamsController_*` operations), `orgUnitIds` is `teamIds` (users, invitations), the notes' `orgUnitId` field and filter are `teamId`, the settings scope `orgUnit` is `team`, the approval rule `orgUnitRole` is `teamRole`, the permission `manageOrgUnits` is `manageTeams` and the condition `inMyUnits` is `inMyTeams`.
