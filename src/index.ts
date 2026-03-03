import { Env, GitHubRepo, CacheEntry } from './types';
import { Cache } from './cache';
import { handleStreamingGeneration } from './handlers/streaming';
import { validateApiKey } from './handlers/auth';
import { trackRepoView } from './utils/analytics';

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
