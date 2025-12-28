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
    id: z.string().min(1),
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
    id: z.string().min(1),
  }),
});

export const deleteDeviceConfigSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export const testDeviceConnectionSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export const syncAttendanceSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  }),
});

export const syncUsersSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export const createUserMappingSchema = z.object({
  params: z.object({
    id: z.string().min(1), // device config id
  }),
  body: z.object({
    memberId: z.number().int().positive(),
    deviceUserId: z.string().min(1, 'Device user ID is required'),
    deviceUserName: z.string().optional(),
  }),
});

export const updateUserMappingSchema = z.object({
  params: z.object({
    id: z.string().min(1), // mapping id
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
    id: z.string().min(1),
  }),
});

export const getUserMappingsSchema = z.object({
  params: z.object({
    id: z.string().min(1), // device config id
  }),
  query: z.object({
    memberId: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
    isActive: z.string().transform((val) => val === 'true').optional(),
  }),
});

export const getDeviceAttendanceLogsSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  }),
});

