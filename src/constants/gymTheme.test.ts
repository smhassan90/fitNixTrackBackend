import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GYM_THEME,
  mergeGymTheme,
  resolveGymTheme,
} from './gymTheme';

test('resolveGymTheme returns defaults for null/undefined', () => {
  assert.deepEqual(resolveGymTheme(null), { ...DEFAULT_GYM_THEME });
  assert.deepEqual(resolveGymTheme(undefined), { ...DEFAULT_GYM_THEME });
});

test('resolveGymTheme merges valid hex and ignores invalid', () => {
  const resolved = resolveGymTheme({
    primary: '#FF0000',
    ink: 'not-a-color',
    extra: '#FFFFFF',
  });
  assert.equal(resolved.primary, '#FF0000');
  assert.equal(resolved.ink, DEFAULT_GYM_THEME.ink);
  assert.equal(resolved.canvas, DEFAULT_GYM_THEME.canvas);
});

test('mergeGymTheme overlays partial onto current', () => {
  const merged = mergeGymTheme(
    { ...DEFAULT_GYM_THEME, primary: '#111111' },
    { canvas: '#ABCDEF' }
  );
  assert.equal(merged.primary, '#111111');
  assert.equal(merged.canvas, '#ABCDEF');
  assert.equal(merged.ink, DEFAULT_GYM_THEME.ink);
});
