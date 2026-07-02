import dotenv from "dotenv";

// Load env BEFORE any other module reads process.env (claude.ts reads DEEPSEEK_MODEL at import time, etc.),
// so this module is imported first in index.ts. This app is standalone — its own .env holds every key it
// needs (DEEPSEEK_API_KEY, COMPOSIO_API_KEY, GOOGLE_*, SUPABASE_*, SESSION_SECRET, PUBLIC_URL, PORT).
dotenv.config();
