import { Router, Response } from 'express';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import {
  platformLocationCityCreateSchema,
  platformLocationCityPatchSchema,
  platformLocationCountryCreateSchema,
  platformLocationCountryPatchSchema,
  platformLocationCountryCitiesParamsSchema,
} from '../../validations/platform';
import { sendError, sendSuccess } from '../../utils/response';
import { writePlatformAuditLog } from '../../services/platformAuditService';
import { locationCatalogService } from '../../services/locationCatalogService';
import { AppError, NotFoundError } from '../../utils/errors';

type PlatformAuditWriter = typeof writePlatformAuditLog;

type LocationCatalogService = typeof locationCatalogService;

export function createPlatformLocationsRouter(deps?: {
  service?: LocationCatalogService;
  auditWriter?: PlatformAuditWriter;
}) {
  const router = Router();
  const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;
  const service = deps?.service ?? locationCatalogService;
  const auditWriter = deps?.auditWriter ?? writePlatformAuditLog;

  router.get('/locations/countries', requirePlatformRole(...readRoles), async (_req, res: Response) => {
    try {
      const countries = await service.listActiveCountries();
      sendSuccess(res, countries);
    } catch (error) {
      sendError(res, error as Error);
    }
  });

  router.get(
    '/locations/countries/:countryId/cities',
    requirePlatformRole(...readRoles),
    validate(platformLocationCountryCitiesParamsSchema),
    async (req: PlatformRequest, res: Response) => {
      try {
        const { countryId } = req.params as unknown as { countryId: number };
        const cities = await service.listActiveCitiesByCountryId(countryId);
        sendSuccess(res, cities);
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  router.get('/locations/catalog', requirePlatformRole(...readRoles), async (_req, res: Response) => {
    try {
      const catalog = await service.getCatalog();
      sendSuccess(res, catalog);
    } catch (error) {
      sendError(res, error as Error);
    }
  });

  router.post(
    '/admin/locations/countries',
    requirePlatformRole(PlatformRole.SUPER_ADMIN),
    validate(platformLocationCountryCreateSchema),
    async (req: PlatformRequest, res: Response) => {
      try {
        const actor = req.platformUser!;
        const payload = req.body as {
          name: string;
          code?: string | null;
          isActive?: boolean;
          sortOrder?: number;
        };
        const country = await service.createCountry(payload);
        await auditWriter({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'LOCATION_COUNTRY_CREATE',
          metadata: country as unknown as Prisma.InputJsonValue,
        });
        sendSuccess(res, country, 'Country created', 201);
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  router.patch(
    '/admin/locations/countries/:id',
    requirePlatformRole(PlatformRole.SUPER_ADMIN),
    validate(platformLocationCountryPatchSchema),
    async (req: PlatformRequest, res: Response) => {
      try {
        const actor = req.platformUser!;
        const { id } = req.params as unknown as { id: number };
        const payload = req.body as Partial<{
          name: string;
          code: string | null;
          isActive: boolean;
          sortOrder: number;
        }>;
        const country = await service.updateCountry(id, payload);
        await auditWriter({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'LOCATION_COUNTRY_UPDATE',
          metadata: { id, ...payload } as Prisma.InputJsonValue,
        });
        sendSuccess(res, country, 'Country updated');
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  router.delete(
    '/admin/locations/countries/:id',
    requirePlatformRole(PlatformRole.SUPER_ADMIN),
    validate(platformLocationCountryPatchSchema.pick({ params: true })),
    async (req: PlatformRequest, res: Response) => {
      try {
        const actor = req.platformUser!;
        const { id } = req.params as unknown as { id: number };
        const country = await prisma.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
          SELECT id, name FROM countries WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
        `);
        if (country.length === 0) throw new NotFoundError('Country', id);

        const gymsUsingCountry = await prisma.gym.count({
          where: { country: country[0].name },
        });
        if (gymsUsingCountry > 0) {
          throw new AppError('COUNTRY_IN_USE', 'Country is referenced by gyms', 409);
        }

        await prisma.$executeRaw(Prisma.sql`
          UPDATE cities
          SET isActive = FALSE, deletedAt = NOW(3), updatedAt = NOW(3)
          WHERE countryId = ${id} AND deletedAt IS NULL
        `);
        await prisma.$executeRaw(Prisma.sql`
          UPDATE countries
          SET isActive = FALSE, deletedAt = NOW(3), updatedAt = NOW(3)
          WHERE id = ${id}
        `);

        await auditWriter({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'LOCATION_COUNTRY_DELETE',
          metadata: { id, name: country[0].name } as Prisma.InputJsonValue,
        });
        sendSuccess(res, { id, deleted: true }, 'Country deleted');
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  router.post(
    '/admin/locations/cities',
    requirePlatformRole(PlatformRole.SUPER_ADMIN),
    validate(platformLocationCityCreateSchema),
    async (req: PlatformRequest, res: Response) => {
      try {
        const actor = req.platformUser!;
        const payload = req.body as {
          countryId: number;
          name: string;
          isActive?: boolean;
          sortOrder?: number;
        };
        const city = await service.createCity(payload);
        await auditWriter({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'LOCATION_CITY_CREATE',
          metadata: city as unknown as Prisma.InputJsonValue,
        });
        sendSuccess(res, city, 'City created', 201);
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  router.patch(
    '/admin/locations/cities/:id',
    requirePlatformRole(PlatformRole.SUPER_ADMIN),
    validate(platformLocationCityPatchSchema),
    async (req: PlatformRequest, res: Response) => {
      try {
        const actor = req.platformUser!;
        const { id } = req.params as unknown as { id: number };
        const payload = req.body as Partial<{
          countryId: number;
          name: string;
          isActive: boolean;
          sortOrder: number;
        }>;
        const city = await service.updateCity(id, payload);
        await auditWriter({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'LOCATION_CITY_UPDATE',
          metadata: { id, ...payload } as Prisma.InputJsonValue,
        });
        sendSuccess(res, city, 'City updated');
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  router.delete(
    '/admin/locations/cities/:id',
    requirePlatformRole(PlatformRole.SUPER_ADMIN),
    validate(platformLocationCityPatchSchema.pick({ params: true })),
    async (req: PlatformRequest, res: Response) => {
      try {
        const actor = req.platformUser!;
        const { id } = req.params as unknown as { id: number };
        const cityRows = await prisma.$queryRaw<Array<{ id: number; name: string; countryId: number }>>(Prisma.sql`
          SELECT id, name, countryId FROM cities WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
        `);
        if (cityRows.length === 0) throw new NotFoundError('City', id);
        const city = cityRows[0];
        const countryRows = await prisma.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
          SELECT id, name FROM countries WHERE id = ${city.countryId} LIMIT 1
        `);
        const countryName = countryRows[0]?.name ?? null;

        const gymsUsingCity = await prisma.gym.count({
          where: {
            city: city.name,
            ...(countryName ? { country: countryName } : {}),
          },
        });
        if (gymsUsingCity > 0) {
          throw new AppError('CITY_IN_USE', 'City is referenced by gyms', 409);
        }

        await prisma.$executeRaw(Prisma.sql`
          UPDATE cities
          SET isActive = FALSE, deletedAt = NOW(3), updatedAt = NOW(3)
          WHERE id = ${id}
        `);

        await auditWriter({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'LOCATION_CITY_DELETE',
          metadata: { id, name: city.name, countryId: city.countryId } as Prisma.InputJsonValue,
        });
        sendSuccess(res, { id, deleted: true }, 'City deleted');
      } catch (error) {
        sendError(res, error as Error);
      }
    }
  );

  return router;
}

const router = createPlatformLocationsRouter();

export default router;
