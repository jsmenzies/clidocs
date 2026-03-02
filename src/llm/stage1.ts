// Stage 1: Cheap LLM to verify if repo is a CLI tool
// Currently returns mock data

import { GitHubRepo } from '../types';

export async function verifyIsCliTool(
  repo: GitHubRepo,
  readme: string,
  ai?: any
): Promise<{ isCli: boolean; confidence: number }> {
  // MOCK IMPLEMENTATION
  // In production, this would call a cheap LLM (Llama 3.1 8B or GPT-4o-mini)
  
  console.log(`[Stage 1] Verifying if ${repo.owner}/${repo.repo} is a CLI tool...`);
  
  // Simple heuristic for now
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
    'binary'
  ];
  
  const hasCliIndicators = cliIndicators.some(indicator => 
    lowerReadme.includes(indicator)
  );
  
  // Mock: Assume popular repos with "commander" or "cli" in name are CLI tools
  const isLikelyCli = hasCliIndicators || 
    repo.repo.includes('cli') || 
    repo.repo.includes('command');

  return {
    isCli: isLikelyCli,
    confidence: isLikelyCli ? 0.85 : 0.3
  };
}
