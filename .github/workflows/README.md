# CI/CD Workflows

This directory contains GitHub Actions workflows for continuous integration and deployment.

## Workflows

### 1. CI (Continuous Integration)
**File:** `.github/workflows/ci.yml`

Runs on:
- Pull requests to `main` or `develop`
- Pushes to `main` or `develop`

**Jobs:**
- **Lint and Build**: Checks code quality, type checks, and builds the project
- **Test**: Runs tests (currently disabled - enable when tests are added)

### 2. CD - Deploy (Continuous Deployment)
**File:** `.github/workflows/cd.yml`

Runs on:
- Pushes to `main` branch
- Manual trigger via workflow_dispatch

**Features:**
- Supports multiple deployment platforms:
  - Vercel
  - Railway
  - Render
- Runs database migrations after deployment
- Environment-specific deployments

### 3. CD - Deploy to Staging
**File:** `.github/workflows/cd-staging.yml`

Runs on:
- Pushes to `develop` branch
- Manual trigger via workflow_dispatch

**Features:**
- Deploys to staging environment
- Uses staging database
- Separate from production deployments

## Required Secrets

Add these secrets in your GitHub repository settings (Settings → Secrets and variables → Actions):

### Production Secrets
- `DATABASE_URL` - PostgreSQL connection string for production
- `JWT_SECRET` - Secret key for JWT tokens
- `CORS_ORIGIN` - Allowed CORS origin

### Deployment Platform Secrets (choose one or more)

**For Vercel:**
- `VERCEL_TOKEN` - Vercel API token
- `VERCEL_ORG_ID` - Vercel organization ID
- `VERCEL_PROJECT_ID` - Vercel project ID

**For Railway:**
- `RAILWAY_TOKEN` - Railway API token
- `RAILWAY_SERVICE_ID` - Railway service ID

**For Render:**
- `RENDER_API_KEY` - Render API key
- `RENDER_SERVICE_ID` - Render service ID

### Staging Secrets
- `STAGING_DATABASE_URL` - PostgreSQL connection string for staging

## Environment Variables

Set these in your deployment platform:

### Required
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT tokens
- `NODE_ENV` - Environment (production/staging)

### Optional
- `JWT_EXPIRES_IN` - JWT expiration (default: 7d)
- `PORT` - Server port (default: 3001)
- `CORS_ORIGIN` - Allowed CORS origin

## Setup Instructions

### 1. Enable GitHub Actions
1. Go to your repository on GitHub
2. Navigate to Settings → Actions → General
3. Enable "Allow all actions and reusable workflows"

### 2. Add Secrets
1. Go to Settings → Secrets and variables → Actions
2. Add all required secrets listed above

### 3. Configure Environments
1. Go to Settings → Environments
2. Create `production` and `staging` environments
3. Add environment-specific secrets if needed

### 4. Deploy to Your Platform

#### Vercel
1. Install Vercel CLI: `npm i -g vercel`
2. Run `vercel login`
3. Run `vercel link` in your project
4. Get your org and project IDs from Vercel dashboard
5. Add them as GitHub secrets

#### Railway
1. Install Railway CLI: `npm i -g @railway/cli`
2. Run `railway login`
3. Create a new project: `railway init`
4. Get your service ID from Railway dashboard
5. Add it as a GitHub secret

#### Render
1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Use the build and start commands from `render.yaml`
4. Get your service ID and API key
5. Add them as GitHub secrets

## Workflow Status

You can check workflow status:
- In the "Actions" tab of your GitHub repository
- Via GitHub API
- In your deployment platform dashboard

## Troubleshooting

### Build Fails
- Check Node.js version matches (should be 20)
- Verify all dependencies are in `package.json`
- Check TypeScript compilation errors

### Deployment Fails
- Verify all required secrets are set
- Check deployment platform credentials
- Ensure database is accessible from deployment platform
- Check environment variables are set correctly

### Database Migration Fails
- Verify `DATABASE_URL` is correct
- Check database permissions
- Ensure Prisma migrations are up to date
- Run `npx prisma migrate deploy` manually if needed

## Local Testing

Test workflows locally using [act](https://github.com/nektos/act):

```bash
# Install act
brew install act  # macOS
# or download from https://github.com/nektos/act/releases

# Run CI workflow
act pull_request

# Run deployment workflow
act push -e .github/workflows/cd.yml
```

## Best Practices

1. **Never commit secrets** - Always use GitHub Secrets
2. **Test locally first** - Run `npm run build` and `npm run lint` before pushing
3. **Review PRs** - All code should go through pull requests
4. **Use environments** - Separate staging and production
5. **Monitor deployments** - Check logs after each deployment
6. **Backup database** - Before running migrations in production

