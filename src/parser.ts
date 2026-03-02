// Fallback regex-based parser when LLMs are not available or fail

export function parseCliSections(readme: string): string {
  const lines = readme.split('\n');
  const sections: string[] = [];
  
  let inCodeBlock = false;
  let currentSection = '';
  
  const cliKeywords = [
    'usage',
    'cli',
    'command',
    'install',
    'getting started',
    'quick start'
  ];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Track code blocks
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
    
    // Look for CLI-related sections
    const isHeader = line.startsWith('#');
    const lowerLine = line.toLowerCase();
    
    if (isHeader) {
      const isCliSection = cliKeywords.some(keyword => 
        lowerLine.includes(keyword)
      );
      
      if (isCliSection && currentSection) {
        sections.push(currentSection);
      }
      
      if (isCliSection) {
        currentSection = line + '\n';
      } else {
        currentSection = '';
      }
    } else if (currentSection) {
      currentSection += line + '\n';
    }
  }
  
  if (currentSection) {
    sections.push(currentSection);
  }
  
  return sections.join('\n---\n') || readme;
}
