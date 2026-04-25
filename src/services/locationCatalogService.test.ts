import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocationCatalogService,
  type CityDto,
  type CountryDto,
  type LocationCatalogRepo,
} from './locationCatalogService';

function createRepo(): LocationCatalogRepo {
  const now = new Date();
  const countries: CountryDto[] = [
    { id: 1, name: 'Pakistan', code: 'PK', isActive: true, sortOrder: 1, createdAt: now, updatedAt: now },
    { id: 2, name: 'UAE', code: 'AE', isActive: false, sortOrder: 2, createdAt: now, updatedAt: now },
  ];
  const cities: CityDto[] = [
    { id: 1, countryId: 1, name: 'Karachi', isActive: true, sortOrder: 1, createdAt: now, updatedAt: now },
    { id: 2, countryId: 1, name: 'Lahore', isActive: true, sortOrder: 2, createdAt: now, updatedAt: now },
    { id: 3, countryId: 2, name: 'Dubai', isActive: true, sortOrder: 1, createdAt: now, updatedAt: now },
    { id: 4, countryId: 1, name: 'Quetta', isActive: false, sortOrder: 3, createdAt: now, updatedAt: now },
  ];

  return {
    async listActiveCountries() {
      return countries.filter((c) => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async listActiveCitiesByCountryId(countryId) {
      return cities
        .filter((c) => c.countryId === countryId && c.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async listActiveCountriesWithCities() {
      const activeCountries = countries.filter((c) => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
      return activeCountries.map((country) => ({
        country,
        cities: cities
          .filter((c) => c.countryId === country.id && c.isActive)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      }));
    },
    async findActiveCountryByName(name) {
      return countries.find((c) => c.isActive && c.name === name) ?? null;
    },
    async findActiveCityByName(name) {
      const city = cities.find((c) => c.isActive && c.name === name);
      if (!city) return null;
      const country = countries.find((c) => c.id === city.countryId)!;
      return { ...city, country };
    },
    async createCountry(data) {
      const row = {
        id: countries.length + 1,
        name: data.name,
        code: data.code ?? null,
        isActive: data.isActive ?? true,
        sortOrder: data.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      countries.push(row);
      return row;
    },
    async updateCountry(id, data) {
      const idx = countries.findIndex((c) => c.id === id);
      countries[idx] = { ...countries[idx], ...data, updatedAt: now };
      return countries[idx];
    },
    async createCity(data) {
      const row = {
        id: cities.length + 1,
        countryId: data.countryId,
        name: data.name,
        isActive: data.isActive ?? true,
        sortOrder: data.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      cities.push(row);
      return row;
    },
    async updateCity(id, data) {
      const idx = cities.findIndex((c) => c.id === id);
      cities[idx] = { ...cities[idx], ...data, updatedAt: now };
      return cities[idx];
    },
    async getCountryById(id) {
      return countries.find((c) => c.id === id) ?? null;
    },
    async getCityById(id) {
      return cities.find((c) => c.id === id) ?? null;
    },
  };
}

test('lists active countries and cities for catalog', async () => {
  const service = buildLocationCatalogService(createRepo());
  const countries = await service.listActiveCountries();
  const cities = await service.listActiveCitiesByCountryId(1);
  const catalog = await service.getCatalog();

  assert.equal(countries.length, 1);
  assert.equal(countries[0].name, 'Pakistan');
  assert.deepEqual(cities.map((c) => c.name), ['Karachi', 'Lahore']);
  assert.equal(catalog[0].country.name, 'Pakistan');
  assert.deepEqual(catalog[0].cities.map((c) => c.name), ['Karachi', 'Lahore']);
});

test('validates gym location and rejects mismatch/inactive entries', async () => {
  const service = buildLocationCatalogService(createRepo());
  const ok = await service.validateActiveGymLocation({ country: 'Pakistan', city: 'Karachi' });
  assert.deepEqual(ok, { country: 'Pakistan', city: 'Karachi' });

  await assert.rejects(
    () => service.validateActiveGymLocation({ country: 'Pakistan', city: 'Dubai' }),
    (err: any) => err?.details?.code === 'city_country_mismatch'
  );

  await assert.rejects(
    () => service.validateActiveGymLocation({ country: 'UAE', city: 'Dubai' }),
    (err: any) => err?.details?.code === 'invalid_country'
  );

  await assert.rejects(
    () => service.validateActiveGymLocation({ country: 'Pakistan', city: 'Quetta' }),
    (err: any) => err?.details?.code === 'invalid_city'
  );
});
