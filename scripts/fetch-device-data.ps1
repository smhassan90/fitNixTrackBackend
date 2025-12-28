# PowerShell script to fetch data from ZKTeco device
# 
# Usage:
#   .\scripts\fetch-device-data.ps1 -DeviceIp "192.168.1.100" -Token "your-token"
#
# Parameters:
#   -DeviceIp      Device IP address (required)
#   -Token         Authentication token (required)
#                   Note: Gym ID is automatically extracted from the token
#   -Port          Device port (default: 4370)
#   -ApiUrl        API base URL (default: http://localhost:3001)
#   -StartDate     Start date for attendance sync (YYYY-MM-DD)
#   -EndDate       End date for attendance sync (YYYY-MM-DD)
#   -SkipUsers     Skip user sync step
#   -SkipTest      Skip connection test

param(
    [Parameter(Mandatory=$true)]
    [string]$DeviceIp,
    
    [Parameter(Mandatory=$true)]
    [string]$Token,
    
    [int]$Port = 4370,
    [string]$ApiUrl = "http://localhost:3001",
    [string]$StartDate = "",
    [string]$EndDate = "",
    [switch]$SkipUsers,
    [switch]$SkipTest
)

$ErrorActionPreference = "Stop"

# Headers for API requests
$headers = @{
    "Authorization" = "Bearer $Token"
    "Content-Type" = "application/json"
}

Write-Host "🚀 Starting ZKTeco Device Data Fetch" -ForegroundColor Cyan
Write-Host ""
Write-Host "Device IP: $DeviceIp"
Write-Host "Device Port: $Port"
Write-Host "API URL: $ApiUrl"
Write-Host ""

$deviceId = $null

try {
    # Step 1: Add or get device configuration
    Write-Host "📝 Step 1: Configuring device..." -ForegroundColor Yellow
    
    try {
        $body = @{
            name = "ZKTeco Device $DeviceIp"
            ipAddress = $DeviceIp
            port = $Port
        } | ConvertTo-Json
        
        $response = Invoke-RestMethod -Uri "$ApiUrl/api/device" `
            -Method POST `
            -Headers $headers `
            -Body $body
        
        $deviceId = $response.data.id
        Write-Host "✅ Device added with ID: $deviceId" -ForegroundColor Green
        Write-Host ""
    }
    catch {
        if ($_.Exception.Response.StatusCode -eq 400 -or $_.ErrorDetails.Message -like "*already exists*") {
            Write-Host "⚠️  Device already exists, finding existing device..." -ForegroundColor Yellow
            
            $devicesResponse = Invoke-RestMethod -Uri "$ApiUrl/api/device" `
                -Method GET `
                -Headers $headers
            
            $device = $devicesResponse.data | Where-Object { 
                $_.ipAddress -eq $DeviceIp -and $_.port -eq $Port 
            }
            
            if ($device) {
                $deviceId = $device.id
                Write-Host "✅ Found existing device with ID: $deviceId" -ForegroundColor Green
                Write-Host ""
            }
            else {
                throw "Device exists but could not be found"
            }
        }
        else {
            throw
        }
    }
    
    # Step 2: Test connection
    if (-not $SkipTest) {
        Write-Host "🔌 Step 2: Testing device connection..." -ForegroundColor Yellow
        
        try {
            $testResponse = Invoke-RestMethod -Uri "$ApiUrl/api/device/$deviceId/test" `
                -Method POST `
                -Headers $headers
            
            if ($testResponse.data.connected) {
                Write-Host "✅ Device connection successful!" -ForegroundColor Green
                Write-Host ""
            }
            else {
                Write-Host "❌ Device connection failed" -ForegroundColor Red
                Write-Host "   $($testResponse.data.message)" -ForegroundColor Red
                Write-Host ""
                exit 1
            }
        }
        catch {
            Write-Host "❌ Connection test failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host ""
            exit 1
        }
    }
    
    # Step 3: Sync users
    if (-not $SkipUsers) {
        Write-Host "👥 Step 3: Syncing users from device..." -ForegroundColor Yellow
        
        try {
            $usersResponse = Invoke-RestMethod -Uri "$ApiUrl/api/device/$deviceId/sync-users" `
                -Method POST `
                -Headers $headers
            
            Write-Host "✅ Found $($usersResponse.data.users.Count) users on device" -ForegroundColor Green
            Write-Host "✅ Mapped $($usersResponse.data.mapped) users to members" -ForegroundColor Green
            
            if ($usersResponse.data.unmappedCount -gt 0) {
                Write-Host "⚠️  $($usersResponse.data.unmappedCount) users remain unmapped" -ForegroundColor Yellow
            }
            Write-Host ""
        }
        catch {
            Write-Host "❌ User sync failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "⚠️  Continuing with attendance sync anyway..." -ForegroundColor Yellow
            Write-Host ""
        }
    }
    
    # Step 4: Sync attendance
    Write-Host "📊 Step 4: Fetching attendance data from device..." -ForegroundColor Yellow
    
    $attendanceUrl = "$ApiUrl/api/device/$deviceId/sync-attendance"
    $queryParams = @()
    
    if ($StartDate) {
        $queryParams += "startDate=$StartDate"
    }
    if ($EndDate) {
        $queryParams += "endDate=$EndDate"
    }
    
    if ($queryParams.Count -gt 0) {
        $attendanceUrl += "?" + ($queryParams -join "&")
    }
    
    try {
        $attendanceResponse = Invoke-RestMethod -Uri $attendanceUrl `
            -Method POST `
            -Headers $headers
        
        Write-Host "✅ Successfully synced $($attendanceResponse.data.synced) attendance records" -ForegroundColor Green
        
        if ($attendanceResponse.data.errors -gt 0) {
            Write-Host "⚠️  $($attendanceResponse.data.errors) errors encountered" -ForegroundColor Yellow
        }
        Write-Host ""
    }
    catch {
        Write-Host "❌ Attendance sync failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        exit 1
    }
    
    # Step 5: Summary
    Write-Host "✨ Data fetch completed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📋 View attendance data: GET $ApiUrl/api/attendance" -ForegroundColor Cyan
    Write-Host "   (Use same token - gymId is automatically extracted from token)" -ForegroundColor Cyan
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

