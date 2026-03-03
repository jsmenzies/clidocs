import { Env } from "../types";
import { CONTENT_TYPE } from "../constants/headers";

const BEARER_PREFIX = "Bearer ";

export interface AuthResult {
  valid: boolean;
  response?: Response;
}

function extractBearerToken(header: string | null): string | null {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : null;
}

function createAuthError(message: string, includeChallenge = true): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: `Unauthorized - ${message}`,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": CONTENT_TYPE.JSON,
        ...(includeChallenge && { "WWW-Authenticate": "Bearer" }),
      },
    },
  );
}

export const validateApiKey = (request: Request, env: Env): AuthResult => {
  const token = extractBearerToken(request.headers.get("Authorization"));

  if (!token) {
    return {
      valid: false,
      response: createAuthError("API key required"),
    };
  }

  if (!env.ADMIN_API_KEY) {
    return {
      valid: false,
      response: createAuthError("Server misconfiguration", false),
    };
  }

  if (token !== env.ADMIN_API_KEY) {
    return {
      valid: false,
      response: createAuthError("Invalid API key"),
    };
  }

  return { valid: true };
};
