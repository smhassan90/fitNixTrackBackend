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
import { generateGymScopedId } from '../utils/idGenerator';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/packages
router.get(
  '/',
  validate(getPackagesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { sortBy = 'createdAt', sortOrder = 'desc' } = req.query as any;

      const packages = await prisma.package.findMany({
        where: { gymId },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      });

      sendSuccess(res, { packages });
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
      const { id } = req.params;

      const packageData = await prisma.package.findFirst({
        where: { id, gymId },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      if (!packageData) {
        sendError(res, new NotFoundError('Package', id));
        return;
      }

      sendSuccess(res, packageData);
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
      const { name, price, duration, features } = req.body;

      // Create package
      const packageData = await prisma.package.create({
        data: {
          id: generateGymScopedId('package', gymId),
          gymId,
          name,
          price,
          duration,
          features,
        },
      });

      sendSuccess(res, packageData, 'Package created successfully', 201);
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
      const { id } = req.params;
      const { name, price, duration, features } = req.body;

      // Check if package exists
      const existingPackage = await prisma.package.findFirst({
        where: { id, gymId },
      });

      if (!existingPackage) {
        sendError(res, new NotFoundError('Package', id));
        return;
      }

      // Update package
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (price !== undefined) updateData.price = price;
      if (duration !== undefined) updateData.duration = duration;
      if (features !== undefined) updateData.features = features;

      const packageData = await prisma.package.update({
        where: { id },
        data: updateData,
      });

      sendSuccess(res, packageData, 'Package updated successfully');
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
      const { id } = req.params;

      const packageData = await prisma.package.findFirst({
        where: { id, gymId },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      if (!packageData) {
        sendError(res, new NotFoundError('Package', id));
        return;
      }

      // Check if package is assigned to members
      if (packageData._count.members > 0) {
        sendError(
          res,
          new ValidationError('Cannot delete package assigned to members')
        );
        return;
      }

      // Delete package
      await prisma.package.delete({
        where: { id },
      });

      sendSuccess(res, { message: 'Package deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

