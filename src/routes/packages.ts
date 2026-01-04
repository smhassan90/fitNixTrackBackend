import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createPackageSchema,
  updatePackageSchema,
  getPackagesSchema,
  getPackageSchema,
  deletePackageSchema,
} from '../validations/packages';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/packages/features - Get all available features from database
// Returns only features that exist in the 'features' table
router.get('/features', async (req: AuthRequest, res: Response) => {
  try {
    // Query database - returns only what's in the features table
    const features = await (prisma as any).feature.findMany({
      orderBy: { name: 'asc' },
    });

    sendSuccess(res, { features });
  } catch (error) {
    sendError(res, error as Error);
  }
});

// GET /api/packages
router.get(
  '/',
  validate(getPackagesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { sortBy = 'createdAt', sortOrder = 'desc' } = req.query as any;

      const packages = await (prisma.package.findMany({
        where: { gymId: gymId as any },
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
        orderBy: { [sortBy]: sortOrder },
      }) as any);

      // Transform features to array of feature names
      const packagesWithFeatures = packages.map((pkg: any) => ({
        ...pkg,
        features: (pkg.features || []).map((pf: { feature: { name: string } }) => pf.feature.name),
      }));

      sendSuccess(res, { packages: packagesWithFeatures });
    } catch (error) {
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

      const packageData = await (prisma.package.findFirst({
        where: { id: id as any, gymId: gymId as any },
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

// POST /api/packages
router.post(
  '/',
  validate(createPackageSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { name, price, discount, duration, featureIds } = req.body;

      // Use raw SQL to create package
      // Note: Database still has old 'features' JSON column, so we provide empty array
      const discountValue = discount ?? 0;
      await prisma.$executeRaw`
        INSERT INTO packages (gymId, name, price, discount, duration, features, createdAt, updatedAt)
        VALUES (${gymId}, ${name}, ${price}, ${discountValue}, ${duration}, JSON_ARRAY(), NOW(), NOW())
      `;

      // Get the created package ID
      const result = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT LAST_INSERT_ID() as id
      `;

      const createdPackageId = result[0]?.id;

      if (!createdPackageId) {
        throw new Error('Failed to create package');
      }

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

// PUT /api/packages/:id
router.put(
  '/:id',
  validate(updatePackageSchema),
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

// DELETE /api/packages/:id
router.delete(
  '/:id',
  validate(deletePackageSchema),
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

