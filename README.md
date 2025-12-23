# FitNix Track Backend API

A multi-tenant gym management system backend built with Node.js, Express, TypeScript, and PostgreSQL.

## Features

- 🔐 JWT-based authentication
- 🏢 Multi-tenant architecture with gym-based data isolation
- 👥 Member management with package assignments
- 💪 Trainer management
- 📦 Package management
- 💳 Payment tracking with auto-generation
- 📊 Attendance tracking
- 📈 Dashboard with statistics
- 📋 Reports and analytics

## Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Validation**: Zod
- **Authentication**: JWT (jsonwebtoken)
- **Password Hashing**: bcrypt

## Prerequisites

- Node.js (v18 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd FitNixTrackBackend
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` and configure:
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: Secret key for JWT tokens
- `JWT_EXPIRES_IN`: Token expiration (default: 7d)
- `PORT`: Server port (default: 3001)
- `CORS_ORIGIN`: Frontend URL (default: http://localhost:3000)

4. Set up the database:
```bash
# Generate Prisma Client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed the database (optional)
npm run prisma:seed
```

## Running the Application

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm run build
npm start
```

The server will start on `http://localhost:3001` (or the port specified in `.env`).

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email/password
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/logout` - Logout (client-side token removal)

### Members
- `GET /api/members` - List all members (with filters, search, sorting)
- `GET /api/members/:id` - Get single member
- `POST /api/members` - Create member
- `PUT /api/members/:id` - Update member
- `DELETE /api/members/:id` - Delete member

### Trainers
- `GET /api/trainers` - List all trainers
- `GET /api/trainers/:id` - Get single trainer
- `POST /api/trainers` - Create trainer
- `PUT /api/trainers/:id` - Update trainer
- `DELETE /api/trainers/:id` - Delete trainer

### Packages
- `GET /api/packages` - List all packages
- `GET /api/packages/:id` - Get single package
- `POST /api/packages` - Create package
- `PUT /api/packages/:id` - Update package
- `DELETE /api/packages/:id` - Delete package

### Payments
- `GET /api/payments` - List all payments (with filters)
- `GET /api/payments/:id` - Get single payment
- `POST /api/payments` - Create payment (manual)
- `PUT /api/payments/:id` - Update payment
- `PATCH /api/payments/:id/mark-paid` - Mark payment as paid
- `GET /api/payments/:id/receipt` - Get payment receipt
- `DELETE /api/payments/:id` - Delete payment
- `POST /api/payments/generate-overdue` - Mark overdue payments

### Attendance
- `GET /api/attendance` - List attendance records (read-only)
- `GET /api/attendance/:id` - Get single attendance record

### Dashboard
- `GET /api/dashboard/stats` - Get dashboard statistics

### Reports
- `GET /api/reports/attendance` - Get attendance statistics

## Authentication

All endpoints (except `/api/auth/login`) require authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## Response Format

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

### Error Response
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message",
    "details": { ... }
  }
}
```

## Multi-Tenancy

The system uses gym-based data isolation. All data is scoped by `gymId`, which is extracted from the authenticated user's JWT token. Users can only access data belonging to their gym.

## Database Schema

The database includes the following models:
- `Gym` - Gym information
- `User` - System users (GYM_ADMIN, STAFF)
- `Member` - Gym members
- `Trainer` - Personal trainers
- `Package` - Membership packages
- `Payment` - Payment records
- `AttendanceRecord` - Attendance tracking
- `MemberTrainer` - Many-to-many relationship between members and trainers

## Seed Data

The seed script creates:
- 2 gyms
- 3 users (admin and staff)
- 3 packages
- 2 trainers
- 3 members
- Sample payments and attendance records

Default credentials:
- Admin: `admin@fitnix.com` / `password123`
- Staff: `staff@fitnix.com` / `password123`

## Development

### Project Structure
```
src/
├── lib/           # Prisma client
├── middleware/    # Express middleware
├── routes/        # API route handlers
├── services/      # Business logic services
├── utils/         # Utility functions
├── validations/   # Zod validation schemas
└── server.ts      # Express app entry point

prisma/
├── schema.prisma  # Database schema
└── seed.ts        # Seed script
```

### Scripts
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run prisma:generate` - Generate Prisma Client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio
- `npm run prisma:seed` - Seed the database

## Error Handling

The API uses standardized error responses with appropriate HTTP status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation errors)
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

## Security Features

- Password hashing with bcrypt
- JWT token authentication
- Rate limiting (100 requests per 15 minutes per IP)
- CORS configuration
- Input validation with Zod
- SQL injection protection via Prisma

## License

ISC

