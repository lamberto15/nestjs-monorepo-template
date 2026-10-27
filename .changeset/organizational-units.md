---
'@nestjs-monorepo-template/api-client': major
---

Organizational units replace teams: `/v1/access/teams` is now `/v1/access/organizational-units` (with `/{id}/members`: member or lead, `validFrom`/`validTo`), the directory `/v1/organizational-units`; `teamId`/`teamIds` become `unitId`/`unitIds`, `Access.manageTeams` becomes `Access.manageOrganizationalUnits`, the condition `inMyTeams` becomes `inMyUnitsAndBelow` (plus `inMyUnits`, `inUnitsILeadAndBelow`), the settings scope and view visibility `team` become `unit`, the approval rule `unitRole`. New 409 codes: `unit_name_taken`, `unit_not_empty`. Tenants are independent: the unreleased tenant tree (`parentId`, `/v1/access/consolidated/*`, `Access.readConsolidated`) is gone.
