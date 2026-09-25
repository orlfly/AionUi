## Requirements

### Requirement: Bootstrap manifest retrieval

The AionUi Kaneo client SHALL attempt `GET /api/agent/agents-config/bootstrap` (Bearer API key) when connecting to a Kaneo instance, and SHALL parse the returned project environment manifest (manifestVersion, generatedAt, envHash, identity{agentRole, project, server}, repositories[], workflow, workspacePolicy) when the endpoint responds successfully.

#### Scenario: Project-bound key

- **WHEN** connecting with an API key whose metadata binds role and project, and the bootstrap endpoint returns a complete manifest
- **THEN** the client exposes the manifest with `identity.agentRole`, `identity.project` (id, teamId, name, slug, description), and `repositories` populated from the server response

#### Scenario: Unbound key

- **WHEN** the bootstrap endpoint returns a manifest with `identity.project: null`
- **THEN** the client treats the key as unbound and the import flow falls back to the legacy templates-based behavior with legacy assistant naming

#### Scenario: Endpoint absent on older Kaneo

- **WHEN** the bootstrap endpoint responds 404 or 405
- **THEN** the client falls back to the existing `GET /api/agent/agents-config/templates` flow without surfacing an error, and no project-scoped features are offered

### Requirement: Manifest version tolerance

The client SHALL accept manifests whose `manifestVersion` is greater than the highest supported version by rendering all known sections and ignoring unknown ones, and SHALL NOT block import on unsupported manifest versions.

#### Scenario: Newer manifest version

- **WHEN** the manifest carries `manifestVersion` 2 while the client supports 1
- **THEN** the client renders the sections it recognizes, ignores unrecognized sections, and shows a non-blocking notice that some environment information may be unavailable

### Requirement: Repository truthfulness

The rendered environment SHALL NOT present a default branch that the manifest did not provide. When `repositories[].defaultBranch` is null, the rendered rules segment SHALL instruct the assistant to detect the primary branch after cloning.

#### Scenario: Branch not provided

- **WHEN** the manifest's primary repository has `defaultBranch: null`
- **THEN** the generated rules segment contains branch-detection guidance instead of a fabricated branch name

#### Scenario: No VCS integration

- **WHEN** the manifest contains an empty `repositories` array
- **THEN** the rules segment states the project has no connected repository, and no clone guidance is rendered

### Requirement: Environment drift detection

The client SHALL store the manifest's `envHash` in the Kaneo context and, on every subsequent connect/sync, compare the freshly fetched hash with the stored one, re-rendering derived surfaces (rules segment, workspace notices) when they differ.

#### Scenario: Repository changed

- **WHEN** a reconnect returns a manifest whose primary repository `cloneUrl` differs from the stored context
- **THEN** the assistant rules segment is rewritten with the new repository, the user is shown a re-clone notice, and the previous workspace directory is not deleted

### Requirement: Templates agentRole contract

While the legacy templates flow remains supported, the client SHALL read `agentRole` from the templates response when present and SHALL NOT assume the field's presence (preserving the existing role-missing warning path).

#### Scenario: Templates response includes agentRole

- **WHEN** the fallback templates flow receives a response containing a string `agentRole`
- **THEN** the import flow uses it to lock the sync to that role, matching the bootstrap behavior
