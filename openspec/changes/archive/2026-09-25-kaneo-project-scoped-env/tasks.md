# Tasks: kaneo-project-scoped-env

Implementation is split so each group lands independently revertible. Group 1 tracks the coordinated Kaneo-repo work (executed there, verified from here); groups 2-6 are AionUi-only and ordered by dependency.

## 1. Kaneo side (kaneo repo — coordinated prerequisite)

- [x] 1.1 Add `GET /api/agent/agents-config/bootstrap` returning the versioned environment manifest (identity from `readAgentRole`/`readProjectId`, repositories from `resolveVcsIntegration` + `cloneUrl` logic, workflow statuses, envHash), reusing existing helpers; unbound key returns `project: null`
- [x] 1.2 Add `agentRole` to the `GET /api/agent/agents-config/templates` response (fixes the existing contract gap AionUi already codes against)
- [x] 1.3 Unit tests: bootstrap for bound key, unbound key, project without VCS integration, inactive/invalid integration filtered with degraded marker
- [ ] 1.4 Verify from AionUi dev environment against a running Kaneo instance (connect flow sees the manifest)

## 2. Manifest client and config model (AionUi renderer, fallback-first)

- [x] 2.1 Add manifest types and `fetchKaneoBootstrap()` in `services/kaneo/` with 404/405 fallback to the templates flow and version tolerance (render known sections, warn on newer major)
- [x] 2.2 Replace `kaneo.activeRole` with `kaneo.contexts[]` + `activeContextId` in `configKeys.ts`; add one-time migration from `kaneo.activeRole` to a project-less context (dual-read window during rollout)
- [x] 2.3 Generalize `filterAssistantsForActiveKaneoRole` to context-based filtering (hide other roles in the active project, keep other projects' Kaneo assistants and non-Kaneo assistants visible)
- [x] 2.4 Unit tests: manifest parsing/fallback, version tolerance, migration, filtering (multi-project scenario)
- [x] 2.5 Run i18n pipeline (`bun run i18n:types`, `node scripts/check-i18n.js`) after adding keys for all new user-facing strings

## 3. Sync upgrades: naming, rules segment, workspace

- [x] 3.1 Extend `kaneoSync` for project-bound keys: assistant name `Kaneo · <projectName> · <role>`, upsert keyed by (baseUrl, projectId, role) with rename-on-project-rename (match by projectId from context, not name)
- [x] 3.2 Implement `renderProjectEnvironmentSegment(manifest)` (repo/branch guidance with nullable defaultBranch, no-VCS case, status machine, boundaries) and append it to assistant rules on every sync, atomically rewriting the segment
- [x] 3.3 Implement workspace allocation `<userData>/kaneo-workspaces/<projectSlug>/<role>/` on sync (recursive create, path recorded in context); no allocation for unbound keys
- [x] 3.4 Implement envHash drift detection on reconnect (re-render rules segment, re-clone notice when primary cloneUrl changes, never delete old workspace)
- [x] 3.5 Skill import collision handling: identical content idempotent, differing content skip + drift warning in sync results
- [x] 3.6 Adapt KaneoImportModal: bootstrap preview (role, project, repository, skills), drift/expiry notices, active-context switching
- [x] 3.7 Unit tests: naming/upsert/rename, segment rendering (all manifest edge cases), workspace paths, drift, collision handling
- [x] 3.8 New `tests/integration/kaneo-bootstrap-roundtrip.integration.test.ts`: bootstrap-mock round trip (rules contain project segment, workspace created, skills filtered; live aioncore workspace endpoint check gated on AIONUI_TEST_URL)

## 4. Guide integration

- [x] 4.1 Auto-preselect the context workspace when its assistant is selected in the Guide (`useKaneoGuideContext`; reuse `dir` state; user override preserved)
- [x] 4.2 Add degradation/expiry badge on the Guide input area for the selected assistant's bound context (<7 days warning, expired/degraded red); rotate flow = reconnect via the import modal
- [x] 4.3 401/403 KaneoConnectionError in the import modal connect flow → mark stored contexts for the instance degraded; successful sync clears it (upsert refreshes from the manifest)
- [x] 4.4 DOM tests `tests/unit/renderer/useKaneoGuideContext.dom.test.ts` (11 cases: matching, preselection/override, degraded/expiry states, degraded marking)

## 5. Credential storage (AionCore backend, AES-256-GCM at rest)

> Architecture note: the renderer talks to the AionCore backend over HTTP
> (port 25808), so storage lives server-side with the existing
> `encryption_key` root (same as provider keys), not Electron safeStorage.

- [x] 5.1 AionCore `KaneoCredentialService`: encrypted store/rotate/delete/list/resolve keyed by `kaneo-credential:<contextId>` in `client_preferences`; HTTP routes `GET/PUT/DELETE /api/kaneo-credentials[/{contextId}]`; responses carry metadata only, never key material; reserved-prefix guard on the generic preferences API
- [x] 5.2 Encrypted-at-rest guarantee: `aionui_common::encrypt_string` (AES-256-GCM) with `derive_encryption_key` root; plaintext exists only in the one-shot PUT body and the server-side `resolve()` path (session MCP env injection)
- [x] 5.3 AionUi renderer wiring: `ipcBridge.kaneoCredentials` namespace (http wrappers); import modal saves plaintext via PUT on successful sync and discards it on modal close; context stores `keyExpiresAt`
- [x] 5.4 Tests: 10 unit tests (encryption at rest, rotation in place, metadata shape, validation, resolve roundtrip) + 8 HTTP integration tests (metadata-only reads, 404/400 paths, list filtering, reserved-prefix rejection)

## 6. Session tooling (MCP injection)

- [x] 6.1 Add `envRef` support to session MCP configuration; main resolves `kaneo:<contextId>` at spawn time and injects `KANEO_API_URL`/`KANEO_API_KEY` into the kaneo-mcp subprocess env (AionCore `kaneo_envref` module resolves refs in the inline session MCP snapshot at agent-build time; unresolvable refs fail closed, server dropped)
- [x] 6.2 Resolve the kaneo MCP server at session start (npx first per design open question; warn-and-continue on failure, never block session creation) — Guide appends the session-injected `kaneo` builtin server (`buildKaneoMcpServer`) to `selected_session_mcp_servers` when the selected assistant matches a Kaneo context; AionCore best-effort resolution never blocks session creation
- [x] 6.3 Prepend the MCP-precedence note to imported SKILL.md content at staging time (in-memory before zip build) — `kaneoMcpPrecedenceNote` + `buildSkillZip` integration; drift comparison strips the note
- [x] 6.4 Rewrite `buildClaimPrompt` for project-bound contexts: MCP tools, no projectId in claim instructions
- [x] 6.5 Unit tests: envRef resolution (AionCore kaneo_envref: 5 unit tests; AionUi: envRef sentinel, prompt content, precedence note), manual smoke test of a full claim → clone → PR → in-review cycle against a live Kaneo pending release-build联调
