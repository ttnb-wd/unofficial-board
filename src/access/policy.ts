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
