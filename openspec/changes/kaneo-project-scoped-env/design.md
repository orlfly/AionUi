# Design: kaneo-project-scoped-env

## Context

AionUi's Kaneo integration (`packages/desktop/src/renderer/services/kaneo/`) is renderer-only: it imports role AGENTS.md and SKILL.md files into globally-named assistants (`Kaneo · <role>`) and skills (`kaneo-*`), keeps the API key in component memory only, and persists one config key (`kaneo.activeRole`). Assistants have no project knowledge, no dedicated workspace, and no tools to act on Kaneo — task claiming relies on a preconfigured prompt telling the model to write curl commands with env vars that are never actually set.

Kaneo's side (repo `/opt/workspace/kaneo`, commit c56ff2e6) added project-bound API keys: `metadata = { agentRole, projectId }` on the better-auth api-key record; `verify-api-key` resolves and validates the binding (403 when the project is deleted/archived); `team-access-middleware` enforces `assertProjectScope` on project/task resources; `/api/task/claim-next` auto-injects the bound projectId. The server also maintains per-project sandboxed workdirs (`agent-<projectId>/repo`) reachable via MCP `agent_*` tools, and ships an official MCP server (`@kaneo/mcp`, stdio, ~60 tools including claim/status/comment/VCS/file tools).

Known contract gap: AionUi reads `agentRole` from `GET /api/agent/agents-config/templates`, but that endpoint never returns it — every connect today hits the "role missing" branch.

Constraints:
- Renderer/main process boundary is a hard rule in AionUi; cross-process calls go through the preload IPC bridge.
- New user-facing text must be i18n'd (all locales in `packages/desktop/src/renderer/services/i18n/locales/`).
- No existing main specs (`openspec/specs/` empty) — this change establishes the first spec set.
- The Kaneo-side endpoint ships in a separate repo/release; AionUi must feature-detect and degrade.

## Goals / Non-Goals

**Goals:**
- A project-bound key produces a self-contained assistant: identity (`Kaneo · <project> · <role>`), knowledge (role rules + rendered project environment segment), tools (session-injected Kaneo MCP), and an isolated local workspace.
- Single source of truth for environment info: a versioned manifest produced by the Kaneo bootstrap endpoint, rendered into all consuming surfaces (rules segment, workspace config, MCP env, drift detection).
- API key never appears in renderer-persistent state, assistant fields, prompts, or plaintext config after import.
- Unbound keys keep today's behavior exactly; existing users migrate without losing assistants.
- Multiple projects and multiple roles per project coexist without workspace conflicts or skill clobbering.

**Non-Goals:**
- No changes to Kaneo's server-side sandbox or its built-in pi-agent chat.
- No automatic PR merging, autonomous scheduling, or task-loop orchestration in AionUi — the assistant works when the user starts a session.
- No support for multi-repository projects beyond manifest modeling (Kaneo itself is single-VCS today; `repositories[]` just future-proofs the contract).
- No browser-based auth flow; keys are still created in Kaneo's web UI and pasted into AionUi.

## Decisions

### D1: Versioned environment manifest as the single source of truth
Kaneo gains `GET /api/agent/agents-config/bootstrap` returning `{ manifestVersion, generatedAt, envHash, identity{agentRole, project, server}, repositories[{id, role: primary|secondary, type, owner, name, cloneUrl, defaultBranch|null, isActive}], workflow{statuses, reviewHandoff, mergePolicy}, workspacePolicy{layout} }`.
- **Why one manifest over scattered fields**: repo config otherwise leaks into 3+ AionUi copies (rules text, workspace derivation, prompt text) that drift independently. One structure, one fingerprint, atomic re-render on sync.
- **`defaultBranch` is nullable**: Kaneo's integration tables don't store a branch. The server MAY probe; otherwise `null` and the rules segment instructs "detect the main branch after cloning". Never fabricate.
- **Versioning**: AionUi renders known sections, ignores unknown ones. `manifestVersion` above the supported major → warn, degrade, never block import of the identity/project sections.
- **Fallback**: endpoint absent (older Kaneo) → 404/405 detection → fall back to today's templates flow unchanged.
- Alternatives considered: extending `/templates` (wrong semantics — that endpoint is static/global); client-side assembly from project + integration endpoints (more round trips, re-implements `resolveVcsIntegration`/`cloneUrl` logic, more drift surface).

### D2: Upsert key and naming — `(baseUrl, projectId, role)`
- Project-bound: assistant name `Kaneo · <projectName> · <role>`, upsert matches on that name (projectName from manifest; id kept in config for stability across renames).
- Unbound: legacy name `Kaneo · <role>`, matching today's `findKaneoAssistant`.
- Skill names stay global `kaneo-<skill>`; skills are content-addressed: identical content → idempotent overwrite; different content with same name → warn and skip overwrite (instance/version drift signal), surfaced in sync results.
- Alternative rejected: per-instance skill names (`kaneo-<instance>-<skill>`) — breaks cross-project sharing and bloats the skill list; drift warning achieves the same safety.

### D3: Workspace layout — per-project directory, per-role subdirectory
`<userData>/kaneo-workspaces/<projectSlug>/<role>/`. Roles sharing a project get separate clones (coding and code-review concurrently open would otherwise fight over branch state in one clone). code-review MAY share a read-only clone later; not modeled now.
- Guide auto-preselects `workspace = <dir>/<activeRole>` when the active context matches the selected assistant; user can still override via the existing workspace picker.
- Primary repo change (different `cloneUrl` in a new manifest): update rules segment, show a "re-clone needed" notice, never delete the old directory (user data).
- Alternative rejected: one clone per project with session locking — locking across windows/processes is fragile and code-review's read-only need doesn't justify it.

### D4: Credentials — `safeStorage` in main, ref indirection for renderer
- Import flow hands the plaintext key to a new IPC endpoint once; main encrypts via `safeStorage` and stores `{ contextId, ciphertext, baseUrl, expiresAt?, agentRole, projectId }` in a main-side store (file under userData, 0600).
- Renderer addresses the key only by `contextId`. Session MCP injection sends `envRef: 'kaneo:<contextId>'`; main resolves the ref and injects `KANEO_API_URL`/`KANEO_API_KEY` into the spawned MCP subprocess env.
- Rotation: re-connect in the modal overwrites the ciphertext for the same contextId (upsert hits the existing assistant; no rebuild).
- Linux without libsecret: `safeStorage.isEncryptionAvailable()` false → offer "remember for this session" (memory only) or explicit plaintext-file opt-in with a warning; never silently plaintext.
- Alternative rejected: keeping plaintext in renderer config (violates the integration's stated security invariant); keytar (extra native dep, overlaps safeStorage).

### D5: Tooling — session-level `@kaneo/mcp` + adapted skill content
- Sessions created from a Kaneo assistant include a session MCP entry `kaneo` (stdio `kaneo-mcp`, resolved via bundled dependency or `npx` fallback) with the env ref from D4.
- Claim prompt rewritten: prefer MCP tools; server-side project binding means no projectId needed in calls.
- Imported SKILL.md content is adapted at import time: a header note is prepended stating that when Kaneo MCP tools are available they take precedence over curl snippets, and env-var references (`KANEO_API_KEY`) degrade to "provided by the host". Original files remain untouched server-side; adaptation happens on the zip content in-memory before import (same staging path as today).
- Alternative rejected: rewriting skill bodies to MCP calls wholesale — brittle against upstream skill edits; a precedence note keeps the diff minimal.

### D6: Config model — `kaneo.contexts[]` + `activeContextId`
`KaneoContext = { id, baseUrl, agentRole, projectId|null, projectName, projectSlug, workspace, manifestSummary{envHash, manifestVersion}, keyExpiresAt|null }` (no key material). Guide filtering generalizes `filterAssistantsForActiveKaneoRole`: hide other `Kaneo · *` assistants within the active context's project; keep assistants from other projects visible.
- Migration: one-time — `kaneo.activeRole` becomes a context with `projectId: null` (legacy naming), then the key is removed.
- Alternative rejected: keeping single `activeContext` — multi-project users lose all other contexts on each import (discussed and rejected in review).

### D7: Lifecycle and drift
- 403 with "bound to project" semantics on any Kaneo call → mark context degraded in config; Guide shows a badge; sync/connect retries clear it.
- Key expiry: `expiresAt` from key creation is stored (D4); Guide warns within 7 days of expiry; expired → degraded state, rotation flow reuses import modal.
- `envHash` mismatch on reconnect → re-render rules segment + workspace notice (D3 re-clone path).

## Risks / Trade-offs

- [Kaneo endpoint slips or changes shape] → feature-detect + manifest version gating; AionUi ships fallback-first, so no dependency on unreleased Kaneo.
- [`safeStorage` unavailable (Linux headless)] → memory-only session key; plaintext opt-in behind explicit warning; documented in the modal.
- [`kaneo-mcp` binary not resolvable] → resolve at session start; on failure, session proceeds with adapted-skill curl instructions minus env (visible warning), never silently breaks session creation.
- [Skill drift across Kaneo instances] → D2 content-addressing warns and skips; user sees which instance "owns" the skill.
- [Project rename changes assistant name] → upsert keyed by name; migration path: rename assistant via update when manifest projectName differs from stored context (match on projectId from config, not name).
- [Two windows, same context, same role] → same workspace concurrently used by two sessions; acceptable (same as any user opening two terminals in one repo); documented, not locked.
- [Main-process IPC surface is new review surface] → single narrow bridge namespace (`kaneoCredentials.*`), typed payloads, no key material in renderer-bound responses.

## Migration Plan

1. Ship Kaneo bootstrap endpoint + templates `agentRole` (kaneo repo, independent PR).
2. AionUi: fallback-first renderer work (manifest client, naming, workspace, config migration) — no main changes yet; keys remain memory-only.
3. AionUi: credential IPC + MCP injection (main/preload) behind the existing UI.
4. Rollback: each AionUi phase is independently revertible; config migration writes `kaneo.contexts` but retains `kaneo.activeRole` until step 3 lands (dual-read window).

## Open Questions

- Probe `defaultBranch` server-side on bootstrap (adds latency, may fail on private repos without token round-trip) vs always `null`? Lean: `null` in v1.
- Should code-review share a project's clone read-only in v1, or always per-role clones? Lean: per-role clones (simple), revisit if disk usage complaints.
- `@kaneo/mcp` bundling strategy: add as optionalDependency vs `npx` resolution at first use? Lean: `npx` first (zero install footprint), bundle if startup latency hurts.
