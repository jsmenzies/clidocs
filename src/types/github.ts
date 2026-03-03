export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface RepoContents {
  files: string[];
  directories: string[];
  hasCliIndicators: boolean;
}
