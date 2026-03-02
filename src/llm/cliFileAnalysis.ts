import { RepoContents, CliFileAnalysis } from '../types';

// Language-specific CLI indicators
const CLI_INDICATORS: Record<string, {
  files: string[];
  patterns: RegExp[];
  directories: string[];
}> = {
  node: {
    files: ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    patterns: [
      /^(bin|cli|cmd)\//,
      /^src\/(cli|bin|commands)\//,
      /\/(cli|bin|commands)\//,
    ],
    directories: ['bin', 'cli', 'cmd', 'src/cli', 'src/bin', 'src/commands']
  },
  go: {
    files: ['go.mod', 'go.sum', 'main.go', 'Makefile'],
    patterns: [
      /^cmd\//,
      /^main\.go$/,
      /\/main\.go$/,
      /_test\.go$/,
    ],
    directories: ['cmd']
  },
  python: {
    files: ['setup.py', 'pyproject.toml', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    patterns: [
      /^([a-z_]+)\/__main__\.py$/,
      /^cli\.py$/,
      /^main\.py$/,
      /\/cli\.py$/,
      /\/__main__\.py$/,
    ],
    directories: []
  },
  rust: {
    files: ['Cargo.toml', 'Cargo.lock'],
    patterns: [
      /^src\/main\.rs$/,
      /\/main\.rs$/,
      /^src\/bin\//,
    ],
    directories: ['src/bin']
  },
  ruby: {
    files: ['Gemfile', '*.gemspec'],
    patterns: [
      /^bin\//,
      /^exe\//,
      /^lib\/.+\/cli\.rb$/,
    ],
    directories: ['bin', 'exe']
  }
};

// CLI framework indicators
const CLI_FRAMEWORKS: Record<string, RegExp[]> = {
  node: [
    /"commander"/, /"yargs"/, /"meow"/, /"minimist"/, /"arg"/, 
    /"oclif"/, /"ink"/, /"pastel"/
  ],
  go: [
    /"cobra"/, /"urfave\/cli"/, /"spf13\/cobra"/, /"kingpin"/, 
    /"flag".*package/
  ],
  python: [
    /argparse/, /click/, /typer/, /docopt/, /fire/, /plac/
  ],
  rust: [
    /clap/, /structopt/, /argh/, /gumdrop/
  ],
  ruby: [
    /thor/, /clamp/, /commander/, /mercenary/
  ]
};

export function analyzeRepoForCliFiles(contents: RepoContents): CliFileAnalysis {
  const { files, directories } = contents;
  const indicators: string[] = [];
  const entryPointFiles: string[] = [];
  const configFiles: string[] = [];

  let detectedLanguage: 'node' | 'go' | 'python' | 'rust' | 'ruby' | 'unknown' = 'unknown';
  let isCliTool = false;
  let confidence = 0;

  // Detect language
  if (files.some(f => f === 'package.json' || f === 'package-lock.json')) {
    detectedLanguage = 'node';
    indicators.push('Node.js project detected (package.json)');
    confidence += 0.2;
  } else if (files.some(f => f === 'go.mod' || f === 'Cargo.toml' || f === 'setup.py' || f === 'Gemfile')) {
    if (files.some(f => f === 'go.mod')) {
      detectedLanguage = 'go';
      indicators.push('Go project detected (go.mod)');
    } else if (files.some(f => f === 'Cargo.toml')) {
      detectedLanguage = 'rust';
      indicators.push('Rust project detected (Cargo.toml)');
    } else if (files.some(f => f === 'setup.py' || f === 'pyproject.toml')) {
      detectedLanguage = 'python';
      indicators.push('Python project detected (setup.py/pyproject.toml)');
    } else if (files.some(f => f === 'Gemfile')) {
      detectedLanguage = 'ruby';
      indicators.push('Ruby project detected (Gemfile)');
    }
    confidence += 0.2;
  }

  // Check for CLI-specific files and patterns
  if (detectedLanguage !== 'unknown') {
    const langConfig = CLI_INDICATORS[detectedLanguage];

    // Check for CLI directories
    for (const dir of langConfig.directories) {
      if (directories.some(d => d.startsWith(dir) || d === dir)) {
        indicators.push(`CLI directory found: ${dir}/`);
        confidence += 0.15;
      }
    }

    // Check for CLI file patterns
    for (const pattern of langConfig.patterns) {
      const matches = files.filter(f => pattern.test(f));
      if (matches.length > 0) {
        for (const match of matches) {
          if (!entryPointFiles.includes(match)) {
            entryPointFiles.push(match);
          }
        }
        indicators.push(`CLI entry point pattern match: ${pattern.source}`);
        confidence += 0.1;
      }
    }

    // Check for CLI-specific files
    for (const file of langConfig.files) {
      if (files.includes(file)) {
        configFiles.push(file);
      }
    }
  }

  // Check for shell completions (strong CLI indicator)
  const completionFiles = files.filter(f => 
    f.includes('completion') || 
    f.endsWith('.zsh') || 
    f.endsWith('.bash') ||
    f.endsWith('.fish') ||
    f.includes('/completions/')
  );
  if (completionFiles.length > 0) {
    indicators.push(`Shell completions found: ${completionFiles.length} files`);
    confidence += 0.2;
  }

  // Check for man pages
  const manPages = files.filter(f => 
    f.startsWith('man/') || 
    f.includes('/man/') ||
    f.endsWith('.1') ||
    f.endsWith('.8')
  );
  if (manPages.length > 0) {
    indicators.push(`Man pages found: ${manPages.length} files`);
    confidence += 0.15;
  }

  // Check for Docker (might be CLI tool container)
  if (files.some(f => f === 'Dockerfile' || f === 'docker-compose.yml')) {
    indicators.push('Docker configuration found');
    confidence += 0.05;
  }

  // Determine if it's a CLI tool based on confidence threshold
  isCliTool = confidence >= 0.3;

  return {
    language: detectedLanguage,
    isCliTool,
    confidence: Math.min(confidence, 0.95),
    indicators,
    entryPointFiles,
    configFiles
  };
}

// Helper to fetch and analyze specific config files
export async function fetchConfigFileContent(
  owner: string,
  repo: string,
  filePath: string,
  token: string | null
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`;
  
  const headers: Record<string, string> = {
    'User-Agent': 'clidocs/0.1.0'
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  try {
    const response = await fetch(url, { headers });
    if (response.ok) {
      return await response.text();
    }
  } catch (error) {
    console.error(`Error fetching ${filePath}:`, error);
  }
  
  return null;
}

// Analyze package.json for CLI indicators
export function analyzePackageJson(content: string): { isCli: boolean; binEntries: string[] } {
  try {
    const pkg = JSON.parse(content);
    const binEntries: string[] = [];
    
    // Check for bin field
    if (pkg.bin) {
      if (typeof pkg.bin === 'string') {
        binEntries.push(pkg.name || 'cli');
      } else if (typeof pkg.bin === 'object') {
        binEntries.push(...Object.keys(pkg.bin));
      }
    }
    
    // Check for preferGlobal
    if (pkg.preferGlobal === true) {
      return { isCli: true, binEntries };
    }
    
    // Check keywords
    if (pkg.keywords && Array.isArray(pkg.keywords)) {
      const cliKeywords = ['cli', 'command-line', 'terminal', 'tool'];
      if (cliKeywords.some(kw => pkg.keywords.some((k: string) => k.toLowerCase().includes(kw)))) {
        return { isCli: true, binEntries };
      }
    }
    
    return { isCli: binEntries.length > 0, binEntries };
  } catch (error) {
    return { isCli: false, binEntries: [] };
  }
}

// Analyze Go module for CLI indicators
export function analyzeGoMod(content: string): { isCli: boolean; hasMain: boolean } {
  const hasMain = content.includes('package main') || content.includes('func main()');
  const cliPatterns = [
    /github\.com\/spf13\/cobra/,
    /github\.com\/urfave\/cli/,
    /github\.com\/alecthomas\/kingpin/,
    /github\.com\/palantir\/pkg\/cobra/,
  ];
  
  const hasCliFramework = cliPatterns.some(pattern => pattern.test(content));
  
  return {
    isCli: hasMain || hasCliFramework,
    hasMain
  };
}

// Analyze Cargo.toml for CLI indicators
export function analyzeCargoToml(content: string): { isCli: boolean; hasBin: boolean } {
  const hasBin = content.includes('[[bin]]') || /^\[\[bin\]\]/m.test(content);
  const hasClap = content.includes('clap') || content.includes('structopt');
  
  return {
    isCli: hasBin || hasClap,
    hasBin
  };
}

// Analyze Python setup for CLI indicators
export function analyzePythonSetup(content: string): { isCli: boolean; entryPoints: string[] } {
  const entryPoints: string[] = [];
  
  // Check for console_scripts
  const consoleScriptsMatch = content.match(/console_scripts\s*=\s*\[([^\]]+)\]/s);
  if (consoleScriptsMatch) {
    const scripts = consoleScriptsMatch[1].match(/['"]([^'"]+)['"]/g);
    if (scripts) {
      scripts.forEach(script => {
        const clean = script.replace(/['"]/g, '');
        if (clean.includes('=')) {
          entryPoints.push(clean.split('=')[0].trim());
        }
      });
    }
  }
  
  // Check for entry_points
  if (content.includes('entry_points') || content.includes('console_scripts')) {
    return { isCli: entryPoints.length > 0, entryPoints };
  }
  
  return { isCli: false, entryPoints };
}