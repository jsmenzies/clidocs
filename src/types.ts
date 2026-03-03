// AI Model Response Types
export interface AIMessage {
  role: string;
  content: string;
}

export interface AIResponse {
  choices: Array<{
    message: AIMessage;
    index?: number;
    finish_reason?: string;
  }>;
}

// AI Binding Interface
export interface AIBinding {
  run(model: string, params: {
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
  }): Promise<AIResponse>;
}

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

export interface CacheEntry {
  markdown: string;
  isCli: boolean;
  generatedAt: string;
  source: string;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface RepoContents {
  files: string[];
  directories: string[];
  hasCliIndicators: boolean;
}

export interface CliFileAnalysis {
  language: 'node' | 'go' | 'python' | 'rust' | 'ruby' | 'unknown';
  isCliTool: boolean;
  confidence: number;
  indicators: string[];
  entryPointFiles: string[];
  configFiles: string[];
}
