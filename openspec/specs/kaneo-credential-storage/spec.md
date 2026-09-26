## Requirements

### Requirement: Encrypted key persistence in main process

When the user connects with a project-bound or role-bound key inside the assistant creation UI's Kaneo tab and chooses to save it (create or update an instance), the renderer SHALL transfer the plaintext API key to the main process (AionCore `PUT /api/kaneo-credentials/{contextId}`) exactly once, and the main process SHALL persist it encrypted (AES-256-GCM at rest, mode 0600 when file-backed), keyed by Kaneo context id. The entry point is the Kaneo tab; the retired "Import from Kaneo" modal no longer exists.

#### Scenario: Save on create from Kaneo tab

- **WHEN** the tab flow sync succeeds and the user opts to remember the key
- **THEN** main stores `{ contextId, ciphertext, baseUrl, agentRole, projectId, expiresAt? }` and any renderer-held plaintext is discarded when the editor closes

#### Scenario: Rotation

- **WHEN** the user re-connects an existing context with a new API key through the Kaneo tab
- **THEN** the stored ciphertext for that contextId is replaced and the assistant is updated in place (no assistant rebuild)

### Requirement: No plaintext in renderer-persistent state

The plaintext API key SHALL NOT be written to any assistant field, prompt text, rules content, config store, localStorage, or log output. Renderer code SHALL address stored keys only by context id.

#### Scenario: Post-import inspection

- **WHEN** a Kaneo context exists with a saved key
- **THEN** no renderer-readable store (config service, assistant records, conversation extras) contains the plaintext key

### Requirement: Env injection by reference

Session MCP configuration SHALL carry a credential reference (e.g. `envRef: 'kaneo:<contextId>'`) instead of key material, and the main process SHALL resolve the reference at subprocess spawn time, injecting `KANEO_API_URL` and `KANEO_API_KEY` into the Kaneo MCP server process environment.

#### Scenario: Session with Kaneo assistant

- **WHEN** a conversation starts from a Kaneo assistant with tooling enabled
- **THEN** the spawned kaneo-mcp subprocess env contains the resolved `KANEO_API_URL`/`KANEO_API_KEY`, and the conversation create payload sent from the renderer contains no plaintext key

### Requirement: Encryption availability fallback

When `safeStorage` encryption is unavailable, the system SHALL NOT persist plaintext by default; it SHALL offer a session-memory key (valid until app exit) or an explicitly confirmed plaintext opt-in, each with a visible warning.

#### Scenario: Linux without libsecret

- **WHEN** the platform keyring is unavailable at import time
- **THEN** the modal presents memory-only and explicit-plaintext options with warnings, and the default selection is memory-only

### Requirement: Expiry awareness

When the Kaneo key has an expiration, its `expiresAt` SHALL be stored as plaintext metadata alongside the ciphertext, and the Guide SHALL show a warning when expiry is within 7 days and mark the context degraded after expiry.

#### Scenario: Approaching expiry

- **WHEN** a context's key expires in 3 days and its assistant is selected in the Guide
- **THEN** the user sees an expiry warning with an action to rotate the key

#### Scenario: Expired key

- **WHEN** any Kaneo call for the context returns 401
- **THEN** the context is marked degraded, the assistant shows a reconnect/rotate affordance, and no other contexts are affected
