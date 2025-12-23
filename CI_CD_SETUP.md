# CI/CD Setup Guide

This guide will help you set up continuous integration and deployment for the FitNix Track Backend.

## Overview

The project includes:
- **GitHub Actions** workflows for CI/CD
- Support for Vercel deployment (with optional Railway and Render support)

## Quick Start

### 1. GitHub Actions Setup

1. **Enable GitHub Actions**
   - Go to your repository → Settings → Actions → General
   - Enable "Allow all actions and reusable workflows"

2. **Add Required Secrets**
   - Go to Settings → Secrets and variables → Actions
   - Add the following secrets:

   ```
   DATABASE_URL          # PostgreSQL connection string
   JWT_SECRET            # Secret key for JWT tokens
   CORS_ORIGIN           # Allowed CORS origin
   ```

3. **Add Deployment Platform Secrets** (choose your platform)

   **For Vercel:**
   ```
   VERCEL_TOKEN
   VERCEL_ORG_ID
   VERCEL_PROJECT_ID
   ```

   **For Railway:**
   ```
   RAILWAY_TOKEN
   RAILWAY_SERVICE_ID
   ```

   **For Render:**
   ```
   RENDER_API_KEY
   RENDER_SERVICE_ID
   ```

### 2. Workflow Files

The following workflows are configured:

- **`.github/workflows/ci.yml`** - Runs on PRs and pushes
  - Lints code
  - Type checks
  - Builds project
  - Runs tests (when added)

- **`.github/workflows/cd.yml`** - Deploys to production
  - Triggers on push to `main`
  - Supports Vercel, Railway, Render
  - Runs database migrations

- **`.github/workflows/cd-staging.yml`** - Deploys to staging
  - Triggers on push to `develop`
  - Uses staging database

## Deployment Platforms

### Vercel

1. **Install Vercel CLI:**
   ```bash
   npm i -g vercel
   ```

2. **Login and Link:**
   ```bash
   vercel login
   vercel link
   ```

3. **Get IDs:**
   - Go to Vercel Dashboard → Your Project → Settings
   - Copy Organization ID and Project ID
   - Add as GitHub secrets

4. **Deploy:**
   - Pushes to `main` will auto-deploy
   - Or use `vercel --prod` manually

### Railway

1. **Install Railway CLI:**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login:**
   ```bash
   railway login
   ```

3. **Create Project:**
   ```bash
   railway init
   ```

4. **Get Service ID:**
   - Go to Railway Dashboard → Your Service
   - Copy Service ID
   - Add as GitHub secret `RAILWAY_SERVICE_ID`

5. **Get Token:**
   - Go to Railway Dashboard → Account → Tokens
   - Create new token
   - Add as GitHub secret `RAILWAY_TOKEN`

### Render

1. **Create Web Service:**
   - Go to Render Dashboard
   - Click "New" → "Web Service"
   - Connect your GitHub repository

2. **Configure:**
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Environment: `Node`

3. **Get IDs:**
   - Service ID: Found in service URL or settings
   - API Key: Account → API Keys
   - Add as GitHub secrets

## Environment Variables

Set these in your deployment platform:

### Required
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT tokens
- `NODE_ENV` - Environment (production/staging/development)

### Optional
- `JWT_EXPIRES_IN` - JWT expiration (default: 7d)
- `PORT` - Server port (default: 3001)
- `CORS_ORIGIN` - Allowed CORS origin

## Database Migrations

Migrations run automatically during deployment. To run manually:

```bash
# Development
npm run prisma:migrate

# Production
npx prisma migrate deploy
```

## Testing Workflows Locally

Install [act](https://github.com/nektos/act) to test workflows locally:

```bash
# Install act
brew install act  # macOS
# or download from releases

# Test CI workflow
act pull_request

# Test deployment
act push
```

## Branch Strategy

- **`main`** - Production branch (auto-deploys)
- **`develop`** - Staging branch (auto-deploys to staging)
- **Feature branches** - Trigger CI only

## Monitoring

### GitHub Actions
- Check workflow status in "Actions" tab
- View logs for each step
- Set up notifications for failures

### Deployment Platforms
- Monitor application logs
- Set up alerts for errors
- Track deployment history

## Troubleshooting

### CI Fails

1. **Build Errors:**
   ```bash
   # Test locally
   npm run build
   npm run lint
   ```

2. **Type Errors:**
   ```bash
   npm run type-check
   ```

3. **Dependency Issues:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

### Deployment Fails

1. **Check Secrets:**
   - Verify all required secrets are set
   - Check secret values are correct

2. **Database Connection:**
   - Verify `DATABASE_URL` is correct
   - Check database is accessible
   - Test connection manually

3. **Migration Errors:**
   ```bash
   # Run migrations manually
   npx prisma migrate deploy
   ```

## Best Practices

1. **Never commit secrets** - Always use environment variables/secrets
2. **Test locally first** - Run builds and tests before pushing
3. **Use feature branches** - Don't push directly to main
4. **Review PRs** - All code should be reviewed
5. **Monitor deployments** - Check logs after each deployment
6. **Backup database** - Before running migrations in production
7. **Use staging** - Test in staging before production
8. **Version control** - Tag releases for easy rollback

## Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Docker Documentation](https://docs.docker.com/)
- [Prisma Migrations](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [Vercel Documentation](https://vercel.com/docs)
- [Railway Documentation](https://docs.railway.app/)
- [Render Documentation](https://render.com/docs)

