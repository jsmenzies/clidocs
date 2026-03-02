# clidocs

Real-time CLI documentation from GitHub repos.

## What is this?

clidocs.io is a service that automatically generates CLI documentation for any GitHub repository. Simply visit:

```
clidocs.io/owner/repo
```

Example:
- `clidocs.io/tj/commander.js` - Documentation for Commander.js
- `clidocs.io/vercel/next.js` - Next.js CLI docs

## Features

- **30-day cache** - Fast responses, reduced API calls
- **Two-stage LLM** - Cheap verification + premium documentation generation
- **Pure markdown** - Perfect for AI agents and developers
- **Cache invalidation** - Add `?refresh=true` to force update

## Architecture

- **Cloudflare Workers** - Edge deployment
- **Cloudflare KV** - 30-day caching
- **GitHub API** - Fetch repository READMEs
- **LLM Pipeline**:
  - Stage 1: Cheap LLM verifies if repo is a CLI tool
  - Stage 2: Premium LLM generates structured documentation

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure wrangler:
   ```bash
   # Add your GitHub token
   wrangler secret put GITHUB_TOKEN
   
   # Create KV namespace (or use existing)
   wrangler kv:namespace create "CLIDOCS_CACHE"
   ```

3. Update `wrangler.toml` with your KV namespace ID

4. Deploy:
   ```bash
   npm run deploy
   ```

## Development

```bash
npm run dev
```

## Current Status

🚧 **MVP with mock data** - LLM integration pending

The current version uses mock data and simple heuristics. To enable real LLM processing:

1. Add Cloudflare AI binding to `wrangler.toml`:
   ```toml
   [[ai]]
   binding = "AI"
   ```

2. Or integrate external LLM APIs (OpenAI, Anthropic)

3. Update `src/llm/stage1.ts` and `src/llm/stage2.ts` with actual LLM calls

## License

MIT
