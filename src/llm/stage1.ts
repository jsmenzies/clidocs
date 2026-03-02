// Stage 1: Cloudflare AI to verify if repo is a CLI tool
// Uses Llama 3.1 8B for fast, free binary classification

import { GitHubRepo } from '../types';

interface AiVerificationResponse {
  isCli: boolean;
  confidence: number;
  reasoning?: string;
}

export async function verifyIsCliTool(
  repo: GitHubRepo,
  readme: string,
  ai?: any
): Promise<{ isCli: boolean; confidence: number }> {
  console.log(`[Stage 1] Verifying if ${repo.owner}/${repo.repo} is a CLI tool using Cloudflare AI...`);
  
  // Fallback to regex if AI is not available
  if (!ai) {
    console.log('[Stage 1] AI not available, using regex fallback');
    return regexFallback(repo, readme);
  }
  
  // Truncate README if too long (Llama 3.1 8B has context limits)
  const truncatedReadme = readme.length > 8000 
    ? readme.substring(0, 8000) + '\n\n[README truncated due to length...]'
    : readme;
  
  const prompt = `You are an expert at identifying CLI tools from GitHub READMEs. 

Question: Is "${repo.owner}/${repo.repo}" primarily a CLI (command-line interface) tool?

A CLI tool is a program that users install and run from the terminal/command line with commands like:
- tool-name --help
- npx tool-name
- npm install -g tool-name
- tool-name command --option

IMPORTANT: Libraries/SDKs that developers import into code are NOT CLI tools. Only tools that end users run from the command line are CLI tools.

Look for these CLI indicators in the README:
- Global installation instructions (-g flag, npx, brew install, etc.)
- Terminal/command line usage examples
- Binary/executable files mentioned
- Command descriptions and options
- Keywords: CLI, command-line, terminal, binary, executable, "run from command line"

Repository: ${repo.owner}/${repo.repo}

Do you know this is a CLI tool? Answer with ONLY a JSON object:
{"isCli": true/false, "confidence": 0.0-1.0, "reasoning": "brief explanation"}

README:
\`\`\`
${truncatedReadme}
\`\`\`

JSON response:`;

  try {
    // Call Cloudflare AI with Llama 3.1 8B
    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: prompt,
      max_tokens: 150,
      temperature: 0.1 // Low temperature for consistent results
    });
    
    const responseText = response?.response || '';
    console.log('[Stage 1] AI response:', responseText);
    
    // Parse JSON from AI response
    const jsonMatch = responseText.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed: AiVerificationResponse = JSON.parse(jsonMatch[0]);
      console.log(`[Stage 1] Parsed result: isCli=${parsed.isCli}, confidence=${parsed.confidence}`);
      return {
        isCli: parsed.isCli,
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5))
      };
    }
    
    // If JSON parsing fails, use regex fallback
    console.log('[Stage 1] Failed to parse AI response, using regex fallback');
    return regexFallback(repo, readme);
    
  } catch (error) {
    console.error('[Stage 1] AI error:', error);
    console.log('[Stage 1] Falling back to regex');
    return regexFallback(repo, readme);
  }
}

function regexFallback(
  repo: GitHubRepo,
  readme: string
): { isCli: boolean; confidence: number } {
  console.log('[Stage 1] Running regex fallback...');
  
  const lowerReadme = readme.toLowerCase();
  const cliIndicators = [
    'cli',
    'command-line',
    'command line',
    'terminal',
    'shell',
    'npm install -g',
    'global install',
    'npx',
    'binary',
    'executable'
  ];
  
  let score = 0;
  cliIndicators.forEach(indicator => {
    if (lowerReadme.includes(indicator)) {
      score += 1;
    }
  });
  
  // Bonus for repo name containing cli/command keywords
  if (repo.repo.includes('cli') || repo.repo.includes('command')) {
    score += 2;
  }
  
  const isCli = score >= 2;
  const confidence = Math.min(0.95, 0.3 + (score * 0.1));
  
  console.log(`[Stage 1] Regex result: isCli=${isCli}, confidence=${confidence}, score=${score}`);
  
  return {
    isCli,
    confidence
  };
}
