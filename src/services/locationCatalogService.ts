import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';

export type CountryDto = {
  id: number;
  name: string;
  code: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CityDto = {
  id: number;
  countryId: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

type CityWithCountryDto = CityDto & {
  country: CountryDto;
};

export type LocationsCatalogItem = {
  country: CountryDto;
  cities: CityDto[];
};

export interface LocationCatalogRepo {
  listActiveCountries(): Promise<CountryDto[]>;
  listActiveCitiesByCountryId(countryId: number): Promise<CityDto[]>;
  listActiveCountriesWithCities(): Promise<LocationsCatalogItem[]>;
  findActiveCountryByName(name: string): Promise<CountryDto | null>;
  findActiveCityByName(name: string): Promise<CityWithCountryDto | null>;
  createCountry(data: {
    name: string;
    code?: string | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<CountryDto>;
  updateCountry(
    id: number,
    data: Partial<{
      name: string;
      code: string | null;
      isActive: boolean;
      sortOrder: number;
    }>
  ): Promise<CountryDto>;
  createCity(data: {
    countryId: number;
    name: string;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<CityDto>;
  updateCity(
    id: number,
    data: Partial<{
      countryId: number;
      name: string;
      isActive: boolean;
      sortOrder: number;
    }>
  ): Promise<CityDto>;
  getCountryById(id: number): Promise<CountryDto | null>;
  getCityById(id: number): Promise<CityDto | null>;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function handleUniqueError(error: unknown, entity: 'country' | 'city'): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ValidationError(`${entity} already exists`, { code: `${entity}_already_exists` });
  }
  throw error;
}

export function buildLocationCatalogService(repo: LocationCatalogRepo) {
  return {
    async listActiveCountries(): Promise<CountryDto[]> {
      return repo.listActiveCountries();
    },

    async listActiveCitiesByCountryId(countryId: number): Promise<CityDto[]> {
      return repo.listActiveCitiesByCountryId(countryId);
    },

    async getCatalog(): Promise<LocationsCatalogItem[]> {
      return repo.listActiveCountriesWithCities();
    },

    async createCountry(input: {
      name: string;
      code?: string | null;
      isActive?: boolean;
      sortOrder?: number;
    }): Promise<CountryDto> {
      const name = normalizeName(input.name);
      const code = input.code === undefined || input.code === null ? null : normalizeCode(input.code);
      try {
        return await repo.createCountry({ ...input, name, code });
      } catch (error) {
        handleUniqueError(error, 'country');
      }
    },

    async updateCountry(
      id: number,
      input: Partial<{ name: string; code: string | null; isActive: boolean; sortOrder: number }>
    ): Promise<CountryDto> {
      const existing = await repo.getCountryById(id);
      if (!existing) throw new NotFoundError('Country', id);
      const payload: Partial<{ name: string; code: string | null; isActive: boolean; sortOrder: number }> =
        {
          ...input,
        };
      if (payload.name !== undefined) payload.name = normalizeName(payload.name);
      if (payload.code !== undefined && payload.code !== null) payload.code = normalizeCode(payload.code);
      try {
        return await repo.updateCountry(id, payload);
      } catch (error) {
        handleUniqueError(error, 'country');
      }
    },

    async createCity(input: {
      countryId: number;
      name: string;
      isActive?: boolean;
      sortOrder?: number;
    }): Promise<CityDto> {
      const country = await repo.getCountryById(input.countryId);
      if (!country) throw new NotFoundError('Country', input.countryId);
      const name = normalizeName(input.name);
      try {
        return await repo.createCity({ ...input, name });
      } catch (error) {
        handleUniqueError(error, 'city');
      }
    },

    async updateCity(
      id: number,
      input: Partial<{ countryId: number; name: string; isActive: boolean; sortOrder: number }>
    ): Promise<CityDto> {
      const existing = await repo.getCityById(id);
      if (!existing) throw new NotFoundError('City', id);
      if (input.countryId !== undefined) {
        const country = await repo.getCountryById(input.countryId);
        if (!country) throw new NotFoundError('Country', input.countryId);
      }
      const payload: Partial<{ countryId: number; name: string; isActive: boolean; sortOrder: number }> = {
        ...input,
      };
      if (payload.name !== undefined) payload.name = normalizeName(payload.name);
      try {
        return await repo.updateCity(id, payload);
      } catch (error) {
        handleUniqueError(error, 'city');
      }
    },

    async validateActiveGymLocation(input: { country: string; city: string }): Promise<{
      country: string;
      city: string;
    }> {
      const countryName = normalizeName(input.country);
      const cityName = normalizeName(input.city);

      const country = await repo.findActiveCountryByName(countryName);
      if (!country) {
        throw new ValidationError('Invalid country', { code: 'invalid_country', country: countryName });
      }

      const city = await repo.findActiveCityByName(cityName);
      if (!city) {
        throw new ValidationError('Invalid city', { code: 'invalid_city', city: cityName });
      }

      if (city.countryId !== country.id) {
        throw new ValidationError('City does not belong to selected country', {
          code: 'city_country_mismatch',
          city: cityName,
          country: countryName,
        });
      }

      return { country: country.name, city: city.name };
    },
  };
}

const prismaLocationCatalogRepo: LocationCatalogRepo = {
  listActiveCountries: () =>
    prisma.country.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  listActiveCitiesByCountryId: (countryId) =>
    prisma.city.findMany({
      where: { countryId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  listActiveCountriesWithCities: () =>
    prisma.country.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        cities: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
    }).then((countries) =>
      countries.map((country) => ({
        country: {
          id: country.id,
          name: country.name,
          code: country.code,
          isActive: country.isActive,
          sortOrder: country.sortOrder,
          createdAt: country.createdAt,
          updatedAt: country.updatedAt,
        },
        cities: country.cities,
      }))
    ),
  findActiveCountryByName: (name) =>
    prisma.country.findFirst({
      where: { name, isActive: true },
    }),
  findActiveCityByName: (name) =>
    prisma.city.findFirst({
      where: { name, isActive: true },
      include: { country: true },
    }),
  createCountry: (data) =>
    prisma.country.create({
      data: {
        name: data.name,
        code: data.code ?? null,
        isActive: data.isActive ?? true,
        sortOrder: data.sortOrder ?? 0,
      },
    }),
  updateCountry: (id, data) =>
    prisma.country.update({
      where: { id },
      data,
    }),
  createCity: (data) =>
    prisma.city.create({
      data: {
        countryId: data.countryId,
        name: data.name,
        isActive: data.isActive ?? true,
        sortOrder: data.sortOrder ?? 0,
      },
    }),
  updateCity: (id, data) =>
    prisma.city.update({
      where: { id },
      data,
    }),
  getCountryById: (id) => prisma.country.findUnique({ where: { id } }),
  getCityById: (id) => prisma.city.findUnique({ where: { id } }),
};

export const locationCatalogService = buildLocationCatalogService(prismaLocationCatalogRepo);
