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
  // Note: Prisma handles connection pooling internally, but we can add connection timeout
  const connectionTimeout = process.env.DB_CONNECTION_TIMEOUT || '10'; // 10 seconds
  const databaseUrl = `mysql://${encodedUser}:${encodedPassword}@${dbHost}:${dbPort}/${dbName}?connect_timeout=${connectionTimeout}`;

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
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Helper function to retry database operations with exponential backoff
 */
export async function retryDatabaseOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error as Error;
      
      // Check if it's a connection error that might be retryable
      const isConnectionError = 
        error?.code === 'P1001' || // Can't reach database server
        error?.code === 'P1017' || // Server has closed the connection
        error?.message?.includes('Can\'t reach database server') ||
        error?.message?.includes('connection') ||
        error?.message?.includes('timeout');
      
      if (!isConnectionError || attempt === maxRetries - 1) {
        throw error;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = initialDelay * Math.pow(2, attempt);
      console.warn(`Database operation failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error?.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Database operation failed after retries');
}

