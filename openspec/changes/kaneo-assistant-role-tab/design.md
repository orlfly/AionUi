# Design: kaneo-assistant-role-tab

## Context

`kaneo-project-scoped-env` (archived) already ships: project-bound contexts (`kaneo.contexts[]` + `activeContextId`), manifest-driven sync with per-project workspaces, MCP-first claim prompt with `kaneo:<contextId>` env-ref sentinels, and the AionCore encrypted credential API (`PUT/GET/DELETE /api/kaneo-credentials/{contextId}`). The remaining friction is UX: assistants get created through a detached "Import from Kaneo" modal (`KaneoImportModal.tsx`) with a separate button on the assistants home page.

## Goals / Non-Goals

- **Goals**: Kaneo first-class in the assistant creation UI; explicit role+project selection; one instance per (role, project); remove the standalone modal/button.
- **Non-Goals**: No AionCore API changes; no new agent runtime; no import of unbound legacy templates from anywhere except the Kaneo tab fallback.

## Decisions

### D1. Reuse the editor, add a Kaneo section/tab

`AssistantEditorPage` already renders `AssistantEditorSections` with a shared view model (name, emoji, description, prompt, skills). The Kaneo tab is added as a section visible in **create mode** (and as a "connect Kaneo" affordance in edit mode for non-Kaneo assistants). It reuses `AssistantEditorViewModel` state so Create saves the same assistant record.

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
