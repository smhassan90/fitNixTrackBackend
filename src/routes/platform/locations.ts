import { Router, Response } from 'express';
import { PlatformRole, Prisma } from '@prisma/client';
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

  return router;
}

const router = createPlatformLocationsRouter();

export default router;
