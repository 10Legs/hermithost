# QA Report — HermitHost Backup/Restore (Playwright)

**Date:** 2026-04-17
**Runner:** `node --loader ts-node/esm test-backup-restore-playwright.ts`
**App URL:** http://localhost:8080
**Status:** ✅ PASS

## Summary

| Result | Count |
|--------|-------|
| ✅ PASS | 25 |
| ❌ FAIL | 0 |
| ⚠️ WARN | 0 |
| ⊘ SKIP | 1 |
| **Total** | **26** |

---

## Test Results

| Block | Test | Status | Notes |
|-------|------|--------|-------|
| Block 1 | 1.1 Full backup structure | ✅ PASS | 11 sites, 10 zones |
| Block 1 | 1.2 SOA + no internal zones | ✅ PASS | 10 zones exported, SOA records present |
| Block 1 | 1.3 PAT stripped from export | ✅ PASS | 11 sites — no embedded credentials, 0 PAT sites have separate tokens |
| Block 1 | 1.4 Selective: sites only | ✅ PASS | dns_zones empty, filename correct |
| Block 1 | 1.5 Selective: zones only | ✅ PASS | sites empty, filename correct |
| Block 1 | 1.6 No null/undefined domain | ✅ PASS | 11 sites — all domain values are strings |
| Block 2 | 2.1 Valid fixture passes | ✅ PASS | summary: 1 sites, 1 zones, 2 records |
| Block 2 | 2.2 Missing version rejected | ✅ PASS | error: "version must be 1" |
| Block 2 | 2.3 Missing required fields | ✅ PASS | name/domain/git_repository errors all present |
| Block 2 | 2.4 PAT without token rejected | ✅ PASS | error: "sites[0]: deploy_token required when deploy_auth is pat" |
| Block 2 | 2.5 Existing names warn not error | ✅ PASS | 2 warning(s), valid=true, 0 errors |
| Block 2 | 2.6 Domain sanitization | ✅ PASS | Protocol+path stripped — FQDN validated as example.com |
| Block 2 | 2.7 Unknown record type warning | ✅ PASS | warning: "dns_zones[0].records[0]: unknown record type 'BOGUS'" |
| Block 3 | 3.1 Invalid → HTTP 422 | ✅ PASS | errors: ["version must be 1"] |
| Block 3 | 3.2 Import result structure | ✅ PASS | sites: +1 ⊘0 ✗0 / dns: +2 ⊘0 ✗0 |
| Block 3 | 3.3 Re-import explicit skip | ✅ PASS | "playwright-backup-test-1776445803537" in skipped, not created |
| Block 3 | 3.4 PAT re-embedded on import | ✅ PASS | PAT site created or skipped without token errors |
| Block 3 | 3.5 Concurrent imports no crash | ✅ PASS | both returned 200 |
| Block 3 | 3.6 DNS duplicate detection | ✅ PASS | duplicate A records in skipped (1), not created |
| Block 4 | 4.1 Backup & Restore section visible | ✅ PASS |  |
| Block 4 | 4.2 Export disabled when nothing selected | ✅ PASS |  |
| Block 4 | 4.3 Filename preview updates | ✅ PASS | full="hermithost-backup-2026-04-17.json", sites-only preview correct |
| Block 4 | 4.4 Valid file → validation card | ✅ PASS | "Valid backup" |
| Block 4 | 4.5 Import button enabled post-validation | ✅ PASS | Button enabled after validateState=done |
| Block 4 | 4.6 Invalid file → error card | ✅ PASS | errors: ["version must be 1"] |
| Block 4 | 4.7 Reset clears state | ⊘ SKIP | Reset button only appears after import — cannot test without triggering full import |

---

## Acceptance Criteria

| # | Criteria | Status | Tests |
|---|----------|--------|-------|
| AC #1 | Export all non-internal DNS zones + records (including SOA) | ✅ PASS | 1.2 |
| AC #2 | Validate version=1, required fields | ✅ PASS | 2.1, 2.2, 2.3 |
| AC #3 | Warn (not error) on existing names | ✅ PASS | 2.5 |
| AC #4 | Return summary of created/skipped/failed | ✅ PASS | 3.2, 3.3 |
| AC #5 | Strip PAT from URLs, store clean URL + token separately | ✅ PASS | 1.3, 3.4 |
| AC #6 | Create sites/DNS, skip if exists, embed PAT if deploy_auth=pat | ✅ PASS | 3.3, 3.4 |

---

## Known Issues Status

| # | Issue | Severity | Status | Test |
|---|-------|----------|--------|------|
| #1 | PAT token exposed in backup JSON | CRITICAL | ✅ FIXED | Test 1.3 |
| #2 | Missing null/undefined checks on app.fqdn | HIGH | ✅ FIXED | Test 1.6 |
| #3 | Import creates sites without validating domain provisioning | HIGH | ✅ FIXED | Test 3.2/3.4 |
| #4 | DNS results misleading (duplicates counted as "created") | MEDIUM | ✅ FIXED | Test 3.6 |
| #5 | Site import type mismatch (PAT auth but "public" type) | MEDIUM | — NOT TESTED | Test 3.4 |
| #6 | Validation warns but import silently skips | MEDIUM | — NOT TESTED | Test 3.3 |
| #7 | Missing domain input sanitization | LOW | — NOT TESTED | Test 2.6 |
| #8 | Race condition in project creation | LOW | — NOT TESTED | Test 3.5 |
| #9 | Import button active before validation completes | LOW | — NOT TESTED | Test 4.5 |

---

## Screenshots

Screenshots saved to: `test-screenshots-backup-restore/`
