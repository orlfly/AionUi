/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantListItem } from '../types';
import type { KaneoContext } from '@/renderer/services/kaneo/kaneoContexts';
import AssistantAvatar from '../AssistantAvatar';
import RuntimeBadge from './RuntimeBadge';
import { Button, Switch, Tooltip } from '@arco-design/web-react';
import { Attention } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

export type KaneoInstanceEntry = {
  assistant: AssistantListItem;
  context: KaneoContext;
};

type KaneoInstanceCardProps = {
  instance: KaneoInstanceEntry;
  localeKey: string;
  onOpenDetail: (assistant: AssistantListItem) => void;
  onToggleEnabled: (assistant: AssistantListItem, checked: boolean) => void;
  onStartChat: (assistant: AssistantListItem) => void;
};

/**
 * One assistant instance row inside the Kaneo tab, listed under its agent
 * role card. Shows the project + workspace binding so the user can see which
 * (role, project) pair this instance serves.
 */
const KaneoInstanceCard: React.FC<KaneoInstanceCardProps> = ({
  instance,
  localeKey,
  onOpenDetail,
  onToggleEnabled,
  onStartChat,
}) => {
  const { t } = useTranslation();
  const { assistant, context } = instance;
  const enabled = assistant.enabled !== false;

  return (
    <div
      role='button'
      tabIndex={0}
      data-testid={`kaneo-instance-${assistant.id}`}
      className='flex cursor-pointer items-center gap-10px rounded-10px border border-border-2 bg-base px-12px py-10px transition-colors hover:bg-fill-1'
      onClick={() => onOpenDetail(assistant)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetail(assistant);
        }
      }}
    >
      <span onClick={(e) => e.stopPropagation()}>
        <AssistantAvatar assistant={assistant} size={34} />
      </span>
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 items-center gap-8px'>
          <span className={`truncate text-13px font-600 text-t-primary ${enabled ? '' : 'opacity-60'}`}>
            {assistant.name_i18n?.[localeKey] || assistant.name}
          </span>
          {assistant.agent_status !== 'online' && (
            <Tooltip
              content={
                assistant.agent_status === 'missing'
                  ? t('settings.assistantAgentMissing', { defaultValue: 'The required agent is not installed.' })
                  : assistant.agent_status === 'unchecked'
                    ? t('settings.assistantAgentUnchecked', {
                        defaultValue: 'The required agent has not been checked yet.',
                      })
                    : t('settings.assistantAgentUnavailable', {
                        defaultValue: 'The required agent is currently unavailable.',
                      })
              }
            >
              <span className='flex flex-shrink-0 items-center text-warning-6'>
                <Attention size={14} fill='currentColor' />
              </span>
            </Tooltip>
          )}
        </div>
        <div className='mt-2px truncate text-11px text-t-tertiary'>
          {[
            context.projectName || context.projectId || t('settings.kaneoCreateTab.unboundProject'),
            context.workspace
              ? t('settings.kaneoInstance.workspaceSuffix', {
                  defaultValue: 'Workspace: {{workspace}}',
                  workspace: context.workspace,
                })
              : t('settings.kaneoInstance.workspaceMissing', { defaultValue: 'Workspace not allocated' }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <span onClick={(e) => e.stopPropagation()}>
        <RuntimeBadge assistant={assistant} />
      </span>
      <span onClick={(e) => e.stopPropagation()} className={enabled ? '' : 'opacity-55'}>
        <Switch
          size='small'
          data-testid={`switch-kaneo-instance-${assistant.id}`}
          checked={enabled}
          onChange={(checked) => onToggleEnabled(assistant, checked)}
        />
      </span>
      {enabled ? (
        <Button
          type='text'
          size='small'
          data-testid={`btn-kaneo-instance-chat-${assistant.id}`}
          className='!inline-flex !h-26px !items-center !justify-center !rounded-8px !bg-fill-2 !px-10px !leading-none !text-t-secondary hover:!bg-primary-6 hover:!text-white'
          onClick={() => onStartChat(assistant)}
        >
          {t('settings.assistantGoChat', { defaultValue: 'Chat' })}
        </Button>
      ) : null}
    </div>
  );
};

export default KaneoInstanceCard;
