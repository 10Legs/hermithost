#!/usr/bin/env node
// Record a PR demo video: drives a real browser through a named scenario against this
// checkout's frontend build and writes an MP4 and a GIF.
//
//   node demos/record.mjs <scenario> [--before <git-ref>] [--mobile] [--out <dir>]
//
//   <scenario>       demos/scenarios/<scenario>.mjs
//   --before <ref>   also record the same scenario on <ref> (e.g. origin/main) first, so a
//                    bug fix shows the case that used to fail, then this PR
//   --mobile         add a phone-viewport segment (only for screens used on phones)
//   --out <dir>      output directory (default .scratch/demos/<scenario>)
//
// The HermitHost API and external sites are stubbed inside the browser (demos/fixtures.mjs),
// so recordings use only test data and need no running stack.
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, VIEWPORT, MOBILE_VIEWPORT, prepareBuild, removeBuild, startServer, installOverlay, captionFn, encode } from './lib.mjs';

const args = process.argv.slice(2);
const name = args[0];
if (!name || name.startsWith('-')) {
	console.error('usage: node demos/record.mjs <scenario> [--before <git-ref>] [--mobile] [--out <dir>]');
	process.exit(1);
}
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const before = opt('--before');
const outDir = path.resolve(opt('--out') ?? path.join(ROOT, '.scratch', 'demos', name));
const scenario = (await import(path.join(ROOT, 'demos', 'scenarios', `${name}.mjs`))).default;

const segments = [];
if (before) segments.push({ ref: before, label: `BEFORE · ${before.replace(/^origin\//, '')}`, viewport: VIEWPORT });
segments.push({ ref: null, label: before ? 'AFTER · this PR' : '', viewport: VIEWPORT });
if (args.includes('--mobile')) segments.push({ ref: null, label: 'AFTER · this PR (mobile)', viewport: MOBILE_VIEWPORT, mobile: true });

const work = path.join(outDir, '.raw');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// DEMO_CHROMIUM: optional path to an already-installed Chromium/headless-shell binary.
const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM || undefined });
const videos = [];
let port = 4310;
for (const seg of segments) {
	const dir = prepareBuild(seg.ref);
	const server = await startServer(dir, ++port);
	const segDir = path.join(work, String(videos.length));
	try {
		const context = await browser.newContext({
			viewport: seg.viewport,
			recordVideo: { dir: segDir, size: seg.viewport },
			isMobile: !!seg.mobile,
			hasTouch: !!seg.mobile,
			baseURL: `http://127.0.0.1:${port}`,
		});
		await installOverlay(context, seg.label);
		await scenario.setup?.(context);
		const page = await context.newPage();
		await scenario.run(page, { caption: captionFn(page), label: seg.label, before: seg.label.startsWith('BEFORE'), mobile: !!seg.mobile });
		await page.waitForTimeout(800);
		await context.close();
		videos.push(path.join(segDir, readdirSync(segDir).find((f) => f.endsWith('.webm'))));
	} finally {
		server.kill();
		removeBuild(dir);
	}
}
await browser.close();
const out = encode(videos, path.join(outDir, name));
rmSync(work, { recursive: true, force: true });
console.log(`demo written:\n  ${out.mp4}\n  ${out.gif}`);
