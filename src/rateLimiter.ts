import { Env } from './types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: Date;
}

export async function checkRateLimit(
  env: Env,
  type: 'ai',
  config?: { limit?: number; windowSeconds?: number }
): Promise<RateLimitResult> {
  const limit = config?.limit ?? parseInt(env.AI_RATE_LIMIT || '100', 10);
  const windowSeconds = config?.windowSeconds ?? parseInt(env.AI_RATE_WINDOW || '3600', 10);
  
  // Calculate window start (truncate to nearest window)
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * (windowSeconds * 1000);
  const resetTime = new Date(windowStart + windowSeconds * 1000);
  
  const key = `ratelimit:${type}:${windowStart}`;
  
  // Get current count
  const currentCountStr = await env.CLIDOCS_CACHE.get(key);
  const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;
  
  if (currentCount >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetTime
    };
  }
  
  // Increment counter
  await env.CLIDOCS_CACHE.put(key, String(currentCount + 1), {
    expirationTtl: windowSeconds * 2 // Keep a bit longer than window for safety
  });
  
  return {
    allowed: true,
    remaining: limit - currentCount - 1,
    resetTime
  };
}

export async function getRateLimitStatus(
  env: Env,
  type: 'ai'
): Promise<{ current: number; limit: number; resetTime: Date }> {
  const limit = parseInt(env.AI_RATE_LIMIT || '100', 10);
  const windowSeconds = parseInt(env.AI_RATE_WINDOW || '3600', 10);
  
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * (windowSeconds * 1000);
  const resetTime = new Date(windowStart + windowSeconds * 1000);
  
  const key = `ratelimit:${type}:${windowStart}`;
  const currentCountStr = await env.CLIDOCS_CACHE.get(key);
  const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;
  
  return {
    current: currentCount,
    limit,
    resetTime
  };
}
