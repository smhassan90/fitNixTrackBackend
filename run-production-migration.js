require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

// Use production DATABASE_URL from environment or command line
const DATABASE_URL = process.env.DATABASE_URL || process.argv[2];

if (!DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL not provided');
  console.log('\nUsage:');
  console.log('  Method 1: node run-production-migration.js "mysql://user:pass@host:port/db"');
  console.log('  Method 2: DATABASE_URL="mysql://..." node run-production-migration.js');
  console.log('\n⚠️  WARNING: This will modify your PRODUCTION database!');
  process.exit(1);
}

// Override DATABASE_URL
process.env.DATABASE_URL = DATABASE_URL;

const prisma = new PrismaClient();

async function runMigration() {
  try {
    console.log('🔄 Starting PRODUCTION database migration...\n');
    console.log('⚠️  WARNING: This will modify your PRODUCTION database!\n');
    console.log(`📡 Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}\n`);
    
    const sqlPath = path.join(__dirname, 'prisma/migrations/add_admission_fee_and_one_time_payments.sql');
    
    if (!fs.existsSync(sqlPath)) {
      console.error(`❌ Error: Migration file not found at ${sqlPath}`);
      process.exit(1);
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        const cleaned = s.replace(/--.*$/gm, '').trim();
        return cleaned.length > 0 && !cleaned.match(/^\s*$/);
      });
    
    console.log(`📝 Found ${statements.length} SQL statements to execute\n`);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.trim()) {
        try {
          const cleanStatement = statement.replace(/--.*$/gm, '').trim();
          
          if (cleanStatement) {
            console.log(`[${i + 1}/${statements.length}] Executing: ${cleanStatement.substring(0, 60)}...`);
            await prisma.$executeRawUnsafe(cleanStatement);
            console.log(`✅ Success\n`);
          }
        } catch (error) {
          if (error.message.includes('Duplicate') || 
              error.message.includes('already exists') ||
              error.message.includes('Duplicate column')) {
            console.log(`⚠️  Skipped (already exists): ${error.message.split('\n')[0]}\n`);
          } else {
            console.error(`❌ Error executing statement ${i + 1}:`);
            console.error(error.message);
            if (error.meta) {
              console.error('Details:', error.meta);
            }
            throw error;
          }
        }
      }
    }
    
    console.log('✅ Migration completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('   1. Regenerate Prisma Client: npx prisma generate');
    console.log('   2. Test the API endpoint: GET /api/settings');
    console.log('   3. Set admission fee: PUT /api/settings with {"admissionFee": 5000}');
  } catch (error) {
    console.error('\n❌ Migration failed:');
    console.error(error.message);
    if (error.meta) {
      console.error('Details:', error.meta);
    }
    console.error('\n💡 Troubleshooting:');
    console.error('   - Verify DATABASE_URL is correct');
    console.error('   - Check database user has ALTER and CREATE permissions');
    console.error('   - Ensure database is accessible from your IP');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runMigration();

