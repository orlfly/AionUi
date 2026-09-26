# Spec Delta: kaneo-assistant-workspace

## MODIFIED Requirements

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
