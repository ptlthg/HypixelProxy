import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	platform: 'node',
	target: 'node24',
	outDir: 'dist',
	clean: true,
	sourcemap: true,
	minify: false,
	outExtensions: () => ({ js: '.js' }),
	deps: {
		alwaysBundle: [
			/^@hono\/node-server(?:\/|$)/,
			/^hono(?:\/|$)/,
			'ipaddr.js',
			'rate-limiter-flexible',
			'smol-toml',
		],
		onlyBundle: false,
		onlyImport: [],
	},
});
