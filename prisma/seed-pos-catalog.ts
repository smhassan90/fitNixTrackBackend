/**
 * Seed default POS catalog (idempotent).
 * Run via: npx tsx prisma/seed-pos-catalog.ts
 */
import { prisma } from '../src/lib/prisma';

type SubSeed = {
  name: string;
  code: string;
  allowedForms?: ('PACKAGED' | 'SERVING')[];
};

type CategorySeed = {
  name: string;
  code: string;
  subcategories: SubSeed[];
};

const NUTRIENT_CATALOG: CategorySeed[] = [
  {
    name: 'Protein Supplements',
    code: 'PROTEIN_SUPPLEMENTS',
    subcategories: [
      { name: 'Whey Protein', code: 'WHEY_PROTEIN', allowedForms: ['PACKAGED', 'SERVING'] },
      { name: 'Mass Gainer', code: 'MASS_GAINER', allowedForms: ['PACKAGED'] },
    ],
  },
  {
    name: 'Fresh / Made-to-order',
    code: 'FRESH_MADE',
    subcategories: [
      { name: 'Shakes', code: 'SHAKES', allowedForms: ['SERVING'] },
      { name: 'Juices', code: 'JUICES', allowedForms: ['SERVING'] },
    ],
  },
  {
    name: 'Dairy',
    code: 'DAIRY',
    subcategories: [
      { name: 'Milk & Yogurt', code: 'MILK_YOGURT', allowedForms: ['PACKAGED', 'SERVING'] },
    ],
  },
];

const ACCESSORY_CATALOG: CategorySeed[] = [
  {
    name: 'Hand Gear',
    code: 'HAND_GEAR',
    subcategories: [
      { name: 'Gloves', code: 'GLOVES' },
      { name: 'Wraps', code: 'WRAPS' },
    ],
  },
  {
    name: 'Apparel',
    code: 'APPAREL',
    subcategories: [
      { name: 'T-Shirts', code: 'TSHIRTS' },
      { name: 'Shorts', code: 'SHORTS' },
    ],
  },
  {
    name: 'Equipment',
    code: 'EQUIPMENT',
    subcategories: [
      { name: 'Straps & Belts', code: 'STRAPS_BELTS' },
    ],
  },
];

async function upsertCategory(
  productType: 'NUTRIENT' | 'ACCESSORY',
  seed: CategorySeed,
  sortOrder: number
) {
  let category = await prisma.posCategory.findFirst({
    where: { productType, name: seed.name, deletedAt: null },
  });
  if (!category) {
    category = await prisma.posCategory.create({
      data: {
        productType,
        name: seed.name,
        code: seed.code,
        sortOrder,
      },
    });
    console.log(`Created category: ${productType} / ${seed.name}`);
  }

  for (const [index, sub] of seed.subcategories.entries()) {
    const existing = await prisma.posSubcategory.findFirst({
      where: { categoryId: category.id, name: sub.name, deletedAt: null },
    });
    if (existing) continue;

    const allowedForms =
      productType === 'ACCESSORY'
        ? ['PACKAGED']
        : sub.allowedForms ?? ['PACKAGED', 'SERVING'];

    await prisma.posSubcategory.create({
      data: {
        categoryId: category.id,
        name: sub.name,
        code: sub.code,
        allowedForms,
        sortOrder: index,
      },
    });
    console.log(`  Created subcategory: ${sub.name}`);
  }
}

async function main() {
  for (const [index, seed] of NUTRIENT_CATALOG.entries()) {
    await upsertCategory('NUTRIENT', seed, index);
  }
  for (const [index, seed] of ACCESSORY_CATALOG.entries()) {
    await upsertCategory('ACCESSORY', seed, index);
  }
  console.log('POS catalog seed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
