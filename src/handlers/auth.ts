import { Env } from '../types';

export interface AuthResult {
  valid: boolean;
  response?: Response;
}

// Helper function to validate API key authentication
export function validateApiKey(request: Request, env: Env): AuthResult {
  const authHeader = request.headers.get('Authorization');
  const expectedApiKey = env.ADMIN_API_KEY;

  if (!authHeader || !authHeader.startsWith('Bearer ') || !expectedApiKey) {
    return {
      valid: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized - API key required'
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer'
          }
        }
      )
    };
  }

  const providedApiKey = authHeader.slice(7); // Remove 'Bearer ' prefix
  if (providedApiKey !== expectedApiKey) {
    return {
      valid: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized - Invalid API key'
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    };
  }

  return { valid: true };
}
