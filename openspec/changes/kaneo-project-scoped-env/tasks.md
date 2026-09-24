# Tasks: kaneo-project-scoped-env

Implementation is split so each group lands independently revertible. Group 1 tracks the coordinated Kaneo-repo work (executed there, verified from here); groups 2-6 are AionUi-only and ordered by dependency.

## 1. Kaneo side (kaneo repo — coordinated prerequisite)

- [x] 1.1 Add `GET /api/agent/agents-config/bootstrap` returning the versioned environment manifest (identity from `readAgentRole`/`readProjectId`, repositories from `resolveVcsIntegration` + `cloneUrl` logic, workflow statuses, envHash), reusing existing helpers; unbound key returns `project: null`
- [x] 1.2 Add `agentRole` to the `GET /api/agent/agents-config/templates` response (fixes the existing contract gap AionUi already codes against)
- [x] 1.3 Unit tests: bootstrap for bound key, unbound key, project without VCS integration, inactive/invalid integration filtered with degraded marker
- [ ] 1.4 Verify from AionUi dev environment against a running Kaneo instance (connect flow sees the manifest)

## 2. Manifest client and config model (AionUi renderer, fallback-first)

- [ ] 2.1 Add manifest types and `fetchKaneoBootstrap()` in `services/kaneo/` with 404/405 fallback to the templates flow and version tolerance (render known sections, warn on newer major)
- [ ] 2.2 Replace `kaneo.activeRole` with `kaneo.contexts[]` + `activeContextId` in `configKeys.ts`; add one-time migration from `kaneo.activeRole` to a project-less context (dual-read window during rollout)
- [ ] 2.3 Generalize `filterAssistantsForActiveKaneoRole` to context-based filtering (hide other roles in the active project, keep other projects' Kaneo assistants and non-Kaneo assistants visible)
- [ ] 2.4 Unit tests: manifest parsing/fallback, version tolerance, migration, filtering (multi-project scenario)
- [ ] 2.5 Run i18n pipeline (`bun run i18n:types`, `node scripts/check-i18n.js`) after adding keys for all new user-facing strings

## 3. Sync upgrades: naming, rules segment, workspace

- [ ] 3.1 Extend `kaneoSync` for project-bound keys: assistant name `Kaneo · <projectName> · <role>`, upsert keyed by (baseUrl, projectId, role) with rename-on-project-rename (match by projectId from context, not name)
- [ ] 3.2 Implement `renderProjectEnvironmentSegment(manifest)` (repo/branch guidance with nullable defaultBranch, no-VCS case, status machine, boundaries) and append it to assistant rules on every sync, atomically rewriting the segment
- [ ] 3.3 Implement workspace allocation `<userData>/kaneo-workspaces/<projectSlug>/<role>/` on sync (recursive create, path recorded in context); no allocation for unbound keys
- [ ] 3.4 Implement envHash drift detection on reconnect (re-render rules segment, re-clone notice when primary cloneUrl changes, never delete old workspace)
- [ ] 3.5 Skill import collision handling: identical content idempotent, differing content skip + drift warning in sync results
- [ ] 3.6 Adapt KaneoImportModal: bootstrap preview (role, project, repository, skills), drift/expiry notices, active-context switching
- [ ] 3.7 Unit tests: naming/upsert/rename, segment rendering (all manifest edge cases), workspace paths, drift, collision handling
- [ ] 3.8 Extend `tests/integration/kaneo-assistants-sync.integration.test.ts` with a bootstrap-mock round trip (rules contain project segment, workspace created, skills filtered)

## 4. Guide integration

- [ ] 4.1 Auto-preselect the active context's workspace when its assistant is selected in the Guide (reuse `dir` state; user override preserved)
- [ ] 4.2 Add context/degradation badges and expiry warning (<7 days) with rotate action on the assistant card
- [ ] 4.3 403 bound-project and 401 expired-key detection on Kaneo errors → mark context degraded; reconnect clears it
- [ ] 4.4 Unit/DOM tests for preselection and badge states

## 5. Credential storage (main process + preload)

- [ ] 5.1 Implement `kaneoCredentials.*` IPC bridge: store (safeStorage-encrypted, 0600 file), rotate, delete, resolve-by-ref; typed payloads, no key material in renderer-bound responses
- [ ] 5.2 Handle `safeStorage` unavailability: memory-only session key or explicit plaintext opt-in with warning (never silent plaintext)
- [ ] 5.3 Wire the import modal save/rotate flows through the bridge; renderer discards plaintext on modal close
- [ ] 5.4 Unit tests for the bridge (mock safeStorage) + integration test that no renderer-readable store contains plaintext

## 6. Session tooling (MCP injection)

- [ ] 6.1 Add `envRef` support to session MCP configuration; main resolves `kaneo:<contextId>` at spawn time and injects `KANEO_API_URL`/`KANEO_API_KEY` into the kaneo-mcp subprocess env
- [ ] 6.2 Resolve the kaneo MCP server at session start (npx first per design open question; warn-and-continue on failure, never block session creation)
- [ ] 6.3 Prepend the MCP-precedence note to imported SKILL.md content at staging time (in-memory before zip build)
- [ ] 6.4 Rewrite `buildClaimPrompt` for project-bound contexts: MCP tools, no projectId in claim instructions
- [ ] 6.5 Unit tests: envRef resolution, prompt content, precedence note; manual smoke test of a full claim → clone → PR → in-review cycle against a live Kaneo
