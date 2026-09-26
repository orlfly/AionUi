# Design: kaneo-assistant-role-tab

## Context

`kaneo-project-scoped-env` (archived) already ships: project-bound contexts (`kaneo.contexts[]` + `activeContextId`), manifest-driven sync with per-project workspaces, MCP-first claim prompt with `kaneo:<contextId>` env-ref sentinels, and the AionCore encrypted credential API (`PUT/GET/DELETE /api/kaneo-credentials/{contextId}`). The remaining friction is UX: assistants get created through a detached "Import from Kaneo" modal (`KaneoImportModal.tsx`) with a separate button on the assistants home page, and the manual create wizard is an unrelated flow.

## Goals / Non-Goals

- **Goals**: Kaneo first-class in the assistant creation UI; explicit role+project selection; one instance per (role, project); remove the standalone modal/button.
- **Non-Goals**: No AionCore API changes; no new agent runtime; no import of unbound legacy templates from anywhere except the Kaneo tab fallback.

## Decisions

### D1. Assistants home page hosts the Kaneo tab

`AssistantHomeTabs` already hosts the enabled / mine / official tabs with a shared `SettingsPageHeader` tab strip. The Kaneo tab is added there as a fourth home tab, so the manual creation wizard stays unchanged. The tab is self-contained: it mounts its own `useKaneoCreateTab` controller fed by the home page's assistant list and refreshes the list after a create, so instances appear immediately under their role cards.

### D2. Importance ordering of tab content

Connect (base URL + key) → roles listing from `fetchKaneoConfigPackage` / bootstrap roles (role-scoped keys narrow to their bound role) → project picker (from manifest/bootstrap data) → explicit agent selection (exactly one role + one project) → Create. Create stays disabled until role AND project are both explicitly chosen (spec requirement).

### D3. Instance identity = Kaneo context

The (role, project) pair maps to the stable `contextId` already used by `kaneoContexts`/credentials. Creating an assistant for an existing context updates it in place (same rename/upsert semantics as the current sync), preventing duplicates. Workspace allocation follows `kaneo-assistant-workspace` unchanged.

### D4. Credentials

Plaintext key lives in component state only; on Create the tab performs the PUT via existing `kaneoCredentialService` IPC plumbing (same call path the modal used), then drops state. No renderer persistence.

### D5. Modal retirement

Delete the `KaneoImportModal` trigger (`btn-kaneo-import`, `settings.kaneoImport`) from `AssistantHomeTabs`; the tab hosts the same underlying sync functions (`syncKaneoAssistants`, `syncKaneoAssistantsFromManifest`) with identical legacy-fallback semantics.

## Risks / Trade-offs

- Editor complexity grows; mitigated by keeping the tab a self-contained component fed by a hook (connect state machine), tested in isolation.
- Role-scoped keys can only offer one role; spec allows disabling other roles with clear UI, avoiding silent imports.

## Migration Plan

1. Ship tab + create flow reading the same services.
2. Remove home button/modal behind a single commit; i18n keys `settings.kaneoImport` replaced by `settings.kaneoCreateTab.*`.
3. Existing contexts/assistants keep working; no migration needed (binding fields unchanged).

## Open Questions

- None material; project list source (bootstrap vs manifest) reuses existing precedence logic.
