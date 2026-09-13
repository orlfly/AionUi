/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kaneo agent-config client.
//
// Talks to a Kaneo instance's agent configuration endpoints:
//   GET /api/agent/agents-config/templates — role/skill metadata (forRoles included)
//   GET /api/agent/agents-config/download  — zip with roles/<role>/AGENTS.md and skills/<skill>/SKILL.md
//
// The API key is used in-memory only for these calls and never appears in any
// returned data structure or persisted Assistant field.

export const KANEO_AGENT_ROLES = [
  'coding',
  'product-design',
  'architecture-design',
  'devops',
  'ui-design',
  'testing',
  'code-review',
] as const;

export type KaneoRole = (typeof KANEO_AGENT_ROLES)[number];

export type KaneoRoleTemplate = {
  name: string;
  description: string;
};

export type KaneoSkillTemplate = {
  name: string;
  description: string;
  forRoles: string[] | null;
};

export type KaneoTemplates = {
  roles: KaneoRoleTemplate[];
  skills: KaneoSkillTemplate[];
};

export type KaneoConfigPackage = {
  /** Role name → AGENTS.md content. */
  roles: Record<string, string>;
  /** Skill name → SKILL.md content. */
  skills: Record<string, string>;
};

export type KaneoConnectionErrorKind = 'unreachable' | 'unauthorized' | 'unsupported' | 'unknown';

export class KaneoConnectionError extends Error {
  readonly kind: KaneoConnectionErrorKind;

  constructor(kind: KaneoConnectionErrorKind, message: string) {
    super(message);
    this.name = 'KaneoConnectionError';
    this.kind = kind;
  }
}

/** Normalize a user-entered base URL: trim, drop trailing slash. */
export function normalizeKaneoBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

async function kaneoFetch(url: string, apiKey: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw new KaneoConnectionError(
      'unreachable',
      `Kaneo instance unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new KaneoConnectionError('unauthorized', `Kaneo instance rejected the API key (HTTP ${response.status})`);
  }
  return response;
}

/** Fetch the role/skill template listing from a Kaneo instance. */
export async function fetchKaneoTemplates(baseUrl: string, apiKey: string): Promise<KaneoTemplates> {
  const base = normalizeKaneoBaseUrl(baseUrl);
  const response = await kaneoFetch(`${base}/api/agent/agents-config/templates`, apiKey);
  if (!response.ok) {
    throw new KaneoConnectionError('unknown', `Kaneo templates endpoint failed: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new KaneoConnectionError('unsupported', 'Kaneo templates endpoint returned non-JSON content');
  }
  // Kaneo may wrap in {success, data} or return the object directly.
  const data = (body as { data?: unknown }).data ?? body;
  const roles = (data as { roles?: unknown }).roles;
  const skills = (data as { skills?: unknown }).skills;
  if (!Array.isArray(roles) || !Array.isArray(skills)) {
    throw new KaneoConnectionError('unsupported', 'Kaneo templates response has unexpected shape');
  }
  return {
    roles: roles as KaneoRoleTemplate[],
    skills: skills as KaneoSkillTemplate[],
  };
}

/** Minimal zip reader: locate stored/deflated entries via the central directory. */
type ZipEntry = {
  name: string;
  compressedData: Uint8Array;
  method: number;
};

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  // Find End Of Central Directory (EOCD) signature 0x06054b50 scanning backwards.
  let eocd = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new KaneoConnectionError('unsupported', 'Downloaded agent config is not a valid zip file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // Read local file header to find the data start (names may differ via data descriptor).
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      compressedData: bytes.subarray(dataStart, dataStart + compressedSize),
      method,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateEntry(entry: ZipEntry): Promise<string> {
  const stream = new Blob([entry.compressedData as BlobPart]).stream();
  if (entry.method === 0) {
    // Stored
    return new TextDecoder().decode(entry.compressedData);
  }
  if (entry.method !== 8) {
    throw new KaneoConnectionError('unsupported', `Unsupported zip compression method ${entry.method}`);
  }
  // DeflateRaw (method 8). DecompressionStream 'deflate-raw' is available in
  // Chromium 103+; AionUi's renderer is Chromium-based (Electron 37).
  const ds = new DecompressionStream('deflate-raw');
  const readable = stream.pipeThrough(ds);
  const buffer = await new Response(readable).arrayBuffer();
  return new TextDecoder().decode(buffer);
}

/** Download and unpack the Kaneo agent config zip into role/skill text maps. */
export async function fetchKaneoConfigPackage(baseUrl: string, apiKey: string): Promise<KaneoConfigPackage> {
  const base = normalizeKaneoBaseUrl(baseUrl);
  const response = await kaneoFetch(`${base}/api/agent/agents-config/download`, apiKey);
  if (!response.ok) {
    throw new KaneoConnectionError('unknown', `Kaneo config download failed: HTTP ${response.status}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  const entries = readZipEntries(buffer);

  const result: KaneoConfigPackage = { roles: {}, skills: {} };
  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/g, '/');
    const agentsMatch = normalized.match(/^roles\/([^/]+)\/AGENTS\.md$/);
    if (agentsMatch) {
      result.roles[agentsMatch[1]] = await inflateEntry(entry);
      continue;
    }
    const skillMatch = normalized.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (skillMatch) {
      result.skills[skillMatch[1]] = await inflateEntry(entry);
    }
  }
  return result;
}

/**
 * Parse the `for_roles` frontmatter array from a Kaneo SKILL.md.
 * Mirrors Kaneo's own parser semantics: null when frontmatter or key is
 * absent, null for an empty list (both mean "universal").
 */
export function parseSkillForRoles(content: string): string[] | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) return null;
  const lineMatch = (frontmatterMatch[1] ?? '').match(/^for_roles:\s*\[([^\]]*)\]\s*$/m);
  if (!lineMatch) return null;
  const roles = (lineMatch[1] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  return roles.length > 0 ? roles : null;
}

/** Whether a skill with this `forRoles` applies to `role`. Null means universal. */
export function skillAppliesToRole(forRoles: string[] | null, role: string): boolean {
  if (forRoles === null) return true;
  return forRoles.map((r) => r.trim().toLowerCase()).includes(role.toLowerCase());
}

/** Names of the skills a given role should get enabled, from the templates listing. */
export function skillsForRoleFromTemplates(templates: KaneoTemplates, role: string): string[] {
  return templates.skills.filter((skill) => skillAppliesToRole(skill.forRoles, role)).map((skill) => skill.name);
}
