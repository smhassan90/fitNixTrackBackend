import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BadRequestError, NotFoundError, ValidationError } from '../../utils/errors';
import {
  compressProductImage,
  deleteStoredProductImage,
  storeProductImage,
  type CompressedProductImage,
} from './posProductImageService';

export const PRODUCT_GALLERY_MAX_IMAGES = 5;

export type ProductImageDto = {
  id: number;
  url: string;
  isFeatured: boolean;
  sortOrder: number;
};

export const productImagesInclude = {
  images: {
    orderBy: [{ isFeatured: 'desc' as const }, { sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
};

export const productDetailInclude = {
  subcategory: { include: { category: true } },
  ...productImagesInclude,
} satisfies Prisma.PosProductInclude;

export function serializeProductImages(
  images: Array<{ id: number; url: string; isFeatured: boolean; sortOrder: number }> | undefined | null
): ProductImageDto[] {
  if (!images?.length) return [];
  return images
    .slice()
    .sort((a, b) => {
      if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.id - b.id;
    })
    .map((img) => ({
      id: img.id,
      url: img.url,
      isFeatured: img.isFeatured,
      sortOrder: img.sortOrder,
    }));
}

export function featuredImageUrl(
  images: Array<{ url: string; isFeatured: boolean }> | undefined | null,
  fallback: string | null
): string | null {
  const featured = images?.find((i) => i.isFeatured);
  return featured?.url ?? fallback ?? null;
}

async function assertProductOwned(gymId: number, productId: number) {
  const product = await prisma.posProduct.findFirst({
    where: { id: productId, gymId, deletedAt: null },
    select: { id: true, imageUrl: true },
  });
  if (!product) throw new NotFoundError('Product', productId);
  return product;
}

async function syncProductFeaturedUrl(
  tx: Prisma.TransactionClient,
  productId: number
): Promise<string | null> {
  const featured = await tx.posProductImage.findFirst({
    where: { productId, isFeatured: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const url = featured?.url ?? null;
  await tx.posProduct.update({
    where: { id: productId },
    data: { imageUrl: url },
  });
  return url;
}

async function ensureSingleFeatured(
  tx: Prisma.TransactionClient,
  productId: number,
  featuredImageId: number
): Promise<void> {
  await tx.posProductImage.updateMany({
    where: { productId, isFeatured: true, id: { not: featuredImageId } },
    data: { isFeatured: false },
  });
  await tx.posProductImage.update({
    where: { id: featuredImageId },
    data: { isFeatured: true },
  });
  await syncProductFeaturedUrl(tx, productId);
}

async function promoteFirstAsFeatured(
  tx: Prisma.TransactionClient,
  productId: number
): Promise<void> {
  const first = await tx.posProductImage.findFirst({
    where: { productId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  if (!first) {
    await tx.posProduct.update({
      where: { id: productId },
      data: { imageUrl: null },
    });
    return;
  }
  await ensureSingleFeatured(tx, productId, first.id);
}

export async function listProductImages(gymId: number, productId: number): Promise<ProductImageDto[]> {
  await assertProductOwned(gymId, productId);
  const images = await prisma.posProductImage.findMany({
    where: { productId, gymId },
    orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });
  return serializeProductImages(images);
}

/**
 * Add one or more uploaded images to the product gallery (max 5 total).
 * First image becomes featured when the gallery was empty, or when `setFeatured` is true
 * (applies to the first file in the batch).
 */
export async function addProductImages(
  gymId: number,
  productId: number,
  files: Express.Multer.File[],
  options?: { setFeatured?: boolean }
): Promise<{ images: ProductImageDto[]; imageUrl: string | null; added: number }> {
  if (!files.length) {
    throw new ValidationError('Missing image file field (images, image, photo, or file)');
  }

  await assertProductOwned(gymId, productId);

  const existingCount = await prisma.posProductImage.count({ where: { productId } });
  const remaining = PRODUCT_GALLERY_MAX_IMAGES - existingCount;
  if (remaining <= 0) {
    throw new BadRequestError(`Product already has the maximum of ${PRODUCT_GALLERY_MAX_IMAGES} images`);
  }
  if (files.length > remaining) {
    throw new BadRequestError(
      `Only ${remaining} more image(s) allowed (max ${PRODUCT_GALLERY_MAX_IMAGES} per product)`
    );
  }

  const compressedList: CompressedProductImage[] = [];
  for (const file of files) {
    compressedList.push(await compressProductImage(file.buffer));
  }

  const storedUrls: string[] = [];
  try {
    for (const compressed of compressedList) {
      storedUrls.push(await storeProductImage(compressed, gymId));
    }
  } catch (err) {
    await Promise.all(storedUrls.map((url) => deleteStoredProductImage(url)));
    throw err;
  }

  const makeFirstFeatured = existingCount === 0 || options?.setFeatured === true;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const maxSort = await tx.posProductImage.aggregate({
        where: { productId },
        _max: { sortOrder: true },
      });
      let nextSort = (maxSort._max.sortOrder ?? -1) + 1;

      if (makeFirstFeatured) {
        await tx.posProductImage.updateMany({
          where: { productId, isFeatured: true },
          data: { isFeatured: false },
        });
      }

      const createdIds: number[] = [];
      for (let i = 0; i < storedUrls.length; i++) {
        const row = await tx.posProductImage.create({
          data: {
            gymId,
            productId,
            url: storedUrls[i],
            isFeatured: makeFirstFeatured && i === 0,
            sortOrder: nextSort++,
          },
        });
        createdIds.push(row.id);
      }

      if (makeFirstFeatured && createdIds[0]) {
        await ensureSingleFeatured(tx, productId, createdIds[0]);
      } else {
        const hasFeatured = await tx.posProductImage.findFirst({
          where: { productId, isFeatured: true },
        });
        if (!hasFeatured) {
          await promoteFirstAsFeatured(tx, productId);
        } else {
          await syncProductFeaturedUrl(tx, productId);
        }
      }

      const images = await tx.posProductImage.findMany({
        where: { productId },
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      });
      const product = await tx.posProduct.findUnique({
        where: { id: productId },
        select: { imageUrl: true },
      });

      return {
        images: serializeProductImages(images),
        imageUrl: product?.imageUrl ?? null,
        added: createdIds.length,
      };
    });

    return result;
  } catch (err) {
    await Promise.all(storedUrls.map((url) => deleteStoredProductImage(url)));
    throw err;
  }
}

/**
 * Legacy single-image upload: replace featured image file, or create featured if none.
 * Other gallery images are preserved.
 */
export async function replaceFeaturedProductImage(
  gymId: number,
  productId: number,
  file: Express.Multer.File
): Promise<{ images: ProductImageDto[]; imageUrl: string }> {
  await assertProductOwned(gymId, productId);
  const compressed = await compressProductImage(file.buffer);
  const newUrl = await storeProductImage(compressed, gymId);

  try {
    return await prisma.$transaction(async (tx) => {
      const featured = await tx.posProductImage.findFirst({
        where: { productId, isFeatured: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });

      let previousUrl: string | null = null;

      if (featured) {
        previousUrl = featured.url;
        await tx.posProductImage.update({
          where: { id: featured.id },
          data: { url: newUrl },
        });
      } else {
        const count = await tx.posProductImage.count({ where: { productId } });
        if (count >= PRODUCT_GALLERY_MAX_IMAGES) {
          throw new BadRequestError(
            `Product already has the maximum of ${PRODUCT_GALLERY_MAX_IMAGES} images`
          );
        }
        const created = await tx.posProductImage.create({
          data: {
            gymId,
            productId,
            url: newUrl,
            isFeatured: true,
            sortOrder: 0,
          },
        });
        await ensureSingleFeatured(tx, productId, created.id);
      }

      await syncProductFeaturedUrl(tx, productId);

      const images = await tx.posProductImage.findMany({
        where: { productId },
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      });
      const product = await tx.posProduct.findUnique({
        where: { id: productId },
        select: { imageUrl: true },
      });

      // Delete previous file after DB commit path (still inside try; caller may await)
      if (previousUrl && previousUrl !== newUrl) {
        await deleteStoredProductImage(previousUrl);
      }

      return {
        images: serializeProductImages(images),
        imageUrl: product?.imageUrl ?? newUrl,
      };
    });
  } catch (err) {
    await deleteStoredProductImage(newUrl);
    throw err;
  }
}

export async function setProductImageFeatured(
  gymId: number,
  productId: number,
  imageId: number
): Promise<{ images: ProductImageDto[]; imageUrl: string | null }> {
  await assertProductOwned(gymId, productId);

  return prisma.$transaction(async (tx) => {
    const image = await tx.posProductImage.findFirst({
      where: { id: imageId, productId, gymId },
    });
    if (!image) throw new NotFoundError('Product image', imageId);

    await ensureSingleFeatured(tx, productId, imageId);

    const images = await tx.posProductImage.findMany({
      where: { productId },
      orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    const product = await tx.posProduct.findUnique({
      where: { id: productId },
      select: { imageUrl: true },
    });

    return {
      images: serializeProductImages(images),
      imageUrl: product?.imageUrl ?? null,
    };
  });
}

export async function reorderProductImages(
  gymId: number,
  productId: number,
  imageIds: number[]
): Promise<{ images: ProductImageDto[]; imageUrl: string | null }> {
  await assertProductOwned(gymId, productId);

  if (!imageIds.length) {
    throw new ValidationError('imageIds must not be empty');
  }
  if (new Set(imageIds).size !== imageIds.length) {
    throw new ValidationError('imageIds must be unique');
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.posProductImage.findMany({
      where: { productId, gymId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((e) => e.id));
    if (existingIds.size !== imageIds.length || imageIds.some((id) => !existingIds.has(id))) {
      throw new ValidationError('imageIds must include every existing product image exactly once');
    }

    for (let i = 0; i < imageIds.length; i++) {
      await tx.posProductImage.update({
        where: { id: imageIds[i] },
        data: { sortOrder: i },
      });
    }

    const images = await tx.posProductImage.findMany({
      where: { productId },
      orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    const product = await tx.posProduct.findUnique({
      where: { id: productId },
      select: { imageUrl: true },
    });

    return {
      images: serializeProductImages(images),
      imageUrl: product?.imageUrl ?? null,
    };
  });
}

export async function deleteProductImage(
  gymId: number,
  productId: number,
  imageId: number
): Promise<{ images: ProductImageDto[]; imageUrl: string | null }> {
  await assertProductOwned(gymId, productId);

  const image = await prisma.posProductImage.findFirst({
    where: { id: imageId, productId, gymId },
  });
  if (!image) throw new NotFoundError('Product image', imageId);

  await prisma.$transaction(async (tx) => {
    await tx.posProductImage.delete({ where: { id: imageId } });
    if (image.isFeatured) {
      await promoteFirstAsFeatured(tx, productId);
    } else {
      await syncProductFeaturedUrl(tx, productId);
    }
  });

  await deleteStoredProductImage(image.url);

  const images = await prisma.posProductImage.findMany({
    where: { productId },
    orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });
  const product = await prisma.posProduct.findUnique({
    where: { id: productId },
    select: { imageUrl: true },
  });

  return {
    images: serializeProductImages(images),
    imageUrl: product?.imageUrl ?? null,
  };
}

/**
 * Remove featured image only (legacy DELETE /image). Other gallery images remain;
 * next image becomes featured when present.
 */
export async function deleteFeaturedProductImage(
  gymId: number,
  productId: number
): Promise<{ images: ProductImageDto[]; imageUrl: string | null }> {
  await assertProductOwned(gymId, productId);

  const featured = await prisma.posProductImage.findFirst({
    where: { productId, gymId, isFeatured: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });

  if (!featured) {
    // Fallback: clear denormalized URL if orphaned
    const product = await prisma.posProduct.findFirst({
      where: { id: productId, gymId },
      select: { imageUrl: true },
    });
    if (product?.imageUrl) {
      await prisma.posProduct.update({
        where: { id: productId },
        data: { imageUrl: null },
      });
      await deleteStoredProductImage(product.imageUrl);
    }
    return { images: [], imageUrl: null };
  }

  return deleteProductImage(gymId, productId, featured.id);
}

/**
 * When create/update passes a raw imageUrl string, sync the featured gallery row.
 */
export async function syncFeaturedImageFromUrl(
  tx: Prisma.TransactionClient,
  gymId: number,
  productId: number,
  imageUrl: string | null
): Promise<void> {
  const featured = await tx.posProductImage.findFirst({
    where: { productId, isFeatured: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });

  if (!imageUrl) {
    if (featured) {
      await tx.posProductImage.delete({ where: { id: featured.id } });
      const first = await tx.posProductImage.findFirst({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      if (first) {
        await ensureSingleFeatured(tx, productId, first.id);
      } else {
        await tx.posProduct.update({
          where: { id: productId },
          data: { imageUrl: null },
        });
      }
    } else {
      await tx.posProduct.update({
        where: { id: productId },
        data: { imageUrl: null },
      });
    }
    return;
  }

  if (featured) {
    await tx.posProductImage.update({
      where: { id: featured.id },
      data: { url: imageUrl },
    });
    await tx.posProduct.update({
      where: { id: productId },
      data: { imageUrl },
    });
    return;
  }

  const count = await tx.posProductImage.count({ where: { productId } });
  if (count >= PRODUCT_GALLERY_MAX_IMAGES) {
    throw new BadRequestError(
      `Product already has the maximum of ${PRODUCT_GALLERY_MAX_IMAGES} images`
    );
  }

  const created = await tx.posProductImage.create({
    data: {
      gymId,
      productId,
      url: imageUrl,
      isFeatured: true,
      sortOrder: 0,
    },
  });
  await ensureSingleFeatured(tx, productId, created.id);
}
