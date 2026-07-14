import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest, requireRole } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createPackageSchema,
  updatePackageSchema,
  getPackagesSchema,
  getPackageSchema,
  deletePackageSchema,
  getPackageFeaturesQuerySchema,
  createPackageFeatureSchema,
  updatePackageFeatureSchema,
  deletePackageFeatureSchema,
} from '../validations/packages';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError, ForbiddenError, AppError, ConflictError } from '../utils/errors';

const router = Router();

function normalizeFeatureCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.trim().toUpperCase();
}

function serializeFeature(row: {
  id: number | bigint;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean | number;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: Number(row.id),
    name: row.name,
    code: row.code ?? null,
    description: row.description ?? null,
    isActive: Boolean(row.isActive),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/packages/features — active features for package form; ?all=true for catalog (GYM_ADMIN)
router.get(
  '/features',
  validate(getPackageFeaturesQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const includeAll = Boolean((req.query as { all?: boolean }).all);
      if (includeAll) {
        const role = String(req.user?.role || '').toUpperCase();
        if (role !== 'GYM_ADMIN') {
          sendError(res, new ForbiddenError('Only gym administrators can list inactive features'));
          return;
        }
      }

      const features = includeAll
        ? await prisma.$queryRaw<Array<any>>(Prisma.sql`
            SELECT id, name, code, description, isActive, sortOrder, createdAt, updatedAt
            FROM features
            WHERE deletedAt IS NULL
            ORDER BY sortOrder ASC, name ASC
          `)
        : await prisma.$queryRaw<Array<any>>(Prisma.sql`
            SELECT id, name, code, description, isActive, sortOrder, createdAt, updatedAt
            FROM features
            WHERE isActive = TRUE
              AND deletedAt IS NULL
            ORDER BY sortOrder ASC, name ASC
          `);

      sendSuccess(res, { features: features.map(serializeFeature) });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/packages/features — create feature (GYM_ADMIN)
router.post(
  '/features',
  requireRole('GYM_ADMIN'),
  validate(createPackageFeatureSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body as {
        name: string;
        code?: string | null;
        description?: string | null;
        isActive?: boolean;
        sortOrder?: number;
      };
      const name = body.name.trim();
      const code = normalizeFeatureCode(body.code);

      const duplicate = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT id FROM features
        WHERE deletedAt IS NULL
          AND (name = ${name} OR (${code} IS NOT NULL AND code = ${code}))
        LIMIT 1
      `);
      if (duplicate.length > 0) {
        sendError(res, new ConflictError('A feature with this name or code already exists'));
        return;
      }

      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO features (name, code, description, isActive, sortOrder, createdAt, updatedAt, deletedAt)
        VALUES (
          ${name},
          ${code},
          ${body.description ?? null},
          ${body.isActive ?? true},
          ${body.sortOrder ?? 0},
          NOW(3),
          NOW(3),
          NULL
        )
      `);

      const rows = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, name, code, description, isActive, sortOrder, createdAt, updatedAt
        FROM features WHERE name = ${name} AND deletedAt IS NULL
        ORDER BY id DESC LIMIT 1
      `);

      sendSuccess(res, { feature: serializeFeature(rows[0]) }, 'Feature created', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PATCH /api/packages/features/:id — update feature (GYM_ADMIN)
router.patch(
  '/features/:id',
  requireRole('GYM_ADMIN'),
  validate(updatePackageFeatureSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const body = req.body as Record<string, unknown>;

      const existing = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT id FROM features WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
      `);
      if (existing.length === 0) {
        sendError(res, new NotFoundError('Feature', id));
        return;
      }

      const nextName = body.name !== undefined ? String(body.name).trim() : undefined;
      const nextCode =
        body.code !== undefined ? normalizeFeatureCode(body.code as string | null) : undefined;

      if (nextName !== undefined || nextCode !== undefined) {
        const duplicate = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
          SELECT id FROM features
          WHERE id <> ${id}
            AND deletedAt IS NULL
            AND (
              (${nextName ?? null} IS NOT NULL AND name = ${nextName ?? null})
              OR (${nextCode ?? null} IS NOT NULL AND code = ${nextCode ?? null})
            )
          LIMIT 1
        `);
        if (duplicate.length > 0) {
          sendError(res, new ConflictError('A feature with this name or code already exists'));
          return;
        }
      }

      const updates: Prisma.Sql[] = [];
      if (body.name !== undefined) updates.push(Prisma.sql`name = ${nextName}`);
      if (body.code !== undefined) updates.push(Prisma.sql`code = ${nextCode}`);
      if (body.description !== undefined) {
        updates.push(Prisma.sql`description = ${body.description ?? null}`);
      }
      if (body.isActive !== undefined) updates.push(Prisma.sql`isActive = ${Boolean(body.isActive)}`);
      if (body.sortOrder !== undefined) {
        updates.push(Prisma.sql`sortOrder = ${Number(body.sortOrder)}`);
      }
      updates.push(Prisma.sql`updatedAt = NOW(3)`);

      await prisma.$executeRaw(Prisma.sql`
        UPDATE features SET ${Prisma.join(updates)} WHERE id = ${id}
      `);

      const rows = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, name, code, description, isActive, sortOrder, createdAt, updatedAt
        FROM features WHERE id = ${id} LIMIT 1
      `);

      sendSuccess(res, { feature: serializeFeature(rows[0]) }, 'Feature updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/packages/features/:id — soft delete (GYM_ADMIN); blocked if used by packages
router.delete(
  '/features/:id',
  requireRole('GYM_ADMIN'),
  validate(deletePackageFeatureSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const existing = await prisma.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
        SELECT id, name FROM features WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
      `);
      if (existing.length === 0) {
        sendError(res, new NotFoundError('Feature', id));
        return;
      }

      const inUse = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) as count FROM package_features WHERE featureId = ${id}
      `);
      if (inUse.length > 0 && inUse[0].count > BigInt(0)) {
        sendError(
          res,
          new AppError('FEATURE_IN_USE', 'Feature is assigned to one or more packages', 409)
        );
        return;
      }

      await prisma.$executeRaw(Prisma.sql`
        UPDATE features
        SET isActive = FALSE, deletedAt = NOW(3), updatedAt = NOW(3)
        WHERE id = ${id}
      `);

      sendSuccess(res, { id, deleted: true }, 'Feature deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/packages - Get all packages from database for the authenticated gym
router.get(
  '/',
  validate(getPackagesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const query = req.query as any;
      const { 
        sortBy = 'createdAt', 
        sortOrder = 'desc',
        limit,
        page,
      } = query;

      // Build query options
      const where = { gymId: gymId };
      const take = limit ? parseInt(String(limit), 10) : undefined;
      const skip = page && take ? (parseInt(String(page), 10) - 1) * take : undefined;

      // Log query details for debugging
      console.log('[GET Packages] Fetching from database:', {
        gymId,
        where,
        sortBy,
        sortOrder,
        take,
        skip,
      });

      // ALWAYS fetch from database - no hardcoded data
      const [packages, total] = await Promise.all([
        prisma.package.findMany({
          where,
          include: {
            features: {
              include: {
                feature: true,
              },
            },
            _count: {
              select: {
                members: true,
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
          ...(take && { take }),
          ...(skip !== undefined && { skip }),
        }),
        prisma.package.count({ where }),
      ]);

      // Log results from database
      console.log('[GET Packages] Fetched from database:', {
        count: packages.length,
        total,
        packageIds: packages.map((p: any) => p.id),
      });

      // Transform features to array of feature names
      const packagesWithFeatures = packages.map((pkg: any) => ({
        id: pkg.id,
        gymId: pkg.gymId,
        name: pkg.name,
        price: pkg.price,
        discount: pkg.discount ?? 0, // Include discount field (defaults to 0)
        duration: pkg.duration,
        features: (pkg.features || []).map((pf: any) => pf.feature.name),
        _count: pkg._count,
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
      }));

      // Return packages with total count
      sendSuccess(res, { 
        packages: packagesWithFeatures,
        total: total,
      });
    } catch (error) {
      console.error('[GET Packages] Error fetching packages from database:', error);
      sendError(res, error as Error);
    }
  }
);

// GET /api/packages/:id
router.get(
  '/:id',
  validate(getPackageSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      // Debug logging to help diagnose issues
      console.log('[GET Package] Looking for package:', { id, gymId, idType: typeof id, gymIdType: typeof gymId });

      const packageData = await (prisma.package.findFirst({
        where: { 
          id: id,
          gymId: gymId,
        },
        include: {
          features: {
            include: {
              feature: true,
            },
          },
          _count: {
            select: {
              members: true,
            },
          },
        } as any,
      }) as any);

      if (!packageData) {
        // Additional debug: Check if package exists at all (regardless of gym)
        const anyPackage = await (prisma.package.findFirst({
          where: { id: id },
          select: { id: true, gymId: true, name: true },
        }) as any);
        
        if (anyPackage) {
          console.log('[GET Package] Package exists but belongs to different gym:', {
            packageGymId: anyPackage.gymId,
            userGymId: gymId,
            packageName: anyPackage.name
          });
        } else {
          console.log('[GET Package] Package does not exist with id:', id);
        }
        
        sendError(res, new NotFoundError('Package', id));
        return;
      }

      // Transform features to array of feature names
      const packageWithFeatures = {
        ...packageData,
        features: (packageData.features || []).map((pf: { feature: { name: string } }) => pf.feature.name),
      };

      sendSuccess(res, packageWithFeatures);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/packages - Requires GYM_ADMIN role
router.post(
  '/',
  validate(createPackageSchema),
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { name, price, discount, duration, featureIds } = req.body;

      const discountValue = discount ?? 0;
      const createdPackage = await (prisma.package.create({
        data: {
          gymId,
          name,
          price,
          discount: discountValue,
          duration,
        },
        select: { id: true },
      }) as any);
      const createdPackageId = createdPackage.id as number;

      // Add features separately if provided
      let featuresAssigned = false;
      let featureError: string | null = null;
      
      if (featureIds && Array.isArray(featureIds) && featureIds.length > 0) {
        try {
          // Validate that all feature IDs exist
          const existingFeatures = await (prisma as any).feature.findMany({
            where: {
              id: { in: featureIds },
            },
          });

          if (existingFeatures.length !== featureIds.length) {
            const existingIds = existingFeatures.map((f: any) => f.id);
            const missingIds = featureIds.filter((id: number) => !existingIds.includes(id));
            throw new Error(`Features with IDs ${missingIds.join(', ')} do not exist`);
          }

          await (prisma as any).packageFeature.createMany({
            data: featureIds.map((featureId: number) => ({
              packageId: createdPackageId,
              featureId,
            })),
            skipDuplicates: true,
          });
          featuresAssigned = true;
        } catch (error) {
          // Log error but don't fail the entire request
          console.error('Error assigning features to package:', error);
          featureError = error instanceof Error ? error.message : String(error);
        }
      }

      // Fetch the package with features
      const packageData = await (prisma.package.findFirst({
        where: { id: createdPackageId as any },
        include: {
          features: {
            include: {
              feature: true,
            },
          },
        } as any,
      }) as any);

      if (!packageData) {
        throw new Error('Failed to fetch created package');
      }

      // Transform features to array of feature names
      const packageWithFeatures = {
        ...packageData,
        features: (packageData.features || []).map((pf: { feature: { name: string } }) => pf.feature.name),
      };

      // Return success with warning if features failed to assign
      if (featureIds && Array.isArray(featureIds) && featureIds.length > 0 && !featuresAssigned) {
        // Include error details in response for debugging
        const responseData = {
          ...packageWithFeatures,
          warning: featureError || 'Features could not be assigned',
        };
        sendSuccess(
          res, 
          responseData, 
          'Package created successfully, but features could not be assigned. Please edit the package to add features manually.',
          201
        );
      } else {
        sendSuccess(res, packageWithFeatures, 'Package created successfully', 201);
      }
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PUT /api/packages/:id - Requires GYM_ADMIN role
router.put(
  '/:id',
  validate(updatePackageSchema),
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);
      const { name, price, discount, duration, featureIds } = req.body;

      // Check if package exists
      const existingPackage = await (prisma.package.findFirst({
        where: { id: id as any, gymId: gymId as any },
      }) as any);

      if (!existingPackage) {
        sendError(res, new NotFoundError('Package', id));
        return;
      }

      // Update package
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (price !== undefined) updateData.price = price;
      if (discount !== undefined) updateData.discount = discount;
      if (duration !== undefined) updateData.duration = duration;

      // Update features if provided
      if (featureIds !== undefined) {
        // Delete existing features
        await (prisma as any).packageFeature.deleteMany({
          where: { packageId: id },
        });

        // Add new features
        updateData.features = {
          create: featureIds.map((featureId: number) => ({
            featureId,
          })),
        };
      }

      const packageData = await (prisma.package.update({
        where: { id: id as any },
        data: updateData,
        include: {
          features: {
            include: {
              feature: true,
            },
          },
        } as any,
      }) as any);

      // Transform features to array of feature names
      const packageWithFeatures = {
        ...packageData,
        features: (packageData.features || []).map((pf: { feature: { name: string } }) => pf.feature.name),
      };

      sendSuccess(res, packageWithFeatures, 'Package updated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/packages/:id - Requires GYM_ADMIN role
router.delete(
  '/:id',
  validate(deletePackageSchema),
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      // Check if package exists and get member count using raw SQL
      const packageCheck = await prisma.$queryRaw<Array<{ id: number; memberCount: number }>>`
        SELECT 
          p.id,
          COUNT(m.id) as memberCount
        FROM packages p
        LEFT JOIN members m ON m.packageId = p.id
        WHERE p.id = ${id} AND p.gymId = ${gymId}
        GROUP BY p.id
      `;

      if (!packageCheck || packageCheck.length === 0) {
        sendError(res, new NotFoundError('Package', id));
        return;
      }

      const memberCount = Number(packageCheck[0].memberCount) || 0;

      // Check if package is assigned to members
      if (memberCount > 0) {
        sendError(
          res,
          new ValidationError('Cannot delete package assigned to members')
        );
        return;
      }

      // Delete package features first (cascade should handle this, but being explicit)
      await (prisma as any).packageFeature.deleteMany({
        where: { packageId: id },
      });

      // Delete package using raw SQL to avoid Prisma Client type issues
      await prisma.$executeRaw`
        DELETE FROM packages WHERE id = ${id} AND gymId = ${gymId}
      `;

      sendSuccess(res, { message: 'Package deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

