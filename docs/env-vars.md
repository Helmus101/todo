# Environment Variables

This document describes all environment variables used by Otto Lycée. Required variables must be set in production; optional variables have defaults or graceful degradation.

## Core Server Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8788` | Server port for the Express backend |
| `NODE_ENV` | No | `development` | Environment: `development` or `production` |

## Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET` | Yes (production) | - | Secret for signing session cookies. Must be at least 32 characters. |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes | - | Key for encrypting sensitive credentials (e.g., Pronote tokens). Must be at least 32 characters. Generate with `openssl rand -hex 32`. |

## AI Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | No* | - | DeepSeek API key for AI generation. Required unless `AI_PROVIDER=nvidia`. |
| `NVIDIA_API_KEY` | No* | - | NVIDIA API key. Required when `AI_PROVIDER=nvidia`. |
| `AI_PROVIDER` | No | `deepseek` | AI provider: `deepseek` or `nvidia`. |
| `DEEPSEEK_MODEL` | No | `deepseek-v4-flash` | DeepSeek model to use. |
| `NVIDIA_MODEL` | No | `mistralai/mistral-nemotron` | NVIDIA model to use. |

*At least one of `DEEPSEEK_API_KEY` or `NVIDIA_API_KEY` must be set, depending on `AI_PROVIDER`.

## Composio Integration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COMPOSIO_API_KEY` | Yes | - | Composio API key for app integrations (Gmail, Calendar, Drive, etc.). |

## Supabase Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | - | Supabase project URL (must start with `https://`). |
| `SUPABASE_SERVICE_KEY` | Yes | - | Supabase service role key for server-side operations. |
| `SUPABASE_ANON_KEY` | No | - | Supabase anonymous key (for development only). |

## Public URLs

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PUBLIC_URL` | Yes | - | Public URL of the app (for OAuth callbacks). Must start with `http://` or `https://`. |

## Email/Mailer Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | No | - | SMTP server host for transactional emails. |
| `SMTP_PORT` | No | - | SMTP server port. |
| `SMTP_USER` | No | - | SMTP username. |
| `SMTP_PASSWORD` | No | - | SMTP password. |
| `SMTP_FROM` | No | - | From address for transactional emails. |

## Error Tracking

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SENTRY_DSN` | No | - | Sentry DSN for server-side error tracking. |
| `VITE_SENTRY_DSN` | No | - | Sentry DSN for client-side error tracking. |

## Vercel

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VERCEL` | No | - | Set to `1` when running on Vercel. |

## Development Setup

For local development, create a `.env` file in the project root:

```bash
# Core
PORT=8788
NODE_ENV=development

# Security
SESSION_SECRET=your-session-secret-min-32-chars
CREDENTIAL_ENCRYPTION_KEY=your-encryption-key-min-32-chars

# AI (choose one provider)
DEEPSEEK_API_KEY=your-deepseek-api-key
# OR
# AI_PROVIDER=nvidia
# NVIDIA_API_KEY=your-nvidia-api-key

# Composio
COMPOSIO_API_KEY=your-composio-api-key

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key

# Public URL
PUBLIC_URL=http://localhost:5273

# Email (optional)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=otto@example.com

# Sentry (optional)
SENTRY_DSN=https://your-sentry-dsn
VITE_SENTRY_DSN=https://your-sentry-dsn
```

## Production Setup

For production deployment, ensure all required variables are set:

- ✅ `SESSION_SECRET` (required)
- ✅ `CREDENTIAL_ENCRYPTION_KEY` (required)
- ✅ `COMPOSIO_API_KEY` (required)
- ✅ `SUPABASE_URL` (required)
- ✅ `SUPABASE_SERVICE_KEY` (required)
- ✅ `PUBLIC_URL` (required)
- ✅ `DEEPSEEK_API_KEY` or `NVIDIA_API_KEY` (required, based on `AI_PROVIDER`)
- ✅ `NODE_ENV=production` (recommended)

## Environment Validation

The server validates environment variables on startup and will fail to start if required variables are missing in production. Validation errors and warnings are logged to the console.

To manually validate environment variables:

```bash
# The server validates on startup automatically
npm run dev
```

## Security Notes

- Never commit `.env` files to version control
- Use strong, randomly generated secrets (minimum 32 characters)
- Rotate secrets periodically
- Use different secrets for development and production
- Store secrets securely in your deployment platform (Vercel Environment Variables, AWS Secrets Manager, etc.)
