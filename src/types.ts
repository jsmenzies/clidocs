export interface Env {
  CLIDOCS_CACHE: KVNamespace;
  GITHUB_TOKEN: string;
  AI?: any;
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
