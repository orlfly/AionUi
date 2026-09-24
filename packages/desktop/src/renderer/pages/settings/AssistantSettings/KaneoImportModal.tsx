/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// KaneoImportModal — "Import from Kaneo" flow for the assistants page.
//
// Connect probes the project bootstrap endpoint first (fallback-first):
//  - Project-bound manifest → project-scoped import: the preview shows the
//    bound role, project, repositories and applicable skills; sync targets the
//    single bound role via the manifest, upserts the Kaneo context and makes
//    it active, and surfaces drift (envHash change on reconnect) plus
//    newer-manifest-version notices.
//  - Unbound manifest or missing endpoint (404/405) → legacy templates flow
//    with legacy naming, exactly as before this change.
//
// The API key lives only in component state and is never written into any
// assistant field or persisted storage. Plaintext is dropped when the modal
// closes; main-process safeStorage persistence arrives with the credential
// bridge (group 5).

import { Alert, Button, Input, Message, Modal, Tag } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KaneoConnectionError,
  fetchKaneoConfigPackage,
  fetchKaneoTemplates,
  skillAppliesToRole,
  type KaneoTemplates,
} from '@/renderer/services/kaneo/kaneoClient';
import {
  fetchKaneoBootstrap,
  isManifestVersionNewer,
  type KaneoEnvironmentManifest,
} from '@/renderer/services/kaneo/kaneoManifest';
import { getKaneoContexts, updateKaneoContext } from '@/renderer/services/kaneo/kaneoContexts';
import { syncKaneoAssistants, syncKaneoAssistantsFromManifest } from '@/renderer/services/kaneo/kaneoSync';
import { useAssistantList } from '@/renderer/hooks/assistant';
import { configService } from '@/common/config/configService';

type KaneoImportModalProps = {
  visible: boolean;
  onCancel: () => void;
  /** Notified after a successful sync so the parent can refresh the list. */
  onSynced: () => void;
};

const EXPIRY_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const KaneoImportModal: React.FC<KaneoImportModalProps> = ({ visible, onCancel, onSynced }) => {
  const { t } = useTranslation();
  const { assistants, loadAssistants } = useAssistantList();

  const [baseUrl, setBaseUrl] = useState('http://localhost:1337');
  const [apiKey, setApiKey] = useState('');
  const [templates, setTemplates] = useState<KaneoTemplates | null>(null);
  const [manifest, setManifest] = useState<KaneoEnvironmentManifest | null>(null);
  const [manifestNewerVersion, setManifestNewerVersion] = useState(false);
  const [configPackage, setConfigPackage] = useState<{
    roles: Record<string, string>;
    skills: Record<string, string>;
  } | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ role: string; status: string; error?: string }> | null>(null);
  const [syncWarnings, setSyncWarnings] = useState<string[]>([]);
  const [syncDrift, setSyncDrift] = useState(false);

  useEffect(() => {
    if (!visible) {
      // Clear secrets and transient state when the modal closes.
      setApiKey('');
      setTemplates(null);
      setManifest(null);
      setManifestNewerVersion(false);
      setConfigPackage(null);
      setSelectedRoles([]);
      setConnectError(null);
      setResults(null);
      setSyncWarnings([]);
      setSyncDrift(false);
    }
  }, [visible]);

  // D7: a 401 (expired key) or 403 (key no longer bound / revoked) on connect
  // marks every stored context for this instance degraded; the next successful
  // sync/connect clears it (upsert refreshes `degraded` from the manifest).
  const degradeContextsOnError = useCallback(
    async (error: unknown) => {
      if (!(error instanceof KaneoConnectionError)) return;
      if (error.kind !== 'unauthorized') return;
      const contexts = getKaneoContexts().filter((c) => c.baseUrl === baseUrl.trim());
      for (const c of contexts) {
        await updateKaneoContext(c.id, {
          degraded: true,
          degradedReason: error.message.includes('HTTP 401') ? 'key-expired-or-revoked' : 'binding-revoked',
        });
      }
    },
    [baseUrl]
  );

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      // Bootstrap probe (fallback-first). 404/405 → `unavailable` → legacy flow.
      const bootstrap = await fetchKaneoBootstrap(baseUrl, apiKey);
      if (bootstrap.kind === 'manifest') {
        setManifest(bootstrap.manifest);
        setManifestNewerVersion(isManifestVersionNewer(bootstrap.manifest.manifestVersion));
        // Role/skill display data comes from templates; the bootstrap manifest
        // locks the sync to the bound role.
        const tpl = await fetchKaneoTemplates(baseUrl, apiKey);
        setTemplates(tpl);
        setSelectedRoles([bootstrap.manifest.identity.agentRole]);
        void configService.remove('kaneo.activeRole').catch(() => {});
      } else {
        setManifest(null);
        setManifestNewerVersion(false);
        const fetched = await fetchKaneoTemplates(baseUrl, apiKey);
        setTemplates(fetched);
        // Legacy flow: every Kaneo API key is bound to exactly one agent role.
        // Persist it so the Guide dialog stays scoped to the same role. Without
        // a bound role there is nothing to sync — the modal disables the action.
        if (fetched.agentRole) {
          setSelectedRoles(fetched.roles.map((r) => r.name).filter((name) => name === fetched.agentRole));
          void configService.set('kaneo.activeRole', fetched.agentRole).catch(() => {});
        } else {
          setSelectedRoles([]);
          void configService.remove('kaneo.activeRole').catch(() => {});
        }
      }
      // Fetch the full config package so the modal can show the role's base
      // rules (AGENTS.md) for the bound role.
      let cfg: { roles: Record<string, string>; skills: Record<string, string> } | null = null;
      try {
        cfg = await fetchKaneoConfigPackage(baseUrl, apiKey);
      } catch {
        cfg = null;
      }
      setConfigPackage(cfg);
    } catch (error) {
      await degradeContextsOnError(error).catch(() => {});
      const messageText =
        error instanceof KaneoConnectionError
          ? `${t('settings.kaneoConnectionFailed')}: ${error.message}`
          : `${t('settings.kaneoConnectionFailed')}: ${String(error)}`;
      setConnectError(messageText);
    } finally {
      setConnecting(false);
    }
  }, [apiKey, baseUrl, t]);

  const handleSync = useCallback(async () => {
    if (!templates) return;
    setSyncing(true);
    setResults(null);
    setSyncWarnings([]);
    setSyncDrift(false);
    try {
      if (manifest) {
        // Project-scoped sync: the key targets exactly its bound role.
        const result = await syncKaneoAssistantsFromManifest({
          baseUrl,
          apiKey,
          manifest,
          config: configPackage ?? { roles: {}, skills: {} },
          templates,
          existing: assistants,
        });
        setResults(result.results);
        setSyncWarnings(result.skillDriftWarnings);
        setSyncDrift(result.envDrift);
        const failed = result.results.filter((r) => r.status === 'failed').length;
        if (failed === 0) {
          Message.success(t('settings.kaneoSyncSuccess'));
        } else {
          Message.warning(t('settings.kaneoSyncPartial'));
        }
      } else {
        if (selectedRoles.length === 0) return;
        const result = await syncKaneoAssistants(baseUrl, apiKey, selectedRoles, assistants);
        setResults(result.results);
        const failed = result.results.filter((r) => r.status === 'failed').length;
        if (failed === 0) {
          Message.success(t('settings.kaneoSyncSuccess'));
        } else {
          Message.warning(t('settings.kaneoSyncPartial'));
        }
      }
      await loadAssistants();
      onSynced();
    } catch (error) {
      Message.error(`${t('settings.kaneoSyncFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncing(false);
    }
  }, [apiKey, assistants, baseUrl, configPackage, loadAssistants, manifest, onSynced, selectedRoles, t, templates]);

  // Details for the API-key-bound role: description, applicable skills, and the
  // base config (AGENTS.md) fetched from the config package. kaneoRoleSelected
  // already announces the role; this fills in the rich preview below.
  const boundRole = manifest?.identity.agentRole ?? templates?.agentRole ?? null;
  const boundRoleTemplate = templates?.roles.find((r) => r.name === boundRole);
  const boundRoleSkills = useMemo(
    () =>
      templates && boundRole
        ? templates.skills.filter((s) => skillAppliesToRole(s.forRoles, boundRole)).map((s) => s.name)
        : [],
    [templates, boundRole]
  );
  const boundRoleRules = boundRole && configPackage ? configPackage.roles[boundRole] : undefined;

  const project = manifest?.identity.project ?? null;
  const primaryRepo = useMemo(
    () =>
      manifest ? (manifest.repositories.find((r) => r.role === 'primary') ?? manifest.repositories[0]) : undefined,
    [manifest]
  );

  // Reconnect drift/expiry signals derived from stored contexts.
  const storedContext = useMemo(() => {
    if (!manifest) return undefined;
    const contexts = getKaneoContexts();
    return contexts.find(
      (c) =>
        c.baseUrl === baseUrl &&
        (c.projectId ?? null) === (manifest.identity.project?.id ?? null) &&
        c.agentRole === manifest.identity.agentRole
    );
  }, [baseUrl, manifest]);

  const driftNotice =
    storedContext?.manifestSummary && manifest && storedContext.manifestSummary.envHash !== manifest.envHash;

  const expiryNotice = useMemo(() => {
    if (!storedContext?.keyExpiresAt) return false;
    const expires = new Date(storedContext.keyExpiresAt).getTime();
    if (Number.isNaN(expires)) return false;
    return expires - Date.now() < EXPIRY_WARN_WINDOW_MS;
  }, [storedContext]);

  return (
    <Modal
      title={t('settings.kaneoImport')}
      visible={visible}
      onCancel={onCancel}
      footer={null}
      unmountOnExit
      style={{ width: 520 }}
    >
      <div className='flex flex-col gap-12px'>
        <p className='m-0 text-12px text-t-tertiary'>{t('settings.kaneoImportDescription')}</p>

        <Input
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder={t('settings.kaneoBaseUrlPlaceholder')}
          disabled={connecting || syncing}
        />
        <Input.Password
          value={apiKey}
          onChange={setApiKey}
          placeholder={t('settings.kaneoApiKeyPlaceholder')}
          disabled={connecting || syncing}
        />

        <Button
          type='primary'
          loading={connecting}
          onClick={() => void handleConnect()}
          disabled={syncing || !baseUrl.trim() || !apiKey.trim()}
        >
          {connecting ? t('settings.kaneoSyncing') : t('settings.kaneoConnect')}
        </Button>

        {connectError && <Alert type='error' content={connectError} />}

        {templates && (
          <div className='flex flex-col gap-10px'>
            <div className='text-13px text-t-primary'>{t('settings.kaneoConnected')}</div>
            {manifestNewerVersion && (
              <Alert type='warning' content={t('settings.kaneoManifestNewer')} style={{ marginBottom: 0 }} />
            )}
            {driftNotice && (
              <Alert
                type='warning'
                content={t('settings.kaneoEnvDrift', {
                  repo: primaryRepo ? `${primaryRepo.owner}/${primaryRepo.name}` : '',
                })}
                style={{ marginBottom: 0 }}
              />
            )}
            {expiryNotice && (
              <Alert type='warning' content={t('settings.kaneoKeyExpiring')} style={{ marginBottom: 0 }} />
            )}
            {boundRole && (
              <>
                <Alert
                  type='info'
                  content={
                    project
                      ? t('settings.kaneoProjectSelected', { role: boundRole, project: project.name })
                      : t('settings.kaneoRoleSelected', { role: boundRole })
                  }
                  style={{ marginBottom: 0 }}
                />
                <div className='flex flex-col gap-4px rounded-8px bg-fill-1 p-10px'>
                  <div className='flex items-baseline gap-6px'>
                    <span className='text-13px font-semibold text-t-primary'>
                      {boundRoleTemplate?.name ?? boundRole}
                    </span>
                    {boundRoleTemplate?.description && (
                      <span className='text-12px text-t-tertiary'>{boundRoleTemplate.description}</span>
                    )}
                  </div>
                  {project && (
                    <div className='flex flex-wrap items-center gap-6px text-12px text-t-secondary'>
                      <Tag size='small' bordered={false} color='arcoblue'>
                        {t('settings.kaneoProjectTag', { project: project.name })}
                      </Tag>
                      <span className='text-t-tertiary'>{project.slug}</span>
                    </div>
                  )}
                  {primaryRepo && (
                    <div className='text-12px text-t-secondary'>
                      {t('settings.kaneoRepoLine', {
                        repo: `${primaryRepo.owner}/${primaryRepo.name}`,
                        branch: primaryRepo.defaultBranch ?? t('settings.kaneoRepoBranchUnknown'),
                      })}
                    </div>
                  )}
                  {boundRoleSkills.length > 0 && (
                    <div className='flex flex-wrap gap-4px'>
                      {boundRoleSkills.map((s) => (
                        <Tag size='small' key={s} bordered={false} color='arcoblue'>
                          {s}
                        </Tag>
                      ))}
                    </div>
                  )}
                  {boundRoleRules && (
                    <pre className='m-0 max-h-150px overflow-auto whitespace-pre-wrap text-12px text-t-secondary'>
                      {boundRoleRules}
                    </pre>
                  )}
                </div>
              </>
            )}
            {!boundRole && (
              <Alert type='warning' content={t('settings.kaneoRoleMissing')} style={{ marginBottom: 0 }} />
            )}
            <div>
              <Tag size='small' color='arcoblue' bordered={false}>
                {t('settings.kaneoSkillsOverview', { count: boundRoleSkills.length })}
              </Tag>
            </div>

            {results && (
              <div className='flex flex-col gap-4px rounded-8px bg-fill-1 p-8px'>
                {results.map((r) => (
                  <div key={r.role} className='flex items-center gap-6px text-12px'>
                    <Tag size='small' bordered={false} color={r.status === 'failed' ? 'red' : 'green'}>
                      {r.status}
                    </Tag>
                    <span>{r.role}</span>
                    {r.error && <span className='text-t-tertiary'>{r.error}</span>}
                  </div>
                ))}
                {syncDrift && (
                  <div className='flex items-center gap-6px text-12px'>
                    <Tag size='small' bordered={false} color='orange'>
                      {t('settings.kaneoEnvDriftTag')}
                    </Tag>
                    <span className='text-t-secondary'>
                      {t('settings.kaneoEnvDrift', {
                        repo: primaryRepo ? `${primaryRepo.owner}/${primaryRepo.name}` : '',
                      })}
                    </span>
                  </div>
                )}
                {syncWarnings.map((skill) => (
                  <div key={skill} className='flex items-center gap-6px text-12px'>
                    <Tag size='small' bordered={false} color='orange'>
                      {t('settings.kaneoSkillDriftTag')}
                    </Tag>
                    <span className='text-t-secondary'>{t('settings.kaneoSkillDrift', { skill })}</span>
                  </div>
                ))}
              </div>
            )}

            <Button
              type='primary'
              loading={syncing}
              onClick={() => void handleSync()}
              disabled={selectedRoles.length === 0}
            >
              {syncing ? t('settings.kaneoSyncing') : t('settings.kaneoSync')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default KaneoImportModal;
