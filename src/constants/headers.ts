// Shared header constants used across multiple files
export const CONTENT_TYPE = {
  MARKDOWN: "text/markdown; charset=utf-8",
  JSON: "application/json",
  SVG: "image/svg+xml",
} as const;

export const CACHE_CONTROL = {
  ONE_DAY: "public, max-age=86400",
  NO_CACHE: "no-cache",
} as const;
