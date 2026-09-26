import type { Theme } from '@/common/theme/types';
import type { KaneoContext } from '@/renderer/services/kaneo/kaneoContexts';

export type ConfigKeyMap = {
  language: string;
  'ui.zoomFactor': number | undefined;
  'ui.fontSize.app': number | undefined;
  'ui.fontSize.chat': number | undefined;
  'ui.fontSize.markdown': number | undefined;
  'ui.fontSize.code': number | undefined;
  'ui.fontFamily.app': string | undefined;
  'ui.fontFamily.chat': string | undefined;
  'ui.fontFamily.markdown': string | undefined;
  'ui.fontFamily.code': string | undefined;
  'ui.fontWeight.app': string | undefined;
  'ui.fontWeight.chat': string | undefined;
  'ui.fontWeight.markdown': string | undefined;
  'ui.fontWeight.code': string | undefined;
  'window.bounds': { x?: number; y?: number; width: number; height: number } | undefined;
  'webui.desktop.enabled': boolean | undefined;
  'webui.desktop.allowRemote': boolean | undefined;
  'webui.desktop.port': number | undefined;
  'theme.activeId': string;
  'theme.userThemes': Theme[];
  'workspace.pasteConfirm': boolean | undefined;
  'guid.lastAssistantId': string | undefined;
  /** Kaneo role bound to the last imported role-scoped API key (e.g. `coding`).
   * Legacy: migrated once into `kaneo.contexts` by migrateKaneoContexts; kept
   * in the type map during the dual-read window, then removed. */
  'kaneo.activeRole': string | undefined;
  /** Imported Kaneo contexts (project/role bindings, no key material). */
  'kaneo.contexts': KaneoContext[] | undefined;
  /** Which Kaneo context is currently active in the Guide. */
  'kaneo.activeContextId': string | undefined;
  /** Last Kaneo base URL used in the assistant-create Kaneo tab. */
  'kaneo.lastBaseUrl': string | undefined;
  /** User-defined order for the enabled assistant picker surfaces. */
  'assistants.enabledOrder': string[] | undefined;
  'upload.saveToWorkspace': boolean | undefined;
  'system.closeToTray': boolean | undefined;
  'system.notificationEnabled': boolean | undefined;
  'system.cronNotificationEnabled': boolean | undefined;
  'system.keepAwake': boolean | undefined;
  'skillsMarket.enabled': boolean | undefined;
  'pet.enabled': boolean | undefined;
  'pet.size': number | undefined;
  'pet.dnd': boolean | undefined;
  'pet.confirmEnabled': boolean | undefined;
  // Removed: 'system.autoPreviewOfficeFiles'. It gated "auto-open a preview tab
  // when an Office file appears in the workspace", a behaviour that was dropped
  // along with its hook — leaving the toggle would have been a switch the user
  // can flip with nothing behind it. Existing values may still sit in older
  // installs' stored preferences; nothing reads them, and the migration ignores
  // unknown keys, so they are inert.
  // One-shot completion flags for legacy → backend migrations. Kept in the
  // local config file (not the backend client-preferences bag) so a downgrade
  // to a pre-flag build still re-reads the legacy data unchanged. See
  // `migrateProviders` / `migrateAssistantsToBackend` (ELECTRON-1KT).
  'migration.providersMigrated_v1': boolean | undefined;
  'migration.assistantsMigrated_v1': boolean | undefined;
};

export type ConfigKey = keyof ConfigKeyMap;
