import { Env, GitHubRepo, CacheEntry } from './types';
import { GitHubClient } from './github';
import { Cache } from './cache';
import { analyzeAndGenerateDocsWithStreaming } from './llm/analyzer';

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="16" fill="#1e1e2e"/>
  <rect x="10" y="20" width="80" height="60" rx="6" fill="#313244"/>
  <circle cx="22" cy="32" r="3" fill="#f38ba8"/>
  <circle cx="32" cy="32" r="3" fill="#f9e2af"/>
  <circle cx="42" cy="32" r="3" fill="#a6e3a1"/>
  <text x="18" y="52" font-family="monospace" font-size="16" fill="#94e2d5">$</text>
  <text x="30" y="52" font-family="monospace" font-size="14" fill="#cdd6f4">clidocs</text>
  <rect x="82" y="42" width="2" height="14" fill="#cdd6f4">
    <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
  </rect>
  <text x="50" y="82" font-family="monospace" font-size="8" fill="#89b4fa" text-anchor="middle">CLI DOCS</text>
</svg>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle favicon requests
    if (path === '/favicon.ico' || path === '/favicon.svg') {
      return new Response(FAVICON_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }
    
    const pathWithoutSlash = path.slice(1); // Remove leading slash
    
    // Handle cache invalidation endpoint
    if (pathWithoutSlash === 'admin/invalidate-cache' && request.method === 'POST') {
      return handleCacheInvalidation(env);
    }
    
    // Parse owner/repo from path
    const parts = pathWithoutSlash.split('/');
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
    
    // No cache or bypass - fetch from GitHub with streaming
    return handleStreamingGeneration(repoData, env, cache, skipCache);
  }
};

async function handleStreamingGeneration(
  repoData: GitHubRepo,
  env: Env,
  cache: Cache,
  skipCache: boolean
): Promise<Response> {
  const { owner, repo } = repoData;
  const github = new GitHubClient(env.GITHUB_TOKEN || null);
  
  // Create a TransformStream for streaming
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // Start the background work
  const backgroundWork = async () => {
    try {
      // Send initial loading message
      await writer.write(encoder.encode(`# Loading CLI documentation for ${owner}/${repo}...\n\n`));
      
      // Fetch repository data
      await writer.write(encoder.encode(`> Fetching repository data...\n`));
      const [readme, repoContents] = await Promise.all([
        github.fetchReadme(repoData),
        github.fetchRepoContents(repoData)
      ]);
      
      if (!readme) {
        const notFoundMarkdown = `# ${repo}\n\nRepository not found or has no README.`;
        await writer.write(encoder.encode(`\n${notFoundMarkdown}`));
        await writer.close();
        
        // Cache the not-found result
        const notFoundResponse: CacheEntry = {
          markdown: notFoundMarkdown,
          isCli: false,
          generatedAt: new Date().toISOString(),
          source: 'github'
        };
        await cache.set(owner, repo, notFoundResponse);
        return;
      }
      
      // Analyze and generate docs with streaming progress
      await writer.write(encoder.encode(`> Analyzing repository structure...\n`));
      
      const progressCallback = async (message: string) => {
        await writer.write(encoder.encode(`> ${message}\n`));
      };
      
      const { markdown, isCli } = await analyzeAndGenerateDocsWithStreaming(
        repoData,
        readme,
        repoContents,
        env.GITHUB_TOKEN || null,
        env.AI,
        env,
        progressCallback
      );
      
      // Send the final markdown
      await writer.write(encoder.encode(`\n---\n\n`));
      await writer.write(encoder.encode(markdown));
      await writer.close();
      
      // Cache the result
      const cacheEntry: CacheEntry = {
        markdown,
        isCli,
        generatedAt: new Date().toISOString(),
        source: 'github'
      };
      await cache.set(owner, repo, cacheEntry);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Streaming] Error:', error);
      
      // Handle rate limit errors
      if (errorMessage.startsWith('RATE_LIMIT_EXCEEDED:')) {
        const resetTime = errorMessage.split(':')[1];
        await writer.write(encoder.encode(`\n\n# Rate Limit Exceeded\n\nAI rate limit has been reached.\n\nThe limit resets at: ${new Date(resetTime).toLocaleString()}\n\nPlease try again after the reset time.`));
      } else {
        await writer.write(encoder.encode(`\n\n# Error\n\nFailed to fetch documentation for ${owner}/${repo}.\n\nError: ${errorMessage}\n\nPlease try again later.`));
      }
      await writer.close();
    }
  };
  
  // Start background work without awaiting
  backgroundWork();
  
  // Return the streaming response immediately
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Cache': skipCache ? 'BYPASS' : 'MISS',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache'
    }
  });
}

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
