/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kaneo → AionUi Assistants sync service.
//
// Upserts one AionUi Assistant per Kaneo agent role, named `Kaneo · <role>`:
//   - description  ← role description from the templates endpoint
//   - rules        ← role AGENTS.md content (via assistant-rule write API)
//   - prompts      ← a preconfigured claim-task prompt
//   - skills       ← Kaneo skills filtered by for_roles, imported as custom
//                    skills named `kaneo-<skill>`
//
// Skill import: Kaneo zips carry only SKILL.md per skill. The renderer cannot
// create directories (fs/write refuses missing parents and there is no mkdir
// endpoint), so we stage each skill as an in-memory zip (`kaneo-<skill>/SKILL.md`)
// uploaded via `POST /api/fs/upload` (multipart), then hand the uploaded path to
// `POST /api/skills/import`, which unpacks it into the user skills root.
// Re-import overwrites, so syncs are idempotent.
//
// Idempotence: assistants matching the naming convention are updated in place;
// anything else is never touched. The Kaneo API key is used in-memory only and
// never written into any Assistant field.

import { ipcBridge } from '@/common';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import {
  type KaneoConfigPackage,
  type KaneoTemplates,
  fetchKaneoConfigPackage,
  fetchKaneoTemplates,
  skillAppliesToRole,
  skillsForRoleFromTemplates,
} from './kaneoClient';
import { type KaneoEnvironmentManifest, isManifestVersionNewer, primaryRepository } from './kaneoManifest';
import {
  type KaneoContext,
  contextFromManifest,
  getKaneoContexts,
  newKaneoContextId,
  updateKaneoContext,
  upsertKaneoContext,
} from './kaneoContexts';
import type { IMcpServer } from '@/common/config/storage';

export const KANEO_ASSISTANT_NAME_PREFIX = 'Kaneo · ';
export const KANEO_SKILL_NAME_PREFIX = 'kaneo-';

export function kaneoAssistantName(role: string): string {
  return `${KANEO_ASSISTANT_NAME_PREFIX}${role}`;
}

/** Project-bound assistant name: `Kaneo · <projectName> · <role>`. */
export function kaneoProjectAssistantName(projectName: string, role: string): string {
  return `${KANEO_ASSISTANT_NAME_PREFIX}${projectName} · ${role}`;
}

export function kaneoSkillName(skill: string): string {
  return `${KANEO_SKILL_NAME_PREFIX}${skill}`;
}

/** Build the preconfigured claim-task prompt for a role. */
export function buildClaimPrompt(role: string, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return (
    `Claim your next Kaneo task and complete it according to your role rules. ` +
    `Prefer the Kaneo MCP tools when they are available in this session: use them to claim a task matching your ` +
    `role, work it following the working rules in your assistant rules, then submit a PR and set the task status ` +
    `to in-review. If the Kaneo MCP tools are not available, fall back to the ${kaneoSkillName('claim-task')} ` +
    `skill; it may reference the KANEO_API_KEY environment variable, which is provided by the host — do not ask ` +
    `for a key and do not need one. Kaneo API base URL: ${base || 'http://localhost:1337'}`
  );
}

// ── Session MCP server (project-scoped env) ───────────────────────────────

export const KANEO_MCP_SERVER_NAME = 'kaneo';
export const KANEO_MCP_BUILTIN_ID = 'builtin-kaneo';

/**
 * Build the Kaneo builtin session MCP server for a stored context. The key is
 * addressed ONLY by env-ref sentinel (`kaneo:<contextId>`): AionCore resolves
 * the ref against the encrypted credential store at agent-build time and
 * injects the decrypted KANEO_API_URL/KANEO_API_KEY into the spawned MCP
 * subprocess env. Plaintext key material never appears here.
 */
export function buildKaneoMcpServer(context: KaneoContext): IMcpServer {
  const envRef = `kaneo:${context.id}`;
  const env: Record<string, string> = {
    KANEO_API_URL: envRef,
    KANEO_API_KEY: envRef,
  };
  const serverConfig = { command: 'npx', args: ['-y', 'kaneo-mcp@latest'], env };
  const now = Date.now();
  return {
    id: KANEO_MCP_BUILTIN_ID,
    name: KANEO_MCP_SERVER_NAME,
    description: 'Kaneo task tools bound to the imported project (session-injected).',
    enabled: true,
    builtin: true,
    transport: { type: 'stdio', command: serverConfig.command, args: serverConfig.args, env },
    original_json: JSON.stringify({ mcpServers: { [KANEO_MCP_SERVER_NAME]: serverConfig } }, null, 2),
    created_at: now,
    updated_at: now,
  };
}

// ── Project environment segment (rendered from the manifest) ────────────────

export const KANEO_ENV_SEGMENT_START = '<!-- kaneo-project-environment -->';
export const KANEO_ENV_SEGMENT_END = '<!-- /kaneo-project-environment -->';

/**
 * Render the project environment segment from a manifest: repository and
 * branch guidance, the task status machine, and boundaries. Deterministic for
 * a given manifest so identical envHash ⇒ identical segment.
 *
 * Repository truthfulness: `defaultBranch: null` renders branch-detection
 * guidance, never a fabricated branch name. No repositories renders a
 * no-repository statement without clone guidance.
 */
export function renderProjectEnvironmentSegment(manifest: KaneoEnvironmentManifest): string {
  const project = manifest.identity.project;
  const lines: string[] = [];
  lines.push(KANEO_ENV_SEGMENT_START);
  lines.push('## Project environment');
  lines.push('');
  if (!project) {
    lines.push('This key is not bound to a Kaneo project; no project environment applies.');
    lines.push(KANEO_ENV_SEGMENT_END);
    return lines.join('\n');
  }
  lines.push(
    `Kaneo project: ${project.name} (${project.slug}). All task operations are confined to this project by the API key binding; do not attempt to access other projects.`
  );

  const primary = primaryRepository(manifest);
  if (!primary) {
    lines.push('');
    lines.push(
      '**Repository:** this project has no connected version-control repository. Do not clone anything; work only on task descriptions and attached files.'
    );
  } else {
    lines.push('');
    lines.push(
      `**Primary repository:** ${primary.type} ${primary.owner}/${primary.name} (clone URL: ${primary.cloneUrl}).`
    );
    lines.push(
      `Clone it into this workspace if no checkout exists yet, and never clone repositories outside this manifest.`
    );
    if (primary.defaultBranch) {
      lines.push(`The default branch is \`${primary.defaultBranch}\`.`);
    } else {
      lines.push(
        'The default branch is not provided by Kaneo: after cloning, detect the primary branch (e.g. `git remote show origin`) instead of guessing a branch name.'
      );
    }
    if (manifest.repositories.length > 1) {
      const secondaries = manifest.repositories.filter((r) => r !== primary);
      for (const repo of secondaries) {
        lines.push(`**Secondary repository:** ${repo.type} ${repo.owner}/${repo.name} (clone URL: ${repo.cloneUrl}).`);
      }
    }
  }

  const statuses = manifest.workflow?.statuses ?? [];
  if (statuses.length > 0) {
    lines.push('');
    lines.push(`**Task status machine:** ${statuses.join(' → ')}.`);
    lines.push(
      `When submitting work for review, set the task status to \`${manifest.workflow?.reviewHandoff === 'code-review' ? 'in-review' : statuses[statuses.length - 1]}\`.`
    );
    if (manifest.workflow?.mergePolicy === 'human-only') {
      lines.push('Merging is performed by humans only: never merge or self-approve your own PR.');
    }
  }

  if (isManifestVersionNewer(manifest.manifestVersion)) {
    lines.push('');
    lines.push(
      `Note: this Kaneo instance reports environment manifest v${manifest.manifestVersion}; some newer environment details may not be shown here.`
    );
  }
  lines.push('');
  lines.push(KANEO_ENV_SEGMENT_END);
  return lines.join('\n');
}

/**
 * Replace (or append) the project environment segment in a rules document.
 * Atomic per segment: the rest of the document (role AGENTS.md) is preserved.
 */
export function appendEnvironmentSegment(rules: string, segment: string): string {
  const regex = new RegExp(
    `${KANEO_ENV_SEGMENT_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${KANEO_ENV_SEGMENT_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`
  );
  const replaced = rules.replace(regex, '');
  const base = replaced.trimEnd();
  return base ? `${base}\n\n${segment}\n` : `${segment}\n`;
}

/**
 * Allocate (create if missing) the per-project per-role workspace directory
 * and return its absolute path. Calls the backend's dedicated
 * `/api/fs/kaneo-workspace` endpoint, which validates the slug/role and
 * creates `{managed-root}/kaneo-workspaces/<slug>/<role>/`.
 */
export async function allocateKaneoWorkspace(projectSlug: string, role: string): Promise<string> {
  const dir = await ipcBridge.kaneoWorkspace.ensure.invoke({ project_slug: projectSlug, role });
  return dir;
}

export type KaneoSyncRoleResult =
  | { role: string; status: 'created' | 'updated' }
  | { role: string; status: 'failed'; error: string };

export type KaneoSyncResult = {
  results: KaneoSyncRoleResult[];
  importedSkills: string[];
};

/** Find an existing Kaneo assistant for a role among the given assistants. */
export function findKaneoAssistant(assistants: Assistant[], role: string): Assistant | undefined {
  const target = kaneoAssistantName(role);
  return assistants.find((a) => a.name === target);
}

/**
 * Filter the assistant list for the active Kaneo context.
 *
 * Project-bound context: hide every other `Kaneo · <project> · *` assistant of
 * the same project (the key only authorizes one role there) while keeping
 * Kaneo assistants from other projects and all non-Kaneo assistants visible.
 * Project-less (legacy) context: fall back to the legacy role filter — hide
 * every `Kaneo · <role>` assistant other than the bound role. In both cases
 * the full list is returned when the bound assistant does not exist yet.
 */
export function filterAssistantsForKaneoContext<T extends { name: string }>(
  assistants: T[],
  context: { projectName: string | null; agentRole: string } | undefined
): T[] {
  if (!context) return assistants;
  if (!context.projectName) {
    // Legacy role filter (migrated unbound context).
    const targetName = kaneoAssistantName(context.agentRole);
    const hasTarget = assistants.some((assistant) => assistant.name === targetName);
    if (!hasTarget) return assistants;
    return assistants.filter(
      (assistant) => !assistant.name.startsWith(KANEO_ASSISTANT_NAME_PREFIX) || assistant.name === targetName
    );
  }
  const targetName = kaneoProjectAssistantName(context.projectName, context.agentRole);
  const hasTarget = assistants.some((assistant) => assistant.name === targetName);
  if (!hasTarget) return assistants;
  const projectPrefix = kaneoProjectAssistantName(context.projectName, '');
  return assistants.filter((assistant) => !assistant.name.startsWith(projectPrefix) || assistant.name === targetName);
}

/**
 * Import a Kaneo skill as `kaneo-<skill>` into the AionUi user skills root.
 *
 * Builds an in-memory zip containing `kaneo-<skill>/SKILL.md`, uploads it via
 * the multipart `/api/fs/upload` endpoint, and passes the uploaded absolute
 * path to the skills import endpoint, which unpacks it. Importing an
 * already-registered skill overwrites it in place (idempotent).
 */
export async function importKaneoSkill(
  skillName: string,
  skillMdContent: string
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const targetName = kaneoSkillName(skillName);
  try {
    const zipBlob = buildSkillZip(targetName, skillMdContent);
    const uploadedPath = await uploadZipForImport(zipBlob, `${targetName}.zip`);

    const result = await ipcBridge.fs.importSkills.invoke({ skill_path: uploadedPath });
    if (result.failed && result.failed.length > 0) {
      return {
        ok: false,
        error: result.failed
          .map((f: { source_name: string; code: string }) => `${f.source_name}: ${f.code}`)
          .join('; '),
      };
    }
    return { ok: true, name: targetName };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * MCP-precedence note (design D5/6.3): prepended to imported SKILL.md content
 * at staging time. Kaneo MCP tools (session-injected) take precedence over the
 * curl snippets in the skill body; env-var references degrade to "provided by
 * the host". The original Kaneo zip content is never modified server-side.
 */
export const KANEO_PRECEDENCE_START = '<!-- kaneo-mcp-precedence -->';
export const KANEO_PRECEDENCE_END = '<!-- /kaneo-mcp-precedence -->';

export function kaneoMcpPrecedenceNote(): string {
  return (
    KANEO_PRECEDENCE_START +
    '\n' +
    '> **Host note:** when Kaneo MCP tools are available in this session, prefer them over the\n' +
    '> curl/HTTP snippets below — they are already authenticated by the host. References to the\n' +
    '> `KANEO_API_KEY` environment variable mean "provided by the host": the value is injected\n' +
    '> into the tool process automatically; never ask the user for it.\n' +
    KANEO_PRECEDENCE_END +
    '\n\n'
  );
}

/**
 * Rewrite the `name:` field in a SKILL.md frontmatter to `skillDir`.
 * The skills import endpoint derives the installed skill name from the
 * frontmatter `name:` when present (falling back to the zip entry folder), so
 * Kaneo skills carrying their own name would otherwise be installed without
 * the `kaneo-` prefix, breaking the naming convention and role upsert matching.
 */
export function rewriteSkillName(skillMdContent: string, skillName: string): string {
  const frontmatter = skillMdContent.match(/^---\r?\n([\s\S]*?)\r?\n(-{3,}\r?\n?)/);
  if (!frontmatter) return skillMdContent;
  const rewritten = frontmatter[1].replace(/^(\s*name:\s*).*$/m, `$1${skillName}`);
  if (rewritten === frontmatter[1]) return skillMdContent;
  return skillMdContent.replace(frontmatter[0], `---\n${rewritten}\n---\n`);
}

/** Build a zip blob with a single `<skillDir>/SKILL.md` entry (stored, no compression). */
export function buildSkillZip(skillDir: string, skillMdContent: string): Blob {
  const content = rewriteSkillName(kaneoMcpPrecedenceNote() + skillMdContent, skillDir);
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(`${skillDir}/SKILL.md`);
  const dataBytes = encoder.encode(content);
  const crc32 = crc32Of(dataBytes);

  const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number): Uint8Array =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const parts: ArrayBufferView[] = [];

  // Local file header (method 0 = stored).
  const local: Uint8Array[] = [
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(crc32),
    u32(dataBytes.length),
    u32(dataBytes.length),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
    dataBytes,
  ];
  const localSize = local.reduce((n, c) => n + c.length, 0);
  parts.push(...local);

  // Central directory header.
  const central = [
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(crc32),
    u32(dataBytes.length),
    u32(dataBytes.length),
    u16(nameBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBytes,
  ];
  const centralSize = central.reduce((n: number, c: Uint8Array) => n + c.length, 0);
  parts.push(...central);

  // End of central directory.
  parts.push(u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(centralSize), u32(localSize), u16(0));

  return new Blob(parts as BlobPart[], { type: 'application/zip' });
}

/** CRC-32 (IEEE 802.3, reflected) as required by the zip format. */
function crc32Of(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Upload a zip to the backend temp store and return the stored absolute path.
 * Uses the same multipart contract as FileService.uploadFileViaHttp; the
 * backend stores it under `/tmp/aionui/general/` and returns that path.
 */
async function uploadZipForImport(zip: Blob, fileName: string): Promise<string> {
  const { getBaseUrl } = await import('@/common/adapter/httpBridge');
  const formData = new FormData();
  formData.append('file', zip, fileName);
  const response = await fetch(`${getBaseUrl()}/api/fs/upload`, { method: 'POST', body: formData });
  const body: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    throw new Error(`Skill staging upload failed: HTTP ${response.status}`);
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== 'string' || !data) {
    throw new Error('Skill staging upload returned no path');
  }
  return data;
}

/**
 * Sync Kaneo role assistants into AionUi.
 *
 * @param baseUrl Kaneo instance base URL
 * @param apiKey Kaneo API key (in-memory only)
 * @param roles Roles to sync
 * @param existing Current assistants, for upsert detection
 */
export async function syncKaneoAssistants(
  baseUrl: string,
  apiKey: string,
  roles: readonly string[],
  existing: Assistant[]
): Promise<KaneoSyncResult> {
  const templates: KaneoTemplates = await fetchKaneoTemplates(baseUrl, apiKey);
  const config: KaneoConfigPackage = await fetchKaneoConfigPackage(baseUrl, apiKey);

  // Import every skill once (shared across roles), tracking failures.
  const importedSkillNames = new Set<string>();
  const availableSkills = await ipcBridge.fs.listAvailableSkills.invoke();
  const availableNames = new Set(availableSkills.map((s: { name: string }) => s.name));

  for (const skill of templates.skills) {
    const targetName = kaneoSkillName(skill.name);
    const content = config.skills[skill.name];
    if (content === undefined) {
      // Listed in templates but not in the zip — keep an existing import if any.
      if (availableNames.has(targetName)) importedSkillNames.add(targetName);
      continue;
    }
    const importResult = await importKaneoSkill(skill.name, content);
    if (importResult.ok) {
      importedSkillNames.add(importResult.name);
    }
  }

  const results: KaneoSyncRoleResult[] = [];

  // Assistants need an agent backend; default to the first available managed
  // agent (same order the assistant editor uses).
  let defaultAgentId: string | undefined;
  try {
    const managedAgents = await ipcBridge.acpConversation.getManagedAgents.invoke();
    defaultAgentId = managedAgents.find((a: { id: string }) => Boolean(a.id))?.id;
  } catch {
    defaultAgentId = undefined;
  }

  for (const role of roles) {
    try {
      const agentsMd = config.roles[role];
      if (agentsMd === undefined) {
        throw new Error(`Role "${role}" has no AGENTS.md in the Kaneo config package`);
      }
      const description = templates.roles.find((r) => r.name === role)?.description ?? `Kaneo ${role} agent`;
      const enabledSkills = templates.skills
        .filter(
          (skill) => skillAppliesToRole(skill.forRoles, role) && importedSkillNames.has(kaneoSkillName(skill.name))
        )
        .map((skill) => kaneoSkillName(skill.name));

      const existingAssistant = findKaneoAssistant(existing, role);
      const rolePrompt = buildClaimPrompt(role, baseUrl);
      const createAssistant = async () => {
        const created = await ipcBridge.assistants.create.invoke({
          name: kaneoAssistantName(role),
          description,
          agent_id: defaultAgentId,
          custom_skill_names: enabledSkills,
          prompts: [rolePrompt],
        });
        await writeAssistantRule(created.id, agentsMd);
        return created;
      };

      if (existingAssistant) {
        try {
          await ipcBridge.assistants.update.invoke({
            id: existingAssistant.id,
            description,
            custom_skill_names: enabledSkills,
            recommended_prompts: [rolePrompt],
          });
          await writeAssistantRule(existingAssistant.id, agentsMd);
          results.push({ role, status: 'updated' });
        } catch (updateError) {
          // The assistant was found in the snapshot but no longer exists on the
          // backend (e.g. deleted elsewhere). Fall back to creating it so a
          // stale snapshot can't strand a role with neither update nor create.
          const message = updateError instanceof Error ? updateError.message : String(updateError);
          if (/not found|NOT_FOUND/i.test(message)) {
            await createAssistant();
            results.push({ role, status: 'created' });
          } else {
            throw updateError;
          }
        }
      } else {
        await createAssistant();
        results.push({ role, status: 'created' });
      }
    } catch (error) {
      results.push({
        role,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results, importedSkills: Array.from(importedSkillNames) };
}

export type KaneoManifestSyncResult = KaneoSyncResult & {
  context: KaneoContext;
  /** Whether the envHash changed since the stored context (drift). */
  envDrift: boolean;
  /** Primary cloneUrl changed since last sync (re-clone needed). */
  cloneUrlChanged: boolean;
  /** A newer manifest major than this client supports (non-blocking notice). */
  newerManifestVersion: boolean;
  /** Skill drift warnings (same name, different content). */
  skillDriftWarnings: string[];
};

/**
 * Sync a project-bound Kaneo key from a bootstrap manifest: project-named
 * assistant (upsert keyed by baseUrl/projectId/role), rules = role AGENTS.md +
 * rendered project environment segment, per-project per-role workspace, and
 * envHash drift detection against the stored context.
 */
export async function syncKaneoAssistantsFromManifest(options: {
  baseUrl: string;
  apiKey: string;
  manifest: KaneoEnvironmentManifest;
  config: KaneoConfigPackage;
  templates: KaneoTemplates;
  existing: Assistant[];
}): Promise<KaneoManifestSyncResult> {
  const { baseUrl, apiKey, manifest, config, templates, existing } = options;
  const project = manifest.identity.project;
  const role = manifest.identity.agentRole;
  const skillDriftWarnings: string[] = [];

  // The key is project-bound: the sync targets exactly its bound role.
  if (!project) {
    // Defensive: callers should route unbound keys to the legacy flow.
    const legacy = await syncKaneoAssistants(baseUrl, apiKey, [manifest.identity.agentRole], existing);
    return {
      ...legacy,
      context: contextFromManifest(manifest, baseUrl),
      envDrift: false,
      cloneUrlChanged: false,
      newerManifestVersion: isManifestVersionNewer(manifest.manifestVersion),
      skillDriftWarnings: [],
    };
  }

  // Import skills (shared), with content-addressed collision handling.
  const importedSkillNames = new Set<string>();
  const availableSkills = await ipcBridge.fs.listAvailableSkills.invoke();
  const installed = new Map(availableSkills.map((s: { name: string }) => [s.name, s]));
  for (const skill of templates.skills) {
    if (!skillAppliesToRole(skill.forRoles, role)) continue;
    const targetName = kaneoSkillName(skill.name);
    const content = config.skills[skill.name];
    if (content === undefined) {
      if (installed.has(targetName)) importedSkillNames.add(targetName);
      continue;
    }
    // Content-addressed import: identical content re-imports idempotently;
    // differing content for an existing skill is a drift signal — skip and warn.
    // The installed copy carries the host MCP-precedence note (6.3), so strip
    // it before comparing against the upstream Kaneo content.
    const existingSkill = await readInstalledSkillContent(targetName);
    if (
      existingSkill !== null &&
      normalizeSkillContent(stripKaneoPrecedenceNote(existingSkill)) !== normalizeSkillContent(content)
    ) {
      skillDriftWarnings.push(skill.name);
      if (installed.has(targetName)) importedSkillNames.add(targetName);
      continue;
    }
    const importResult = await importKaneoSkill(skill.name, content);
    if (importResult.ok) importedSkillNames.add(importResult.name);
  }

  const agentsMd = config.roles[role];
  if (agentsMd === undefined) {
    throw new Error(`Role "${role}" has no AGENTS.md in the Kaneo config package`);
  }

  // Workspace allocation (project-bound only).
  const workspace = await allocateKaneoWorkspace(project.slug, role);

  const description =
    templates.roles.find((r) => r.name === role)?.description ?? `Kaneo ${role} agent for ${project.name}`;
  const enabledSkills = templates.skills
    .filter((skill) => skillAppliesToRole(skill.forRoles, role) && importedSkillNames.has(kaneoSkillName(skill.name)))
    .map((skill) => kaneoSkillName(skill.name));

  // Drift detection against the stored context (if any).
  const existingContexts = await getKaneoContextsSnapshot();
  const previous = existingContexts.find(
    (c) => c.baseUrl === baseUrl && c.projectId === project.id && c.agentRole === role
  );
  const envDrift = Boolean(previous?.manifestSummary && previous.manifestSummary.envHash !== manifest.envHash);
  // A manifest change that alters repositories is covered by envHash drift.
  // A dedicated cloneUrlChanged signal requires storing the last primary
  // cloneUrl; v1 derives the re-clone notice from envDrift instead.
  const cloneUrlChanged = envDrift;

  const name = kaneoProjectAssistantName(project.name, role);
  const rules = appendEnvironmentSegment(agentsMd, renderProjectEnvironmentSegment(manifest));
  const rolePrompt = buildClaimPrompt(role, baseUrl);
  let defaultAgentId: string | undefined;
  try {
    const managedAgents = await ipcBridge.acpConversation.getManagedAgents.invoke();
    defaultAgentId = managedAgents.find((a: { id: string }) => Boolean(a.id))?.id;
  } catch {
    defaultAgentId = undefined;
  }

  // Project rename: match by context assistantId first (stable across renames),
  // then by name (fresh import), never creating a duplicate.
  const existingAssistant =
    (previous?.assistantId && existing.find((a) => a.id === previous.assistantId)) ||
    existing.find((a) => a.name === name);

  const createAssistant = async () => {
    const created = await ipcBridge.assistants.create.invoke({
      name,
      description,
      agent_id: defaultAgentId,
      custom_skill_names: enabledSkills,
      prompts: [rolePrompt],
    });
    await writeAssistantRule(created.id, rules);
    return created;
  };

  let assistantId: string;
  let status: 'created' | 'updated';
  if (existingAssistant) {
    try {
      await ipcBridge.assistants.update.invoke({
        id: existingAssistant.id,
        name,
        description,
        custom_skill_names: enabledSkills,
        recommended_prompts: [rolePrompt],
      });
      await writeAssistantRule(existingAssistant.id, rules);
      assistantId = existingAssistant.id;
      status = 'updated';
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : String(updateError);
      if (/not found|NOT_FOUND/i.test(message)) {
        const created = await createAssistant();
        assistantId = created.id;
        status = 'created';
      } else {
        throw updateError;
      }
    }
  } else {
    const created = await createAssistant();
    assistantId = created.id;
    status = 'created';
  }

  // Upsert the context (preserves id/credential on reconnect) and record
  // workspace + assistant id + the new manifest fingerprint.
  const base = contextFromManifest(manifest, baseUrl);
  const { context } = await upsertKaneoContext({ ...base, assistantId, workspace });
  await updateKaneoContext(context.id, { assistantId, workspace });

  return {
    results: [{ role, status }],
    importedSkills: Array.from(importedSkillNames),
    context,
    envDrift,
    cloneUrlChanged,
    newerManifestVersion: isManifestVersionNewer(manifest.manifestVersion),
    skillDriftWarnings,
  };
}

async function getKaneoContextsSnapshot(): Promise<KaneoContext[]> {
  const { getKaneoContexts } = await import('./kaneoContexts');
  return getKaneoContexts();
}

/** Read an installed custom skill's SKILL.md content for collision checks. */
async function readInstalledSkillContent(targetName: string): Promise<string | null> {
  try {
    const skills = await ipcBridge.fs.listAvailableSkills.invoke();
    const found = skills.find((s: { name: string }) => s.name === targetName);
    if (!found?.location) return null;
    const content = await ipcBridge.fs.readFile.invoke({
      path: `${found.location}${found.location.endsWith('/') ? '' : '/'}SKILL.md`,
    });
    return content ?? null;
  } catch {
    return null;
  }
}

function normalizeSkillContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/** Remove the host MCP-precedence note (6.3) from installed skill content. */
function stripKaneoPrecedenceNote(content: string): string {
  const start = content.indexOf(KANEO_PRECEDENCE_START);
  if (start === -1) return content;
  const end = content.indexOf(KANEO_PRECEDENCE_END, start);
  if (end === -1) return content;
  return (content.slice(0, start) + content.slice(end + KANEO_PRECEDENCE_END.length)).replace(/^\n+/, '');
}

async function writeAssistantRule(assistantId: string, content: string): Promise<void> {
  if (content.trim()) {
    await ipcBridge.fs.writeAssistantRule.invoke({ assistant_id: assistantId, content });
  }
}

export type KaneoExplicitBindingResult = {
  /** Created or updated assistant instance for the (role, project) pair. */
  status: 'created' | 'updated';
  assistantId: string;
  contextId: string;
  workspace: string;
  /** True when an existing (role, project) context was reused (rotation). */
  reusedExisting: boolean;
};

/** Options for the explicit (role, project) binding sync from the create tab. */
export type KaneoExplicitBindingOptions = {
  baseUrl: string;
  /** The instance's project the role is bound to (from the tab picker). */
  project: { id: string; name: string; slug: string };
  role: string;
  /** Role AGENTS.md content from the config package. */
  agentsMd: string;
  /** Description for the assistant (from templates). */
  description: string;
  /** Skill ids enabled for this role (already imported). */
  enabledSkills: string[];
  /** Current assistants for in-place update detection. */
  existing: Assistant[];
  /** Explicit agent engine chosen in the tab; falls back to the first managed agent. */
  agentId?: string;
};

/**
 * Create-or-update one assistant instance for an explicitly chosen
 * (role, project) pair from the Kaneo create tab.
 *
 * Unlike the manifest sync this does not require a bootstrap manifest:
 * real Kaneo instances expose roles via `/api/agent/agents-config/*` and
 * projects via `/api/team` + `/api/project?teamId=...`, so the user binds
 * a role to a chosen project in the UI. The created context follows the
 * same upsert semantics as manifest sync (never duplicates a binding),
 * allocates the per-project per-role workspace, and writes role rules
 * without the project environment segment (no manifest is available).
 */
export async function syncKaneoAssistantForBinding(
  options: KaneoExplicitBindingOptions
): Promise<KaneoExplicitBindingResult> {
  const { baseUrl, project, role, agentsMd, description, enabledSkills, existing, agentId } = options;
  if (!agentsMd.trim()) {
    throw new Error(`Role "${role}" has no AGENTS.md in the Kaneo config package`);
  }
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  const workspace = await allocateKaneoWorkspace(project.slug, role);
  const name = kaneoProjectAssistantName(project.name, role);
  const rolePrompt = buildClaimPrompt(role, trimmedBase);

  let defaultAgentId: string | undefined = agentId;
  if (!defaultAgentId) {
    try {
      const managedAgents = await ipcBridge.acpConversation.getManagedAgents.invoke();
      defaultAgentId = managedAgents.find((a: { id: string }) => Boolean(a.id))?.id;
    } catch {
      defaultAgentId = undefined;
    }
  }

  // Match a previous instance first by its stored context, then by name so a
  // fresh import cannot collide with an old naming.
  const previousContext = getKaneoContexts().find(
    (c) => c.baseUrl === trimmedBase && (c.projectId ?? null) === project.id && c.agentRole === role
  );
  const existingAssistant =
    (previousContext?.assistantId && existing.find((a) => a.id === previousContext.assistantId)) ||
    existing.find((a) => a.name === name);

  const createAssistant = async () => {
    const created = await ipcBridge.assistants.create.invoke({
      name,
      description,
      agent_id: defaultAgentId,
      custom_skill_names: enabledSkills,
      prompts: [rolePrompt],
    });
    await writeAssistantRule(created.id, agentsMd);
    return created;
  };

  let assistantId: string;
  let status: 'created' | 'updated';
  if (existingAssistant) {
    try {
      await ipcBridge.assistants.update.invoke({
        id: existingAssistant.id,
        name,
        description,
        custom_skill_names: enabledSkills,
        recommended_prompts: [rolePrompt],
      });
      await writeAssistantRule(existingAssistant.id, agentsMd);
      assistantId = existingAssistant.id;
      status = 'updated';
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : String(updateError);
      if (/not found|NOT_FOUND/i.test(message)) {
        const created = await createAssistant();
        assistantId = created.id;
        status = 'created';
      } else {
        throw updateError;
      }
    }
  } else {
    const created = await createAssistant();
    assistantId = created.id;
    status = 'created';
  }

  // Gateway context: stable identity for credentials + session MCP env-ref.
  const baseContext: KaneoContext = previousContext ?? {
    id: newKaneoContextId(),
    baseUrl: trimmedBase,
    agentRole: role,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
    workspace: null,
    assistantId: null,
    manifestSummary: null,
    keyExpiresAt: null,
    degraded: false,
    degradedReason: null,
  };
  const { context, created: createdContext } = await upsertKaneoContext({
    ...baseContext,
    assistantId,
    workspace,
  });
  if (createdContext || context.assistantId !== assistantId) {
    await updateKaneoContext(context.id, { assistantId, workspace });
  }

  return {
    status,
    assistantId,
    contextId: context.id,
    workspace,
    reusedExisting: !createdContext,
  };
}

export { skillsForRoleFromTemplates };
