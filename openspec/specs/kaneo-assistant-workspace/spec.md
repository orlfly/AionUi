## Requirements

### Requirement: Per-project per-role workspace allocation

For every project-bound Kaneo context, the sync flow (triggered from the assistants home page's Kaneo tab or from reconnection/rotation in place) SHALL allocate a dedicated workspace directory at `<userData>/kaneo-workspaces/<projectSlug>/<role>/`, creating it (recursively) on sync if missing, and SHALL record the absolute path in the Kaneo context. The allocation entry point is the Kaneo tab (see `kaneo-assistant-create-tab`), not the retired standalone import modal. Kaneo project slugs are free-form text (any script); the backend maps each slug to a filesystem-safe directory name deterministically: ASCII slugs are used verbatim, and other slugs are folded to an escaped ASCII form, so a given slug always maps to the same directory and no slug can escape or traverse out of the `kaneo-workspaces` root.

#### Scenario: First sync from the Kaneo tab

- **WHEN** a project-bound key completes sync for role `coding` on project `aionui` via the Kaneo tab
- **THEN** the directory `<userData>/kaneo-workspaces/aionui/coding/` exists and the context records it as the workspace

#### Scenario: Role isolation

- **WHEN** the same project is later synced for role `code-review` with a different key
- **THEN** that assistant's workspace is `<userData>/kaneo-workspaces/aionui/code-review/`, distinct from the coding workspace

#### Scenario: Non-ASCII project slug

- **WHEN** a project's slug contains non-ASCII characters (e.g. a project named in Chinese, whose auto-generated slug is Han text)
- **THEN** allocation succeeds and the workspace directory name is a deterministic, filesystem-safe ASCII form of that slug; re-creating the assistant for the same project reuses the same directory

#### Scenario: Legacy modal retired

- **WHEN** the user looks for the standalone "Import from Kaneo" modal on the assistants home page
- **THEN** it no longer exists; the same allocation happens through the Kaneo tab

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
