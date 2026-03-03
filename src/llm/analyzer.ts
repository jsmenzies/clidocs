import { Env, GitHubRepo, RepoContents, AIBinding } from '../types';
import { checkRateLimit } from '../rateLimiter';
import { createLogger, Logger } from '../utils/logger';


// Parallel map utility with concurrency limit
async function pMap<T, R>(
  items: T[],
  mapper: (item: T) => Promise<R>,
  options: { concurrency: number }
): Promise<R[]> {
  const results: R[] = [];
  const { concurrency } = options;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }

  return results;
}

// Helper to fetch file content from GitHub
async function fetchConfigFileContent(
  owner: string,
  repo: string,
  filePath: string,
  token: string | null,
  timeoutMs: number = 10000,
  log?: Logger
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`;

  const headers: Record<string, string> = {
    'User-Agent': 'clidocs/0.1.0'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      return await response.text();
    }
  } catch (error) {
    if (log) {
      log.error(`Error fetching ${filePath}:`, error);
    } else {
      console.error(`Error fetching ${filePath}:`, error);
    }
  }

  return null;
}

interface CliFileContent {
  path: string;
  content: string;
}

export async function analyzeAndGenerateDocsWithStreaming(
  repo: GitHubRepo,
  readme: string,
  contents: RepoContents,
  token: string | null,
  ai?: AIBinding,
  env?: Env,
  progressCallback?: (message: string) => Promise<void>
): Promise<{ markdown: string; isCli: boolean }> {
  const log = createLogger(repo);
  
  log.log(`Processing ${repo.owner}/${repo.repo}...`);
  log.log(`Repo has ${contents.files.length} files`);

  if (!ai) {
    log.log('AI not available, using basic extraction');
    return {
      markdown: generateBasicMarkdown(repo, readme, contents),
      isCli: detectCliFromFiles(contents)
    };
  }

  // Check rate limit before using AI
  if (env) {
    const rateLimit = await checkRateLimit(env, 'ai');
    if (!rateLimit.allowed) {
      log.log(`AI rate limit exceeded. Reset at ${rateLimit.resetTime}`);
      throw new Error(`RATE_LIMIT_EXCEEDED:${rateLimit.resetTime.toISOString()}`);
    }
    log.log(`Rate limit check passed. Remaining: ${rateLimit.remaining}`);
  }

  // Get config values with defaults
  const maxFilesToAnalyze = env?.MAX_FILES_TO_ANALYZE ? parseInt(env.MAX_FILES_TO_ANALYZE, 10) : 50;
  const maxFileContentSize = env?.MAX_FILE_CONTENT_SIZE ? parseInt(env.MAX_FILE_CONTENT_SIZE, 10) : 10000;
  const maxReadmeSize = env?.MAX_README_SIZE ? parseInt(env.MAX_README_SIZE, 10) : 5000;
  const aiMaxTokens = env?.AI_MAX_TOKENS ? parseInt(env.AI_MAX_TOKENS, 10) : 4000;
  const aiTemperature = env?.AI_TEMPERATURE ? parseFloat(env.AI_TEMPERATURE) : 0.2;
  const rawGithubTimeoutMs = env?.GITHUB_TIMEOUT_MS ? parseInt(env.GITHUB_TIMEOUT_MS, 10) : 10000;

  // Step 1: Use heuristic to pre-select likely CLI files (no AI)
  log.log('Pre-selecting CLI files...');
  if (progressCallback) {
    await progressCallback('Identifying CLI-related files...');
  }
  const preselectedFiles = await heuristicFileSelection(repo, contents, token, maxFilesToAnalyze, rawGithubTimeoutMs, log);
  log.log(`Pre-selected ${preselectedFiles.length} files`);

  if (progressCallback) {
    await progressCallback(`Found ${preselectedFiles.length} potential CLI files`);
  }

  if (preselectedFiles.length === 0) {
    log.log('No CLI files detected');
    return {
      markdown: generateNotCliMarkdown(repo, readme),
      isCli: false
    };
  }

  // Step 2: Fetch file contents
  log.log('Fetching file contents...');
  if (progressCallback) {
    await progressCallback('Fetching file contents...');
  }
  const fileContents = await fetchFiles(repo, preselectedFiles, token, maxFileContentSize, rawGithubTimeoutMs, log);

  if (progressCallback) {
    await progressCallback(`Fetched ${fileContents.length} files`);
  }

  if (fileContents.length === 0) {
    log.log('Failed to fetch any files');
    return {
      markdown: generateBasicMarkdown(repo, readme, contents),
      isCli: true
    };
  }

  log.log(`Successfully fetched ${fileContents.length} files`);

  // Step 3: Single AI call to analyze everything and generate docs
  log.log('Analyzing and generating documentation...');
  if (progressCallback) {
    await progressCallback('Generating documentation with AI...');
  }
  const markdown = await analyzeAndGenerateWithAI(repo, readme, fileContents, contents, ai, env, maxReadmeSize, aiMaxTokens, aiTemperature, log);
  
  if (progressCallback) {
    await progressCallback('Documentation generated successfully');
  }

  return { markdown, isCli: true };
}

async function heuristicFileSelection(
  repo: GitHubRepo,
  contents: RepoContents,
  token: string | null,
  maxFiles: number = 50,
  rawGithubTimeoutMs: number = 10000,
  log: Logger
): Promise<string[]> {
  const selected = new Set<string>();
  const fileSet = new Set(contents.files);

  // Helper to add files up to a limit
  const addFiles = (files: string[], limit: number) => {
    for (const file of files) {
      if (selected.size >= limit) break;
      if (!file.includes('_test') && !file.includes('test')) {
        selected.add(file);
      }
    }
  };

  // Priority 1: Config files with CLI metadata
  const configFiles = [
    'package.json', 'Cargo.toml', 'Cargo.lock', 'setup.py', 'setup.cfg',
    'pyproject.toml', 'go.mod', 'go.sum', 'Gemfile', '*.gemspec'
  ];
  
  for (const pattern of configFiles) {
    if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace('*', '.*'));
      for (const file of contents.files) {
        if (regex.test(file)) selected.add(file);
      }
    } else if (fileSet.has(pattern)) {
      selected.add(pattern);
    }
  }

  // Parse Cargo.toml for [[bin]] entries (Rust projects)
  if (fileSet.has('Cargo.toml')) {
    try {
      const cargoContent = await fetchConfigFileContent(repo.owner, repo.repo, 'Cargo.toml', token, rawGithubTimeoutMs, log);
      if (cargoContent) {
        const binMatches = cargoContent.matchAll(/\[\[bin\]\][^\[]*?path\s*=\s*"([^"]+)"/gs);
        for (const match of binMatches) {
          const binPath = match[1];
          if (fileSet.has(binPath)) {
            selected.add(binPath);
            log.log(`Found bin entry in Cargo.toml: ${binPath}`);
          }
        }
      }
    } catch (e) {
      log.error('Error parsing Cargo.toml:', e);
    }
  }

  // Priority 2: Language-specific CLI directories and patterns
  const cliPatterns = [
    { pattern: /cmd\/[^/]+\/main\.go$/, limit: 25 },
    { pattern: /^(src\/main\.rs|.*\/src\/main\.rs)$/, limit: 30 },
    { pattern: /src\/bin\/.*\.rs$/, limit: 35 },
    { pattern: /crates\/[^/]+\/src\/main\.rs$/, limit: 40 },
    { pattern: /src\/bin\/[^/]+\/main\.(c|cpp)$|src\/backend\/[^/]+\/main\.(c|cpp)$|^src\/main\.c$|\/main\.c$/, limit: 45 },
  ];

  for (const { pattern, limit } of cliPatterns) {
    const matches = contents.files.filter(f => pattern.test(f));
    addFiles(matches, limit);
  }

  // General CLI directories
  const cliDirs = ['bin/', 'cli/', 'src/cli/', 'src/cmd/'];
  const cliDirFiles = contents.files.filter(f => 
    cliDirs.some(dir => f.includes(dir)) && !f.includes('test') && !f.includes('_test.')
  );
  addFiles(cliDirFiles, 35);

  // Priority 3: Main entry points by language
  const entryPoints = [
    'main.go', 'cmd/root.go', 'index.js', 'cli.ts', 'cli.js',
    'src/main.rs', 'main.rs', '__main__.py', 'main.py', 'cli.py',
    'main.c', 'main.cpp', 'src/main.c', 'src/main.cpp',
    'bin/console', 'exe/console', 'lib/cli.rb'
  ];
  
  for (const file of entryPoints) {
    if (selected.size >= 40) break;
    if (fileSet.has(file)) selected.add(file);
  }

  // Priority 4: Documentation files
  const docFiles = ['README.md', 'README.rst', 'CONTRIBUTING.md', 'docs/CLI.md', 'docs/cli.md'];
  for (const file of docFiles) {
    if (selected.size >= 45) break;
    if (fileSet.has(file)) selected.add(file);
  }

  return Array.from(selected).slice(0, maxFiles);
}

async function fetchFiles(
  repo: GitHubRepo,
  filePaths: string[],
  token: string | null,
  maxSize: number = 10000,
  timeoutMs: number = 10000,
  log: Logger
): Promise<CliFileContent[]> {
  const results = await pMap(
    filePaths,
    async (filePath) => {
      const content = await fetchConfigFileContent(repo.owner, repo.repo, filePath, token, timeoutMs, log);
      if (!content) return null;
      
      const truncated = content.length > maxSize 
        ? content.substring(0, maxSize) + '\n\n[File truncated...]'
        : content;
      
      return { path: filePath, content: truncated };
    },
    { concurrency: 10 }
  );

  return results.filter((r): r is CliFileContent => r !== null);
}

async function analyzeAndGenerateWithAI(
  repo: GitHubRepo,
  readme: string,
  fileContents: CliFileContent[],
  allContents: RepoContents,
  ai: AIBinding,
  env: Env | undefined,
  maxReadmeSize: number = 5000,
  maxTokens: number = 4000,
  temperature: number = 0.2,
  log: Logger
): Promise<string> {
  // Build file context
  const fileContext = fileContents.map(file => {
    return `\n### ${file.path}\n\`\`\`${getLanguageFromPath(file.path)}\n${file.content}\n\`\`\``;
  }).join('\n');

  // Show additional files that weren't fetched
  const additionalFiles = allContents.files
    .filter(f => !fileContents.find(fc => fc.path === f))
    .filter(f => 
      f.includes('cmd/') || f.includes('cli/') || f.includes('bin/') ||
      f.includes('option') || f.includes('flag') || f.includes('arg') ||
      f.endsWith('.md')
    )
    .slice(0, 50);

  const additionalContext = additionalFiles.length > 0 
    ? `\n\nAdditional files in repository (not analyzed):\n${additionalFiles.map(f => `- ${f}`).join('\n')}`
    : '';

  // Truncate readme
  const readmeContext = readme.length > maxReadmeSize 
    ? readme.substring(0, maxReadmeSize) + '\n\n[README truncated...]'
    : readme;

  const messages = [
    {
      role: "system",
      content: `You are a technical documentation expert specializing in CLI tools.

YOUR TASK:
Analyze the provided repository files to determine if this is a CLI tool, extract CLI arguments/options, and generate documentation.

LANGUAGE-SPECIFIC CLI DETECTION:
For each language, prioritize and analyze these file patterns to find CLI entry points:
- **Go**: Look for cmd/*/main.go, main.go, any file importing github.com/spf13/cobra, or files defining Command structs
- **Rust**: Prioritize src/bin/**/*.rs, src/main.rs, check Cargo.toml for [[bin]] entries, look for clap/structopt imports
- **C/C++**: Find files containing int main( or argc/argv parameters, especially in root or src/ directories
- **Python**: Look for argparse, click, typer imports; check for if __name__ == "__main__": blocks
- **Node.js**: Prioritize bin/*, cli.js, index.js in package.json bin field, files importing commander/yargs/meow
- **Ruby**: Look for Thor, Clamp, or Commander usage in bin/ or exe/ directories

EXPLICIT ENTRY POINT INSTRUCTIONS:
CRITICAL: Your first priority is finding the CLI entry point:
1. Look for the main() function or equivalent entry point in the files provided
2. Find where command-line arguments are parsed (cobra.Command, argparse.ArgumentParser, etc.)
3. Identify the file that defines available commands/subcommands
4. If multiple binaries exist, document each one separately

CRITICAL RULES:
1. ONLY document what you can verify from the provided files - NEVER hallucinate or invent flags, options, or commands
2. If information is missing, explicitly state what you couldn't find and suggest where it might be located
3. Be conservative - if you're unsure about a flag's purpose, say so
4. Focus exclusively on CLI usage - no programming examples or API documentation
5. For each command/flag, cite which file it came from

OUTPUT FORMAT:
# Installation
[Installation methods you can verify]

# Command Reference
[Commands with flags/options - only what you see in the files]

# Data Location Notes
[Where CLI data was found OR where it might be if not found]

# CLI Examples
[Practical examples based on verified commands]`
    },
    {
      role: "user",
      content: `Analyze this repository and generate CLI documentation.

Repository: ${repo.owner}/${repo.repo}

README:
\`\`\`
${readmeContext}
\`\`\`

Source Files Analyzed (${fileContents.length} files):${fileContext}${additionalContext}

Analyze these files to determine:
1. Is this a CLI tool? (check for bin entries, main functions, CLI imports)
2. What are the CLI commands and flags? (look for argument parsing, command definitions)
3. Where else might CLI data be? (suggest other files to check)

Generate documentation following the format in your instructions. Be explicit about what you found and what you couldn't find.`
    }
  ];

  try {
    const response = await ai.run('@cf/zai-org/glm-4.7-flash', {
      messages,
      max_tokens: maxTokens,
      temperature: temperature
    });

    const generatedContent = response?.choices?.[0]?.message?.content || '';
    log.log(`Generated ${generatedContent.length} characters`);

    return `# ${repo.repo}

Source: github.com/${repo.owner}/${repo.repo}

${generatedContent}

---

*Generated by clidocs.io*
*AI Model: GLM-4.7-Flash via Cloudflare Workers AI*
*Analysis based on ${fileContents.length} source files*${additionalFiles.length > 0 ? ` (+ ${additionalFiles.length} additional files listed)` : ''}`;

  } catch (error) {
    log.error('Documentation generation error:', error);
    return generateBasicMarkdown(repo, readme, allContents);
  }
}

function detectCliFromFiles(contents: RepoContents): boolean {
  const cliIndicators = [
    'package.json', 'Cargo.toml', 'setup.py', 'go.mod',
    'bin/', 'cmd/', 'cli/'
  ];
  
  return contents.files.some(f => 
    cliIndicators.some(indicator => f.includes(indicator))
  );
}

function generateNotCliMarkdown(repo: GitHubRepo, readme: string): string {
  const lines = readme.split('\n');
  const title = lines[0]?.replace(/^#+\s*/, '') || repo.repo;

  return `# ${title}

Source: github.com/${repo.owner}/${repo.repo}

This repository does not appear to be a CLI tool based on its file structure.

---

*Analyzed by clidocs.io*  
*AI Model: GLM-4.7-Flash via Cloudflare Workers AI*`;
}

function generateBasicMarkdown(repo: GitHubRepo, readme: string, contents: RepoContents): string {
  const lines = readme.split('\n');
  const title = lines[0]?.replace(/^#+\s*/, '') || repo.repo;

  const cliFiles = contents.files.filter(f => 
    f.includes('bin/') || f.includes('cmd/') || f.includes('cli/') || 
    f === 'package.json' || f === 'Cargo.toml'
  ).slice(0, 15);

  return `# ${title}

Source: github.com/${repo.owner}/${repo.repo}

**Detected CLI-related files:**
${cliFiles.map(f => `- ${f}`).join('\n')}

## Overview

Please visit the repository for full documentation.

---

*Generated by clidocs.io*
*Note: AI generation unavailable, showing file listing only.*`;
}

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    'js': 'javascript', 'ts': 'typescript', 'go': 'go',
    'py': 'python', 'rs': 'rust', 'rb': 'ruby',
    'json': 'json', 'toml': 'toml', 'yaml': 'yaml', 'yml': 'yaml',
    'md': 'markdown'
  };
  return langMap[ext] || '';
}