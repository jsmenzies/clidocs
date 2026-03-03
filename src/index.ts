import { Env, GitHubRepo, CacheEntry } from './types';
import { GitHubClient } from './github';
import { Cache } from './cache';
import { analyzeAndGenerateDocsWithStreaming } from './llm/analyzer';

// Analytics tracking helper
function trackRepoView(
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
      indexes: [`${owner}/${repo}`, new Date().toISOString().slice(0, 10)]
    });
  } catch (e) {
    console.error('[Analytics] Failed to track:', e);
  }
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- Background circle -->
  <circle cx="50" cy="50" r="45" fill="#6366f1"/>
  
  <!-- Greater than symbol -->
  <path d="M35 30 L65 50 L35 70" stroke="#ffffff" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Underscore -->
  <line x1="40" y1="72" x2="60" y2="72" stroke="#10b981" stroke-width="6" stroke-linecap="round">
    <animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/>
  </line>
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
    
    // Redirect homepage to GitHub repo
    if (path === '/' || path === '') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': 'https://github.com/jsmenzies/clidocs'
        }
      });
    }
    
    const pathWithoutSlash = path.slice(1); // Remove leading slash

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

    // Require authentication for cache bypass
    if (skipCache) {
      const authResult = validateApiKey(request, env);
      if (!authResult.valid) {
        return authResult.response!;
      }
    }

    // Initialize cache
    const cache = new Cache(env);
    
    // Check cache first
    if (!skipCache) {
      const cached = await cache.get(owner, repo);
      if (cached) {
        // Track cache hit
        trackRepoView(env, owner, repo, 'HIT', 'success');
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
    return handleStreamingGeneration(repoData, env, cache, skipCache, ctx);
  }
};

async function handleStreamingGeneration(
  repoData: GitHubRepo,
  env: Env,
  cache: Cache,
  skipCache: boolean,
  ctx: ExecutionContext
): Promise<Response> {
  const { owner, repo } = repoData;
  const githubTimeout = env.GITHUB_TIMEOUT_MS ? parseInt(env.GITHUB_TIMEOUT_MS, 10) : 10000;
  const github = new GitHubClient(env.GITHUB_TOKEN || null, githubTimeout);
  
  // Create a TransformStream for streaming
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // Track generation start time
  const generationStartTime = Date.now();
  let filesAnalyzed = 0;
  
  // Start the background work
  const backgroundWork = async () => {
    try {
      // Send initial loading message
      await writer.write(encoder.encode(`# Loading CLI documentation for ${owner}/${repo}...\n\n`));
      
      // Indicate cache status
      if (skipCache) {
        await writer.write(encoder.encode(`> Bypassing cache...\n`));
      } else {
        await writer.write(encoder.encode(`> Cache miss - generating fresh documentation...\n`));
      }
      
      // Fetch repository data
      await writer.write(encoder.encode(`> Fetching repository data...\n`));
      const [readme, repoContents] = await Promise.all([
        github.fetchReadme(repoData),
        github.fetchRepoContents(repoData)
      ]);
      
      if (!readme) {
        const notFoundMarkdown = `# ${repo}\n\nRepository not found or has no README.\n\nThis usually means:\n- The repository doesn't exist\n- The repository has no README file\n- GitHub API rate limit exceeded (60 requests/hour without token)`;
        await writer.write(encoder.encode(`\n${notFoundMarkdown}`));
        await writer.close();
        
        // Track not found
        trackRepoView(env, owner, repo, skipCache ? 'BYPASS' : 'MISS', 'not_found');
        
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
      
      // Track files analyzed (estimate from repoContents)
      filesAnalyzed = repoContents.files.filter(f => 
        f.includes('cmd/') || f.includes('cli/') || f.includes('bin/') ||
        f === 'package.json' || f === 'Cargo.toml' || f.endsWith('.md')
      ).length;
      
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
      
      // Track successful generation
      const generationTimeMs = Date.now() - generationStartTime;
      trackRepoView(env, owner, repo, skipCache ? 'BYPASS' : 'MISS', 'success', generationTimeMs, filesAnalyzed);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Streaming] Error:', error);
      
      // Determine error type for tracking
      let resultStatus: 'error' | 'rate_limited' = 'error';
      
      // Handle rate limit errors
      if (errorMessage.startsWith('RATE_LIMIT_EXCEEDED:')) {
        resultStatus = 'rate_limited';
        const resetTime = errorMessage.split(':')[1];
        await writer.write(encoder.encode(`\n\n# Rate Limit Exceeded\n\nAI rate limit has been reached.\n\nThe limit resets at: ${new Date(resetTime).toLocaleString()}\n\nPlease try again after the reset time.`));
      } else {
        await writer.write(encoder.encode(`\n\n# Error\n\nFailed to fetch documentation for ${owner}/${repo}.\n\nError: ${errorMessage}\n\nPlease try again later.`));
      }
      await writer.close();
      
      // Track error
      trackRepoView(env, owner, repo, skipCache ? 'BYPASS' : 'MISS', resultStatus);
    }
  };
  
  // Start background work and ensure it completes using waitUntil
  ctx.waitUntil(backgroundWork());
  
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

// Helper function to validate API key authentication
function validateApiKey(request: Request, env: Env): { valid: boolean; response?: Response } {
  const authHeader = request.headers.get('Authorization');
  const expectedApiKey = env.ADMIN_API_KEY;

  if (!authHeader || !authHeader.startsWith('Bearer ') || !expectedApiKey) {
    return {
      valid: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized - API key required'
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer'
          }
        }
      )
    };
  }

  const providedApiKey = authHeader.slice(7); // Remove 'Bearer ' prefix
  if (providedApiKey !== expectedApiKey) {
    return {
      valid: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized - Invalid API key'
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    };
  }

  return { valid: true };
}
