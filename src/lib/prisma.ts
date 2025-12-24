import { PrismaClient } from '@prisma/client';

/**
 * Construct DATABASE_URL from individual components if DATABASE_URL is not set
 * This handles passwords with special characters like @
 */
function getDatabaseUrl(): string {
  // If DATABASE_URL is already set, use it
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Otherwise, construct it from individual components
  const dbHost = process.env.DB_HOST;
  const dbPort = process.env.DB_PORT || '3306';
  const dbName = process.env.DB_NAME;
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;

  if (!dbHost || !dbName || !dbUser || !dbPassword) {
    throw new Error(
      'Database configuration error: Either DATABASE_URL must be set, or all of DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD must be set'
    );
  }

  // URL-encode the password to handle special characters like @, #, etc.
  const encodedPassword = encodeURIComponent(dbPassword);
  const encodedUser = encodeURIComponent(dbUser);

  // Construct MySQL connection string
  const databaseUrl = `mysql://${encodedUser}:${encodedPassword}@${dbHost}:${dbPort}/${dbName}`;

  // Set it in process.env so Prisma can use it
  process.env.DATABASE_URL = databaseUrl;

  return databaseUrl;
}

// Initialize DATABASE_URL before Prisma Client is created
getDatabaseUrl();

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

