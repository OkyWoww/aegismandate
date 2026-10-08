export interface ScanResult {
  flagged: boolean;
  score: number; // 0.0 to 1.0 risk level
  matchedPatterns: string[];
  snippet?: string | undefined;
}

const INJECTION_PATTERNS: Array<{ id: string; regex: RegExp; weight: number }> = [
  { id: 'IGNORE_SYSTEM_PROMPT', regex: /ignore\s+(all\s+)?(previous|prior|system)\s+instructions?/i, weight: 0.9 },
  { id: 'DISREGARD_BUDGET', regex: /disregard\s+(the\s+)?(budget|limit|mandate|cap)/i, weight: 0.85 },
  { id: 'BUY_GIFT_CARDS', regex: /(buy|purchase|send)\s+(amazon|apple|steam|google|prepaid)?\s*(gift\s*card|crypto)/i, weight: 0.9 },
  { id: 'SECRET_EXFIL', regex: /(reveal|print|send|exfiltrate|leak)\s+(the\s+)?(secret|token|api_key|password)/i, weight: 0.95 },
  { id: 'ROLE_OVERRIDE', regex: /(you\s+are\s+now|system\s+override|admin\s+mode)/i, weight: 0.75 },
];

/**
 * Scans merchant web content, product descriptions, or cart metadata for indirect prompt injection indicators.
 */
export function scanAdvisoryText(content: string): ScanResult {
  const matches: string[] = [];
  let totalScore = 0;
  let firstSnippet: string | undefined;

  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.regex.exec(content);
    if (match) {
      matches.push(pattern.id);
      totalScore = Math.max(totalScore, pattern.weight);
      if (!firstSnippet && match[0]) {
        firstSnippet = match[0];
      }
    }
  }

  return {
    flagged: matches.length > 0,
    score: Math.min(1.0, totalScore),
    matchedPatterns: matches,
    snippet: firstSnippet,
  };
}
