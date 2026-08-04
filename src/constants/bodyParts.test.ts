import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_PART_LABELS,
  WORKOUT_BODY_PARTS,
  normalizeBodyParts,
} from './bodyParts';

test('body-parts catalog includes TRAPS, YOGA, AEROBICS and keeps CARDIO', () => {
  assert.ok(WORKOUT_BODY_PARTS.includes('TRAPS'));
  assert.ok(WORKOUT_BODY_PARTS.includes('YOGA'));
  assert.ok(WORKOUT_BODY_PARTS.includes('AEROBICS'));
  assert.ok(WORKOUT_BODY_PARTS.includes('CARDIO'));
  assert.ok(WORKOUT_BODY_PARTS.includes('FULL_BODY'));
  assert.equal(BODY_PART_LABELS.TRAPS, 'Traps');
  assert.equal(BODY_PART_LABELS.YOGA, 'Yoga');
  assert.equal(BODY_PART_LABELS.AEROBICS, 'Aerobics');
  assert.equal(BODY_PART_LABELS.CARDIO, 'Cardio');
});

test('normalizeBodyParts accepts new codes', () => {
  assert.deepEqual(normalizeBodyParts(['traps', 'YOGA', 'AEROBICS', 'CARDIO']), [
    'TRAPS',
    'YOGA',
    'AEROBICS',
    'CARDIO',
  ]);
});
