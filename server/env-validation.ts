/**
 * Environment Variable Validation
 * 
 * Validates that all required environment variables are present and valid.
 * Fails fast on startup if configuration is missing.
 */

export interface EnvVarDefinition {
  name: string;
  required: boolean;
  description: string;
  validator?: (value: string) => boolean;
  defaultValue?: string;
}

const ENV_DEFINITIONS: EnvVarDefinition[] = [
  // Core server configuration
  {
    name: "PORT",
    required: false,
    description: "Server port (default: 8788)",
    defaultValue: "8788",
  },
  {
    name: "NODE_ENV",
    required: false,
    description: "Environment (development/production)",
    defaultValue: "development",
  },
  
  // Security
  {
    name: "SESSION_SECRET",
    required: true,
    description: "Secret for session signing (required in production)",
    validator: (v) => v.length >= 32,
  },
  {
    name: "CREDENTIAL_ENCRYPTION_KEY",
    required: true,
    description: "Key for encrypting sensitive credentials (e.g., Pronote tokens)",
    validator: (v) => v.length >= 32,
  },
  
  // AI configuration
  {
    name: "DEEPSEEK_API_KEY",
    required: false,
    description: "DeepSeek API key for AI generation (unless AI_PROVIDER=nvidia)",
  },
  {
    name: "NVIDIA_API_KEY",
    required: false,
    description: "NVIDIA API key (when AI_PROVIDER=nvidia)",
  },
  {
    name: "AI_PROVIDER",
    required: false,
    description: "AI provider: 'deepseek' or 'nvidia' (default: deepseek)",
    defaultValue: "deepseek",
  },
  {
    name: "DEEPSEEK_MODEL",
    required: false,
    description: "DeepSeek model to use (default: deepseek-v4-flash)",
  },
  {
    name: "NVIDIA_MODEL",
    required: false,
    description: "NVIDIA model to use (default: mistralai/mistral-nemotron)",
  },
  
  // Composio integration
  {
    name: "COMPOSIO_API_KEY",
    required: true,
    description: "Composio API key for app integrations",
  },
  
  // Supabase configuration
  {
    name: "SUPABASE_URL",
    required: true,
    description: "Supabase project URL",
    validator: (v) => v.startsWith("https://"),
  },
  {
    name: "SUPABASE_SERVICE_KEY",
    required: true,
    description: "Supabase service role key",
  },
  {
    name: "SUPABASE_ANON_KEY",
    required: false,
    description: "Supabase anonymous key (for development)",
  },
  
  // Public URLs
  {
    name: "PUBLIC_URL",
    required: true,
    description: "Public URL of the app (for OAuth callbacks)",
    validator: (v) => v.startsWith("http://") || v.startsWith("https://"),
  },
  
  // Email/mailer configuration
  {
    name: "SMTP_HOST",
    required: false,
    description: "SMTP server host for transactional emails",
  },
  {
    name: "SMTP_PORT",
    required: false,
    description: "SMTP server port",
  },
  {
    name: "SMTP_USER",
    required: false,
    description: "SMTP username",
  },
  {
    name: "SMTP_PASSWORD",
    required: false,
    description: "SMTP password",
  },
  {
    name: "SMTP_FROM",
    required: false,
    description: "From address for transactional emails",
  },
  
  // Sentry error tracking
  {
    name: "SENTRY_DSN",
    required: false,
    description: "Sentry DSN for error tracking",
  },
  {
    name: "VITE_SENTRY_DSN",
    required: false,
    description: "Sentry DSN for client-side error tracking",
  },
  
  // Vercel analytics
  {
    name: "VERCEL",
    required: false,
    description: "Set to '1' when running on Vercel",
  },
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate all environment variables
 * Returns validation result with errors and warnings
 */
export function validateEnvironment(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = process.env.NODE_ENV === "production";

  for (const def of ENV_DEFINITIONS) {
    const value = process.env[def.name];
    const isMissing = value === undefined || value === "";

    // Check if required in production
    if (def.required && isProduction && isMissing) {
      errors.push(`${def.name} is required in production: ${def.description}`);
      continue;
    }

    // Warn if required in development but missing
    if (def.required && !isProduction && isMissing) {
      warnings.push(`${def.name} is missing: ${def.description} (required in production)`);
      continue;
    }

    // Skip validation if missing and not required
    if (isMissing) continue;

    // Run custom validator if provided
    if (def.validator && !def.validator(value)) {
      errors.push(`${def.name} has invalid value: ${def.description}`);
    }
  }

  // Check AI provider configuration
  const aiProvider = (process.env.AI_PROVIDER || "deepseek").toLowerCase();
  if (aiProvider === "nvidia") {
    if (!process.env.NVIDIA_API_KEY) {
      errors.push("NVIDIA_API_KEY is required when AI_PROVIDER=nvidia");
    }
  } else {
    if (!process.env.DEEPSEEK_API_KEY) {
      warnings.push("DEEPSEEK_API_KEY is missing (AI generation will not work)");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate environment and throw if invalid
 * Call this on server startup
 */
export function validateEnvironmentOrThrow(): void {
  const result = validateEnvironment();
  
  if (result.warnings.length > 0) {
    console.warn("[env-validation] Warnings:");
    for (const warning of result.warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  if (!result.valid) {
    console.error("[env-validation] Errors:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    throw new Error("Environment validation failed. See errors above.");
  }

  console.log("[env-validation] Environment is valid.");
}

/**
 * Get all environment variable definitions for documentation
 */
export function getEnvVarDefinitions(): EnvVarDefinition[] {
  return ENV_DEFINITIONS;
}
