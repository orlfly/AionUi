# Spec Delta: kaneo-session-tooling

## ADDED Requirements

### Requirement: Session-level Kaneo MCP injection

When a conversation is created from a Kaneo assistant whose context has a usable credential, the session configuration SHALL include a session MCP server entry for the official Kaneo MCP (stdio), resolved without requiring global installation, with credentials supplied via the env reference mechanism.

#### Scenario: Session started with valid key

- **WHEN** the user starts a conversation from a project-bound Kaneo assistant with a saved credential
- **THEN** the session's MCP set includes the kaneo server, and claim/status/comment/VCS tools are callable within the conversation

#### Scenario: MCP server fails to resolve

- **WHEN** the kaneo-mcp binary or npx resolution fails at session start
- **THEN** the session is still created, a visible warning explains that Kaneo tools are unavailable, and the adapted skill instructions remain as fallback

### Requirement: Project-scoped tool guidance

The assistant's preconfigured claim prompt SHALL instruct the assistant to claim tasks via Kaneo MCP tools without passing a projectId (the key's server-side binding enforces scope), then follow role rules, submit a PR, and set the task status to in-review.

#### Scenario: Claim prompt

- **WHEN** a Kaneo assistant session is created and the claim prompt is used
- **THEN** the prompt references MCP tools (not raw curl) and omits projectId from claim instructions

### Requirement: Skill content adaptation

At import time, Kaneo SKILL.md content SHALL be adapted before staging: a precedence note is prepended stating that Kaneo MCP tools take precedence over curl-based instructions when available, and that env vars like `KANEO_API_KEY` are provided by the host environment. The upstream Kaneo files are not modified.

#### Scenario: Adapted import

- **WHEN** a Kaneo skill containing curl instructions is imported
- **THEN** the installed SKILL.md begins with the precedence note, followed by the original content

### Requirement: Skill import collision handling

When importing a `kaneo-<skill>` whose target name already exists with different content, the sync SHALL skip the overwrite, keep the existing skill, and report a drift warning in sync results; identical content SHALL overwrite idempotently.

#### Scenario: Same skill, different content across instances

- **WHEN** a second Kaneo instance exports a `kaneo-claim-task` whose content differs from the installed one
- **THEN** the installed skill is unchanged and the sync result lists a drift warning naming the skill

#### Scenario: Same content re-import

- **WHEN** the same instance is re-synced with unchanged skill content
- **THEN** the import completes idempotently with no warnings

### Requirement: Config contexts and Guide filtering

Kaneo contexts SHALL be stored as a list (`kaneo.contexts`) with an `activeContextId` pointer. The Guide SHALL, for the active context, hide Kaneo assistants of other roles within the same project while keeping Kaneo assistants of other projects and all non-Kaneo assistants visible. Existing `kaneo.activeRole` data SHALL be migrated once into a project-less context.

#### Scenario: Multiple projects

- **WHEN** two project contexts exist and context A is active
- **THEN** the Guide shows A's bound-role assistant and hides A's other-role assistants, while B's assistants remain visible

#### Scenario: Legacy migration

- **WHEN** the app upgrades with `kaneo.activeRole` set and no `kaneo.contexts`
- **THEN** a project-less context is created preserving the role-based filtering behavior, and `kaneo.activeRole` is no longer read
