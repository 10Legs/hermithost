import { execSync } from 'child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const gitCommit = (() => {
	try { return execSync('git rev-parse --short HEAD').toString().trim(); }
	catch { return 'dev'; }
})();

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__GIT_COMMIT__: JSON.stringify(gitCommit)
	},
	server: {
		port: 5113,
		proxy: {
			'/api': {
				target: 'http://localhost:3013',
				changeOrigin: true
			}
		}
	}
});
