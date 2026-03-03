import { Env, CacheEntry } from './types';

const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

export class Cache {
  private kv: KVNamespace;
  private ttl: number;

  constructor(env: Env) {
    this.kv = env.CLIDOCS_CACHE;
    this.ttl = env.CACHE_TTL ? parseInt(env.CACHE_TTL, 10) : DEFAULT_CACHE_TTL;
  }

  private getKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  async get(owner: string, repo: string): Promise<CacheEntry | null> {
    const key = this.getKey(owner, repo);
    const data = await this.kv.get(key, 'json');
    return data as CacheEntry | null;
  }

  async set(owner: string, repo: string, entry: CacheEntry): Promise<void> {
    const key = this.getKey(owner, repo);
    await this.kv.put(key, JSON.stringify(entry), {
      expirationTtl: this.ttl
    });
  }

  async delete(owner: string, repo: string): Promise<void> {
    const key = this.getKey(owner, repo);
    await this.kv.delete(key);
  }
}
