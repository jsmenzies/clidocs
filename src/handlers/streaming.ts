import { Env, GitHubRepo } from "../types";
import { GitHubClient } from "../github";
import { Cache } from "../cache";
import { analyzeAndGenerateDocsWithStreaming } from "../llm/analyzer";
import { trackRepoView } from "../utils/analytics";
import { CONTENT_TYPE, CACHE_CONTROL } from "../constants/headers";

const CLI_FILE_PATTERNS = [
  /cmd\//,
  /cli\//,
  /bin\//,
  /^package\.json$/,
  /^Cargo\.toml$/,
  /\.md$/,
] as const;

const DEFAULT_GITHUB_TIMEOUT_MS = 10000;
const RATE_LIMIT_PREFIX = "RATE_LIMIT_EXCEEDED:";

const ResultStatus = {
  SUCCESS: "success",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  ERROR: "error",
} as const;

type ResultStatusValue = (typeof ResultStatus)[keyof typeof ResultStatus];

class RateLimitError extends Error {
  readonly resetTime: Date;

  constructor(resetTime: string) {
    super(`Rate limit exceeded until ${resetTime}`);
    this.resetTime = new Date(resetTime);
    this.name = "RateLimitError";
  }
}

interface DocGenerationContext {
  readonly startTime: number;
  readonly skipCache: boolean;
}

interface CacheEntry {
  markdown: string;
  isCli: boolean;
  generatedAt: string;
  source: string;
}

class DocGenerationService {
  private readonly encoder = new TextEncoder();
  private filesAnalyzed = 0;

  constructor(
    private readonly env: Env,
    private readonly cache: Cache,
    private readonly github: GitHubClient,
  ) {}

  async execute(
    repoData: GitHubRepo,
    ctx: DocGenerationContext,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<CacheEntry | null> {
    try {
      return await this.generate(repoData, ctx, writer);
    } catch (error) {
      await this.handleError(writer, error, repoData, ctx);
      return null;
    }
  }

  private async generate(
    repoData: GitHubRepo,
    ctx: DocGenerationContext,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<CacheEntry> {
    const { owner, repo } = repoData;

    await this.writeLine(writer, `# Loading CLI documentation for ${owner}/${repo}...`);
    await this.writeLine(writer, "");
    await this.writeStatus(writer, ctx.skipCache ? "Bypassing cache..." : "Cache miss - generating fresh documentation...");
    await this.writeStatus(writer, "Fetching repository data...");

    const [readme, repoContents] = await Promise.all([
      this.github.fetchReadme(repoData),
      this.github.fetchRepoContents(repoData),
    ]);

    if (!readme) {
      return this.handleNotFound(writer, repoData, ctx);
    }

    await this.writeStatus(writer, "Analyzing repository structure...");

    const progressCallback = this.createProgressCallback(writer);

    const { markdown, isCli } = await analyzeAndGenerateDocsWithStreaming(
      repoData,
      readme,
      repoContents,
      this.env.GITHUB_TOKEN || null,
      this.env.AI,
      this.env,
      progressCallback,
    );

    this.filesAnalyzed = this.calculateFilesAnalyzed(repoContents.files);

    await writer.write(this.encoder.encode(`\n---\n\n`));
    await writer.write(this.encoder.encode(markdown));

    const cacheEntry: CacheEntry = {
      markdown,
      isCli,
      generatedAt: new Date().toISOString(),
      source: "github",
    };

    await this.cache.set(owner, repo, cacheEntry);
    this.trackSuccess(repoData, ctx);

    return cacheEntry;
  }

  private createProgressCallback(
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): (message: string) => Promise<void> {
    return (message: string) => this.writeStatus(writer, message);
  }

  private async handleNotFound(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    repoData: GitHubRepo,
    ctx: DocGenerationContext,
  ): Promise<CacheEntry> {
    const { owner, repo } = repoData;

    const notFoundMarkdown = `# ${repo}\n\nRepository not found or has no README.\n\nThis usually means:\n- The repository doesn't exist\n- The repository has no README file\n- GitHub API rate limit exceeded (60 requests/hour without token)`;

    await writer.write(this.encoder.encode(`\n${notFoundMarkdown}`));

    trackRepoView(this.env, owner, repo, ctx.skipCache ? "BYPASS" : "MISS", ResultStatus.NOT_FOUND);

    const entry: CacheEntry = {
      markdown: notFoundMarkdown,
      isCli: false,
      generatedAt: new Date().toISOString(),
      source: "github",
    };

    await this.cache.set(owner, repo, entry);

    return entry;
  }

  private async handleError(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    error: unknown,
    repoData: GitHubRepo,
    ctx: DocGenerationContext,
  ): Promise<void> {
    const { owner, repo } = repoData;

    const rateLimitError = this.parseRateLimitError(error);
    if (rateLimitError) {
      await this.writeRateLimitError(writer, rateLimitError);
      trackRepoView(this.env, owner, repo, ctx.skipCache ? "BYPASS" : "MISS", ResultStatus.RATE_LIMITED);
      return;
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[Streaming] Error:", error);

    await this.writeGenericError(writer, owner, repo, errorMessage);
    trackRepoView(this.env, owner, repo, ctx.skipCache ? "BYPASS" : "MISS", ResultStatus.ERROR);
  }

  private parseRateLimitError(error: unknown): RateLimitError | null {
    if (error instanceof RateLimitError) {
      return error;
    }

    if (error instanceof Error && error.message.startsWith(RATE_LIMIT_PREFIX)) {
      const resetTime = error.message.slice(RATE_LIMIT_PREFIX.length);
      return new RateLimitError(resetTime);
    }

    return null;
  }

  private async writeRateLimitError(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    error: RateLimitError,
  ): Promise<void> {
    await writer.write(
      this.encoder.encode(
        `\n\n# Rate Limit Exceeded\n\nAI rate limit has been reached.\n\nThe limit resets at: ${error.resetTime.toLocaleString()}\n\nPlease try again after the reset time.`,
      ),
    );
  }

  private async writeGenericError(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    owner: string,
    repo: string,
    errorMessage: string,
  ): Promise<void> {
    await writer.write(
      this.encoder.encode(
        `\n\n# Error\n\nFailed to fetch documentation for ${owner}/${repo}.\n\nError: ${errorMessage}\n\nPlease try again later.`,
      ),
    );
  }

  private async writeLine(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    line: string,
  ): Promise<void> {
    await writer.write(this.encoder.encode(line + "\n"));
  }

  private async writeStatus(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    message: string,
  ): Promise<void> {
    await writer.write(this.encoder.encode(`> ${message}\n`));
  }

  private calculateFilesAnalyzed(files: readonly string[]): number {
    return files.filter((file) =>
      CLI_FILE_PATTERNS.some((pattern) => pattern.test(file)),
    ).length;
  }

  private trackSuccess(repoData: GitHubRepo, ctx: DocGenerationContext): void {
    const generationTimeMs = Date.now() - ctx.startTime;
    trackRepoView(
      this.env,
      repoData.owner,
      repoData.repo,
      ctx.skipCache ? "BYPASS" : "MISS",
      ResultStatus.SUCCESS,
      generationTimeMs,
      this.filesAnalyzed,
    );
  }
}

export async function handleStreamingGeneration(
  repoData: GitHubRepo,
  env: Env,
  cache: Cache,
  skipCache: boolean,
  ctx: ExecutionContext,
): Promise<Response> {
  const githubTimeout = env.GITHUB_TIMEOUT_MS
    ? parseInt(env.GITHUB_TIMEOUT_MS, 10)
    : DEFAULT_GITHUB_TIMEOUT_MS;
  const github = new GitHubClient(env.GITHUB_TOKEN || null, githubTimeout);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const generationCtx: DocGenerationContext = {
    startTime: Date.now(),
    skipCache,
  };

  const service = new DocGenerationService(env, cache, github);

  const backgroundWork = async () => {
    try {
      await service.execute(repoData, generationCtx, writer);
    } finally {
      await writer.close();
    }
  };

  ctx.waitUntil(backgroundWork());

  return new Response(readable, {
    headers: {
      "Content-Type": CONTENT_TYPE.MARKDOWN,
      "X-Cache": skipCache ? "BYPASS" : "MISS",
      "Transfer-Encoding": "chunked",
      "Cache-Control": CACHE_CONTROL.NO_CACHE,
    },
  });
}
