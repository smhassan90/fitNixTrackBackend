export type GymPermissionDefinition = {
  key: string;
  label: string;
  description: string;
  group: string;
};

/**
 * Checkbox catalog for gym team members.
 * Attendance viewing and imports are intentionally absent:
 * - every authenticated gym user may view attendance;
 * - imports are a one-time administrative activity, not a delegated feature.
 */
export const GYM_PERMISSION_DEFINITIONS: GymPermissionDefinition[] = [
  {
    key: 'gym.dashboard.read',
    label: 'View dashboard',
    description: 'View gym overview, statistics, and currently-present members.',
    group: 'Dashboard & reports',
  },
  {
    key: 'gym.financialReports.read',
    label: 'View financial reports',
    description: 'View revenue, collections, payment summaries, and financial reports.',
    group: 'Dashboard & reports',
  },
  {
    key: 'gym.members.read',
    label: 'View members',
    description: 'View member lists, profiles, status, and payment history.',
    group: 'Members',
  },
  {
    key: 'gym.members.manage',
    label: 'Manage members',
    description: 'Create and edit members, status, trainers, and member photos.',
    group: 'Members',
  },
  {
    key: 'gym.members.delete',
    label: 'Delete members',
    description: 'Permanently delete member records.',
    group: 'Members',
  },
  {
    key: 'gym.trainers.read',
    label: 'View trainers',
    description: 'View trainer lists and profiles.',
    group: 'Trainers',
  },
  {
    key: 'gym.trainers.manage',
    label: 'Manage trainers',
    description: 'Create, edit, activate, and deactivate trainers.',
    group: 'Trainers',
  },
  {
    key: 'gym.trainers.delete',
    label: 'Delete trainers',
    description: 'Permanently delete trainer records.',
    group: 'Trainers',
  },
  {
    key: 'gym.packages.read',
    label: 'View packages',
    description: 'View membership packages and their features.',
    group: 'Packages',
  },
  {
    key: 'gym.packages.manage',
    label: 'Manage packages',
    description: 'Create, edit, and delete membership packages.',
    group: 'Packages',
  },
  {
    key: 'gym.packageFeatures.manage',
    label: 'Manage package features',
    description: 'Create, edit, and delete the package feature catalog.',
    group: 'Packages',
  },
  {
    key: 'gym.payments.read',
    label: 'View payments',
    description: 'View payments, dues, installments, and receipts.',
    group: 'Payments',
  },
  {
    key: 'gym.payments.manage',
    label: 'Collect and update payments',
    description: 'Collect fees, mark installments paid, and update payment records.',
    group: 'Payments',
  },
  {
    key: 'gym.payments.delete',
    label: 'Delete or reverse payments',
    description: 'Delete or reverse payment records.',
    group: 'Payments',
  },
  {
    key: 'gym.attendancePolicy.manage',
    label: 'Manage attendance policy',
    description: 'Change check-in, check-out, and attendance policy settings.',
    group: 'Attendance',
  },
  {
    key: 'gym.devices.read',
    label: 'View devices',
    description: 'View biometric devices, users, mappings, and sync status.',
    group: 'Devices',
  },
  {
    key: 'gym.devices.manage',
    label: 'Manage device settings',
    description: 'Add, edit, sync, map, and remove devices and tablet sync settings.',
    group: 'Devices',
  },
  {
    key: 'gym.settings.read',
    label: 'View gym settings',
    description: 'View gym configuration and attendance settings.',
    group: 'Administration',
  },
  {
    key: 'gym.settings.manage',
    label: 'Edit gym settings',
    description: 'Change gym configuration and preferences.',
    group: 'Administration',
  },
  {
    key: 'gym.team.manage',
    label: 'Manage team',
    description: 'Create, edit, disable, and assign permissions to team members.',
    group: 'Administration',
  },
];

export const KNOWN_GYM_PERMISSION_KEYS = new Set(
  GYM_PERMISSION_DEFINITIONS.map((permission) => permission.key)
);

const IMPLIED_PERMISSIONS: Record<string, string[]> = {
  'gym.members.manage': ['gym.members.read'],
  'gym.members.delete': ['gym.members.manage', 'gym.members.read'],
  'gym.trainers.manage': ['gym.trainers.read'],
  'gym.trainers.delete': ['gym.trainers.manage', 'gym.trainers.read'],
  'gym.packages.manage': ['gym.packages.read'],
  'gym.packageFeatures.manage': ['gym.packages.read'],
  // Payment desk staff need member/settings context for receipts and member-linked payment screens.
  'gym.payments.read': ['gym.members.read', 'gym.settings.read', 'gym.packages.read'],
  'gym.payments.manage': ['gym.payments.read'],
  'gym.payments.delete': ['gym.payments.manage', 'gym.payments.read'],
  'gym.devices.manage': ['gym.devices.read'],
  'gym.settings.manage': ['gym.settings.read'],
};

export function normalizeGymPermissionKeys(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((key): key is string => (
    typeof key === 'string' && KNOWN_GYM_PERMISSION_KEYS.has(key)
  )))];
}

export function expandGymPermissionKeys(keys: readonly string[]): Set<string> {
  const expanded = new Set(keys);
  const visit = (key: string): void => {
    for (const implied of IMPLIED_PERMISSIONS[key] ?? []) {
      if (!expanded.has(implied)) {
        expanded.add(implied);
        visit(implied);
      }
    }
  };
  keys.forEach(visit);
  return expanded;
}

/**
 * Existing users created before checkbox permissions retain their old role-level access
 * until an admin explicitly saves a permission list for them.
 */
export function legacyGymPermissionsForRole(role: string): string[] {
  if (role === 'GYM_ADMIN') {
    return [...KNOWN_GYM_PERMISSION_KEYS];
  }
  if (role === 'GYM_MANAGER') {
    return [...KNOWN_GYM_PERMISSION_KEYS].filter((key) => ![
      'gym.packageFeatures.manage',
      'gym.attendancePolicy.manage',
      'gym.settings.manage',
      'gym.team.manage',
    ].includes(key));
  }
  return [
    'gym.dashboard.read',
    'gym.members.read',
    'gym.members.manage',
    'gym.members.delete',
    'gym.trainers.read',
    'gym.trainers.manage',
    'gym.trainers.delete',
    'gym.packages.read',
    'gym.payments.read',
    'gym.payments.manage',
    'gym.payments.delete',
    'gym.financialReports.read',
    'gym.devices.read',
    'gym.settings.read',
  ];
}

export function effectiveGymPermissionKeys(role: string, storedKeys: unknown): string[] {
  if (role === 'GYM_ADMIN') return [...KNOWN_GYM_PERMISSION_KEYS];
  return storedKeys === null || storedKeys === undefined
    ? legacyGymPermissionsForRole(role)
    : normalizeGymPermissionKeys(storedKeys);
}

/** Stored/effective keys expanded with implied permissions (for login/me/UI). */
export function effectiveExpandedGymPermissionKeys(role: string, storedKeys: unknown): string[] {
  return [...expandGymPermissionKeys(effectiveGymPermissionKeys(role, storedKeys))];
}
