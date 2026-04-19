export type PlatformPermissionDefinition = {
  key: string;
  label: string;
  description?: string;
  group?: string;
};

/**
 * Catalog of assignable platform permission keys (portal checkboxes).
 * SUPER_ADMIN may bypass these in the portal; keys still define scope for PLATFORM_SUPPORT.
 */
export const PLATFORM_PERMISSION_DEFINITIONS: PlatformPermissionDefinition[] = [
  {
    key: 'platform.gyms.read',
    label: 'View gyms',
    description: 'List gyms, subscriptions, and gym details.',
    group: 'Gyms',
  },
  {
    key: 'platform.gyms.manage',
    label: 'Manage gyms',
    description: 'Create gyms and update gym records (super-admin routes).',
    group: 'Gyms',
  },
  {
    key: 'platform.billing.read',
    label: 'View billing',
    description: 'View subscription dues and billing summaries.',
    group: 'Billing',
  },
  {
    key: 'platform.reports.read',
    label: 'View reports',
    description: 'Access platform-wide reports and analytics.',
    group: 'Reports',
  },
  {
    key: 'platform.audit.read',
    label: 'View audit logs',
    description: 'Read platform audit log entries.',
    group: 'Security',
  },
  {
    key: 'platform.operators.read',
    label: 'View operators',
    description: 'List platform operator accounts (API currently SUPER_ADMIN only).',
    group: 'Operators',
  },
  {
    key: 'platform.operators.manage',
    label: 'Manage operators',
    description: 'Create, update, and remove platform operator accounts.',
    group: 'Operators',
  },
];

const _keys = new Set(PLATFORM_PERMISSION_DEFINITIONS.map((p) => p.key));

export function isKnownPlatformPermissionKey(key: string): boolean {
  return _keys.has(key);
}

export const KNOWN_PLATFORM_PERMISSION_KEYS = _keys;
