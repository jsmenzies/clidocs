import { Env, GitHubRepo, CacheEntry } from './types';
import { GitHubClient } from './github';
import { Cache } from './cache';
import { verifyIsCliTool } from './llm/stage1';
import { generateCliDocs } from './llm/stage2';
import { parseCliSections } from './parser';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1); // Remove leading slash
    
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
    // Token is optional - works without auth but has lower rate limits (60 req/hour)
    const github = new GitHubClient(env.GITHUB_TOKEN || null);
    
    try {
      const readme = await github.fetchReadme(repoData);
      
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
      
      // Stage 1: Verify if this is a CLI tool (cheap LLM)
      const verification = await verifyIsCliTool(repoData, readme, env.AI);
      
      let markdown: string;
      let isCli: boolean;
      
      if (verification.isCli && verification.confidence > 0.5) {
        // Stage 2: Generate CLI documentation (better LLM)
        markdown = await generateCliDocs(repoData, readme, env.AI);
        isCli = true;
      } else {
        // Not a CLI tool - return message
        markdown = `# ${repo}\n\nSource: github.com/${owner}/${repo}\n\nThis repository does not appear to be a CLI tool.\n\nConfidence: ${(verification.confidence * 100).toFixed(0)}%\n\n---\n\n*Detected by clidocs.io*  
*Note: This is mock data. Connect LLMs for real detection.*`;
        isCli = false;
      }
      
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
