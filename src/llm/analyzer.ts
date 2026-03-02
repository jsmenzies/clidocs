import { Env, GitHubRepo, RepoContents } from '../types';
import { fetchConfigFileContent } from './cliFileAnalysis';
import { checkRateLimit } from '../rateLimiter';

interface CliFileContent {
  path: string;
  content: string;
}

export async function analyzeAndGenerateDocs(
  repo: GitHubRepo,
  readme: string,
  contents: RepoContents,
  token: string | null,
  ai?: any,
  env?: Env
): Promise<{ markdown: string; isCli: boolean }> {
  return analyzeAndGenerateDocsWithStreaming(repo, readme, contents, token, ai, env);
}

export async function analyzeAndGenerateDocsWithStreaming(
  repo: GitHubRepo,
  readme: string,
  contents: RepoContents,
  token: string | null,
  ai?: any,
  env?: Env,
  progressCallback?: (message: string) => Promise<void>
): Promise<{ markdown: string; isCli: boolean }> {
  console.log(`[Analyzer] Processing ${repo.owner}/${repo.repo}...`);
  console.log(`[Analyzer] Repo has ${contents.files.length} files`);

  if (!ai) {
    console.log('[Analyzer] AI not available, using basic extraction');
    return {
      markdown: generateBasicMarkdown(repo, readme, contents),
      isCli: detectCliFromFiles(contents)
    };
  }

  // Check rate limit before using AI
  if (env) {
    const rateLimit = await checkRateLimit(env, 'ai');
    if (!rateLimit.allowed) {
      console.log(`[Analyzer] AI rate limit exceeded. Reset at ${rateLimit.resetTime}`);
      throw new Error(`RATE_LIMIT_EXCEEDED:${rateLimit.resetTime.toISOString()}`);
    }
    console.log(`[Analyzer] Rate limit check passed. Remaining: ${rateLimit.remaining}`);
  }

  // Step 1: Use heuristic to pre-select likely CLI files (no AI)
  console.log('[Analyzer] Pre-selecting CLI files...');
  if (progressCallback) {
    await progressCallback('Identifying CLI-related files...');
  }
  const preselectedFiles = await heuristicFileSelection(repo, contents, token);
  console.log(`[Analyzer] Pre-selected ${preselectedFiles.length} files`);

  if (progressCallback) {
    await progressCallback(`Found ${preselectedFiles.length} potential CLI files`);
  }

  if (preselectedFiles.length === 0) {
    console.log('[Analyzer] No CLI files detected');
    return {
      markdown: generateNotCliMarkdown(repo, readme),
      isCli: false
    };
  }

  // Step 2: Fetch file contents
  console.log('[Analyzer] Fetching file contents...');
  if (progressCallback) {
    await progressCallback('Fetching file contents...');
  }
  const fileContents = await fetchFiles(repo, preselectedFiles, token);

  if (progressCallback) {
    await progressCallback(`Fetched ${fileContents.length} files`);
  }

  if (fileContents.length === 0) {
    console.log('[Analyzer] Failed to fetch any files');
    return {
      markdown: generateBasicMarkdown(repo, readme, contents),
      isCli: true
    };
  }

  console.log(`[Analyzer] Successfully fetched ${fileContents.length} files`);

  // Step 3: Single AI call to analyze everything and generate docs
  console.log('[Analyzer] Analyzing and generating documentation...');
  if (progressCallback) {
    await progressCallback('Generating documentation with AI...');
  }
  const markdown = await analyzeAndGenerateWithAI(repo, readme, fileContents, contents, ai);
  
  if (progressCallback) {
    await progressCallback('Documentation generated successfully');
  }

  return { markdown, isCli: true };
}

async function heuristicFileSelection(
  repo: GitHubRepo,
  contents: RepoContents,
  token: string | null
): Promise<string[]> {
  const selected: string[] = [];
  const fileSet = new Set(contents.files);

  // Priority 1: Config files with CLI metadata
  const configFiles = [
    'package.json', 'Cargo.toml', 'Cargo.lock', 'setup.py', 'setup.cfg',
    'pyproject.toml', 'go.mod', 'go.sum', 'Gemfile', '*.gemspec'
  ];
  
  for (const pattern of configFiles) {
    if (pattern.includes('*')) {
      // Handle wildcard patterns
      const regex = new RegExp(pattern.replace('*', '.*'));
      for (const file of contents.files) {
        if (regex.test(file) && !selected.includes(file)) {
          selected.push(file);
        }
      }
    } else if (fileSet.has(pattern) && !selected.includes(pattern)) {
      selected.push(pattern);
    }
  }

  // Parse Cargo.toml for [[bin]] entries (Rust projects)
  if (fileSet.has('Cargo.toml')) {
    try {
      const cargoContent = await fetchConfigFileContent(repo.owner, repo.repo, 'Cargo.toml', token);
      if (cargoContent) {
        // Look for [[bin]] sections with path = "..."
        const binMatches = cargoContent.matchAll(/\[\[bin\]\][^\[]*?path\s*=\s*"([^"]+)"/gs);
        for (const match of binMatches) {
          const binPath = match[1];
          // Convert path like "src/main.rs" or "crates/core/src/main.rs" to the actual file
          if (fileSet.has(binPath) && !selected.includes(binPath)) {
            selected.push(binPath);
            console.log(`[Analyzer] Found bin entry in Cargo.toml: ${binPath}`);
          }
        }
      }
    } catch (e) {
      console.error('[Analyzer] Error parsing Cargo.toml:', e);
    }
  }

  // Priority 2: Language-specific CLI directories and patterns
  // Go: cmd/ directories
  for (const file of contents.files) {
    if (selected.length >= 25) break;
    if (file.match(/cmd\/[^/]+\/main\.go$/) && !file.includes('_test')) {
      if (!selected.includes(file)) {
        selected.push(file);
      }
    }
  }
  
  // Rust: src/main.rs, src/bin/, and workspace crates
  for (const file of contents.files) {
    if (selected.length >= 30) break;
    // Standard src/main.rs
    if ((file === 'src/main.rs' || file.endsWith('/src/main.rs')) && !file.includes('_test')) {
      if (!selected.includes(file)) {
        selected.push(file);
      }
    }
  }
  
  // Rust: src/bin/ directory
  for (const file of contents.files) {
    if (selected.length >= 35) break;
    if (file.match(/src\/bin\/.*\.rs$/) && !file.includes('_test')) {
      if (!selected.includes(file)) {
        selected.push(file);
      }
    }
  }
  
  // Rust: workspace crates (e.g., crates/*/src/main.rs)
  for (const file of contents.files) {
    if (selected.length >= 40) break;
    if (file.match(/crates\/[^/]+\/src\/main\.rs$/) && !file.includes('_test')) {
      if (!selected.includes(file)) {
        selected.push(file);
      }
    }
  }

  // C/C++: Look for main.c or files in src/bin/ directories
  for (const file of contents.files) {
    if (selected.length >= 45) break;
    // Common C binary patterns
    if ((file.match(/src\/bin\/[^/]+\/main\.(c|cpp)$/) ||
         file.match(/src\/backend\/[^/]+\/main\.(c|cpp)$/) ||
         file === 'src/main.c' ||
         file.endsWith('/main.c')) &&
        !file.includes('_test')) {
      if (!selected.includes(file)) {
        selected.push(file);
      }
    }
  }

  // General CLI directories
  const cliDirs = ['bin/', 'cli/', 'src/cli/', 'src/cmd/'];
  for (const file of contents.files) {
    if (selected.length >= 35) break;
    for (const dir of cliDirs) {
      if (file.includes(dir) && !file.includes('test') && !file.includes('_test.')) {
        if (!selected.includes(file)) {
          selected.push(file);
        }
        break;
      }
    }
  }

  // Priority 3: Main entry points by language
  const entryPoints = [
    // Go
    'main.go', 'cmd/root.go', 
    // Node.js
    'index.js', 'cli.ts', 'cli.js',
    // Rust  
    'src/main.rs', 'main.rs',
    // Python
    '__main__.py', 'main.py', 'cli.py',
    // C/C++
    'main.c', 'main.cpp', 'src/main.c', 'src/main.cpp',
    // Ruby
    'bin/console', 'exe/console', 'lib/cli.rb'
  ];
  
  for (const file of entryPoints) {
    if (selected.length >= 40) break;
    if (fileSet.has(file) && !selected.includes(file)) {
      selected.push(file);
    }
  }

  // Priority 4: Documentation files
  const docFiles = ['README.md', 'README.rst', 'CONTRIBUTING.md', 'docs/CLI.md', 'docs/cli.md'];
  for (const file of docFiles) {
    if (selected.length >= 45) break;
    if (fileSet.has(file) && !selected.includes(file)) {
      selected.push(file);
    }
  }

  return selected.slice(0, 50); // Max 50 files
}

async function fetchFiles(
  repo: GitHubRepo,
  filePaths: string[],
  token: string | null
): Promise<CliFileContent[]> {
  const contents: CliFileContent[] = [];

  for (const filePath of filePaths) {
    const content = await fetchConfigFileContent(repo.owner, repo.repo, filePath, token);
    if (content) {
      // Truncate very large files
      const maxSize = 10000;
      const truncated = content.length > maxSize 
        ? content.substring(0, maxSize) + '\n\n[File truncated...]'
        : content;
      
      contents.push({ path: filePath, content: truncated });
    }
  }

  return contents;
}

async function analyzeAndGenerateWithAI(
  repo: GitHubRepo,
  readme: string,
  fileContents: CliFileContent[],
  allContents: RepoContents,
  ai: any
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
  const readmeContext = readme.length > 5000 
    ? readme.substring(0, 5000) + '\n\n[README truncated...]'
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
      max_tokens: 4000,
      temperature: 0.2
    });

    const generatedContent = response?.choices?.[0]?.message?.content || '';
    console.log(`[Analyzer] Generated ${generatedContent.length} characters`);

    return `# ${repo.repo}

Source: github.com/${repo.owner}/${repo.repo}

${generatedContent}

---

*Generated by clidocs.io*
*AI Model: GLM-4.7-Flash via Cloudflare Workers AI*
*Analysis based on ${fileContents.length} source files*${additionalFiles.length > 0 ? ` (+ ${additionalFiles.length} additional files listed)` : ''}`;

  } catch (error) {
    console.error('[Analyzer] Documentation generation error:', error);
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