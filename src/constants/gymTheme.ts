export const DEFAULT_GYM_THEME = {
  ink: '#0f0f0f',
  surface: '#202020',
  primary: '#5DD62C',
  primaryDark: '#337418',
  canvas: '#f8f8f8',
} as const;

export type GymTheme = {
  ink: string;
  surface: string;
  primary: string;
  primaryDark: string;
  canvas: string;
};

export const GYM_THEME_KEYS = [
  'ink',
  'surface',
  'primary',
  'primaryDark',
  'canvas',
] as const;

export type GymThemeKey = (typeof GYM_THEME_KEYS)[number];

export const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_REGEX.test(value);
}

/** Always returns a full 5-color theme (defaults fill missing/invalid). */
export function resolveGymTheme(raw: unknown): GymTheme {
  const resolved: GymTheme = { ...DEFAULT_GYM_THEME };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return resolved;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of GYM_THEME_KEYS) {
    if (isHexColor(obj[key])) {
      resolved[key] = obj[key];
    }
  }
  return resolved;
}

/**
 * Merge a partial theme onto the current stored theme (or defaults).
 * Returns a complete theme object suitable for persisting as JSON.
 */
export function mergeGymTheme(
  current: unknown,
  partial: Partial<Record<GymThemeKey, string>>
): GymTheme {
  return resolveGymTheme({ ...resolveGymTheme(current), ...partial });
}
