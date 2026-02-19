
# Mission Ignite — Backend API

The NestJS backend powering the Mission Ignite platform, featuring:
- **Authentication**: JWT, Refresh Tokens (HttpOnly Cookie), Google OAuth, Rate Limiting
- **Real-Time Engine**: WebSocket Gateway for GTO simulations and Behavior Analysis
- **AI Services**: Notebook generation (Ollama), Quiz creation, Interview simulation
- **PDF Generation**: HTML-to-PDF rendering with daily quota management
- **Uploads**: Secure PDF handling with magic-byte validation and VirusTotal (planned)

## 🛠️ Prerequisites

- Node.js v20+
- PostgreSQL 16+
- Redis 7+
- Docker (optional, for production build)
- Ollama (for AI features)

## 🚀 Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Configuration**
   Copy `.env.example` to `.env` and fill in your secrets.
   ```bash
   cp .env.example .env
   ```

3. **Database Setup**
   Ensure Postgres is running, then direct Prisma to create tables:
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```

4. **Run Application**
   ```bash
   # Development (Hot Reload)
   npm run start:dev
   
   # Production Mode
   npm run build
   npm run start:prod
   ```

5. **API Documentation**
   Visit `http://localhost:3001/api` to see the Swagger UI.

## 🐳 Docker Production Build

Use the provided `docker-compose.prod.yml` to spin up the entire stack including Nginx, Postgres, and Redis:

```bash
docker-compose -f docker-compose.prod.yml up -d --build
```

This will expose the API at `http://localhost:80` (or configured port).

## 🧪 Testing

```bash
# Unit tests
npm run test

# e2e tests
npm run test:e2e
```
