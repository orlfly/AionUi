# Tasks: kaneo-assistant-role-tab

## 1. Kaneo tab scaffolding in the assistant editor

- [x] 1.1 Add a Kaneo tab/section component (`AssistantKaneoCreateTab`) under `packages/desktop/src/renderer/pages/settings/AssistantSettings/`, wired into `AssistantEditorSections` for create mode (and visible as a connect affordance in edit mode for non-Kaneo assistants)
- [x] 1.2 Implement the connect state machine hook: base URL (last-used default) + password-masked API key + Connect → uses `fetchKaneoBootstrap` (fallback-first) and `fetchKaneoConfigPackage`
- [x] 1.3 Roles listing UI: render roles from config package / bootstrap, group by project; role-scoped keys narrow selectable roles to the bound role and show others as unavailable
- [x] 1.4 Explicit role + project selection UI with Create disabled until both are selected; duplicate (role, project) pair detected from existing contexts shows "update in place" hint
- [x] 1.5 i18n: add `settings.kaneoCreateTab.*` keys in all configured languages; run `bun run i18n:types` and `node scripts/check-i18n.js`

## 2. Instance creation and credential hand-off

- [x] 2.1 Create assistant from the tab: build/reuse the Kaneo context (`contextFromManifest` semantics), workspace path record, and assistant upsert via `syncKaneoAssistantsFromManifest` (project-bound) or `syncKaneoAssistants` (legacy fallback)
- [x] 2.2 Credential transfer on create: single `PUT /api/kaneo-credentials/{contextId}` (same IPC path the modal used); drop key state after success or editor close; no renderer persistence
- [x] 2.3 Rotation path: re-connecting an existing (role, project) context with a new key replaces ciphertext and updates the assistant in place

## 3. Retire the standalone Import from Kaneo entry

- [ ] 3.1 Remove the `btn-kaneo-import` button from `AssistantHomeTabs` and unmount/delete `KaneoImportModal.tsx`; keep home page actions otherwise intact
- [ ] 3.2 Port legacy-fallback semantics (unbound manifest / 404/405) into the tab flow; retire modal-only i18n keys and add new keys for the tab
- [ ] 3.3 Clean up dead imports/state (`onKaneoImport`, `kaneoImportVisible`) and verify no `KaneoImportModal` references remain

## 4. Tests

- [ ] 4.1 Unit tests for the tab hook: connect failure surfaces non-blocking error and retains base URL; role-scoped key narrows roles; create disabled without role+project
- [ ] 4.2 Unit tests: (role, project) binding produces context with workspace `<userData>/kaneo-workspaces/<slug>/<role>/`; duplicate pair updates in place
- [ ] 4.3 Unit tests: exactly one credential PUT per create; key state cleared on close
- [ ] 4.4 Test: no "Import from Kaneo" button rendered on assistants home; legacy fallback path still syncs
- [ ] 4.5 Run `bunx vitest run` for kaneo + assistant settings suites; tsc clean; oxlint/oxfmt clean

## 5. Validation

- [ ] 5.1 Manual flow: create assistant → Kaneo tab → connect → pick role + project → Create → assistant appears with workspace, session MCP server `kaneo:<contextId>` env-ref resolves in a live conversation
- [ ] 5.2 Confirm home page no longer shows the import button; edit existing (role, project) instance updates in place
