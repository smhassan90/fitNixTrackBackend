// Quick script to generate bcrypt hash for password
// Usage: node generate_password_hash.js [password]
// Example: node generate_password_hash.js password123

const bcrypt = require('bcrypt');

const password = process.argv[2] || 'password123';

bcrypt.hash(password, 10)
  .then(hash => {
    console.log('\n✅ Password Hash Generated:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(hash);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n📝 Copy this hash and use it in the SQL query');
    console.log('   Replace "YOUR_BCRYPT_HASHED_PASSWORD" with the hash above\n');
  })
  .catch(err => {
    console.error('Error generating hash:', err);
    process.exit(1);
  });

