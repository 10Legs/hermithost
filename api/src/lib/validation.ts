/**
 * Shared validation helpers — single source of truth for FQDN, slug, and
 * domain-safety regexes. Used by api/src/routes/sites.ts.
 *
 * NOTE: docker-proxy (sidecar/docker-proxy/src/index.ts) has its own tsconfig
 * and cannot import from api/. If you update these regexes, keep the copies in
 * docker-proxy in sync (search for "// SYNC: validation.ts").
 */

/** Validates a fully-qualified domain name (labels separated by dots, no trailing dot). */
export const FQDN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Validates a Coolify UUID-style slug (alphanumeric only). */
export const SLUG_RE = /^[a-z0-9]+$/i;

/**
 * Matches any character that is dangerous inside a Traefik YAML template:
 * backtick, single quote, double quote, dollar sign, newline, carriage return,
 * open brace, close brace.
 */
export const DOMAIN_DANGEROUS_CHARS_RE = /[`'"$\n\r{}]/;

export function isValidFqdn(s: string): boolean {
  return FQDN_RE.test(s);
}

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function domainHasDangerousChars(s: string): boolean {
  return DOMAIN_DANGEROUS_CHARS_RE.test(s);
}

// ── Site name / description ──────────────────────────────────────────────────
// The deploy engine (4.7+) rejects names and descriptions outside these
// patterns with a 422. Mirror them here so users get a clear 400 instead.
const SITE_NAME_RE = /^[\p{L}\p{M}\p{N}\s\-_.@/&()#,:+]+$/u;
const SITE_DESCRIPTION_RE = /^[\p{L}\p{M}\p{N}\s\-_.,!?()'"+=*@/&]+$/u;
const SITE_TEXT_MAX = 255;
const SITE_NAME_MIN = 3;

/** Replace typographic dashes and quotes with the ASCII forms the engine accepts. */
export function normalizeSiteText(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/…/g, '...');
}

/** Returns an error message, or null when the engine will accept the name. */
export function siteNameError(name: string): string | null {
  if (name.length < SITE_NAME_MIN) return `Site name must be at least ${SITE_NAME_MIN} characters`;
  if (name.length > SITE_TEXT_MAX) return `Site name must be at most ${SITE_TEXT_MAX} characters`;
  if (!SITE_NAME_RE.test(name)) {
    return 'Site name may only contain letters, numbers, spaces, and - _ . / @ & ( ) # , : +';
  }
  return null;
}

/** Returns an error message, or null when the engine will accept the description. */
export function siteDescriptionError(description: string): string | null {
  if (description === '') return null;
  if (description.length > SITE_TEXT_MAX) return `Description must be at most ${SITE_TEXT_MAX} characters`;
  if (!SITE_DESCRIPTION_RE.test(description)) {
    return 'Description may only contain letters, numbers, spaces, and - _ . , ! ? ( ) \' " + = * / @ &';
  }
  return null;
}

/**
 * Best-effort repair for names and descriptions that came from somewhere other
 * than a user (e.g. an old backup): normalize, drop rejected characters, trim
 * to length. Names shorter than the minimum are padded with "-site".
 */
export function sanitizeSiteName(name: string): string {
  let s = [...normalizeSiteText(name)].filter((c) => SITE_NAME_RE.test(c)).join('').trim();
  s = s.slice(0, SITE_TEXT_MAX).trim();
  if (s.length < SITE_NAME_MIN) s = `${s}-site`.replace(/^-/, '');
  return s;
}

export function sanitizeSiteDescription(description: string): string {
  return [...normalizeSiteText(description)]
    .filter((c) => SITE_DESCRIPTION_RE.test(c))
    .join('')
    .trim()
    .slice(0, SITE_TEXT_MAX)
    .trim();
}
