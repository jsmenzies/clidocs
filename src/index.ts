import { Env, GitHubRepo, CacheEntry } from './types';
import { GitHubClient } from './github';
import { Cache } from './cache';
import { analyzeAndGenerateDocs } from './llm/analyzer';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1); // Remove leading slash
    
    // Handle cache invalidation endpoint
    if (path === 'admin/invalidate-cache' && request.method === 'POST') {
      return handleCacheInvalidation(env);
    }
    
    // Parse owner/repo from path
    const parts = path.split('/');
    if (parts.length !== 2) {
      return new Response(
        `# Error\n\nInvalid URL format. Use: clidocs.io/owner/repo\n\nExample: clidocs.io/tj/commander.js`,
        { 
          status: 400,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'X-Error': 'invalid-path'
          }
        }
      );
    }
    
    const [owner, repo] = parts;
    
    if (!owner || !repo) {
      return new Response(
        `# Error\n\nMissing owner or repo name.`,
        { 
          status: 400,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
        }
      );
    }
    
    const repoData: GitHubRepo = { owner, repo };
    const skipCache = url.searchParams.has('nocache') || url.searchParams.has('refresh');
    
    // Initialize cache
    const cache = new Cache(env);
    
    // Check cache first
    if (!skipCache) {
      const cached = await cache.get(owner, repo);
      if (cached) {
        return new Response(cached.markdown, {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'X-Cache': 'HIT',
            'X-Generated-At': cached.generatedAt,
            'X-Is-Cli': String(cached.isCli),
            'X-Auth': env.GITHUB_TOKEN ? 'token' : 'none',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }
    }
    
    // No cache or bypass - fetch from GitHub
    const github = new GitHubClient(env.GITHUB_TOKEN || null);
    
    try {
      // Fetch both README and repo structure
      const [readme, repoContents] = await Promise.all([
        github.fetchReadme(repoData),
        github.fetchRepoContents(repoData)
      ]);
      
      if (!readme) {
        const notFoundResponse: CacheEntry = {
          markdown: `# ${repo}\n\nRepository not found or has no README.`,
          isCli: false,
          generatedAt: new Date().toISOString(),
          source: 'github'
        };
        
        await cache.set(owner, repo, notFoundResponse);
        
        return new Response(notFoundResponse.markdown, {
          status: 404,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'X-Cache': 'MISS',
            'X-Generated-At': notFoundResponse.generatedAt
          }
        });
      }
      
      // Analyze repo and generate documentation
      console.log(`[Main] Starting analysis for ${owner}/${repo}...`);
      const { markdown, isCli } = await analyzeAndGenerateDocs(
        repoData,
        readme,
        repoContents,
        env.GITHUB_TOKEN || null,
        env.AI
      );
      
      // Cache the result
      const cacheEntry: CacheEntry = {
        markdown,
        isCli,
        generatedAt: new Date().toISOString(),
        source: 'github'
      };
      
      await cache.set(owner, repo, cacheEntry);
      
      return new Response(markdown, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'X-Cache': skipCache ? 'BYPASS' : 'MISS',
          'X-Generated-At': cacheEntry.generatedAt,
          'X-Is-Cli': String(isCli),
          'X-Auth': env.GITHUB_TOKEN ? 'token' : 'none',
          'Cache-Control': 'public, max-age=86400'
        }
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Main] Error:', error);
      
      return new Response(
        `# Error\n\nFailed to fetch documentation for ${owner}/${repo}.\n\nError: ${errorMessage}\n\nPlease try again later.`,
        {
          status: 500,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'X-Error': 'fetch-failed'
          }
        }
      );
    }
  }
};

async function handleCacheInvalidation(env: Env): Promise<Response> {
  try {
    // Get all keys from KV
    const keys: string[] = [];
    let cursor: string | undefined;
    
    // Cloudflare KV list returns paginated results
    do {
      const listResult = await env.CLIDOCS_CACHE.list({ cursor, limit: 1000 });
      keys.push(...listResult.keys.map(k => k.name));
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);
    
    console.log(`[Admin] Found ${keys.length} cache entries to invalidate`);
    
    // Delete all keys
    const deletePromises = keys.map(key => env.CLIDOCS_CACHE.delete(key));
    await Promise.all(deletePromises);
    
    console.log(`[Admin] Successfully invalidated ${keys.length} cache entries`);
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Invalidated ${keys.length} cache entries`,
        timestamp: new Date().toISOString()
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Cache invalidation failed:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: errorMessage 
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}