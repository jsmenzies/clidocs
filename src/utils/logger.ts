import { GitHubRepo } from "../types";

// Logger factory that prefixes messages with repo name for tracking
export function createLogger(repo: GitHubRepo) {
  const prefix = `[${repo.owner}/${repo.repo}]`;
  return {
    log: (msg: string) => console.log(`${prefix} ${msg}`),
    error: (msg: string, err?: unknown) => console.error(`${prefix} ${msg}`, err),
  };
}

export type Logger = ReturnType<typeof createLogger>;
