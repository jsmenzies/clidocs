import { GitHubRepo, RepoContents } from "./types";

export class GitHubClient {
  private token: string | null;
  private baseUrl = "https://api.github.com";
  private timeoutMs: number;

  constructor(token: string | null, timeoutMs: number = 10000) {
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async fetchRepoContents(repo: GitHubRepo): Promise<RepoContents> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/git/trees/HEAD?recursive=1`;
    const response = await this.makeRequest(url);

    if (response.status === 404) {
      return { files: [], directories: [], hasCliIndicators: false };
    }

    await this.handleErrors(response, "Repo contents");

    const data = (await response.json()) as { tree: Array<{ path: string; type: string }> };

    const files: string[] = [];
    const directories: string[] = [];

    for (const item of data.tree) {
      if (item.type === "blob") {
        files.push(item.path);
      } else if (item.type === "tree") {
        directories.push(item.path);
      }
    }

    return { files, directories, hasCliIndicators: false };
  }

  async fetchReadme(repo: GitHubRepo): Promise<string | null> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/readme`;
    const response = await this.makeRequest(url);

    if (response.status === 404) {
      return null;
    }

    await this.handleErrors(response, "README");

    const data = (await response.json()) as { content: string; encoding: string };

    if (data.encoding === "base64") {
      return atob(data.content.replace(/\n/g, ""));
    }

    return data.content;
  }

  private async makeRequest(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "clidocs/0.1.0",
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    return fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async handleErrors(response: Response, context: string): Promise<void> {
    if (response.status === 403) {
      const isRateLimit = response.headers.get("X-RateLimit-Remaining") === "0";
      if (isRateLimit && !this.token) {
        throw new Error(
          "GitHub API rate limit exceeded. Add a GITHUB_TOKEN to increase limits from 60 to 5000 requests/hour.",
        );
      }
      throw new Error(`GitHub API error: ${response.status} - ${response.statusText}`);
    }

    if (!response.ok) {
      console.error(`[GitHub] ${context} error ${response.status}`);
      throw new Error(`GitHub API error: ${response.status} - ${response.statusText}`);
    }
  }
}
