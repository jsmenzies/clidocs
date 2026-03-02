<div align="center">

# clidocs

Instant CLI documentation from source code.

Paste any GitHub URL and get comprehensive command docs.

</div>

---

## Usage

```
https://clidocs.io/owner/repo
```

### How it works

1. Parses repository structure (Cargo.toml, package.json, etc.)
2. Identifies CLI entry points and command definitions
3. Analyzes source code with AI
4. Returns markdown documentation with commands, flags, and examples

### Query Parameters

- `?refresh=true` - Bypass cache and regenerate
- `?nocache=true` - Skip cache read (still writes)

### Examples

- [clidocs.io/vercel/next.js](https://clidocs.io/vercel/next.js) — Next.js CLI
- [clidocs.io/vitejs/vite](https://clidocs.io/vitejs/vite) — Vite
- [clidocs.io/pnpm/pnpm](https://clidocs.io/pnpm/pnpm) — pnpm package manager
- [clidocs.io/tj/commander.js](https://clidocs.io/tj/commander.js) — Commander.js

---

<div align="center">

*AI-generated docs • ~2-3s latency • 30-day cache*

</div>
