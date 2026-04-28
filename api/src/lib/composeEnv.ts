import { randomBytes } from 'crypto';

export interface ComposeEnvVar {
  name: string;
  required: boolean;
  defaultValue?: string;
  isSecret: boolean;
}

const SECRET_PATTERN = /PASSWORD|SECRET|KEY|TOKEN|APIKEY/i;

// Matches ${VAR}, ${VAR?msg}, ${VAR:?msg}, ${VAR:-default}, ${VAR-default}
// Only captures names matching [A-Z_][A-Z0-9_]*
const INTERPOLATION_RE =
  /\$\{([A-Z_][A-Z0-9_]*)(?::?(\?[^}]*|-[^}]*))?\}/g;

export function extractEnvVars(yamlText: string): ComposeEnvVar[] {
  const map = new Map<string, ComposeEnvVar>();

  let match: RegExpExecArray | null;
  INTERPOLATION_RE.lastIndex = 0;

  while ((match = INTERPOLATION_RE.exec(yamlText)) !== null) {
    const name = match[1];
    const modifier: string | undefined = match[2]; // e.g. ":-default", "-default", "?msg", ":?msg"

    let required = true;
    let defaultValue: string | undefined;

    if (modifier !== undefined) {
      if (modifier.startsWith(':-') || modifier.startsWith('-')) {
        // optional with default
        required = false;
        defaultValue = modifier.startsWith(':-')
          ? modifier.slice(2)
          : modifier.slice(1);
      }
      // ?msg and :?msg keep required = true, no default
    }

    const existing = map.get(name);

    if (existing) {
      // Default wins: if either occurrence is optional, treat as optional
      if (!required) {
        existing.required = false;
        existing.defaultValue = defaultValue;
        existing.isSecret = false; // required is now false
      }
      // If new occurrence is required but existing is already optional, leave it
    } else {
      const isSecret = SECRET_PATTERN.test(name) && required;
      map.set(name, { name, required, defaultValue, isSecret });
    }
  }

  return Array.from(map.values());
}

export function generateSecretValue(length = 32): string {
  if (length % 2 !== 0) {
    // round up to nearest even number for hex output
    length = length + 1;
  }
  return randomBytes(length / 2).toString('hex');
}
