import { AIBinding } from './ai';

export interface Env {
  CLIDOCS_CACHE: KVNamespace;
  GITHUB_TOKEN: string;
  ADMIN_API_KEY: string;
  AI?: AIBinding;
  ANALYTICS?: AnalyticsEngineDataset;
  AI_RATE_LIMIT?: string;
  AI_RATE_WINDOW?: string;
  CACHE_TTL?: string;
  MAX_FILES_TO_ANALYZE?: string;
  MAX_FILE_CONTENT_SIZE?: string;
  MAX_README_SIZE?: string;
  AI_MAX_TOKENS?: string;
  AI_TEMPERATURE?: string;
  GITHUB_TIMEOUT_MS?: string;
}
