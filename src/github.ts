import { GitHubRepo } from './types';

export class GitHubClient {
  private token: string;
  private baseUrl = 'https://api.github.com';

  constructor(token: string) {
    this.token = token;
  }

  async fetchReadme(repo: GitHubRepo): Promise<string | null> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/readme`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'clidocs/0.1.0'
      }
    });

    if (response.status === 404) {
      return null;
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
