import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { createApp, parseConfig } from '../src/index.js';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const REAL_KEY = '99999999-9999-4999-8999-999999999999';

const toml = (extra = '') => `
[contributors.alice]
key = "${TOKEN}"
${extra}
`;

const config = (extra = '', env: NodeJS.ProcessEnv = {}) =>
	parseConfig(toml(extra), {
		HYPIXEL_API_KEY: REAL_KEY,
		FORWARDED_FOR_HEADER: 'X-Test-IP',
		...env,
	});

async function upstream(
	handler: (request: IncomingMessage, response: import('node:http').ServerResponse) => void,
) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Missing upstream address');
	}
	return { server, url: `http://127.0.0.1:${address.port}` };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('configuration', () => {
	it('loads contributors and optional settings', () => {
		const result = config('ipWhitelist = ["127.0.0.1/32"]\nrequestsPerMinute = 12');
		assert.equal(result.contributors.size, 1);
		assert.equal(result.contributors.get(TOKEN)?.name, 'alice');
		assert.equal(result.contributors.get(TOKEN)?.limit, 12);
		assert.equal(result.forwardedForHeader, 'X-Test-IP');
		assert.equal(
			config('', { UPSTREAM_USER_AGENT: 'HypixelProxy-Test/1.0' }).userAgent,
			'HypixelProxy-Test/1.0',
		);
	});
});

describe('application', () => {
	it('serves health and rejects unsupported or unauthenticated requests', async () => {
		const app = createApp(config());
		assert.equal((await app.request('/healthz')).status, 200);
		assert.equal((await app.request('/v2/player')).status, 401);
		assert.equal(
			(
				await app.request('/v2/player', {
					method: 'POST',
					headers: { 'API-Key': TOKEN, 'X-Test-IP': '127.0.0.1' },
				})
			).status,
			405,
		);
	});

	it('enforces a contributor IP whitelist', async () => {
		const app = createApp(config('ipWhitelist = ["203.0.113.0/24"]'));
		const denied = await app.request('/v2/player', {
			headers: { 'API-Key': TOKEN, 'X-Test-IP': '198.51.100.1' },
		});
		assert.equal(denied.status, 403);
	});

	it('proxies public Hypixel endpoints without either API key', async () => {
		let received: IncomingMessage | undefined;
		const origin = await upstream((request, response) => {
			received = request;
			response.end('public');
		});

		try {
			const app = createApp(config(), origin.url);
			const response = await app.request('/v2/resources/skyblock/items');

			assert.equal(response.status, 200);
			assert.equal(await response.text(), 'public');
			assert.equal(received?.headers['api-key'], undefined);
		} finally {
			await close(origin.server);
		}
	});

	it('proxies the path and query while replacing and filtering credentials', async () => {
		let received: IncomingMessage | undefined;
		const origin = await upstream((request, response) => {
			received = request;
			response.writeHead(418, { 'RateLimit-Limit': '120', 'X-Upstream': 'yes' });
			response.end('proxied');
		});

		try {
			const app = createApp(
				config('', { UPSTREAM_USER_AGENT: 'HypixelProxy-Test/1.0' }),
				origin.url,
			);
			const response = await app.request(`/v2/player?uuid=a%2Fb&key=${TOKEN}`, {
				headers: {
					Authorization: 'secret',
					Cookie: 'secret=true',
					'X-Test-IP': '127.0.0.1',
				},
			});

			assert.equal(response.status, 418);
			assert.equal(await response.text(), 'proxied');
			assert.equal(response.headers.get('RateLimit-Limit'), '120');
			assert.equal(received?.url, '/v2/player?uuid=a%2Fb');
			assert.equal(received?.headers['api-key'], REAL_KEY);
			assert.equal(received?.headers['user-agent'], 'HypixelProxy-Test/1.0');
			assert.equal(received?.headers.authorization, undefined);
			assert.equal(received?.headers.cookie, undefined);
		} finally {
			await close(origin.server);
		}
	});

	it('applies the configured per-contributor rate limit', async () => {
		let calls = 0;
		const origin = await upstream((_request, response) => {
			calls += 1;
			response.end('ok');
		});

		try {
			const app = createApp(config('requestsPerMinute = 1'), origin.url);
			const request = () =>
				app.request('/v2/player', { headers: { 'API-Key': TOKEN, 'X-Test-IP': '127.0.0.1' } });
			const first = await request();
			const second = await request();

			assert.equal(first.status, 200);
			assert.equal(first.headers.get('X-RateLimit-Remaining'), '0');
			assert.equal(second.status, 429);
			assert.ok(second.headers.has('Retry-After'));
			assert.equal(calls, 1);
		} finally {
			await close(origin.server);
		}
	});

	it('turns upstream timeouts into 504 responses', async () => {
		const origin = await upstream(() => undefined);
		try {
			const app = createApp(config('', { UPSTREAM_TIMEOUT_MS: '20' }), origin.url);
			const response = await app.request('/v2/player', {
				headers: { 'API-Key': TOKEN, 'X-Test-IP': '127.0.0.1' },
			});
			assert.equal(response.status, 504);
		} finally {
			origin.server.closeAllConnections();
			await close(origin.server);
		}
	});
});
