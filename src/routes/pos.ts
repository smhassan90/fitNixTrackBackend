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
import { resolveLocalProductImagePath } from '../services/pos/posProductImageService';
import {
  addProductImages,
  deleteFeaturedProductImage,
  deleteProductImage,
  listProductImages,
  PRODUCT_GALLERY_MAX_IMAGES,
  reorderProductImages,
  replaceFeaturedProductImage,
  setProductImageFeatured,
} from '../services/pos/posProductGalleryService';
import {
  createSale,
  getGymPosSummary,
  getSale,
  listSales,
  voidSale,
} from '../services/pos/posSaleService';
import {
  listPendingMobileOrdersForGym,
  completeMobileOrderFromPortal,
  cancelMobileOrderFromPortal,
} from '../services/mobileOrderService';
import {
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../utils/dateHelpers';
import {
  posCatalogQuerySchema,
  posGymReportQuerySchema,
  posGymSubcategoriesPutSchema,
  posInventoryAdjustSchema,
  posInventoryRestockSchema,
  posProductCreateSchema,
  posProductIdParamSchema,
  posProductImageFeatureSchema,
  posProductImageIdParamSchema,
  posProductImagesReorderSchema,
  posProductListQuerySchema,
  posProductPatchSchema,
  posSaleCreateSchema,
  posSaleIdParamSchema,
  posSalesListQuerySchema,
  posSaleVoidSchema,
  posStockHistoryQuerySchema,
} from '../validations/pos';
import {
  mobilePortalOrderListSchema,
  mobilePortalOrderCompleteSchema,
  mobilePortalOrderCancelSchema,
} from '../validations/mobile';
import {
  parseProductGalleryUpload,
  parseProductImageUpload,
} from '../middleware/productImageMultipart';
import { NotFoundError, UploadFailedError, ValidationError } from '../utils/errors';
import { prisma } from '../lib/prisma';

const router = Router();

/**
 * Public product featured image serve for <img src> (no JWT).
 * Redirects to blob URL or streams local file.
 */
router.get(
  '/products/:id/image',
  validate(posProductIdParamSchema),
  async (req, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const product = await prisma.posProduct.findFirst({
        where: { id: productId },
        select: { imageUrl: true },
      });

      if (!product?.imageUrl) {
        sendError(res, new NotFoundError('Product image', productId));
        return;
      }

      const imageUrl = product.imageUrl;

      if (/^https?:\/\//i.test(imageUrl)) {
        res.redirect(302, imageUrl);
        return;
      }

      const localPath = resolveLocalProductImagePath(imageUrl);
      if (!localPath) {
        sendError(res, new NotFoundError('Product image', productId));
        return;
      }

      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.type('image/jpeg');
      res.sendFile(localPath);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/**
 * Public serve for a specific gallery image by id (no JWT).
 */
router.get(
  '/products/:id/images/:imageId',
  validate(posProductImageIdParamSchema),
  async (req, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const imageId = Number(req.params.imageId);
      const image = await prisma.posProductImage.findFirst({
        where: { id: imageId, productId },
        select: { url: true },
      });

      if (!image?.url) {
        sendError(res, new NotFoundError('Product image', imageId));
        return;
      }

      if (/^https?:\/\//i.test(image.url)) {
        res.redirect(302, image.url);
        return;
      }

      const localPath = resolveLocalProductImagePath(image.url);
      if (!localPath) {
        sendError(res, new NotFoundError('Product image', imageId));
        return;
      }

      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.type('image/jpeg');
      res.sendFile(localPath);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

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
        form?: 'PACKAGED' | 'SERVING';
        subcategoryId?: string;
        isActive?: string;
        search?: string;
        page?: string;
        limit?: string;
      };
      const { products, total } = await listGymProducts(req.user!.gymId, {
        productType: query.productType,
        form: query.form,
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

/**
 * Upload / replace featured product image (legacy single-image API).
 * Other gallery images are preserved. POST multipart field: image | photo | file
 */
router.post(
  '/products/:id/image',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductIdParamSchema),
  parseProductImageUpload,
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.user!.gymId;
      const productId = Number(req.params.id);
      const file = (req as AuthRequest & { file?: Express.Multer.File }).file;

      if (!file?.buffer?.length) {
        sendError(res, new ValidationError('Missing image file field (image, photo, or file)'));
        return;
      }

      let result;
      try {
        result = await replaceFeaturedProductImage(gymId, productId, file);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        if (err instanceof ValidationError || err instanceof NotFoundError) {
          sendError(res, err);
          return;
        }
        if (/BLOB_READ_WRITE_TOKEN|Failed to store/i.test(message)) {
          sendError(res, new UploadFailedError(message));
          return;
        }
        sendError(res, err instanceof Error ? err : new ValidationError('Invalid image'));
        return;
      }

      sendSuccess(
        res,
        {
          product: {
            id: productId,
            imageUrl: result.imageUrl,
            images: result.images,
          },
          imageUrl: result.imageUrl,
          images: result.images,
        },
        'Product image uploaded'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/products/:id/image',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.user!.gymId;
      const productId = Number(req.params.id);
      const result = await deleteFeaturedProductImage(gymId, productId);
      sendSuccess(
        res,
        {
          product: {
            id: productId,
            imageUrl: result.imageUrl,
            images: result.images,
          },
        },
        'Product image removed'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/** List gallery images for a product. */
router.get(
  '/products/:id/images',
  requireGymPermission('gym.pos.catalog.read'),
  validate(posProductIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const images = await listProductImages(req.user!.gymId, Number(req.params.id));
      sendSuccess(res, {
        images,
        maxImages: PRODUCT_GALLERY_MAX_IMAGES,
        imageUrl: images.find((i) => i.isFeatured)?.url ?? null,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/**
 * Add one or more gallery images (max 5 total per product).
 * Multipart fields: images[] (preferred) | image | photo | file
 * Optional form field: isFeatured=true — make the first uploaded file the featured image
 */
router.post(
  '/products/:id/images',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductIdParamSchema),
  parseProductGalleryUpload,
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.user!.gymId;
      const productId = Number(req.params.id);
      const filesList =
        (req as AuthRequest & { filesList?: Express.Multer.File[] }).filesList ?? [];
      const setFeatured =
        (req as AuthRequest & { setFeatured?: boolean }).setFeatured === true;

      let result;
      try {
        result = await addProductImages(gymId, productId, filesList, { setFeatured });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        if (/BLOB_READ_WRITE_TOKEN|Failed to store/i.test(message)) {
          sendError(res, new UploadFailedError(message));
          return;
        }
        sendError(res, err instanceof Error ? err : new ValidationError('Invalid image'));
        return;
      }

      sendSuccess(
        res,
        {
          product: {
            id: productId,
            imageUrl: result.imageUrl,
            images: result.images,
          },
          images: result.images,
          imageUrl: result.imageUrl,
          added: result.added,
          maxImages: PRODUCT_GALLERY_MAX_IMAGES,
        },
        'Product images uploaded',
        201
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/** Reorder gallery images. Body: { imageIds: number[] } — must list every image exactly once. */
router.put(
  '/products/:id/images/reorder',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductImagesReorderSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const result = await reorderProductImages(
        req.user!.gymId,
        productId,
        req.body.imageIds
      );
      sendSuccess(res, {
        product: { id: productId, imageUrl: result.imageUrl, images: result.images },
        images: result.images,
        imageUrl: result.imageUrl,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/** Mark one gallery image as the featured / primary image. */
router.post(
  '/products/:id/images/:imageId/feature',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductImageFeatureSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const imageId = Number(req.params.imageId);
      const result = await setProductImageFeatured(req.user!.gymId, productId, imageId);
      sendSuccess(res, {
        product: { id: productId, imageUrl: result.imageUrl, images: result.images },
        images: result.images,
        imageUrl: result.imageUrl,
      }, 'Featured image updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/** Delete one gallery image. If it was featured, the next image becomes featured. */
router.delete(
  '/products/:id/images/:imageId',
  requireGymPermission('gym.pos.products.manage'),
  validate(posProductImageIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const imageId = Number(req.params.imageId);
      const result = await deleteProductImage(req.user!.gymId, productId, imageId);
      sendSuccess(res, {
        product: { id: productId, imageUrl: result.imageUrl, images: result.images },
        images: result.images,
        imageUrl: result.imageUrl,
      }, 'Product image removed');
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
      // data is the sale object itself (id, receiptNo, items, totals, ...)
      sendSuccess(res, sale, 'Sale completed', 201);
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
        from: query.from
          ? (/^\d{4}-\d{2}-\d{2}$/.test(query.from)
            ? startOfGymCalendarDayUtc(query.from)
            : new Date(query.from))
          : undefined,
        to: query.to
          ? (/^\d{4}-\d{2}-\d{2}$/.test(query.to)
            ? new Date(startOfNextGymCalendarDayUtc(query.to).getTime() - 1)
            : new Date(query.to))
          : undefined,
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
      sendSuccess(res, sale);
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
      sendSuccess(res, sale, 'Sale voided');
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
        query.from,
        query.to,
        query.groupBy ?? 'day'
      );
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// ─── Mobile app orders (placed from phone, paid at counter) ─────────────────

router.get(
  '/mobile-orders',
  requireGymPermission('gym.pos.sell'),
  validate(mobilePortalOrderListSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const query = req.query as { page?: string; limit?: string };
      const result = await listPendingMobileOrdersForGym(req.user!.gymId, {
        page: Number(query.page ?? 1),
        limit: Number(query.limit ?? 50),
      });
      sendSuccess(res, {
        orders: result.orders,
        pagination: buildPagination(result.page, result.limit, result.total),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/mobile-orders/:id/complete',
  requireGymPermission('gym.pos.sell'),
  validate(mobilePortalOrderCompleteSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const canManageDiscounts = hasGymPermission(req, 'gym.pos.discounts.manage');
      const result = await completeMobileOrderFromPortal(
        req.user!.gymId,
        Number(req.params.id),
        req.user!.id,
        canManageDiscounts
      );
      sendSuccess(res, result, 'Mobile order completed');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/mobile-orders/:id/cancel',
  requireGymPermission('gym.pos.sell'),
  validate(mobilePortalOrderCancelSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const order = await cancelMobileOrderFromPortal(
        req.user!.gymId,
        Number(req.params.id),
        req.body.reason
      );
      sendSuccess(res, { order }, 'Mobile order cancelled');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
