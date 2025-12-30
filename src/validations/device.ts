import { z } from 'zod';

export const createDeviceConfigSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Device name is required'),
    ipAddress: z.string().ip('Invalid IP address'),
    port: z.number().int().min(1).max(65535).optional().default(4370),
    serialNumber: z.string().optional(),
    syncInterval: z.number().int().min(60).optional().default(300),
    deviceUserId: z.string().optional(),
    devicePassword: z.string().optional(),
  }),
});

export const updateDeviceConfigSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    ipAddress: z.string().ip('Invalid IP address').optional(),
    port: z.number().int().min(1).max(65535).optional(),
    serialNumber: z.string().optional(),
    isActive: z.boolean().optional(),
    syncInterval: z.number().int().min(60).optional(),
    deviceUserId: z.string().optional(),
    devicePassword: z.string().optional(),
  }),
});

export const getDeviceConfigSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const deleteDeviceConfigSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const testDeviceConnectionSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const syncAttendanceSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  }),
});

export const syncUsersSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const createUserMappingSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)), // device config id
  }),
  body: z.object({
    memberId: z.number().int().positive(),
    deviceUserId: z.string().min(1, 'Device user ID is required'),
    deviceUserName: z.string().optional(),
  }),
});

export const updateUserMappingSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Mapping ID must be a number').transform((val) => parseInt(val, 10)), // mapping id
  }),
  body: z.object({
    memberId: z.number().int().positive().optional(),
    deviceUserId: z.string().min(1).optional(),
    deviceUserName: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const deleteUserMappingSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Mapping ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const getUserMappingsSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)), // device config id
  }),
  query: z.object({
    memberId: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
    isActive: z.string().transform((val) => val === 'true').optional(),
  }),
});

export const getDeviceAttendanceLogsSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    fullSync: z.string().transform((val) => val === 'true').optional(), // Force full sync from beginning
  }),
});

export const syncUsersOfflineSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    users: z.array(z.object({
      uid: z.number(),
      name: z.string(),
      privilege: z.number(),
      password: z.string(),
      groupId: z.string(),
      userId: z.string(),
      card: z.number(),
    })),
    apiKey: z.string().min(1, 'API key is required'),
  }),
});

export const syncAttendanceOfflineSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Device ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    logs: z.array(z.object({
      uid: z.number().optional(),
      id: z.number().optional(),
      state: z.number().optional(),
      timestamp: z.number().optional(),
      type: z.number().optional(),
      userSn: z.number().optional(),
      deviceUserId: z.string().optional(),
      recordTime: z.string().optional(),
      ip: z.string().optional(),
    })),
    lastSyncAt: z.string().optional(),
    apiKey: z.string().min(1, 'API key is required'),
  }),
});

