# Spec Delta: kaneo-assistant-workspace

## MODIFIED Requirements

### Requirement: Per-project per-role workspace allocation

For every project-bound Kaneo context, the sync flow (triggered from the assistants home page's Kaneo tab or from reconnection/rotation in place) SHALL allocate a dedicated workspace directory at `<userData>/kaneo-workspaces/<projectSlug>/<role>/`, creating it (recursively) on sync if missing, and SHALL record the absolute path in the Kaneo context. The allocation entry point is the Kaneo tab (see `kaneo-assistant-create-tab`), not the retired standalone import modal.

#### Scenario: First sync from the Kaneo tab

- **WHEN** a project-bound key completes sync for role `coding` on project `aionui` via the Kaneo tab
- **THEN** the directory `<userData>/kaneo-workspaces/aionui/coding/` exists and the context records it as the workspace

#### Scenario: Role isolation

- **WHEN** the same project is later synced for role `code-review` with a different key
- **THEN** that assistant's workspace is `<userData>/kaneo-workspaces/aionui/code-review/`, distinct from the coding workspace

#### Scenario: Legacy modal retired

- **WHEN** the user looks for the standalone "Import from Kaneo" modal on the assistants home page
- **THEN** it no longer exists; the same allocation happens through the Kaneo tab
