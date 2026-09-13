/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// KaneoImportModal — "Import from Kaneo" flow for the assistants page.
//
// Step 1: enter base URL + API key, connect (fetches role/skill templates).
// Step 2: review the bound role and run sync. Every Kaneo API key is bound to
// exactly one agent role, so the modal shows only that role. The API key lives
// only in component state and is never written into any assistant field or
// persisted storage.

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
import { syncKaneoAssistants } from '@/renderer/services/kaneo/kaneoSync';
import { useAssistantList } from '@/renderer/hooks/assistant';
import { configService } from '@/common/config/configService';

type KaneoImportModalProps = {
  visible: boolean;
  onCancel: () => void;
  /** Notified after a successful sync so the parent can refresh the list. */
  onSynced: () => void;
};

const KaneoImportModal: React.FC<KaneoImportModalProps> = ({ visible, onCancel, onSynced }) => {
  const { t } = useTranslation();
  const { assistants, loadAssistants } = useAssistantList();

  const [baseUrl, setBaseUrl] = useState('http://localhost:1337');
  const [apiKey, setApiKey] = useState('');
  const [templates, setTemplates] = useState<KaneoTemplates | null>(null);
  const [configPackage, setConfigPackage] = useState<{
    roles: Record<string, string>;
    skills: Record<string, string>;
  } | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ role: string; status: string; error?: string }> | null>(null);

  useEffect(() => {
    if (!visible) {
      // Clear secrets and transient state when the modal closes.
      setApiKey('');
      setTemplates(null);
      setConfigPackage(null);
      setSelectedRoles([]);
      setConnectError(null);
      setResults(null);
    }
  }, [visible]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const fetched = await fetchKaneoTemplates(baseUrl, apiKey);
      setTemplates(fetched);
      // Fetch the full config package so the modal can show the role's base
      // rules (AGENTS.md) for the bound role.
      let cfg: { roles: Record<string, string>; skills: Record<string, string> } | null = null;
      try {
        cfg = await fetchKaneoConfigPackage(baseUrl, apiKey);
      } catch {
        cfg = null;
      }
      setConfigPackage(cfg);
      // Every Kaneo API key is bound to exactly one agent role: the sync is
      // locked to that role (the key cannot act as other roles), and the modal
      // shows only that role. Persist it so the Guide dialog stays scoped to
      // the same role. Without a bound role there is nothing to sync — the
      // modal disables the action (no role picker is shown).
      if (fetched.agentRole) {
        setSelectedRoles(fetched.roles.map((r) => r.name).filter((name) => name === fetched.agentRole));
        void configService.set('kaneo.activeRole', fetched.agentRole).catch(() => {});
      } else {
        setSelectedRoles([]);
        void configService.remove('kaneo.activeRole').catch(() => {});
      }
    } catch (error) {
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
    if (!templates || selectedRoles.length === 0) return;
    setSyncing(true);
    setResults(null);
    try {
      const result = await syncKaneoAssistants(baseUrl, apiKey, selectedRoles, assistants);
      setResults(result.results);
      const failed = result.results.filter((r) => r.status === 'failed').length;
      if (failed === 0) {
        Message.success(t('settings.kaneoSyncSuccess'));
      } else {
        Message.warning(t('settings.kaneoSyncPartial'));
      }
      await loadAssistants();
      onSynced();
    } catch (error) {
      Message.error(`${t('settings.kaneoSyncFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncing(false);
    }
  }, [apiKey, assistants, baseUrl, loadAssistants, onSynced, selectedRoles, t, templates]);

  // Details for the API-key-bound role: description, applicable skills, and the
  // base config (AGENTS.md) fetched from the config package. kaneoRoleSelected
  // already announces the role; this fills in the rich preview below.
  const boundRole = templates?.agentRole ?? null;
  const boundRoleTemplate = templates?.roles.find((r) => r.name === boundRole);
  const boundRoleSkills = useMemo(
    () =>
      templates && boundRole
        ? templates.skills.filter((s) => skillAppliesToRole(s.forRoles, boundRole)).map((s) => s.name)
        : [],
    [templates, boundRole]
  );
  const boundRoleRules = boundRole && configPackage ? configPackage.roles[boundRole] : undefined;

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
            {templates.agentRole ? (
              <>
                <Alert
                  type='info'
                  content={t('settings.kaneoRoleSelected', { role: templates.agentRole })}
                  style={{ marginBottom: 0 }}
                />
                {boundRoleTemplate && (
                  <div className='flex flex-col gap-4px rounded-8px bg-fill-1 p-10px'>
                    <div className='flex items-baseline gap-6px'>
                      <span className='text-13px font-semibold text-t-primary'>{boundRoleTemplate.name}</span>
                      <span className='text-12px text-t-tertiary'>{boundRoleTemplate.description}</span>
                    </div>
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
                )}
              </>
            ) : (
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
