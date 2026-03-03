import { Env, HandlerContext } from "./types";
import { serveFavicon } from "./routes/favicon";
import { redirectHome } from "./routes/home";
import { handleDocsRoute } from "./routes/docs";

const routes: Array<{
  match: (path: string) => boolean;
  handler: (ctx: HandlerContext) => Promise<Response> | Response;
}> = [
  {
    match: (p) => p === "/favicon.ico" || p === "/favicon.svg",
    handler: serveFavicon,
  },
  {
    match: (p) => p === "/" || p === "",
    handler: redirectHome,
  },
  {
    match: () => true,
    handler: handleDocsRoute,
  },
];

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const route =
      routes.find((r) => r.match(url.pathname)) ?? routes[routes.length - 1]!;

    return route.handler({ request, env, ctx, url });
  },
};
