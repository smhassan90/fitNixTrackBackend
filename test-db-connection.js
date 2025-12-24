// Quick test script to verify DATABASE_URL
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function testConnection() {
  try {
    console.log('Testing database connection...');
    console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set (hidden)' : 'NOT SET');
    
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful!');
    
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection failed:');
    console.error('Error:', error.message);
    console.error('Code:', error.code);
    
    if (!process.env.DATABASE_URL) {
      console.error('\n⚠️  DATABASE_URL environment variable is not set!');
    }
    
    await prisma.$disconnect();
    process.exit(1);
  }
}

testConnection();

