export interface Env {
  CLIDOCS_CACHE: KVNamespace;
  GITHUB_TOKEN: string;
  ADMIN_API_KEY: string;
  AI?: any;
  AI_RATE_LIMIT?: string;
  AI_RATE_WINDOW?: string;
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
