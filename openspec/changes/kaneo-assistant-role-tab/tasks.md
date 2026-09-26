# Tasks: kaneo-assistant-role-tab

## 1. Kaneo tab on the assistants home page

- [x] 1.1 Add a Kaneo tab component (`AssistantKaneoCreateTab`) under `packages/desktop/src/renderer/pages/settings/AssistantSettings/`, hosted as a fourth tab on `AssistantHomeTabs` next to enabled / mine / official (the manual create wizard stays unchanged; the editor embeds no Kaneo section)
- [x] 1.2 Implement the connect state machine hook: base URL (last-used default) + password-masked API key + Connect → uses `fetchKaneoBootstrap` (fallback-first) and `fetchKaneoConfigPackage`
- [x] 1.3 Roles listing UI: render roles from config package / bootstrap, group by project; role-scoped keys narrow selectable roles to the bound role and show others as unavailable
- [x] 1.4 Explicit role + project selection UI with Create disabled until both are selected; duplicate (role, project) pair detected from existing contexts shows "update in place" hint
- [x] 1.5 i18n: add `settings.kaneoCreateTab.*` keys in all configured languages; run `bun run i18n:types` and `node scripts/check-i18n.js`
- [x] 1.6 Show assistant instances under their agent role card in the Kaneo tab, grouped by role with project + workspace context

## 2. Instance creation and credential hand-off

- [x] 2.1 Create assistant from the tab: build/reuse the Kaneo context (`contextFromManifest` semantics), workspace path record, and assistant upsert via `syncKaneoAssistantsFromManifest` (project-bound) or `syncKaneoAssistants` (legacy fallback)
- [x] 2.2 Credential transfer on create: single `PUT /api/kaneo-credentials/{contextId}` (same IPC path the modal used); drop key state after success or editor close; no renderer persistence
- [x] 2.3 Rotation path: re-connecting an existing (role, project) context with a new key replaces ciphertext and updates the assistant in place

## 3. Retire the standalone Import from Kaneo entry

- [x] 3.1 Remove the `btn-kaneo-import` button from `AssistantHomeTabs` and unmount/delete `KaneoImportModal.tsx`; keep home page actions otherwise intact
- [x] 3.2 Port legacy-fallback semantics (unbound manifest / 404/405) into the tab flow; retire modal-only i18n keys and add new keys for the tab
- [x] 3.3 Clean up dead imports/state (`onKaneoImport`, `kaneoImportVisible`) and verify no `KaneoImportModal` references remain

## 4. Tests

- [x] 4.1 Unit tests for the tab hook: connect failure surfaces non-blocking error and retains base URL; role-scoped key narrows roles; create disabled without role+project
- [x] 4.2 Unit tests: (role, project) binding produces context with workspace `<userData>/kaneo-workspaces/<slug>/<role>/`; duplicate pair updates in place
- [x] 4.3 Unit tests: exactly one credential PUT per create; key state cleared on close
- [x] 4.4 Test: no "Import from Kaneo" button rendered on assistants home; legacy fallback path still syncs
- [x] 4.5 Run `bunx vitest run` for kaneo + assistant settings suites; tsc clean; oxlint/oxfmt clean

## 5. Validation

- [ ] 5.1 Manual flow: create assistant → Kaneo tab → connect → pick role + project → Create → assistant appears with workspace, session MCP server `kaneo:<contextId>` env-ref resolves in a live conversation
- [ ] 5.2 Confirm home page no longer shows the import button; edit existing (role, project) instance updates in place
