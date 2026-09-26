# Proposal: kaneo-assistant-role-tab

## Why

Kaneo-backed assistants are currently created through a detached "Import from Kaneo" modal that is disconnected from the normal assistant creation flow. Users must discover a separate button, paste a key into a preview-driven wizard, and cannot see how a Kaneo agent role maps to the assistant being created. Role instances per project (the core value of `kaneo-project-scoped-env`, already shipped) are invisible at creation time.

## What Changes

- Add a dedicated **Kaneo tab** inside the assistant creation UI (assistant editor). The tab lists the agent roles defined in the connected Kaneo instance (from the roles config package / manifest roles) grouped by project.
- Entering a Kaneo API key inside the Kaneo tab connects to Kaneo, then lets the user bind the selected role to a **specific project**; creating the assistant instantiates that role for that project as a first-class assistant ("one instance per project per role", consistent with `kaneo-project-scoped-env`).
- Creating an assistant instance requires an **explicit agent selection**: the user must pick exactly one Kaneo agent role (and project) before Create is enabled. The created assistant records its Kaneo role + project binding so Guide/skill sync keeps targeting the same instance.
- **Remove** the standalone "Import from Kaneo" button on the assistants home page (settings.kaneoImport) and retire the modal entry point; Kaneo import capabilities move fully into the new Kaneo tab.
- Keep the existing credential safety model: plaintext API key lives only in component state, transferred exactly once to `PUT /api/kaneo-credentials/{contextId}` (AES-256-GCM at rest, no plaintext in renderer persistence).

## Capabilities

### New Capabilities
- `kaneo-assistant-create-tab`: The dedicated Kaneo tab in the assistant creation UI: role/project listing from Kaneo, API-key entry, role→project binding, explicit role selection, and assistant instance creation.

### Modified Capabilities
- `kaneo-assistant-workspace`: Assistant instance creation moves from the import modal into the create-flow Kaneo tab; per-project per-role workspace allocation and guidance preselection requirements carry over unchanged but now mutate through the create tab.
- `kaneo-credential-storage`: Storage/rotation events now originate from the create-flow Kaneo tab instead of the import modal (same PUT-once API contract); the old modal-only entry requirement is retired.

## Impact

- **Code**:
  - `packages/desktop/src/renderer/pages/settings/AssistantSettings/` (editor sections gain a Kaneo tab; home page loses the import button; `KaneoImportModal.tsx` retired/refactored into the tab)
  - `kaneoClient.ts` (roles listing), `kaneoContexts.ts`, `kaneoSync.ts` (reuse sync-from-manifest), `kaneoManifest.ts`
  - i18n: new keys under `settings.kaneoCreateTab.*` (all languages in `i18n-config.json`)
- **Compatibility**: No backend API changes; reuses AionCore kaneo credentials + env-ref pipeline from `kaneo-project-scoped-env`/`fd601c9`.
- **Requires**: The AionCore backend bundled in desktop builds must include the kaneo credentials API (>= fork commit `6d5fd9d`).
