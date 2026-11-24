import type { AppConfig } from '../config.js';

export function isOwnerPreview(config: AppConfig): boolean {
  return config.accessMode === 'PRELAUNCH' && !config.testGroup;
}

export function allowsGroupWorkflows(config: AppConfig): boolean {
  return config.accessMode === 'LIVE' || config.testGroup !== undefined;
}

export function groupDestination(config: AppConfig, ownerGroupId: bigint): string {
  if (!allowsGroupWorkflows(config) || ownerGroupId >= 0n || ownerGroupId !== config.groupId ||
      (config.testGroup && (config.accessMode !== 'PRELAUNCH' || ownerGroupId !== config.testGroup.id ||
        ownerGroupId === config.testGroup.originalGroupId))) {
    throw new Error('Group destination does not match the active scope');
  }
  return ownerGroupId.toString();
}

export type AccessMode = 'PRELAUNCH' | 'LIVE';

export function hasPrelaunchAccess(
  mode: AccessMode,
  ownerId: bigint,
  requestingMemberId: bigint,
): boolean {
  return mode === 'PRELAUNCH' && ownerId === requestingMemberId;
}

export function ownsResource(
  resourceOwnerId: bigint,
  requestingMemberId: bigint,
): boolean {
  return resourceOwnerId === requestingMemberId;
}
