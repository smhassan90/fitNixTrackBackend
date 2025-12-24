// Quick test script to verify DATABASE_URL
require('dotenv').config();

// Construct DATABASE_URL from individual components if not set
function getDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const dbHost = process.env.DB_HOST;
  const dbPort = process.env.DB_PORT || '3306';
  const dbName = process.env.DB_NAME;
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;

  if (!dbHost || !dbName || !dbUser || !dbPassword) {
    console.error('Error: Either DATABASE_URL must be set, or all of DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD must be set');
    process.exit(1);
  }

  const encodedPassword = encodeURIComponent(dbPassword);
  const encodedUser = encodeURIComponent(dbUser);
  return `mysql://${encodedUser}:${encodedPassword}@${dbHost}:${dbPort}/${dbName}`;
}

// Set DATABASE_URL
process.env.DATABASE_URL = getDatabaseUrl();

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testConnection() {
  try {
    console.log('Testing database connection...');
    console.log('Using:', process.env.DATABASE_URL ? 'DATABASE_URL or constructed from components' : 'NOT SET');
    
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful!');
    
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection failed:');
    console.error('Error:', error.message);
    console.error('Code:', error.code);
    
    await prisma.$disconnect();
    process.exit(1);
  }
}

testConnection();

