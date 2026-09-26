# Spec Delta: kaneo-assistant-create-tab

## ADDED Requirements

### Requirement: Kaneo tab on the assistants home page

The assistants home page SHALL expose a dedicated **Kaneo** tab alongside the enabled / mine / official tabs. The tab SHALL provide: a Kaneo base URL field (pre-filled from the last used value), an API key field (password-masked), and a Connect action. The assistant creation wizard (manual create flow) SHALL remain unchanged and MUST NOT embed a Kaneo section.

#### Scenario: Tab visible on the assistants home

- **WHEN** the assistants home page renders
- **THEN** a Kaneo tab is available next to the official tab and selecting it shows the Kaneo connection form

#### Scenario: Manual create flow unchanged

- **WHEN** the user opens the assistant creation wizard (manual create)
- **THEN** no Kaneo section is rendered; the wizard keeps its original identity / prompts / defaults structure

### Requirement: Role listing from Kaneo

After a successful connect (base URL + API key), the tab SHALL fetch the agent roles defined by the Kaneo instance (roles in the config package, narrowed to the key-bound role when the key is role-scoped) and SHALL present them as selectable agent role cards, grouped by the Kaneo project they will be bound to.

#### Scenario: Roles listed after connect

- **WHEN** connect succeeds against a Kaneo instance exposing roles `coordinator`, `coding`, `code-review`
- **THEN** those roles appear as selectable agent role cards in the tab

#### Scenario: Role-scoped key

- **WHEN** the connected key reports a bound `agentRole` of `coding`
- **THEN** only `coding` is selectable and other roles are shown as unavailable for this key

#### Scenario: Connect failure

- **WHEN** the base URL is unreachable or the key is rejected (401/403)
- **THEN** the tab shows a non-blocking error and retains the entered base URL for retry

### Requirement: Role bound to a specific project

For the selected role, the user SHALL explicitly bind it to a **specific Kaneo project** before creating the assistant. The available projects SHALL come from the Kaneo bootstrap/manifest data (project id, name, slug). Binding determines the Kaneo context identity (`contextId`), the per-project workspace, and the session MCP env-ref used by `kaneo-project-scoped-env`.

#### Scenario: Project selection required

- **WHEN** the user selects role `coordinator` but no project
- **THEN** the Create action stays disabled with an explicit prompt to choose a project

#### Scenario: Binding recorded

- **WHEN** the user binds role `coordinator` to project `aionui` and creates the assistant
- **THEN** a Kaneo context exists with `{ agentRole: 'coordinator', projectId: 'aionui', workspace: '<userData>/kaneo-workspaces/aionui/coordinator/' }` and the assistant references it

### Requirement: One assistant instance per project per role

Each (role, project) pair SHALL surface as exactly one assistant instance in AionUi. Creating an instance for an already-bound pair SHALL re-open / update that existing assistant in place rather than duplicating it.

#### Scenario: Distinct instances per project

- **WHEN** role `coding` is bound to project `aionui` and later to project `kaneo`
- **THEN** two assistant instances exist, each carrying its own project binding and workspace

#### Scenario: Duplicate guard

- **WHEN** the user selects role `coding` for project `aionui` which already has an instance
- **THEN** the tab indicates an existing instance for this role-project pair and creating updates that instance instead of creating a second one

#### Scenario: Instances listed under their role

- **WHEN** the user opens the Kaneo tab while at least one (role, project) assistant instance exists
- **THEN** each Kaneo assistant instance is listed under its agent role card as an assistant entry

### Requirement: Explicit agent selection is mandatory

The Create action in the Kaneo tab SHALL remain disabled until the user has explicitly selected both the agent role and the project (i.e. no implicit default role/project). The selection state SHALL be visible before Create.

#### Scenario: Create disabled without selection

- **WHEN** the user enters an API key but has not picked a role and project
- **THEN** Create is disabled and the prompt explains what is missing

### Requirement: Credential transfer on create

When the user creates the assistant instance, the tab SHALL transfer the plaintext API key exactly once to `PUT /api/kaneo-credentials/{contextId}` via the AionCore kaneo credentials API (AES-256-GCM at rest). The renderer SHALL NOT persist the plaintext key in config or assistant fields; the key SHALL be discarded from component state after successful hand-off.

#### Scenario: Key handed to backend once

- **WHEN** the assistant instance is created with a fresh API key
- **THEN** exactly one PUT call carries the key; subsequent reads/edits of the assistant never see plaintext

#### Scenario: Tab closed without create

- **WHEN** the user navigates away from the Kaneo tab or disconnects before creating
- **THEN** no credential is stored and no context is created

### Requirement: Remove standalone Import from Kaneo button

The assistants home page SHALL NOT render the standalone "Import from Kaneo" button; the Kaneo import capabilities are reachable only through the Kaneo tab on the assistants home page. Legacy template-import behavior (unbound manifest fallback) SHALL remain available inside the Kaneo tab.

#### Scenario: Button absent

- **WHEN** the assistants home page renders
- **THEN** no "Import from Kaneo" action exists; Kaneo import is reachable only via the home page's Kaneo tab

#### Scenario: Legacy fallback still works in tab

- **WHEN** the connected Kaneo instance has no project-bound bootstrap endpoint (404/405) or an unbound key
- **THEN** the tab falls back to the legacy templates flow and its naming, without the modal
