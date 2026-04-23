function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function headingName(line: string): string | null {
  const match = line.match(/^##\s+(.+?)\s*#*\s*$/);
  return match ? normalizeHeading(match[1]) : null;
}

function findSectionBounds(markdown: string, heading: string): { start: number; end: number; lines: string[] } | null {
  const lines = markdown.split(/\r?\n/);
  const target = normalizeHeading(heading);
  const start = lines.findIndex((line) => headingName(line) === target);

  if (start < 0) {
    return null;
  }

  const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return {
    start,
    end: next < 0 ? lines.length : next,
    lines,
  };
}

export function extractMarkdownSection(markdown: string, heading: string): string | null {
  const bounds = findSectionBounds(markdown, heading);
  if (!bounds) {
    return null;
  }

  const section = bounds.lines.slice(bounds.start, bounds.end).join("\n").trim();
  return section.length > 0 ? section : null;
}

export function removeMarkdownSection(markdown: string, heading: string): string {
  const bounds = findSectionBounds(markdown, heading);
  if (!bounds) {
    return markdown.trim();
  }

  return [...bounds.lines.slice(0, bounds.start), ...bounds.lines.slice(bounds.end)].join("\n").trim();
}
