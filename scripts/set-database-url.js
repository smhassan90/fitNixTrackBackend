#!/usr/bin/env node
/**
 * Script to set DATABASE_URL from individual DB components
 * This is used for Prisma CLI commands (migrate, generate, etc.)
 * 
 * Usage:
 *   node scripts/set-database-url.js
 *   # Outputs: DATABASE_URL=mysql://...
 * 
 * Or set it directly:
 *   export DATABASE_URL=$(node scripts/set-database-url.js)
 */

require('dotenv').config();

function getDatabaseUrl() {
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
    console.error('Error: Either DATABASE_URL must be set, or all of DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD must be set');
    process.exit(1);
  }

  // URL-encode the password and user to handle special characters like @, #, etc.
  const encodedPassword = encodeURIComponent(dbPassword);
  const encodedUser = encodeURIComponent(dbUser);

  // Construct MySQL connection string
  const databaseUrl = `mysql://${encodedUser}:${encodedPassword}@${dbHost}:${dbPort}/${dbName}`;

  return databaseUrl;
}

// Output the DATABASE_URL
console.log(getDatabaseUrl());

