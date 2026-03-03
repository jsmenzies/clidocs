import { Env, HandlerContext, ParseResult } from "../types";
import { Cache } from "../cache";
import { handleStreamingGeneration } from "../handlers/streaming";
import { validateApiKey } from "../handlers/auth";
import { trackRepoView } from "../utils/analytics";
import { CONTENT_TYPE, CACHE_CONTROL } from "../constants/headers";

function parseRepoParams(pathname: string): ParseResult {
  const pathWithoutSlash = pathname.slice(1);
  const parts = pathWithoutSlash.split("/");

  if (parts.length !== 2) {
    return {
      success: false,
      error: new Response(
        `# Error\n\nInvalid URL format. Use: clidocs.io/owner/repo\n\nExample: clidocs.io/tj/commander.js`,
        {
          status: 400,
          headers: {
            "Content-Type": CONTENT_TYPE.MARKDOWN,
            "X-Error": "invalid-path",
          },
        }
      ),
    };
  }

  const [owner, repo] = parts;

  if (!owner || !repo) {
    return {
      success: false,
      error: new Response(`# Error\n\nMissing owner or repo name.`, {
        status: 400,
        headers: { "Content-Type": CONTENT_TYPE.MARKDOWN },
      }),
    };
  }

  return {
    success: true,
    data: { owner, repo },
  };
}

function shouldSkipCache(url: URL): boolean {
  return url.searchParams.has("nocache") || url.searchParams.has("refresh");
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "Unauthorized - API key required",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": CONTENT_TYPE.JSON,
        "WWW-Authenticate": "Bearer",
      },
    }
  );
}

async function getCachedResponse(
  cache: Cache,
  owner: string,
  repo: string,
  env: Env
): Promise<Response | null> {
  const cached = await cache.get(owner, repo);
  if (!cached) return null;

  trackRepoView(env, owner, repo, "HIT", "success");
  return new Response(cached.markdown, {
    headers: {
      "Content-Type": CONTENT_TYPE.MARKDOWN,
      "X-Cache": "HIT",
      "X-Generated-At": cached.generatedAt,
      "X-Is-Cli": String(cached.isCli),
      "X-Auth": env.GITHUB_TOKEN ? "token" : "none",
      "Cache-Control": CACHE_CONTROL.ONE_DAY,
    },
  });
}

export async function handleDocsRoute({
  request,
  env,
  ctx,
  url,
}: HandlerContext): Promise<Response> {
  const parseResult = parseRepoParams(url.pathname);
  if (!parseResult.success) {
    return parseResult.error;
  }

  const { owner, repo } = parseResult.data;
  const skipCache = shouldSkipCache(url);
  const cache = new Cache(env);

  if (skipCache) {
    const authResult = validateApiKey(request, env);
    if (!authResult.valid) {
      return authResult.response ?? unauthorized();
    }
  }

  if (!skipCache) {
    const cachedResponse = await getCachedResponse(cache, owner, repo, env);
    if (cachedResponse) {
      return cachedResponse;
    }
  }

  return handleStreamingGeneration(
    { owner, repo },
    env,
    cache,
    skipCache,
    ctx
  );
}
