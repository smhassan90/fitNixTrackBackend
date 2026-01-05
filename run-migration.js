const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function runMigration() {
  try {
    console.log('🔄 Starting database migration...\n');
    
    const sqlPath = path.join(__dirname, 'prisma/migrations/add_admission_fee_and_one_time_payments.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Split by semicolon and clean up statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        // Filter out empty statements and comments
        const cleaned = s.replace(/--.*$/gm, '').trim();
        return cleaned.length > 0 && !cleaned.match(/^\s*$/);
      });
    
    console.log(`📝 Found ${statements.length} SQL statements to execute\n`);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.trim()) {
        try {
          // Remove comments from statement
          const cleanStatement = statement.replace(/--.*$/gm, '').trim();
          
          if (cleanStatement) {
            console.log(`[${i + 1}/${statements.length}] Executing: ${cleanStatement.substring(0, 60)}...`);
            await prisma.$executeRawUnsafe(cleanStatement);
            console.log(`✅ Success\n`);
          }
        } catch (error) {
          // Check if it's a "duplicate" error (column/table already exists)
          if (error.message.includes('Duplicate') || error.message.includes('already exists')) {
            console.log(`⚠️  Skipped (already exists): ${error.message.split('\n')[0]}\n`);
          } else {
            throw error;
          }
        }
      }
    }
    
    console.log('✅ Migration completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('   1. Run: npx prisma generate');
    console.log('   2. Restart your server');
  } catch (error) {
    console.error('\n❌ Migration failed:');
    console.error(error.message);
    if (error.meta) {
      console.error('Details:', error.meta);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runMigration();

