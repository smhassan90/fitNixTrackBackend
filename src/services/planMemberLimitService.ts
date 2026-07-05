import { prisma } from '../lib/prisma';
import { ValidationError } from '../utils/errors';

/**
 * Ensures the gym can add one more active member under its platform plan maxMembers.
 * Counts active members only (isActive = true).
 */
export async function assertGymCanAddActiveMember(gymId: number): Promise<void> {
  const subscription = await prisma.gymSubscription.findUnique({
    where: { gymId },
    include: {
      plan: {
        select: { id: true, code: true, name: true, maxMembers: true, isActive: true },
      },
    },
  });

  const maxMembers = subscription?.plan?.maxMembers;
  if (maxMembers == null || maxMembers <= 0) {
    return;
  }

  const activeMembers = await prisma.member.count({
    where: { gymId, isActive: true },
  });

  if (activeMembers >= maxMembers) {
    throw new ValidationError(
      `Active member limit reached for the ${subscription!.plan.name} plan (${maxMembers}). Upgrade your FitNixTrack plan to add more members.`,
      {
        code: 'PLAN_MEMBER_LIMIT',
        planId: subscription!.plan.id,
        planCode: subscription!.plan.code,
        planName: subscription!.plan.name,
        maxMembers,
        activeMembers,
      }
    );
  }
}
