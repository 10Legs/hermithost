import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
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
