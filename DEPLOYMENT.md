# Deployment Guide — Mission Ignite OTA SSB

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                   RENDER (Cloud)                      │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────┐ │
│  │  NestJS    │  │ PostgreSQL │  │     Redis        │ │
│  │  Backend   │──│ (Render DB)│  │ (Render Redis)   │ │
│  │  (Docker)  │  │  Free: 1GB │  │ Free: 25MB       │ │
│  └─────┬──────┘  └────────────┘  └─────────────────┘ │
│        │                                              │
└────────┼──────────────────────────────────────────────┘
         │
    ┌────┴────┐
    │ Ollama  │ ← Runs on USER's device (Android/Desktop)
    │ (Local) │   NOT on Render free tier
    └─────────┘
```

---

## What to Deploy on Render

| Component | Render Service Type | Plan |
|-----------|-------------------|------|
| NestJS Backend | Web Service (Docker) | Free / Starter ($7) |
| PostgreSQL | Managed Database | Free (256MB) |
| Redis | Managed Redis | Free (25MB) |

## What NOT to Deploy on Render

| Component | Reason |
|-----------|--------|
| Android App | Deployed via Play Store / APK sideload |
| Ollama models | Downloaded to user's device locally |
| Ollama server | Free tier has no GPU and insufficient RAM |

> [!IMPORTANT]
> Render free tier web services spin down after 15 min of inactivity. Use Starter tier ($7/mo) for always-on. Ollama runs locally on user devices — the backend only manages model recommendations and preferences.

---

## Step 1 — Create Render Account

1. Sign up at [render.com](https://render.com)
2. Connect your GitHub account

---

## Step 2 — Deploy via Blueprint (Recommended)

The `render.yaml` file in the repo root enables one-click deploy:

1. Go to **Render Dashboard → New → Blueprint**
2. Connect your GitHub repo
3. Render auto-detects `render.yaml`
4. Review services (Backend + PostgreSQL + Redis)
5. Click **Apply**

This creates all three services with correct configuration.

---

## Step 3 — Manual Deploy (Alternative)

### 3a. PostgreSQL Database

1. Render Dashboard → **New → PostgreSQL**
2. Name: `mission-ignite-db`
3. Plan: Free
4. Region: Singapore (or nearest)
5. Copy **Internal Connection String** → use as `DATABASE_URL`
6. Copy **External Connection String** → use as `DIRECT_URL` (for migrations)

### 3b. Redis

1. Render Dashboard → **New → Redis**
2. Name: `mission-ignite-redis`
3. Plan: Free
4. Copy **Internal Redis URL** → use as `REDIS_URL`

### 3c. Web Service (Backend)

1. Render Dashboard → **New → Web Service**
2. Connect GitHub repo
3. Settings:
   - **Name**: `mission-ignite-api`
   - **Runtime**: Docker
   - **Dockerfile Path**: `./Dockerfile`
   - **Branch**: `main`
   - **Plan**: Free
4. Add all environment variables (see table below)
5. Click **Create Web Service**

---

## Step 4 — Environment Variables

Set these in Render's **Environment** tab:

| Variable | Value | Source |
|----------|-------|--------|
| `NODE_ENV` | `production` | Static |
| `PORT` | `4000` | Static |
| `SWAGGER_ENABLED` | `true` | Static |
| `DATABASE_URL` | `postgresql://...` | Render PostgreSQL (Internal) |
| `DIRECT_URL` | `postgresql://...` | Render PostgreSQL (External) |
| `REDIS_URL` | `redis://...` | Render Redis (Internal) |
| `JWT_SECRET` | Generate: `openssl rand -base64 64` | Manual |
| `JWT_EXPIRES_IN` | `15m` | Static |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console | Manual |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console | Manual |
| `GOOGLE_CALLBACK_URL` | `https://<your-app>.onrender.com/api/v1/auth/google/callback` | Manual |
| `GOOGLE_DRIVE_CLIENT_ID` | From Google Cloud Console | Manual |
| `GOOGLE_DRIVE_CLIENT_SECRET` | From Google Cloud Console | Manual |
| `GOOGLE_DRIVE_REDIRECT_URI` | `https://<your-app>.onrender.com/api/v1/drive/callback` | Manual |
| `OLLAMA_API_URL` | `http://localhost:11434` | Static |
| `OLLAMA_DEFAULT_MODE` | `local` | Static (free tier) |
| `CLOUDINARY_CLOUD_NAME` | From Cloudinary dashboard | Manual |
| `CLOUDINARY_API_KEY` | From Cloudinary dashboard | Manual |
| `CLOUDINARY_API_SECRET` | From Cloudinary dashboard | Manual |
| `FRONTEND_URL` | `https://your-frontend.vercel.app` | Manual |

---

## Step 5 — Google OAuth Setup

### Auth (Login)
1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create **OAuth 2.0 Client ID** (Web application)
3. Authorized redirect URI: `https://<your-app>.onrender.com/api/v1/auth/google/callback`
4. Copy Client ID + Secret → set in Render env vars

### Drive Integration
1. Same project → Enable **Google Drive API**
2. Create another OAuth client OR reuse the same one
3. Add redirect URI: `https://<your-app>.onrender.com/api/v1/drive/callback`
4. Required scope: `https://www.googleapis.com/auth/drive.file`

> [!NOTE]
> `drive.file` scope only accesses files created by the app. No full Drive access.

---

## Step 6 — Multi-Account / Load Balancing Strategy

### When to Use Separate Accounts

| Scenario | Solution |
|----------|----------|
| Free tier limits (750 hrs/mo) | 2 accounts = 1500 hrs/mo |
| Geographic distribution | Account 1: Singapore, Account 2: Oregon |
| Staging + Production | Account 1: staging, Account 2: prod |

### Setup for 2–3 Accounts

**Account 1 (Primary — Production)**
- Deploy: Backend + PostgreSQL + Redis
- Region: Nearest to majority users

**Account 2 (Secondary — Load Balancer)**
- Deploy: Backend only (Docker)
- Same `DATABASE_URL` (Account 1's external PostgreSQL URL)
- Same `REDIS_URL` (Account 1's Redis, if external access enabled)

**Account 3 (Optional — Staging)**
- Deploy: Full stack (separate DB)
- Different `DATABASE_URL`, different `REDIS_URL`

> [!WARNING]
> Render free-tier PostgreSQL and Redis are internal-only. For cross-account access, use Supabase (PostgreSQL) + Upstash (Redis) as external providers shared across accounts.

### External Providers for Multi-Account

| Service | Provider | Free Limits |
|---------|----------|-------------|
| PostgreSQL | Supabase | 500 MB, 2 GB bandwidth |
| Redis | Upstash | 10,000 req/day, 256 MB |

---

## Step 7 — Verify Deployment

### Health Check
```
GET https://<your-app>.onrender.com/api/v1/health
```

Expected:
```json
{
  "status": "ok",
  "timestamp": "2026-02-19T07:00:00.000Z",
  "checks": { "database": "ok", "redis": "ok" }
}
```

### Swagger
```
https://<your-app>.onrender.com/api/docs
```

---

## Local Development

```bash
# 1. Copy env
cp .env.example .env
# Edit .env with real values

# 2. Start local Postgres + Redis
docker-compose up postgres redis -d

# 3. Install deps
npm install

# 4. Generate Prisma client
npx prisma generate

# 5. Run migrations
npx prisma migrate dev

# 6. Start dev server
npm run start:dev
```

---

## Dockerfile Reference

```dockerfile
# Multi-stage: build → production
# Build: npm ci → prisma generate → nest build
# Prod: npm ci --omit=dev → copy dist + prisma → migrate → start
```

See `Dockerfile` for full implementation.

## render.yaml Reference

See `render.yaml` in repo root for Render Blueprint configuration.
