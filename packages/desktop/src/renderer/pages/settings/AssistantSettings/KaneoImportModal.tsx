/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// KaneoImportModal — "Import from Kaneo" flow for the assistants page.
//
// Step 1: enter base URL + API key, connect (fetches role/skill templates).
// Step 2: pick roles, run sync. The API key lives only in component state and
// is never written into any assistant field or persisted storage.

import { Alert, Button, Checkbox, Input, Message, Modal, Tag } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KANEO_AGENT_ROLES,
  KaneoConnectionError,
  fetchKaneoTemplates,
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
      // A role-scoped API key (metadata.agentRole) is only authorized for that
      // one role: default the selection to it and remember it so the Guide
      // dialog stays scoped to that role too.
      if (fetched.agentRole) {
        setSelectedRoles(fetched.roles.map((r) => r.name).filter((name) => name === fetched.agentRole));
        void configService.set('kaneo.activeRole', fetched.agentRole).catch(() => {});
      } else {
        setSelectedRoles(
          fetched.roles.map((r) => r.name).filter((name) => (KANEO_AGENT_ROLES as readonly string[]).includes(name))
        );
        // A non-scoped key can import any role; drop any stale role-bound
        // scope so the Guide reverts to its normal (unfiltered) behavior.
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

  const skillCount = templates?.skills.length ?? 0;

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
          <div className='flex flex-col gap-8px'>
            <div className='text-13px text-t-primary'>{t('settings.kaneoConnected')}</div>
            {templates.agentRole ? (
              <Alert
                type='info'
                content={t('settings.kaneoRoleLocked', { role: templates.agentRole })}
                style={{ marginBottom: 0 }}
              />
            ) : null}
            <Checkbox.Group
              value={selectedRoles}
              onChange={(values: string[]) => {
                // A role-scoped API key is only authorized for its bound role:
                // ignore attempts to change the selection to other roles.
                if (!templates?.agentRole) setSelectedRoles(values);
              }}
            >
              <div className='flex flex-col gap-6px'>
                {templates.roles.map((role) => (
                  <Checkbox key={role.name} value={role.name} disabled={syncing || Boolean(templates.agentRole)}>
                    <span className='text-13px'>{role.name}</span>
                    <span className='ml-6px text-12px text-t-tertiary'>{role.description}</span>
                  </Checkbox>
                ))}
              </div>
            </Checkbox.Group>
            <div>
              <Tag size='small' color='arcoblue' bordered={false}>
                {t('settings.kaneoSkillsOverview', { count: skillCount })}
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
