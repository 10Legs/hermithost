// Shared helpers for PR demo recordings (see demos/README.md).
// Nothing here is imported by the app; demos/ is excluded from Docker builds.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const VIEWPORT = { width: 1280, height: 800 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

/**
 * Check out <ref> into a throwaway git worktree (or use the current checkout when ref is
 * null), build the frontend there and return its directory.
 */
export function prepareBuild(ref) {
	let dir = ROOT;
	if (ref) {
		dir = path.join(ROOT, '.scratch', `demo-${ref.replace(/[^A-Za-z0-9._-]/g, '_')}`);
		rmSync(dir, { recursive: true, force: true });
		execFileSync('git', ['worktree', 'prune'], { cwd: ROOT });
		sh('git', ['worktree', 'add', '--detach', '-f', dir, ref], { cwd: ROOT });
		if (!existsSync(path.join(dir, 'node_modules'))) {
			symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
		}
	}
	sh('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: dir });
	return dir;
}

export function removeBuild(dir) {
	if (dir !== ROOT) {
		try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT }); } catch { /* ignore */ }
	}
}

/** Serve <dir>/build (adapter-node) on 127.0.0.1:<port>. API calls never reach it: scenarios stub them. */
export async function startServer(dir, port) {
	const proc = spawn('node', ['build/index.js'], {
		cwd: dir,
		env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: `http://127.0.0.1:${port}` },
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	for (let i = 0; i < 50; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/login`)).ok) return proc; } catch { /* starting */ }
		await new Promise((r) => setTimeout(r, 200));
	}
	proc.kill();
	throw new Error(`frontend build in ${dir} did not start on :${port}`);
}

/**
 * On-screen captions + a segment label, injected into every page load.
 * ctx.caption(text, ms) shows a caption and holds it long enough to read.
 */
export async function installOverlay(context, label) {
	await context.addInitScript((lbl) => {
		const mount = () => {
			if (document.getElementById('__demo_caption')) return;
			const bar = document.createElement('div');
			bar.id = '__demo_caption';
			bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 22px;'
				+ 'background:rgba(15,23,42,.92);color:#fff;font:600 19px/1.35 system-ui,sans-serif;'
				+ 'text-align:center;pointer-events:none;';
			bar.textContent = sessionStorage.getItem('__demo_caption') || '';
			bar.style.display = bar.textContent ? 'block' : 'none';
			document.body.appendChild(bar);
			if (lbl) {
				const tag = document.createElement('div');
				tag.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;padding:6px 12px;'
					+ 'border-radius:6px;font:700 14px system-ui,sans-serif;color:#fff;pointer-events:none;'
					+ `background:${lbl.startsWith('BEFORE') ? '#b91c1c' : '#15803d'};`;
				tag.textContent = lbl;
				document.body.appendChild(tag);
			}
		};
		if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
	}, label);
}

export function captionFn(page) {
	return async (text, holdMs = 2200) => {
		await page.evaluate((t) => {
			sessionStorage.setItem('__demo_caption', t);
			const bar = document.getElementById('__demo_caption');
			if (bar) { bar.textContent = t; bar.style.display = t ? 'block' : 'none'; }
		}, text);
		await page.waitForTimeout(holdMs);
	};
}

/** Draw attention to an element for the viewer. */
export async function highlight(locator) {
	await locator.evaluate((el) => {
		el.style.outline = '4px solid #f59e0b';
		el.style.outlineOffset = '3px';
		el.scrollIntoView({ block: 'center', behavior: 'instant' });
	});
}

/** Convert segment videos (webm) into one MP4 and one GIF. */
export function encode(segments, outBase) {
	mkdirSync(path.dirname(outBase), { recursive: true });
	const mp4s = segments.map((webm, i) => {
		const out = `${outBase}.part${i}.mp4`;
		sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
			'-r', '25', '-vf', 'scale=1280:-2', out]);
		return out;
	});
	const list = `${outBase}.parts.txt`;
	execFileSync('sh', ['-c', `printf "file '%s'\\n" ${mp4s.map((p) => `'${p}'`).join(' ')} > '${list}'`]);
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', `${outBase}.mp4`]);
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${outBase}.mp4`, '-vf',
		'fps=6,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
		`${outBase}.gif`]);
	for (const f of [...mp4s, list]) rmSync(f, { force: true });
	return { mp4: `${outBase}.mp4`, gif: `${outBase}.gif` };
}
