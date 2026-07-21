import { Router, Response } from 'express';
import {
  authenticateToken,
  AuthRequest,
  hasGymPermission,
  requireGymPermission,
} from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { validate } from '../middleware/validation';
import { sendError, sendSuccess, buildPagination } from '../utils/response';
import {
  getGymCatalog,
  setGymEnabledSubcategories,
} from '../services/pos/posCatalogService';
import {
  adjustProductStock,
  createGymProduct,
  deactivateGymProduct,
  getGymProduct,
  listGymProducts,
  listStockMovements,
  restockProduct,
  updateGymProduct,
} from '../services/pos/posProductService';
import {
  createSale,
  getGymPosSummary,
  getSale,
  listSales,
  voidSale,
} from '../services/pos/posSaleService';
import {
  posCatalogQuerySchema,
  posGymReportQuerySchema,
  posGymSubcategoriesPutSchema,
  posInventoryAdjustSchema,
  posInventoryRestockSchema,
  posProductCreateSchema,
  posProductIdParamSchema,
  posProductListQuerySchema,
  posProductPatchSchema,
  posSaleCreateSchema,
  posSaleIdParamSchema,
  posSalesListQuerySchema,
  posSaleVoidSchema,
  posStockHistoryQuerySchema,
} from '../validations/pos';

const router = Router();

router.use(authenticateToken);
router.use(requireGymId);

router.get(
  '/catalog',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posCatalogQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { productType, includeDisabled } = req.query as {
        productType?: 'NUTRIENT' | 'ACCESSORY';
        includeDisabled?: string;
      };
      const catalog = await getGymCatalog(req.user!.gymId, {
        productType,
        includeDisabled: includeDisabled === 'true',
      });
      sendSuccess(res, { catalog });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.put(
  '/gym-subcategories',
  requireGymPermission('gym.pos.products.manage'),
  validate(posGymSubcategoriesPutSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const catalog = await setGymEnabledSubcategories(
        req.user!.gymId,
        req.body.subcategoryIds
      );
      sendSuccess(res, { catalog });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/products',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posProductListQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const query = req.query as {
        productType?: 'NUTRIENT' | 'ACCESSORY';
        subcategoryId?: string;
        isActive?: string;
        search?: string;
        page?: string;
        limit?: string;
      };
      const { products, total } = await listGymProducts(req.user!.gymId, {
        productType: query.productType,
        subcategoryId: query.subcategoryId ? Number(query.subcategoryId) : undefined,
        isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
        search: query.search,
        page: Number(query.page ?? 1),
        limit: Number(query.limit ?? 50),
      });
      sendSuccess(res, {
        products,
        pagination: buildPagination(
          Number(query.page ?? 1),
          Number(query.limit ?? 50),
          total
        ),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/products/:id',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posProductIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const product = await getGymProduct(req.user!.gymId, Number(req.params.id));
      sendSuccess(res, { product });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/products',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductCreateSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const product = await createGymProduct(req.user!.gymId, req.user!.id, req.body);
      sendSuccess(res, { product }, 'Product created', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/products/:id',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductPatchSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const product = await updateGymProduct(
        req.user!.gymId,
        Number(req.params.id),
        req.body
      );
      sendSuccess(res, { product });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/products/:id',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const product = await deactivateGymProduct(req.user!.gymId, Number(req.params.id));
      sendSuccess(res, { product }, 'Product deactivated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/products/:id/restock',
  requireGymPermission('gym.pos.inventory.manage'),
  validate(posInventoryRestockSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const product = await restockProduct(
        req.user!.gymId,
        Number(req.params.id),
        req.user!.id,
        req.body.quantity,
        req.body.note
      );
      sendSuccess(res, { product }, 'Stock added');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/products/:id/adjust-stock',
  requireGymPermission('gym.pos.inventory.manage'),
  validate(posInventoryAdjustSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const product = await adjustProductStock(
        req.user!.gymId,
        Number(req.params.id),
        req.user!.id,
        req.body.stockQuantity,
        req.body.note
      );
      sendSuccess(res, { product }, 'Stock adjusted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/products/:id/stock-history',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posStockHistoryQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { movements, total } = await listStockMovements(
        req.user!.gymId,
        Number(req.params.id),
        Number(req.query.page ?? 1),
        Number(req.query.limit ?? 20)
      );
      sendSuccess(res, {
        movements,
        pagination: buildPagination(
          Number(req.query.page ?? 1),
          Number(req.query.limit ?? 20),
          total
        ),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/sales',
  requireGymPermission('gym.pos.sell'),
  validate(posSaleCreateSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const canManageDiscounts = hasGymPermission(req, 'gym.pos.discounts.manage');
      const sale = await createSale(
        req.user!.gymId,
        req.user!.id,
        canManageDiscounts,
        req.body
      );
      sendSuccess(res, { sale }, 'Sale completed', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/sales',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posSalesListQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const query = req.query as {
        status?: 'COMPLETED' | 'VOIDED';
        from?: string;
        to?: string;
        page?: string;
        limit?: string;
      };
      const { sales, total } = await listSales(req.user!.gymId, {
        status: query.status,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        page: Number(query.page ?? 1),
        limit: Number(query.limit ?? 20),
      });
      sendSuccess(res, {
        sales,
        pagination: buildPagination(
          Number(query.page ?? 1),
          Number(query.limit ?? 20),
          total
        ),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/sales/:id',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posSaleIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const sale = await getSale(req.user!.gymId, Number(req.params.id));
      sendSuccess(res, { sale });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/sales/:id/void',
  requireGymPermission('gym.pos.sell'),
  validate(posSaleVoidSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const sale = await voidSale(
        req.user!.gymId,
        Number(req.params.id),
        req.user!.id,
        req.body.reason
      );
      sendSuccess(res, { sale }, 'Sale voided');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/reports/summary',
  requireGymPermission('gym.pos.revenue.read'),
  validate(posGymReportQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const query = req.query as {
        from?: string;
        to?: string;
        groupBy?: 'day' | 'category' | 'subcategory' | 'product';
      };
      const data = await getGymPosSummary(
        req.user!.gymId,
        query.from ? new Date(query.from) : undefined,
        query.to ? new Date(query.to) : undefined,
        query.groupBy ?? 'day'
      );
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
