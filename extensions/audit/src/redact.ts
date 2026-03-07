import type { AuditConfig } from "./config-schema.js";

type ParamRedactOptions = {
  enabled: boolean;
  paramFields: string[];
};

function resolveParamRedactOptions(cfg: AuditConfig): ParamRedactOptions {
  return {
    enabled: cfg.redact?.enabled !== false,
    paramFields: cfg.redact?.paramFields ?? [
      "token",
      "secret",
      "password",
      "passwd",
      "key",
      "appSecret",
      "encryptKey",
    ],
  };
}

function isSensitiveKey(key: string, sensitiveFields: string[]): boolean {
  const lower = key.toLowerCase();
  return sensitiveFields.some((f) => lower === f.toLowerCase() || lower.endsWith(`.${f.toLowerCase()}`));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= 4 ? "***" : `${value.slice(0, 2)}***`;
  }
  return "***";
}

/**
 * Recursively redact sensitive fields from tool params.
 * Only processes plain objects/arrays; leaves primitives untouched unless the key is sensitive.
 */
function redactObject(
  obj: unknown,
  sensitiveFields: string[],
  depth = 0,
): unknown {
  // Guard against deep nesting
  if (depth > 8) {
    return "[nested]";
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, sensitiveFields, depth + 1));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(k, sensitiveFields)) {
        result[k] = redactValue(v);
      } else {
        result[k] = redactObject(v, sensitiveFields, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

export class AuditRedactor {
  private readonly opts: ParamRedactOptions;

  constructor(cfg: AuditConfig) {
    this.opts = resolveParamRedactOptions(cfg);
  }

  /** Redact sensitive fields from tool parameters */
  redactParams(params: Record<string, unknown>): Record<string, unknown> {
    if (!this.opts.enabled) {
      return params;
    }
    return redactObject(params, this.opts.paramFields, 0) as Record<string, unknown>;
  }

  /** Redact a plain text string using the core redactSensitiveText utility */
  redactText(text: string): string {
    if (!this.opts.enabled) {
      return text;
    }
    // Lazy import to avoid circular deps; core re-exports redactSensitiveText
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { redactSensitiveText } = require("openclaw/plugin-sdk") as {
        redactSensitiveText: (text: string) => string;
      };
      return redactSensitiveText(text);
    } catch {
      return text;
    }
  }
}
