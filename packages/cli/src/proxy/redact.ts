/**
 * Best-effort secret redaction, applied to the *stored copy* of each frame —
 * never to the live protocol stream. On by default: recording other people's
 * tool traffic should be safe before it is convenient.
 *
 * Patterns are deliberately conservative (long, high-entropy, well-known
 * shapes) to keep false positives rare. Replacements never contain quotes or
 * backslashes, so redacting inside a JSON string keeps the JSON valid.
 */

interface Pattern {
  label: string;
  regex: RegExp;
  replace: (match: RegExpExecArray) => string;
}

const tag = (label: string): string => `[REDACTED:${label}]`;

const DEFAULT_PATTERNS: Pattern[] = [
  {
    label: "api-key",
    // OpenAI/Anthropic/Stripe-style prefixed keys (sk-, sk-ant-, rk-, pk_live_ …).
    regex: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b|\b[ps]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replace: () => tag("api-key"),
  },
  {
    label: "aws-key-id",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => tag("aws-key-id"),
  },
  {
    label: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replace: () => tag("github-token"),
  },
  {
    label: "slack-token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => tag("slack-token"),
  },
  {
    label: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => tag("jwt"),
  },
  {
    label: "bearer",
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    replace: () => `Bearer ${tag("bearer")}`,
  },
  {
    label: "credential-field",
    // "password": "…", "api_key": "…" and friends inside plain JSON bodies.
    // (Escaped-JSON-inside-JSON is not covered yet; tracked for later.)
    regex:
      /"(password|passwd|secret|token|api_key|apikey|access_token|refresh_token|client_secret|private_key)"\s*:\s*"(?:[^"\\]|\\.){1,512}"/gi,
    replace: (m) => `"${m[1]}": "${tag("credential")}"`,
  },
];

export class Redactor {
  private readonly patterns: Pattern[];

  constructor(extra?: RegExp) {
    this.patterns = [...DEFAULT_PATTERNS];
    if (extra !== undefined) {
      this.patterns.push({
        label: "custom",
        regex: new RegExp(extra.source, extra.flags.includes("g") ? extra.flags : extra.flags + "g"),
        replace: () => tag("custom"),
      });
    }
  }

  /** From MCPWATCH_REDACT / MCPWATCH_REDACT_EXTRA; null = redaction disabled. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Redactor | null {
    if (env.MCPWATCH_REDACT === "0" || env.MCPWATCH_REDACT === "false") return null;
    const extra = env.MCPWATCH_REDACT_EXTRA;
    try {
      return new Redactor(extra !== undefined && extra !== "" ? new RegExp(extra) : undefined);
    } catch {
      process.stderr.write(`[mcpwatch] invalid MCPWATCH_REDACT_EXTRA regex; using defaults\n`);
      return new Redactor();
    }
  }

  redact(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    for (const pattern of this.patterns) {
      out = out.replace(pattern.regex, (...args) => {
        count += 1;
        const match = args as unknown as RegExpExecArray;
        return pattern.replace(match);
      });
    }
    return { text: out, count };
  }
}
