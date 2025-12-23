import { randomUUID } from 'crypto';

/**
 * Generate a gym-scoped ID in the format: {entityType}-{gymId}-{uuid}
 */
export function generateGymScopedId(entityType: string, gymId: string): string {
  const uuid = randomUUID();
  return `${entityType}-${gymId}-${uuid}`;
}

/**
 * Extract gymId from a gym-scoped ID
 */
export function extractGymIdFromId(id: string): string | null {
  const parts = id.split('-');
  if (parts.length < 3) return null;
  // Remove the first part (entityType) and last part (uuid)
  // The middle parts are the gymId (which may contain hyphens)
  const uuidIndex = parts.length - 1;
  const gymIdParts = parts.slice(1, uuidIndex);
  return gymIdParts.join('-');
}

