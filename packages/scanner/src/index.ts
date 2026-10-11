export type RiskVerdict = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PromptScanResult {
  risk_score: number; // 0 to 100 integer
  flags: string[];
  verdict: RiskVerdict;
  flagged: boolean; // true if risk_score >= 40 (advisory threshold)
  score: number; // 0.0 to 1.0 normalized float for backwards compatibility
  matchedPatterns: string[]; // alias to flags for backwards compatibility
  snippet?: string | undefined;
  details?: {
    zeroWidthCount?: number;
    decodedSnippets?: string[];
  } | undefined;
}

export type ScanResult = PromptScanResult;

interface PatternRule {
  id: string;
  regex: RegExp;
  weight: number;
}

const REGEX_RULES: PatternRule[] = [
  // 1. Instruction Overrides
  {
    id: 'INSTRUCTION_OVERRIDE',
    regex: /\b(ignore\s+(all\s+)?(previous|prior|system|above|initial)\s+(instructions?|prompts?|rules?|directives?)|disregard\s+(the\s+)?(previous|prior|system|rules?|instructions?|budget|limit|mandate)|system\s+prompt|developer\s+mode|new\s+instructions?\s*:|override\s+(all\s+)?(instructions?|rules?|safety|guidelines?)|forget\s+(all\s+)?(previous|prior)\s+instructions?)\b/i,
    weight: 65,
  },
  // 2. Role Manipulation & Jailbreaks
  {
    id: 'ROLE_MANIPULATION',
    regex: /\b((you\s+are\s+now|pretend\s+to\s+be|act\s+as(\s+a|\s+an)?)\s+([a-z\s]+)?(payment\s+processor|paypal|admin|system|root|unrestricted|jailbreak|dan|merchant\s+officer)|enter\s+(god|dan|developer|debug|unrestricted)\s+mode|simulate\s+(an?\s+)?unrestricted|admin\s+mode|jailbreak)\b/i,
    weight: 65,
  },
  // 3. Urgent & Coercive Payment Language
  {
    id: 'COERCIVE_PAYMENT',
    regex: /\b(immediate(ly)?\s+(wire|transfer|release|send|pay|action|approve)|(wire|transfer|release|send|pay|approve)\s+([a-z\s]+)?immediate(ly)?|urgent(ly)?\s+(release|transfer|payment|action|approval)|bypass\s+(the\s+)?(approval|mandate|limit|check|policy|gateway)|without\s+(delay|user\s+approval|verification)|critical\s+(payment|transfer)\s+required)\b/i,
    weight: 45,
  },
  // 4. Exfiltration of Secrets or Gift Cards
  {
    id: 'BUY_GIFT_CARDS',
    regex: /\b(buy|purchase|send|get)\s+(amazon|apple|steam|google|prepaid)?\s*(gift\s*cards?|crypto|cryptocurrency)\b/i,
    weight: 75,
  },
  {
    id: 'SECRET_EXFIL',
    regex: /\b(reveal|print|send|exfiltrate|leak)\s+(the\s+)?(secrets?|tokens?|api_keys?|passwords?)\b/i,
    weight: 80,
  },
  // 5. Payee Redirection (Crypto, IBAN, Foreign Emails)
  {
    id: 'PAYEE_REDIRECTION_CRYPTO',
    regex: /\b(0x[a-fA-F0-9]{40}|(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39})\b/,
    weight: 75,
  },
  {
    id: 'PAYEE_REDIRECTION_IBAN',
    regex: /\b([A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}|account\s*(number|no)?\s*:\s*\d{6,})\b/i,
    weight: 70,
  },
  {
    id: 'FOREIGN_PAYEE_EMAIL',
    regex: /\b[a-zA-Z0-9._%+-]+@(?!demo-store\.local|mandatepay\.local)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/i,
    weight: 50,
  },
  // 6. Hidden HTML/CSS Text (spec.md §6)
  {
    id: 'HIDDEN_TEXT',
    regex: /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*transparent|color\s*:\s*(white|#fff|#ffffff)\s*;\s*background(-color)?\s*:\s*(white|#fff|#ffffff))/i,
    weight: 60,
  },
  // 7. Hex / Escaped Obfuscation
  {
    id: 'HEX_OBFUSCATION',
    regex: /(?:\\x[0-9a-fA-F]{2}){4,}|(?:\\u[0-9a-fA-F]{4}){4,}/,
    weight: 50,
  },
];

function isZeroWidthCode(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0xfeff ||
    code === 0x2060 ||
    code === 0x00ad ||
    (code >= 0x202a && code <= 0x202e)
  );
}

function countZeroWidthCharacters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (isZeroWidthCode(text.charCodeAt(i))) {
      count++;
    }
  }
  return count;
}

function stripZeroWidthCharacters(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (!isZeroWidthCode(text.charCodeAt(i))) {
      result += text[i];
    }
  }
  return result;
}

const BASE64_CANDIDATE_REGEX = /\b[A-Za-z0-9+/]{20,}={0,2}\b/g;

/**
 * Pure, deterministic advisory heuristics scanner for indirect prompt injection,
 * role manipulation, coercive payment attempts, and obfuscated payloads (spec.md §5, §6, NFR-2).
 * Absolutely ZERO external network or LLM dependencies.
 */
export function scanPromptInjection(content: string): PromptScanResult {
  if (!content || typeof content !== 'string') {
    return {
      risk_score: 0,
      flags: [],
      verdict: 'LOW',
      flagged: false,
      score: 0,
      matchedPatterns: [],
    };
  }

  const matchedFlags: string[] = [];
  const weights: number[] = [];
  let firstSnippet: string | undefined;

  // --------------------------------------------------------------------------
  // 1. Zero-width character inspection & deobfuscation
  // --------------------------------------------------------------------------
  const zeroWidthCount = countZeroWidthCharacters(content);
  if (zeroWidthCount >= 2) {
    matchedFlags.push('ZERO_WIDTH_OBFUSCATION');
    weights.push(65);
    firstSnippet = firstSnippet ?? `Zero-width characters detected (count: ${zeroWidthCount})`;
  }

  // Normalized content without zero-width characters for regex analysis
  const normalizedContent = stripZeroWidthCharacters(content);

  // --------------------------------------------------------------------------
  // 2. Base64 payload detection & inspection
  // --------------------------------------------------------------------------
  const decodedSnippets: string[] = [];
  const base64Matches = normalizedContent.match(BASE64_CANDIDATE_REGEX);
  if (base64Matches) {
    for (const b64 of base64Matches) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        // Only inspect if it decoded into printable ASCII text
        if (/^[\x20-\x7E\s]+$/.test(decoded) && decoded.length >= 8) {
          decodedSnippets.push(decoded);
          if (
            /\b(ignore|system|prompt|bypass|paypal|transfer|admin|payment|instruction|wire)\b/i.test(
              decoded,
            )
          ) {
            matchedFlags.push('ENCODED_PAYLOAD');
            weights.push(75);
            firstSnippet = firstSnippet ?? `Base64 payload decodes to: "${decoded.slice(0, 40)}..."`;
            break;
          }
        }
      } catch {
        // Ignore unparseable candidates
      }
    }
  }

  // --------------------------------------------------------------------------
  // 3. Regex Heuristics (Evaluated against both raw & normalized text)
  // --------------------------------------------------------------------------
  for (const rule of REGEX_RULES) {
    const rawMatch = rule.regex.exec(content);
    const normMatch = rule.regex.exec(normalizedContent);
    const match = rawMatch ?? normMatch;

    if (match) {
      if (!matchedFlags.includes(rule.id)) {
        matchedFlags.push(rule.id);
        weights.push(rule.weight);
        if (!firstSnippet && match[0]) {
          firstSnippet = match[0];
        }
      }
      // Backwards-compatible flag alias for instruction overrides
      if (rule.id === 'INSTRUCTION_OVERRIDE' && !matchedFlags.includes('IGNORE_SYSTEM_PROMPT')) {
        matchedFlags.push('IGNORE_SYSTEM_PROMPT');
      }
    }
  }

  // --------------------------------------------------------------------------
  // 4. Deterministic Cumulative Scoring
  // --------------------------------------------------------------------------
  let riskScore = 0;
  if (weights.length > 0) {
    // Highest severity rule sets the base
    const sortedWeights = [...weights].sort((a, b) => b - a);
    const maxWeight = sortedWeights[0] ?? 0;
    // Additional rules add cumulative risk
    const remainingWeights = sortedWeights.slice(1);
    const additionalBonus = remainingWeights.reduce((acc, curr) => acc + curr * 0.25, 0);
    riskScore = Math.min(100, Math.round(maxWeight + additionalBonus));
  }

  // --------------------------------------------------------------------------
  // 5. Verdict Classification
  // HIGH: >= 70 (triggers DENY in P-10)
  // MEDIUM: >= 40 (triggers STEP_UP in P-10)
  // LOW: < 40
  // --------------------------------------------------------------------------
  let verdict: RiskVerdict = 'LOW';
  if (riskScore >= 70) {
    verdict = 'HIGH';
  } else if (riskScore >= 40) {
    verdict = 'MEDIUM';
  }

  return {
    risk_score: riskScore,
    flags: matchedFlags,
    verdict,
    flagged: riskScore >= 40,
    score: Number((riskScore / 100).toFixed(2)),
    matchedPatterns: matchedFlags,
    snippet: firstSnippet,
    details: {
      ...(zeroWidthCount > 0 ? { zeroWidthCount } : {}),
      ...(decodedSnippets.length > 0 ? { decodedSnippets } : {}),
    },
  };
}

/**
 * Backwards-compatible alias for scanPromptInjection.
 */
export const scanAdvisoryText = scanPromptInjection;
