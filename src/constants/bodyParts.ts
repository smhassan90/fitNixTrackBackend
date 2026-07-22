export const WORKOUT_BODY_PARTS = [
  'CHEST',
  'BICEPS',
  'TRICEPS',
  'BACK',
  'SHOULDERS',
  'LEGS',
  'ABS',
  'CARDIO',
  'FULL_BODY',
] as const;

export type WorkoutBodyPart = (typeof WORKOUT_BODY_PARTS)[number];

export const BODY_PART_LABELS: Record<WorkoutBodyPart, string> = {
  CHEST: 'Chest',
  BICEPS: 'Biceps',
  TRICEPS: 'Triceps',
  BACK: 'Back',
  SHOULDERS: 'Shoulders',
  LEGS: 'Legs',
  ABS: 'Abs',
  CARDIO: 'Cardio',
  FULL_BODY: 'Full Body',
};

export function isValidBodyPart(value: string): value is WorkoutBodyPart {
  return (WORKOUT_BODY_PARTS as readonly string[]).includes(value);
}

export function normalizeBodyParts(parts: string[]): WorkoutBodyPart[] {
  const unique = new Set<WorkoutBodyPart>();
  for (const part of parts) {
    const upper = part.trim().toUpperCase();
    if (isValidBodyPart(upper)) {
      unique.add(upper);
    }
  }
  return [...unique];
}
