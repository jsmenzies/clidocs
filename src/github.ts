import { GitHubRepo, RepoContents } from './types';

export class GitHubClient {
  private token: string | null;
  private baseUrl = 'https://api.github.com';

  constructor(token: string | null) {
    this.token = token;
  }

  async fetchRepoContents(repo: GitHubRepo): Promise<RepoContents> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/git/trees/HEAD?recursive=1`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'clidocs/0.1.0'
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, { headers });

    if (response.status === 404) {
      return { files: [], directories: [], hasCliIndicators: false };
    }

    if (response.status === 403) {
      const isRateLimit = response.headers.get('X-RateLimit-Remaining') === '0';
      if (isRateLimit && !this.token) {
        throw new Error('GitHub API rate limit exceeded. Add a GITHUB_TOKEN to increase limits from 60 to 5000 requests/hour.');
      }
      throw new Error(`GitHub API error: ${response.status} - ${response.statusText}`);
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { tree: Array<{ path: string; type: string }> };
    
    const files: string[] = [];
    const directories: string[] = [];

    for (const item of data.tree) {
      if (item.type === 'blob') {
        files.push(item.path);
      } else if (item.type === 'tree') {
        directories.push(item.path);
      }
    }

    return { files, directories, hasCliIndicators: false };
  }

  async fetchReadme(repo: GitHubRepo): Promise<string | null> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/readme`;
    
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'clidocs/0.1.0'
    };
    
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    
    const response = await fetch(url, { headers });

    if (response.status === 404) {
      return null;
    }

    if (response.status === 403) {
      const isRateLimit = response.headers.get('X-RateLimit-Remaining') === '0';
      if (isRateLimit && !this.token) {
        throw new Error('GitHub API rate limit exceeded. Add a GITHUB_TOKEN to increase limits from 60 to 5000 requests/hour.');
      }
      throw new Error(`GitHub API error: ${response.status} - ${response.statusText}`);
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { content: string; encoding: string };
    
    if (data.encoding === 'base64') {
      // Decode base64 content
      const decoded = atob(data.content.replace(/\n/g, ''));
      return decoded;
    }

    return data.content;
  }
}
