#!/usr/bin/env node

/**
 * Helper script to fetch data from ZKTeco device
 * 
 * Usage:
 *   node scripts/fetch-device-data.js <device-ip> [options]
 * 
 * Options:
 *   --token <token>        Authentication token (or set DEVICE_TOKEN env var)
 *                          Note: Gym ID is automatically extracted from the token
 *   --port <port>          Device port (default: 4370)
 *   --api-url <url>        API base URL (default: http://localhost:3001)
 *   --start-date <date>    Start date for attendance sync (YYYY-MM-DD)
 *   --end-date <date>      End date for attendance sync (YYYY-MM-DD)
 *   --skip-users           Skip user sync step
 *   --skip-test            Skip connection test
 * 
 * Example:
 *   node scripts/fetch-device-data.js 192.168.1.100 --token "your-token"
 */

const https = require('https');
const http = require('http');

// Parse command line arguments
const args = process.argv.slice(2);
const deviceIp = args[0];

if (!deviceIp) {
  console.error('Error: Device IP address is required');
  console.error('\nUsage: node scripts/fetch-device-data.js <device-ip> [options]');
  console.error('\nOptions:');
  console.error('  --token <token>        Authentication token (gym ID is auto-extracted)');
  console.error('  --port <port>          Device port (default: 4370)');
  console.error('  --api-url <url>        API base URL (default: http://localhost:3001)');
  console.error('  --start-date <date>    Start date (YYYY-MM-DD)');
  console.error('  --end-date <date>      End date (YYYY-MM-DD)');
  console.error('  --skip-users           Skip user sync');
  console.error('  --skip-test            Skip connection test');
  process.exit(1);
}

// Parse options
const options = {
  token: process.env.DEVICE_TOKEN || getArg('--token'),
  port: parseInt(getArg('--port') || '4370'),
  apiUrl: getArg('--api-url') || 'http://localhost:3001',
  startDate: getArg('--start-date'),
  endDate: getArg('--end-date'),
  skipUsers: args.includes('--skip-users'),
  skipTest: args.includes('--skip-test'),
};

function getArg(name) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

// Validate required options
if (!options.token) {
  console.error('Error: Authentication token is required');
  console.error('  Use --token <token> or set DEVICE_TOKEN environment variable');
  console.error('  Note: Gym ID is automatically extracted from the token');
  process.exit(1);
}

// Helper function to make HTTP requests
function makeRequest(method, path, body = null, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.apiUrl + path);
    
    // Add query parameters
    Object.entries(queryParams).forEach(([key, value]) => {
      if (value) url.searchParams.append(key, value);
    });

    const requestOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      requestOptions.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }

    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request(url, requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${json.message || data}`));
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// Main execution
async function main() {
  console.log('🚀 Starting ZKTeco Device Data Fetch\n');
  console.log(`Device IP: ${deviceIp}`);
  console.log(`Device Port: ${options.port}`);
  console.log(`API URL: ${options.apiUrl}\n`);

  let deviceId = null;

  try {
    // Step 1: Add or get device configuration
    console.log('📝 Step 1: Configuring device...');
    try {
      // Try to create device
      const createResponse = await makeRequest('POST', '/api/device', {
        name: `ZKTeco Device ${deviceIp}`,
        ipAddress: deviceIp,
        port: options.port,
      });
      deviceId = createResponse.data.id;
      console.log(`✅ Device added with ID: ${deviceId}\n`);
    } catch (error) {
      // Device might already exist, try to find it
      if (error.message.includes('already exists')) {
        console.log('⚠️  Device already exists, finding existing device...');
        const devicesResponse = await makeRequest('GET', '/api/device');
        const device = devicesResponse.data.find(
          (d) => d.ipAddress === deviceIp && d.port === options.port
        );
        if (device) {
          deviceId = device.id;
          console.log(`✅ Found existing device with ID: ${deviceId}\n`);
        } else {
          throw new Error('Device exists but could not be found');
        }
      } else {
        throw error;
      }
    }

    // Step 2: Test connection
    if (!options.skipTest) {
      console.log('🔌 Step 2: Testing device connection...');
      try {
        const testResponse = await makeRequest('POST', `/api/device/${deviceId}/test`);
        if (testResponse.data.connected) {
          console.log('✅ Device connection successful!\n');
        } else {
          console.log('❌ Device connection failed');
          console.log(`   ${testResponse.data.message}\n`);
          process.exit(1);
        }
      } catch (error) {
        console.log(`❌ Connection test failed: ${error.message}\n`);
        process.exit(1);
      }
    }

    // Step 3: Sync users
    if (!options.skipUsers) {
      console.log('👥 Step 3: Syncing users from device...');
      try {
        const usersResponse = await makeRequest('POST', `/api/device/${deviceId}/sync-users`);
        console.log(`✅ Found ${usersResponse.data.users.length} users on device`);
        console.log(`✅ Mapped ${usersResponse.data.mapped} users to members`);
        if (usersResponse.data.unmappedCount > 0) {
          console.log(`⚠️  ${usersResponse.data.unmappedCount} users remain unmapped`);
        }
        console.log('');
      } catch (error) {
        console.log(`❌ User sync failed: ${error.message}\n`);
        console.log('⚠️  Continuing with attendance sync anyway...\n');
      }
    }

    // Step 4: Sync attendance
    console.log('📊 Step 4: Fetching attendance data from device...');
    const queryParams = {};
    if (options.startDate) queryParams.startDate = options.startDate;
    if (options.endDate) queryParams.endDate = options.endDate;

    try {
      const attendanceResponse = await makeRequest(
        'POST',
        `/api/device/${deviceId}/sync-attendance`,
        null,
        queryParams
      );
      console.log(`✅ Successfully synced ${attendanceResponse.data.synced} attendance records`);
      if (attendanceResponse.data.errors > 0) {
        console.log(`⚠️  ${attendanceResponse.data.errors} errors encountered`);
      }
      console.log('');
    } catch (error) {
      console.log(`❌ Attendance sync failed: ${error.message}\n`);
      process.exit(1);
    }

    // Step 5: Summary
    console.log('✨ Data fetch completed successfully!');
    console.log(`\n📋 View attendance data: GET ${options.apiUrl}/api/attendance`);
    console.log(`   (Use same token and gym-id headers)\n`);

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();

