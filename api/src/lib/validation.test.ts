import { describe, it, expect } from 'vitest';
import {
  normalizeSiteText,
  siteNameError,
  siteDescriptionError,
  sanitizeSiteName,
  sanitizeSiteDescription,
} from './validation';

describe('site name / description rules (deploy engine 4.7)', () => {
  it('accepts ordinary names', () => {
    for (const n of ['my-site', 'Fiddlesticks Farm', 'café.example', 'a/b @ c (1) #2, x: y + z']) {
      expect(siteNameError(n)).toBeNull();
    }
  });

  it('rejects short, long, and disallowed names', () => {
    expect(siteNameError('ab')).toMatch(/at least 3/);
    expect(siteNameError('x'.repeat(256))).toMatch(/at most 255/);
    expect(siteNameError("Ron's blog")).toMatch(/may only contain/);
    expect(siteNameError('rocket 🚀')).toMatch(/may only contain/);
  });

  it('accepts empty and ordinary descriptions, rejects : and #', () => {
    expect(siteDescriptionError('')).toBeNull();
    expect(siteDescriptionError(`Ron's "farm" app, v2 (beta) & more!`)).toBeNull();
    expect(siteDescriptionError('Deployed: repo#1')).toMatch(/may only contain/);
    expect(siteDescriptionError('x'.repeat(256))).toMatch(/at most 255/);
  });

  it('normalizes typographic dashes and quotes', () => {
    expect(normalizeSiteText('Lotería — the game’s “board”…')).toBe(`Lotería - the game's "board"...`);
    expect(siteDescriptionError(normalizeSiteText('Lotería — online'))).toBeNull();
  });

  it('sanitizes legacy values into accepted ones', () => {
    for (const n of ["Ron's blog", 'ab', '🚀', '', 'x'.repeat(300)]) {
      expect(siteNameError(sanitizeSiteName(n))).toBeNull();
    }
    expect(sanitizeSiteName("Ron's blog")).toBe('Rons blog');
    for (const d of ['Deployed: repo#1', 'Lotería — online', 'y'.repeat(300)]) {
      expect(siteDescriptionError(sanitizeSiteDescription(d))).toBeNull();
    }
  });
});
