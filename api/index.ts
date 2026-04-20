// Import Prisma first so DATABASE_URL / client init runs before the app.
import '../src/lib/prisma';

import app from '../src/server';

export default app;
