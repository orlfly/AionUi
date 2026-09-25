## Requirements

### Requirement: Per-project per-role workspace allocation

For every project-bound Kaneo context, the sync flow SHALL allocate a dedicated workspace directory at `<userData>/kaneo-workspaces/<projectSlug>/<role>/`, creating it (recursively) on sync if missing, and SHALL record the absolute path in the Kaneo context.

#### Scenario: First sync

- **WHEN** a project-bound key completes sync for role `coding` on project `aionui`
- **THEN** the directory `<userData>/kaneo-workspaces/aionui/coding/` exists and the context records it as the workspace

#### Scenario: Role isolation

- **WHEN** the same project is later synced for role `code-review` with a different key
- **THEN** that assistant's workspace is `<userData>/kaneo-workspaces/aionui/code-review/`, distinct from the coding workspace

### Requirement: Guide workspace preselection

When the Guide's active Kaneo context matches the selected Kaneo assistant (same project and role), the Guide SHALL preselect that context's workspace directory as the conversation workspace, and the user SHALL be able to override it via the existing workspace picker.

#### Scenario: Kaneo assistant selected

- **WHEN** the user selects the active context's assistant in the Guide and starts input
- **THEN** the session is created with `workspace` set to the context workspace and `custom_workspace: true`

#### Scenario: Non-Kaneo assistant

- **WHEN** the user selects any non-Kaneo assistant or a Kaneo assistant belonging to a non-active context
- **THEN** workspace selection behaves exactly as before this change

### Requirement: First-clone guidance

The assistant rules segment for a project with a primary repository SHALL instruct: clone the primary repository into the workspace if absent, using the manifest cloneUrl, and never clone repositories outside the manifest.

#### Scenario: Empty workspace

- **WHEN** a Kaneo assistant session starts in a workspace without a repository checkout
- **THEN** the rules segment instructs the assistant to clone the manifest's primary repository before task work

#### Scenario: Repository change

- **WHEN** a manifest refresh changes the primary repository and the user acknowledges the re-clone notice
- **THEN** guidance points at the new cloneUrl and the old directory contents remain untouched on disk

### Requirement: Legacy compatibility

The workspace allocation SHALL apply only to project-bound contexts. Unbound keys SHALL continue to produce assistants with no workspace allocation and unchanged Guide behavior.

#### Scenario: Unbound key sync

- **WHEN** a key without project binding completes sync
- **THEN** no workspace directory is created and the assistant behaves identically to the pre-change flow
