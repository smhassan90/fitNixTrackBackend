// Import Prisma first to ensure it's initialized
import '../src/lib/prisma';

// Import Express app
import app from '../src/server';

// Export Express app - Vercel's @vercel/node will handle it
export default app;

