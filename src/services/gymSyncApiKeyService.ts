import { prisma } from '../lib/prisma';
import { generateSyncApiKey } from '../utils/syncApiKey';

/**
 * Returns the gym's permanent tablet sync API key, creating one if missing.
 */
export async function ensureGymSyncApiKey(gymId: number): Promise<string> {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { syncApiKey: true },
  });

  if (!gym) {
    throw new Error('Gym not found');
  }

  if (gym.syncApiKey) {
    return gym.syncApiKey;
  }

  let syncApiKey = generateSyncApiKey(gymId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const updated = await prisma.gym.update({
        where: { id: gymId },
        data: { syncApiKey },
        select: { syncApiKey: true },
      });
      return updated.syncApiKey!;
    } catch {
      syncApiKey = generateSyncApiKey(gymId);
    }
  }

  throw new Error('Failed to generate sync API key');
}
