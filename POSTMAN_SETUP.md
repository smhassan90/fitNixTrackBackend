# Postman Collection Setup Guide

This guide will help you import and use the Postman collection for testing the FitNix Track Backend API.

## Files Included

1. **FitNixTrackBackend.postman_collection.json** - Complete API collection with all endpoints
2. **FitNixTrackBackend.postman_environment.json** - Environment variables for easy configuration

## Import Steps

### Step 1: Import Collection

1. Open Postman
2. Click **Import** button (top left)
3. Select **File** tab
4. Click **Upload Files**
5. Select `FitNixTrackBackend.postman_collection.json`
6. Click **Import**

### Step 2: Import Environment

1. Click **Import** button again
2. Select **File** tab
3. Click **Upload Files**
4. Select `FitNixTrackBackend.postman_environment.json`
5. Click **Import**

### Step 3: Select Environment

1. In the top right corner of Postman, click the environment dropdown
2. Select **"FitNix Track Backend - Local"**
3. If you need to change the base URL, click the eye icon next to the environment name and edit `base_url`

## Usage Instructions

### 1. Login First

Before testing other endpoints, you need to authenticate:

1. Navigate to **Authentication** → **Login**
2. The default credentials are:
   - Email: `admin@fitnix.com`
   - Password: `password123`
3. Click **Send**
4. The response will contain a token that is automatically saved to the `auth_token` environment variable

### 2. Test Other Endpoints

Once logged in, you can test any endpoint. The token is automatically included in the Authorization header for all authenticated requests.

### 3. Update IDs

For endpoints that require IDs (like `GET /api/members/:id`), you'll need to:

1. First, call the list endpoint (e.g., `GET /api/members`)
2. Copy an ID from the response
3. Update the `:id` variable in the request URL

Alternatively, you can manually edit the ID in the URL path variable.

## Collection Structure

The collection is organized into folders:

- **Authentication** - Login, Get Current User, Logout
- **Members** - CRUD operations for members
- **Trainers** - CRUD operations for trainers
- **Packages** - CRUD operations for packages
- **Payments** - Payment management including mark as paid, receipt, overdue
- **Attendance** - Read-only attendance records
- **Dashboard** - Dashboard statistics
- **Reports** - Attendance reports

## Environment Variables

The collection uses the following environment variables:

- `base_url` - API base URL (default: `http://localhost:3001`)
- `auth_token` - JWT token (automatically set after login)
- `gym_id` - Gym ID (automatically set after login)

## Sample Request Bodies

All POST and PUT requests include sample request bodies. You can modify them as needed:

### Create Member Example
```json
{
    "name": "John Doe",
    "phone": "+92-300-1234567",
    "email": "john@example.com",
    "gender": "Male",
    "dateOfBirth": "1990-01-15",
    "cnic": "1234567890123",
    "comments": "New member",
    "packageId": null,
    "discount": null,
    "trainerIds": []
}
```

### Create Package Example
```json
{
    "name": "Premium Package",
    "price": 15000,
    "duration": "3 months",
    "features": [
        "Gym Access",
        "Locker",
        "Shower",
        "Personal Trainer",
        "Nutrition Plan",
        "Group Classes"
    ]
}
```

## Testing Workflow

1. **Login** → Get authentication token
2. **Get All Packages** → Get package IDs
3. **Get All Trainers** → Get trainer IDs
4. **Create Member** → Use package ID and trainer IDs from steps 2-3
5. **Get All Members** → Verify member was created
6. **Get Dashboard Stats** → View statistics
7. **Get Payments** → View auto-generated payments for the member
8. **Mark Payment as Paid** → Test payment workflow
9. **Get Reports** → View attendance reports

## Troubleshooting

### 401 Unauthorized
- Make sure you've logged in first
- Check that the `auth_token` environment variable is set
- Verify the token hasn't expired (default: 7 days)

### 404 Not Found
- Check that the server is running on the correct port
- Verify the `base_url` environment variable is correct
- Ensure the endpoint path is correct

### 400 Bad Request
- Check the request body format (must be valid JSON)
- Verify required fields are included
- Check validation rules (e.g., CNIC must be 13 digits, dates in YYYY-MM-DD format)

### Connection Error
- Ensure the backend server is running
- Check that the port matches your environment variable
- Verify CORS is configured correctly

## Notes

- The login endpoint automatically saves the token to the environment variable
- All authenticated endpoints use the `Bearer` token in the Authorization header
- Date formats must be `YYYY-MM-DD` (e.g., `2024-03-15`)
- Month formats must be `YYYY-MM` (e.g., `2024-03`)
- Time formats must be `HH:mm` (e.g., `09:00`)

