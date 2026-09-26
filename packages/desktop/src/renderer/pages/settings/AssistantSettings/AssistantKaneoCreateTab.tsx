/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { Alert, Button, Input, Select } from '@arco-design/web-react';
import { Info } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { KaneoCreateTabController } from './useKaneoCreateTab';
import KaneoInstanceCard, { type KaneoInstanceEntry } from './home/KaneoInstanceCard';

type AssistantKaneoCreateTabProps = {
  kaneo: KaneoCreateTabController;
  /** Called after the assistant was created so the host page can refresh. */
  onCreated?: (assistantId: string) => void;
  /** Existing (role, project) assistant instances, listed under their role cards. */
  instances?: KaneoInstanceEntry[];
  /** Instance-level actions (home page hosting). */
  onOpenInstance?: (assistantId: string) => void;
  onToggleInstance?: (assistantId: string, checked: boolean) => void;
  onStartInstanceChat?: (assistantId: string) => void;
  localeKey?: string;
};

/**
 * Kaneo tab (openspec/changes/kaneo-assistant-role-tab), hosted as a tab on
 * the assistants home page. Shows the existing (role, project) assistant
 * instances grouped under their agent role cards, the connect form, and the
 * explicit role+project creation flow.
 *
 * Requires an explicit (role, project) selection before Create is enabled.
 * Role-scoped keys lock the role grid to their bound role; other roles render
 * as unavailable. The plaintext API key never leaves component state and is
 * handed to the backend exactly once (one-shot PUT) before being dropped.
 */
const AssistantKaneoCreateTab: React.FC<AssistantKaneoCreateTabProps> = ({
  kaneo,
  onCreated,
  instances = [],
  onOpenInstance,
  onToggleInstance,
  onStartInstanceChat,
  localeKey = 'en',
}) => {
  const { t } = useTranslation();

  const lastResult = kaneo.lastResult;
  React.useEffect(() => {
    if (!lastResult) return;
    void onCreated?.(lastResult.assistantId);
  }, [lastResult, onCreated]);

  const projectOptions = useMemo(
    () =>
      kaneo.projects.map((p) => ({
        value: p.id,
        label: p.name,
        slug: p.slug,
      })),
    [kaneo.projects]
  );

  const hasRoles = kaneo.roles.length > 0;

  // Existing instances grouped under their agent role card. Instances whose
  // role no longer appears in the current listing (disconnected, legacy) still
  // surface in a trailing "other instances" group so nothing disappears.
  const instancesByRole = useMemo(() => {
    const grouped = new Map<string, KaneoInstanceEntry[]>();
    for (const instance of instances) {
      const key =
        instance.context.agentRole || t('settings.kaneoCreateTab.unboundRole', { defaultValue: 'Unassigned role' });
      const bucket = grouped.get(key) ?? [];
      bucket.push(instance);
      grouped.set(key, bucket);
    }
    return grouped;
  }, [instances, t]);

  const renderInstancesForRole = (role: string) => {
    const roleInstances = instancesByRole.get(role) ?? [];
    if (roleInstances.length === 0) return null;
    return (
      <div className='mt-6px flex flex-col gap-6px' data-testid={`kaneo-role-instances-${role}`}>
        {roleInstances.map((instance) => (
          <KaneoInstanceCard
            key={instance.assistant.id}
            instance={instance}
            localeKey={localeKey}
            onOpenDetail={(assistant) => onOpenInstance?.(assistant.id)}
            onToggleEnabled={(assistant, checked) => onToggleInstance?.(assistant.id, checked)}
            onStartChat={(assistant) => onStartInstanceChat?.(assistant.id)}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      data-testid='assistant-card-kaneo'
      className='rounded-12px border border-border-2 bg-2 px-[12px] py-[16px] md:rounded-16px md:px-[24px] md:py-[20px]'
    >
      <div className='mb-12px flex items-center gap-8px'>
        <div className='text-14px font-500 text-t-primary'>{t('settings.kaneoCreateTab.title')}</div>
      </div>

      <p className='m-0 mb-12px text-12px text-t-tertiary'>{t('settings.kaneoCreateTab.lead')}</p>

      {kaneo.phase !== 'connected' ? (
        <div className='flex flex-col gap-10px'>
          {instances.length > 0 && (
            <div className='flex flex-col gap-8px' data-testid='kaneo-instances-unconnected'>
              <div className='text-13px font-500 text-t-secondary'>
                {t('settings.kaneoCreateTab.instancesTitle', { defaultValue: 'Assistant instances' })}
              </div>
              {[...instancesByRole.entries()].map(([role, roleInstances]) => (
                <div key={role}>
                  <div className='mb-4px text-11px font-600 text-t-tertiary'>{role}</div>
                  {roleInstances.map((instance) => (
                    <KaneoInstanceCard
                      key={instance.assistant.id}
                      instance={instance}
                      localeKey={localeKey}
                      onOpenDetail={(assistant) => onOpenInstance?.(assistant.id)}
                      onToggleEnabled={(assistant, checked) => onToggleInstance?.(assistant.id, checked)}
                      onStartChat={(assistant) => onStartInstanceChat?.(assistant.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
          <Input
            value={kaneo.baseUrl}
            onChange={kaneo.setBaseUrl}
            placeholder={t('settings.kaneoBaseUrlPlaceholder')}
            disabled={kaneo.phase === 'connecting' || kaneo.creating}
            data-testid='input-kaneo-create-base-url'
          />
          <Input.Password
            value={kaneo.apiKey}
            onChange={kaneo.setApiKey}
            placeholder={t('settings.kaneoApiKeyPlaceholder')}
            disabled={kaneo.phase === 'connecting' || kaneo.creating}
            data-testid='input-kaneo-create-api-key'
          />
          <div className='flex items-center gap-8px'>
            <Button
              type='primary'
              loading={kaneo.phase === 'connecting'}
              onClick={kaneo.connect}
              disabled={kaneo.creating || !kaneo.baseUrl.trim() || !kaneo.apiKey.trim()}
              data-testid='btn-kaneo-create-connect'
            >
              {kaneo.phase === 'connecting' ? t('settings.kaneoSyncing') : t('settings.kaneoConnect')}
            </Button>
          </div>
          {kaneo.connectError && (
            <Alert
              type='error'
              content={`${t('settings.kaneoConnectionFailed')}: ${kaneo.connectError}`}
              data-testid='alert-kaneo-create-error'
            />
          )}
        </div>
      ) : (
        <div className='flex flex-col gap-12px'>
          <div className='flex items-center gap-8px text-13px text-t-primary'>
            {t('settings.kaneoConnected')}
            <Button
              size='mini'
              className='!rounded-8px'
              onClick={kaneo.disconnect}
              disabled={kaneo.creating}
              data-testid='btn-kaneo-create-disconnect'
            >
              {t('common.back', { defaultValue: 'Back' })}
            </Button>
          </div>

          {kaneo.manifestNewerVersion && <Alert type='warning' content={t('settings.kaneoManifestNewer')} />}

          <div className='flex flex-col gap-6px'>
            <div className='text-13px font-500 text-t-secondary'>{t('settings.kaneoCreateTab.rolesTitle')}</div>
            {!hasRoles ? (
              <Alert type='warning' content={t('settings.kaneoRoleMissing')} />
            ) : (
              <div className='flex flex-col gap-10px'>
                {kaneo.roles.map((role) => {
                  const selected = kaneo.selectedRole === role.name;
                  const baseClass = 'rounded-10px border px-10px py-8px transition-colors';
                  const stateClass = !role.selectable
                    ? 'border-border-2 bg-fill-1 opacity-60'
                    : selected
                      ? 'border-primary bg-fill-0'
                      : 'border-border-2 bg-2 hover:bg-fill-1';
                  const roleCard = !role.selectable ? (
                    <div
                      key={role.name}
                      data-testid={`grid-kaneo-create-role-${role.name}`}
                      data-unavailable='true'
                      className={`${baseClass} ${stateClass}`}
                    >
                      <div className='text-13px font-500 text-t-primary'>{role.name}</div>
                      {role.description && (
                        <div className='mt-2px line-clamp-2 text-11px text-t-tertiary'>{role.description}</div>
                      )}
                      <div className='mt-4px text-10px text-warning-8'>
                        {t('settings.kaneoCreateTab.roleUnavailableHint')}
                      </div>
                    </div>
                  ) : (
                    <span
                      key={role.name}
                      role='button'
                      tabIndex={0}
                      data-testid={`grid-kaneo-create-role-${role.name}`}
                      className={`${baseClass} ${stateClass} cursor-pointer`}
                      onClick={(event) => {
                        event.preventDefault();
                        kaneo.selectRole(role.name);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          kaneo.selectRole(role.name);
                        }
                      }}
                    >
                      <div className='text-13px font-500 text-t-primary'>{role.name}</div>
                      {role.description && (
                        <div className='mt-2px line-clamp-2 text-11px text-t-tertiary'>{role.description}</div>
                      )}
                      {selected && (
                        <div className='mt-4px text-10px text-primary-6'>
                          {t('settings.kaneoCreateTab.roleSelectedHint', { defaultValue: 'Bound to this assistant' })}
                        </div>
                      )}
                    </span>
                  );
                  // Role card with its assistant instances listed underneath.
                  return (
                    <div key={`kaneo-role-block-${role.name}`} className='flex flex-col'>
                      {roleCard}
                      {renderInstancesForRole(role.name)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className='flex flex-col gap-6px'>
            <div className='text-13px font-500 text-t-secondary'>{t('settings.kaneoCreateTab.projectsTitle')}</div>
            {kaneo.projectsError && (
              <Alert
                type='warning'
                content={t('settings.kaneoCreateTab.projectsLoadFailed', { reason: kaneo.projectsError })}
              />
            )}
            <Select
              value={kaneo.selectedProjectId ?? undefined}
              onChange={(value: string) => kaneo.selectProject(value)}
              placeholder={t('settings.kaneoCreateTab.projectPlaceholder')}
              loading={kaneo.teamsLoading}
              disabled={kaneo.creating || kaneo.teamsLoading}
              showSearch
              data-testid='select-kaneo-create-project'
            >
              {projectOptions.map((p) => (
                <Select.Option key={p.value} value={p.value}>
                  {p.label}
                </Select.Option>
              ))}
            </Select>
          </div>

          {kaneo.selectedRole && kaneo.selectedProjectId && (
            <div
              className='flex flex-col gap-6px rounded-8px bg-fill-1 p-10px'
              data-testid='section-kaneo-create-preview'
            >
              {kaneo.manifest ? (
                <Alert
                  type='info'
                  content={t('settings.kaneoProjectSelected', {
                    role: kaneo.selectedRole,
                    project: projectOptions.find((p) => p.value === kaneo.selectedProjectId)?.label ?? '',
                  })}
                  style={{ marginBottom: 0 }}
                />
              ) : (
                <Alert
                  type='info'
                  content={t('settings.kaneoRoleSelected', { role: kaneo.selectedRole })}
                  style={{ marginBottom: 0 }}
                />
              )}
              <div className='flex items-center gap-6px text-12px text-t-secondary'>
                <Info size={14} theme='outline' fill='currentColor' />
                <span>{t('settings.kaneoCreateTab.updateHint')}</span>
              </div>
            </div>
          )}

          <div className='flex items-center justify-end gap-8px'>
            {kaneo.creating ? (
              <span className='mr-auto text-12px text-t-tertiary'>{t('settings.kaneoSyncing')}</span>
            ) : null}
            <Button
              type='primary'
              onClick={() => void kaneo.create()}
              disabled={!kaneo.canCreate || kaneo.creating}
              loading={kaneo.creating}
              data-testid='btn-kaneo-create-assistant'
            >
              {t('settings.kaneoCreateTab.createButton')}
            </Button>
          </div>
        </div>
      )}

      {kaneo.lastResult && kaneo.phase !== 'connected' ? (
        <Alert
          type='success'
          content={t('settings.kaneoCreateTab.createdNotice', { name: kaneo.lastResult.assistantId })}
        />
      ) : null}
    </div>
  );
};

export default AssistantKaneoCreateTab;
