# Proposal: kaneo-project-scoped-env

## Why

Kaneo now lets an API key be bound to a single project (`metadata.projectId`, commit c56ff2e6): the key's task operations are confined to that project server-side, and `claim-next` auto-injects the binding. AionUi's current Kaneo integration ignores projects entirely — it imports role rules/skills into a globally-shared assistant with no workspace, no project context, and no way for the assistant to act on Kaneo. A project-scoped key should yield an assistant with a complete, self-contained working environment (identity, project knowledge, tools, isolated workspace, server-enforced boundaries) so it can autonomously work Kaneo-published dev tasks.

A secondary driver: the current code expects `GET /api/agent/agents-config/templates` to return `agentRole`, but the Kaneo endpoint never does. This change also fixes that contract gap.

## What Changes

- **Kaneo side (separate repo, coordinated)**: new `GET /api/agent/agents-config/bootstrap` endpoint returning a versioned project environment manifest (role, project identity, repositories, workflow, server info) resolved from the API key's bindings; `GET /templates` response gains `agentRole`.
- **AionUi side (this repo)**:
  - Import flow consumes the bootstrap manifest; assistant naming becomes `Kaneo · <project> · <role>` for project-bound keys (unbound keys keep the legacy `Kaneo · <role>` name), upsert keyed by (baseUrl, projectId, role).
  - Assistant rules gain a rendered "project environment" segment (repo, branch policy, status machine, boundaries) generated from the manifest — single source of truth, atomically rewritten on every sync.
  - Each project context gets a dedicated local workspace directory under `<userData>/kaneo-workspaces/<projectSlug>/`, per-role subdirectories to avoid concurrent-agent conflicts, auto-preselected in the Guide when a matching Kaneo assistant is active.
  - Kaneo API keys are persisted encrypted via Electron `safeStorage` (main process only); renderer never handles plaintext after import.
  - Sessions created from a Kaneo assistant inject the official `@kaneo/mcp` server as a session MCP with `KANEO_API_URL`/`KANEO_API_KEY` env (main-process injection via encrypted-ref indirection).
  - Imported Kaneo skills are content-adapted so their curl/env-var instructions degrade gracefully when MCP tools are available instead.
  - Config model migrates from single `kaneo.activeRole` to `kaneo.contexts[]` + `activeContextId`, with one-time migration of existing data.
  - Lifecycle handling: key expiry warning/rotation, project archived/deleted (403) detection marking the assistant degraded, manifest drift detection via `envHash`.

No **BREAKING** changes to existing AionUi behavior: unbound keys retain today's flow and naming; legacy `Kaneo · <role>` assistants and `kaneo.activeRole` are migrated forward.

## Capabilities

### New Capabilities

- `kaneo-environment-manifest`: Contract for the versioned project environment manifest — fields, versioning rules, drift fingerprint (`envHash`), degraded/empty states (no VCS, archived project), and how the AionUi client parses and falls back across manifest versions.
- `kaneo-assistant-workspace`: Per-project, per-role local workspace lifecycle — creation under the managed root, auto-preselection in the Guide, first-clone guidance, primary-repo change handling, and concurrency isolation between roles sharing a project.
- `kaneo-credential-storage`: Encrypted storage of Kaneo API keys using `safeStorage` — main-process ownership, renderer-facing ref indirection, expiry metadata, rotation, and plaintext-never-in-renderer invariants.
- `kaneo-session-tooling`: Session-level injection of the Kaneo MCP server and adapted skill content so a Kaneo assistant can claim/work/submit tasks via tools rather than hand-written curl.

### Modified Capabilities

(None — `openspec/specs/` has no existing specs; this is the first spec set. The existing `kaneoSync`/`kaneoClient` behavior for unbound keys is preserved as-is, so the role-import flow is covered by the new capabilities rather than a delta.)

## Impact

- **Code**:
  - Renderer: `packages/desktop/src/renderer/services/kaneo/` (kaneoClient, kaneoSync, new manifest/workspace/credential modules), `KaneoImportModal`, `useGuidAssistantSelection`, `useGuidSend`/`useGuidInput` workspace preselection, i18n keys across all locales.
  - Main process + preload: new IPC bridge surface for credential storage (encrypt/decrypt-by-ref/inject-env) — the only main-process change.
  - Config: `configKeys.ts` (`kaneo.contexts`, `activeContextId`, removal path for `kaneo.activeRole` after migration).
- **External APIs**: depends on the Kaneo bootstrap endpoint (delivered in the kaneo repo); AionUi must tolerate its absence and fall back to the templates flow.
- **Dependencies**: `@kaneo/mcp` (stdio server) must be resolvable at session start (bundled or `npx`); Electron `safeStorage` availability gates credential persistence (Linux libsecret fallback policy).
- **Systems**: local filesystem under the user data dir; no backend/database changes beyond config keys.
- **Coordination**: the Kaneo repo change (bootstrap endpoint + templates `agentRole`) ships first; AionUi feature-detects it.
