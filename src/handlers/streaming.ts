import { Env, GitHubRepo } from '../types';
import { GitHubClient } from '../github';
import { Cache } from '../cache';
import { analyzeAndGenerateDocsWithStreaming } from '../llm/analyzer';
import { trackRepoView } from '../utils/analytics';

export async function handleStreamingGeneration(
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
        const notFoundResponse = {
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
      filesAnalyzed = repoContents.files.filter((f: string) => 
        f.includes('cmd/') || f.includes('cli/') || f.includes('bin/') ||
        f === 'package.json' || f === 'Cargo.toml' || f.endsWith('.md')
      ).length;
      
      // Send the final markdown
      await writer.write(encoder.encode(`\n---\n\n`));
      await writer.write(encoder.encode(markdown));
      await writer.close();
      
      // Cache the result
      const cacheEntry = {
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
        await writer.write(encoder.encode(`\n\n# Rate Limit Exceeded\n\nAI rate limit has been reached.\n\nThe limit resets at: ${new Date(resetTime!).toLocaleString()}\n\nPlease try again after the reset time.`));
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
