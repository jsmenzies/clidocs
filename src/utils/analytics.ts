import { Env } from '../types';

// Analytics tracking helper
export function trackRepoView(
  env: Env,
  owner: string,
  repo: string,
  cacheStatus: 'HIT' | 'MISS' | 'BYPASS' | 'ERROR',
  resultStatus: 'success' | 'error' | 'not_found' | 'rate_limited',
  generationTimeMs: number = 0,
  filesAnalyzed: number = 0
): void {
  if (!env.ANALYTICS) return;
  
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [owner, repo, cacheStatus, resultStatus],
      doubles: [1, generationTimeMs, filesAnalyzed],
      indexes: [`${owner}/${repo}`]
    });
  } catch (e) {
    console.error('[Analytics] Failed to track:', e);
  }
}
