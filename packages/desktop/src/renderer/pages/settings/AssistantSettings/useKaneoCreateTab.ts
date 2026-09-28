/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// useKaneoCreateTab — connection state machine for the Kaneo tab inside the
// assistant creation UI (openspec/changes/kaneo-assistant-role-tab).
//
// Flow: base URL + API key → connect (bootstrap probe fallback-first, then
// templates + config package) → role options (narrowed to the key-bound role
// for role-scoped keys) + project options (GET /api/team, GET
// /api/project?teamId=, archived filtered on the Kaneo side). The tab
// requires an explicit role AND project selection before Create is enabled.
//
// Secret hygiene mirrors the Kaneo import modal: the plaintext key lives only
// in component state, is handed to the AionCore backend exactly once per sync
// (PUT /api/kaneo-credentials/{contextId}, AES-256-GCM at rest), and is
// dropped from state after the transfer or when the tab closes/unmounts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchKaneoConfigPackage,
  fetchKaneoProjectRepo,
  fetchKaneoProjects,
  fetchKaneoTeams,
  fetchKaneoTemplates,
  KaneoConnectionError,
  skillAppliesToRole,
  type KaneoConfigPackage,
  type KaneoProjectSummary,
  type KaneoTemplates,
} from '@/renderer/services/kaneo/kaneoClient';
import {
  fetchKaneoBootstrap,
  isManifestVersionNewer,
  type KaneoEnvironmentManifest,
} from '@/renderer/services/kaneo/kaneoManifest';
import { getKaneoContexts, updateKaneoContext } from '@/renderer/services/kaneo/kaneoContexts';
import {
  importKaneoSkill,
  kaneoProjectAssistantName,
  syncKaneoAssistantForBinding,
  type KaneoExplicitBindingResult,
} from '@/renderer/services/kaneo/kaneoSync';
import { ipcBridge } from '@/common';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { configService } from '@/common/config/configService';

export type KaneoConnectPhase = 'idle' | 'connecting' | 'connected' | 'error';

export type KaneoRoleOption = {
  name: string;
  description: string;
  /** False when the key's bound role excludes this role (dim + unselectable). */
  selectable: boolean;
  /** True when this (role, project) pair already has an assistant instance. */
  hasInstance: boolean;
  existingAssistantName: string | null;
};

export type KaneoCreateTabState = {
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  phase: KaneoConnectPhase;
  connectError: string | null;
  /** Non-blocking notice: the instance reports a newer manifest version. */
  manifestNewerVersion: boolean;
  roles: KaneoRoleOption[];
  projects: KaneoProjectSummary[];
  teamsLoading: boolean;
  projectsError: string | null;
  selectedRole: string | null;
  selectedProjectId: string | null;
  selectRole: (role: string | null) => void;
  selectProject: (projectId: string | null) => void;
  /** Available agent engines (managed agents); loaded once for the tab. */
  engines: Array<{ id: string; name: string }>;
  /** Chosen engine id; defaults to the first available engine. */
  selectedEngineId: string | null;
  selectEngine: (engineId: string) => void;
  connect: () => void;
  disconnect: () => void;
  canCreate: boolean;
  creating: boolean;
  /** Last successful create result; null until one succeeds. */
  lastResult: KaneoExplicitBindingResult | null;
  create: () => void;
  /** Clear the plaintext key (tab close / unmount). */
  releaseSecrets: () => void;
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const kaneoAssistantList = async (): Promise<Array<{ name: string }>> => {
  try {
    const skills = await ipcBridge.fs.listAvailableSkills.invoke();
    return skills as Array<{ name: string }>;
  } catch {
    return [];
  }
};

// D7 parity: a 401 (expired key) or 403 (revoked/unbound key) marks every
// stored context of this instance degraded; the next successful connect
// clears it via the upsert path.
const degradeContextsOnError = async (baseUrl: string, error: unknown): Promise<void> => {
  if (!(error instanceof KaneoConnectionError)) return;
  if (error.kind !== 'unauthorized') return;
  const contexts = getKaneoContexts().filter((c) => c.baseUrl === baseUrl.trim());
  for (const c of contexts) {
    await updateKaneoContext(c.id, {
      degraded: true,
      degradedReason: describeError(error).includes('HTTP 401') ? 'key-expired-or-revoked' : 'binding-revoked',
    });
  }
};

export function useKaneoCreateTab(options: {
  existing: Assistant[];
  /** Called once after a successful create, with the new assistant id. */
  onCreated?: (assistantId: string) => void;
}) {
  const { existing, onCreated } = options;

  const [baseUrl, setBaseUrl] = useState(() => {
    try {
      return configService.get('kaneo.lastBaseUrl') || 'http://localhost:1337';
    } catch {
      return 'http://localhost:1337';
    }
  });
  const [apiKey, setApiKey] = useState('');
  const [phase, setPhase] = useState<KaneoConnectPhase>('idle');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<KaneoTemplates | null>(null);
  const [configPackage, setConfigPackage] = useState<KaneoConfigPackage | null>(null);
  const [manifest, setManifest] = useState<KaneoEnvironmentManifest | null>(null);
  const [manifestNewerVersion, setManifestNewerVersion] = useState(false);
  const [projects, setProjects] = useState<KaneoProjectSummary[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [engines, setEngines] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<KaneoExplicitBindingResult | null>(null);
  const secretRef = useRef<string>('');

  // The controlled password field mirrors into the ref so unmount-time
  // release can clear both without depending on effect order.
  const setApiKeyBuffered = useCallback((value: string) => {
    secretRef.current = value;
    setApiKey(value);
  }, []);

  const releaseSecrets = useCallback(() => {
    secretRef.current = '';
    setApiKey('');
  }, []);

  useEffect(() => {
    return () => {
      secretRef.current = '';
    };
  }, []);

  // Load the available agent engines once: the create flow requires an
  // explicit engine choice (defaults to the first managed agent).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const managedAgents = await ipcBridge.acpConversation.getManagedAgents.invoke();
        if (cancelled) return;
        const list = (managedAgents as Array<{ id: string; name: string }>)
          .filter((a) => Boolean(a.id))
          .map((a) => ({ id: a.id, name: a.name }));
        setEngines(list);
        setSelectedEngineId((previous) => previous ?? list[0]?.id ?? null);
      } catch {
        if (!cancelled) setEngines([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = phase === 'connected';

  // Project list after connect: one key may belong to multiple teams, so
  // each team contributes its (archived-filtered) projects. Failures degrade
  // to an empty picker with a warning; selector falls back to manual slug.
  // The key is read from secretRef, not the apiKey state, so that the
  // post-create secret release (setApiKey('')) does not recreate this
  // callback and re-trigger the connected-effect with an empty key.
  const loadTeamsAndProjects = useCallback(async () => {
    // secretRef only: reading the apiKey state here would recreate this
    // callback when the post-create release clears the key, re-triggering
    // the connected-effect below with an empty key (a spurious 401 after
    // a successful create).
    const keyNow = secretRef.current;
    setTeamsLoading(true);
    setProjectsError(null);
    try {
      const teams = await fetchKaneoTeams(baseUrl, keyNow);
      const projectLists = await Promise.all(
        teams.map((team) => fetchKaneoProjects(baseUrl, keyNow, team.id).catch((): KaneoProjectSummary[] => []))
      );
      const merged = projectLists.flat();
      const seen = new Set<string>();
      const unique = merged.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
      setProjects(unique);
      // Spec: when the key is project-bound (manifest flow) preselect and
      // lock that project; otherwise default to the first project.
      setSelectedProjectId((previous) => {
        if (manifest?.identity.project) return manifest.identity.project.id;
        if (previous && unique.some((p) => p.id === previous)) return previous;
        return unique[0]?.id ?? null;
      });
    } catch (error) {
      setProjects([]);
      setProjectsError(describeError(error));
    } finally {
      setTeamsLoading(false);
    }
  }, [baseUrl, manifest]);

  useEffect(() => {
    if (!connected) return;
    setProjects([]);
    setProjectsError(null);
    void loadTeamsAndProjects();
  }, [connected, loadTeamsAndProjects]);

  const resetConnection = useCallback(() => {
    setPhase('idle');
    setConnectError(null);
    setTemplates(null);
    setConfigPackage(null);
    setManifest(null);
    setManifestNewerVersion(false);
    setProjects([]);
    setProjectsError(null);
    setSelectedRole(null);
    setSelectedProjectId(null);
    setLastResult(null);
  }, []);

  const connect = useCallback(async () => {
    if (!baseUrl.trim() || !apiKey) return;
    setPhase('connecting');
    setConnectError(null);
    try {
      // Key validity check against an authenticated endpoint FIRST. The
      // agents-config endpoints are unauthenticated on some Kaneo builds
      // (route mounted before the auth middleware), so templates succeeding
      // proves nothing; /api/team enforces the key and surfaces 401 here
      // instead of a confusing failure at the project-loading step.
      await fetchKaneoTeams(baseUrl, apiKey);
      // Bootstrap probe (fallback-first). 404/405 → legacy roles flow.
      const bootstrap = await fetchKaneoBootstrap(baseUrl, apiKey);
      const nextManifest = bootstrap.kind === 'manifest' ? bootstrap.manifest : null;
      const tpl = await fetchKaneoTemplates(baseUrl, apiKey);
      let cfg: KaneoConfigPackage | null = null;
      try {
        cfg = await fetchKaneoConfigPackage(baseUrl, apiKey);
      } catch {
        cfg = null;
      }
      setManifest(nextManifest);
      setManifestNewerVersion(nextManifest ? isManifestVersionNewer(nextManifest.manifestVersion) : false);
      if (nextManifest) {
        setSelectedRole(nextManifest.identity.agentRole);
        void configService.remove('kaneo.activeRole').catch(() => {});
      } else {
        // Legacy flow: every Kaneo API key is bound to exactly one role; the
        // tab locks to it (Hack/legacy parity) and makes project explicit.
        if (tpl.agentRole) {
          setSelectedRole(tpl.agentRole);
          void configService.set('kaneo.activeRole', tpl.agentRole).catch(() => {});
        } else {
          setSelectedRole(null);
          void configService.remove('kaneo.activeRole').catch(() => {});
        }
      }
      setTemplates(tpl);
      setConfigPackage(cfg);
      setPhase('connected');
      try {
        void configService.set('kaneo.lastBaseUrl', baseUrl.trim());
      } catch {
        // Non-fatal: base URL prefill is a convenience.
      }
      await loadTeamsAndProjects();
    } catch (error) {
      await degradeContextsOnError(baseUrl, error).catch(() => {});
      setPhase('error');
      setConnectError(describeError(error));
    }
  }, [apiKey, baseUrl, loadTeamsAndProjects]);

  const disconnect = useCallback(() => {
    releaseSecrets();
    resetConnection();
  }, [releaseSecrets, resetConnection]);

  // Role options narrowed by the key's bound role. When the key is
  // role-scoped (templates.agentRole / manifest identity) all other roles
  // render as unavailable; an unbound key offers the full grid.
  const boundRole: string | null = manifest?.identity.agentRole ?? templates?.agentRole ?? null;
  const roles: KaneoRoleOption[] = useMemo(() => {
    if (!templates) return [];
    const project = projects.find((p) => p.id === selectedProjectId);
    return templates.roles.map((role) => {
      const selectable = !boundRole || boundRole === role.name;
      const expectedName = project ? kaneoProjectAssistantName(project.name, role.name) : null;
      const existingForRole = expectedName ? existing.find((a) => a.name === expectedName) : undefined;
      return {
        name: role.name,
        description: role.description,
        selectable,
        hasInstance: Boolean(existingForRole),
        existingAssistantName: existingForRole?.name ?? null,
      };
    });
  }, [templates, boundRole, selectedProjectId, projects, existing]);

  const canCreate = Boolean(
    connected &&
    selectedRole &&
    selectedProjectId &&
    (apiKey || secretRef.current) &&
    configPackage?.roles[selectedRole]
  );

  const create = useCallback(async () => {
    if (!canCreate || !templates || !configPackage) return;
    const role = selectedRole!;
    const project = projects.find((p) => p.id === selectedProjectId);
    const keyNow = apiKey || secretRef.current;
    if (!project || !keyNow) return;
    setCreating(true);
    try {
      // Import applicable skills (shared pool, idempotent overwrite).
      const enabledSkills: string[] = [];
      const installedSkills = await kaneoAssistantList();
      const installedNames = new Set(installedSkills.map((s) => s.name));
      for (const skill of templates.skills) {
        if (!skillAppliesToRole(skill.forRoles, role)) continue;
        const content = configPackage.skills[skill.name];
        if (content === undefined) {
          // Already installed in a previous session: keep using it.
          const installedName = `kaneo-${skill.name}`;
          if (installedNames.has(installedName)) enabledSkills.push(installedName);
          continue;
        }
        const importResult = await importKaneoSkill(skill.name, content);
        if (importResult.ok === true) enabledSkills.push(importResult.name);
        else console.warn(`[kaneo] skill import failed for ${skill.name}: ${importResult.error}`);
      }

      const description =
        templates.roles.find((r) => r.name === role)?.description ?? `Kaneo ${role} agent for ${project.name}`;

      const result = await syncKaneoAssistantForBinding({
        baseUrl: baseUrl.trim(),
        project: { id: project.id, name: project.name, slug: project.slug },
        role,
        agentsMd: configPackage.roles[role],
        description,
        enabledSkills,
        existing,
        agentId: selectedEngineId ?? undefined,
        // Repo facts for the assistant rules + structured context:
        // manifest flow passes the already-fetched bootstrap manifest (its
        // bound project is the selection there); legacy flow tries the
        // GitLab integration for the chosen project (null-degrading).
        manifest: manifest?.identity.project?.id === project.id ? manifest : null,
        repoIntegration:
          manifest?.identity.project?.id === project.id
            ? undefined
            : await fetchKaneoProjectRepo(baseUrl.trim(), keyNow, project.id),
      });

      // One-shot plaintext hand-off to the backend (rotation = same PUT).
      try {
        await ipcBridge.kaneoCredentials.upsert.invoke({
          contextId: result.contextId,
          base_url: baseUrl.trim(),
          agent_role: boundRole ?? role,
          project_id: project.id,
          key_expires_at: null,
          api_key: keyNow,
        });
      } catch (error) {
        // Non-fatal: sync succeeded; Guide + MCP env-ref re-attempt later.
        console.warn('[KaneoCreateTab] credential store failed:', describeError(error));
      }

      setLastResult(result);
      // Rotation complete: drop the plaintext immediately after the PUT.
      releaseSecrets();
      onCreated?.(result.assistantId);
    } catch (error) {
      setPhase('error');
      setConnectError(describeError(error));
    } finally {
      setCreating(false);
    }
  }, [
    apiKey,
    baseUrl,
    boundRole,
    canCreate,
    configPackage,
    existing,
    onCreated,
    projects,
    releaseSecrets,
    selectedEngineId,
    selectedProjectId,
    selectedRole,
    templates,
  ]);

  return {
    baseUrl,
    setBaseUrl,
    apiKey,
    setApiKey: setApiKeyBuffered,
    phase,
    connectError,
    // Rolled-up from connect: manifest flow or legacy fallback.
    manifest: manifest,
    manifestNewerVersion,
    roles,
    projects,
    teamsLoading,
    projectsError,
    selectedRole,
    selectedProjectId,
    selectRole: setSelectedRole,
    selectProject: setSelectedProjectId,
    engines,
    selectedEngineId,
    selectEngine: setSelectedEngineId,
    connect,
    disconnect,
    canCreate,
    creating,
    lastResult,
    create,
    releaseSecrets,
  };
}

export type KaneoCreateTabController = ReturnType<typeof useKaneoCreateTab>;
