import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { validate } from '../../middleware/validation';
import { sendError, sendSuccess } from '../../utils/response';
import {
  platformPosAnalyticsQuerySchema,
  platformPosCatalogQuerySchema,
  platformPosCategoryCreateSchema,
  platformPosCategoryIdParamSchema,
  platformPosCategoryPatchSchema,
  platformPosSubcategoryCreateSchema,
  platformPosSubcategoryIdParamSchema,
  platformPosSubcategoryPatchSchema,
} from '../../validations/platformPos';
import {
  createPlatformCategory,
  createPlatformSubcategory,
  deletePlatformCategory,
  deletePlatformSubcategory,
  listPlatformCatalog,
  updatePlatformCategory,
  updatePlatformSubcategory,
} from '../../services/pos/posCatalogService';
import { effectiveAllowedForms } from '../../services/pos/posHelpers';
import { compareGymsByCategory, getPlatformPosAnalytics } from '../../services/pos/posAnalyticsService';
import { writePlatformAuditLog } from '../../services/platformAuditService';
import { Prisma } from '@prisma/client';

const router = Router();

function serializeCategory(row: {
  id: number;
  productType: string;
  name: string;
  code: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    productType: row.productType,
    name: row.name,
    code: row.code,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get(
  '/catalog',
  requirePlatformRole(PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT),
  validate(platformPosCatalogQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const { productType, includeInactive } = req.query as {
        productType?: 'NUTRIENT' | 'ACCESSORY';
        includeInactive?: string;
      };
      const catalog = await listPlatformCatalog({
        productType,
        includeInactive: includeInactive === 'true',
      });
      sendSuccess(res, { catalog });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/categories',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPosCategoryCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const category = await createPlatformCategory(req.body);
      await writePlatformAuditLog({
        actorUserId: req.platformUser!.id,
        actorRole: req.platformUser!.role,
        actionType: 'POS_CATEGORY_CREATE',
        metadata: { categoryId: category.id, name: category.name } as Prisma.InputJsonValue,
      });
      sendSuccess(res, serializeCategory(category), 'Category created', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/categories/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPosCategoryPatchSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const category = await updatePlatformCategory(id, req.body);
      await writePlatformAuditLog({
        actorUserId: req.platformUser!.id,
        actorRole: req.platformUser!.role,
        actionType: 'POS_CATEGORY_UPDATE',
        metadata: { categoryId: id } as Prisma.InputJsonValue,
      });
      sendSuccess(res, serializeCategory(category));
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/categories/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPosCategoryIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      await deletePlatformCategory(id);
      await writePlatformAuditLog({
        actorUserId: req.platformUser!.id,
        actorRole: req.platformUser!.role,
        actionType: 'POS_CATEGORY_DELETE',
        metadata: { categoryId: id } as Prisma.InputJsonValue,
      });
      sendSuccess(res, { id }, 'Category deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/subcategories',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPosSubcategoryCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const subcategory = await createPlatformSubcategory(req.body);
      await writePlatformAuditLog({
        actorUserId: req.platformUser!.id,
        actorRole: req.platformUser!.role,
        actionType: 'POS_SUBCATEGORY_CREATE',
        metadata: { subcategoryId: subcategory.id, name: subcategory.name } as Prisma.InputJsonValue,
      });
      sendSuccess(res, {
        id: subcategory.id,
        categoryId: subcategory.categoryId,
        name: subcategory.name,
        code: subcategory.code,
        description: subcategory.description,
        allowedForms: effectiveAllowedForms(subcategory.category.productType, subcategory.allowedForms),
        sortOrder: subcategory.sortOrder,
        isActive: subcategory.isActive,
      }, 'Subcategory created', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/subcategories/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPosSubcategoryPatchSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const subcategory = await updatePlatformSubcategory(id, req.body);
      await writePlatformAuditLog({
        actorUserId: req.platformUser!.id,
        actorRole: req.platformUser!.role,
        actionType: 'POS_SUBCATEGORY_UPDATE',
        metadata: { subcategoryId: id } as Prisma.InputJsonValue,
      });
      sendSuccess(res, {
        id: subcategory.id,
        categoryId: subcategory.categoryId,
        name: subcategory.name,
        code: subcategory.code,
        description: subcategory.description,
        allowedForms: effectiveAllowedForms(subcategory.category.productType, subcategory.allowedForms),
        sortOrder: subcategory.sortOrder,
        isActive: subcategory.isActive,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/subcategories/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPosSubcategoryIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      await deletePlatformSubcategory(id);
      await writePlatformAuditLog({
        actorUserId: req.platformUser!.id,
        actorRole: req.platformUser!.role,
        actionType: 'POS_SUBCATEGORY_DELETE',
        metadata: { subcategoryId: id } as Prisma.InputJsonValue,
      });
      sendSuccess(res, { id }, 'Subcategory deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/analytics',
  requirePlatformRole(PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT),
  validate(platformPosAnalyticsQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const query = req.query as {
        from?: string;
        to?: string;
        gymId?: string;
        productType?: 'NUTRIENT' | 'ACCESSORY';
        categoryId?: string;
        subcategoryId?: string;
        groupBy?: 'gym' | 'day' | 'category' | 'subcategory' | 'product';
        limit?: string;
      };
      const data = await getPlatformPosAnalytics({
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        gymId: query.gymId ? Number(query.gymId) : undefined,
        productType: query.productType,
        categoryId: query.categoryId ? Number(query.categoryId) : undefined,
        subcategoryId: query.subcategoryId ? Number(query.subcategoryId) : undefined,
        groupBy: query.groupBy ?? 'day',
        limit: query.limit ? Number(query.limit) : 20,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/analytics/compare-gyms/category/:categoryId',
  requirePlatformRole(PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT),
  async (req: PlatformRequest, res: Response) => {
    try {
      const categoryId = Number(req.params.categoryId);
      const { from, to } = req.query as { from?: string; to?: string };
      const data = await compareGymsByCategory(
        categoryId,
        from ? new Date(from) : undefined,
        to ? new Date(to) : undefined
      );
      sendSuccess(res, { categoryId, gyms: data });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
