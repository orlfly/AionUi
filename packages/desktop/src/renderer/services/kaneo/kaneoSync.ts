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

export const KANEO_ASSISTANT_NAME_PREFIX = 'Kaneo · ';
export const KANEO_SKILL_NAME_PREFIX = 'kaneo-';

export function kaneoAssistantName(role: string): string {
  return `${KANEO_ASSISTANT_NAME_PREFIX}${role}`;
}

export function kaneoSkillName(skill: string): string {
  return `${KANEO_SKILL_NAME_PREFIX}${skill}`;
}

/** Build the preconfigured claim-task prompt for a role. */
export function buildClaimPrompt(role: string, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return (
    `Claim your next Kaneo task and complete it according to your role rules. ` +
    `Use the ${kaneoSkillName('claim-task')} skill: claim a task matching your role, work it following the ` +
    `working rules in your assistant rules, then submit a PR and set the task status to in-review. ` +
    `Kaneo API base URL: ${base || 'http://localhost:1337'}`
  );
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
 * Filter the assistant list for a role-scoped Kaneo key.
 *
 * When `activeKaneoRole` is set (the role bound to the API key that was used to
 * import agent config), hide every other `Kaneo · <role>` assistant so the
 * Guide only surfaces the single role the key is authorized for. Non-Kaneo
 * assistants are unaffected, and if the bound role's assistant does not exist
 * yet we fall back to the full list rather than hiding everything.
 */
export function filterAssistantsForActiveKaneoRole<T extends { name: string }>(
  assistants: T[],
  activeKaneoRole?: string
): T[] {
  if (!activeKaneoRole) return assistants;
  const targetName = kaneoAssistantName(activeKaneoRole);
  const hasTarget = assistants.some((assistant) => assistant.name === targetName);
  if (!hasTarget) return assistants;
  return assistants.filter(
    (assistant) => !assistant.name.startsWith(KANEO_ASSISTANT_NAME_PREFIX) || assistant.name === targetName
  );
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
  const content = rewriteSkillName(skillMdContent, skillDir);
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

async function writeAssistantRule(assistantId: string, content: string): Promise<void> {
  if (content.trim()) {
    await ipcBridge.fs.writeAssistantRule.invoke({ assistant_id: assistantId, content });
  }
}

export { skillsForRoleFromTemplates };
