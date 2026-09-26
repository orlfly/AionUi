# Spec Delta: kaneo-credential-storage

## MODIFIED Requirements

### Requirement: Encrypted key persistence in main process

When the user connects with a project-bound or role-bound key inside the assistant creation UI's Kaneo tab and chooses to save it (create or update an instance), the renderer SHALL transfer the plaintext API key to the main process (AionCore `PUT /api/kaneo-credentials/{contextId}`) exactly once, and the main process SHALL persist it encrypted (AES-256-GCM at rest, mode 0600 when file-backed), keyed by Kaneo context id. The entry point is the Kaneo tab; the retired "Import from Kaneo" modal no longer exists.

#### Scenario: Save on create from Kaneo tab

- **WHEN** the tab flow sync succeeds and the user opts to remember the key
- **THEN** main stores `{ contextId, ciphertext, baseUrl, agentRole, projectId, expiresAt? }` and any renderer-held plaintext is discarded when the editor closes

#### Scenario: Rotation

- **WHEN** the user re-connects an existing context with a new API key through the Kaneo tab
- **THEN** the stored ciphertext for that contextId is replaced and the assistant is updated in place (no assistant rebuild)
