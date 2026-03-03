export interface HandlerContext {
  request: Request;
  env: import("./env").Env;
  ctx: ExecutionContext;
  url: URL;
}

export interface ParsedRepoParams {
  success: true;
  data: import("./github").GitHubRepo;
}

export interface ParseError {
  success: false;
  error: Response;
}

export type ParseResult = ParsedRepoParams | ParseError;
