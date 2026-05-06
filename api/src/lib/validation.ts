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
