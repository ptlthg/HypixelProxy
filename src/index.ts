import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type HttpBindings, serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import ipaddr from 'ipaddr.js';
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible';
import { parse } from 'smol-toml';

type Range = ReturnType<typeof ipaddr.parseCIDR>;
type RawConfig = {
	contributors?: Record<
		string,
		{ key: string; ipWhitelist?: string[]; requestsPerMinute?: number }
	>;
};

const FORWARDED_HEADERS = [
	'Accept',
	'Accept-Encoding',
	'Cache-Control',
	'If-Modified-Since',
	'If-None-Match',
	'Range',
	'User-Agent',
];
const PUBLIC_ENDPOINTS = new Set([
	'/v2/skyblock/news',
	'/v2/skyblock/auctions',
	'/v2/skyblock/auctions_ended',
	'/v2/skyblock/bazaar',
	'/v2/skyblock/firesales',
]);
const isPublicEndpoint = (path: string) =>
	path.startsWith('/v2/resources/') || PUBLIC_ENDPOINTS.has(path);

const fail = (status: number, cause: string, headers?: HeadersInit) =>
	Response.json({ success: false, cause }, { status, headers });

const parseRange = (value: string): Range => {
	if (value.includes('/')) return ipaddr.parseCIDR(value);
	const address = ipaddr.process(value);
	return [address, address.kind() === 'ipv4' ? 32 : 128];
};

const isAllowed = (ip: string, ranges: Range[]) => {
	if (!ipaddr.isValid(ip)) return false;
	const address = ipaddr.process(ip);
	return ranges.some(
		([range, bits]) => address.kind() === range.kind() && address.match(range, bits),
	);
};

const rateHeaders = (limit: number, remaining: number, resetMs: number) => ({
	'X-RateLimit-Limit': String(limit),
	'X-RateLimit-Remaining': String(remaining),
	'X-RateLimit-Reset': String(Math.ceil(resetMs / 1000)),
});

export function parseConfig(source: string, env: NodeJS.ProcessEnv) {
	const apiKey = env.HYPIXEL_API_KEY;
	if (!apiKey) throw new Error('HYPIXEL_API_KEY is required');

	const { contributors = {} } = parse(source) as RawConfig;
	return {
		apiKey,
		contributors: new Map(
			Object.entries(contributors).map(
				([name, { key, ipWhitelist = [], requestsPerMinute: limit }]) =>
					[
						key,
						{
							name,
							ranges: ipWhitelist.map(parseRange),
							limit,
							limiter: limit ? new RateLimiterMemory({ points: limit, duration: 60 }) : undefined,
						},
					] as const,
			),
		),
		forwardedForHeader: env.FORWARDED_FOR_HEADER,
		userAgent: env.UPSTREAM_USER_AGENT,
		timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 30_000,
	};
}

export function createApp(
	config: ReturnType<typeof parseConfig>,
	upstream = 'https://api.hypixel.net',
) {
	const app = new Hono<{ Bindings: HttpBindings }>();

	app.use('*', async (c, next) => {
		if (c.req.path === '/healthz') return next();
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
			return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
		if (isPublicEndpoint(c.req.path)) return next();

		const contributor = config.contributors.get(
			c.req.header('API-Key') ?? c.req.query('key') ?? '',
		);
		if (!contributor) return fail(401, 'Missing or invalid API key');

		const clientIp = config.forwardedForHeader
			? c.req.header(config.forwardedForHeader)
			: getConnInfo(c).remote.address;
		if (!clientIp || (contributor.ranges.length && !isAllowed(clientIp, contributor.ranges)))
			return fail(403, 'Client IP is not allowed');

		let headers: Record<string, string> | undefined;
		if (contributor.limiter && contributor.limit) {
			try {
				const result = await contributor.limiter.consume('requests');
				headers = rateHeaders(contributor.limit, result.remainingPoints, result.msBeforeNext);
			} catch (error) {
				const result = error as RateLimiterRes;
				const reset = String(Math.ceil(result.msBeforeNext / 1000));
				return fail(429, 'Contributor rate limit exceeded', {
					...rateHeaders(contributor.limit, 0, result.msBeforeNext),
					'Retry-After': reset,
				});
			}
		}

		const started = performance.now();
		await next();
		for (const [name, value] of Object.entries(headers ?? {})) c.res.headers.set(name, value);
		console.log(
			JSON.stringify({
				contributor: contributor.name,
				clientIp,
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				durationMs: Math.round((performance.now() - started) * 100) / 100,
			}),
		);
	});

	app.get('/healthz', (c) => c.json({ status: 'ok' }));
	app.all('/healthz', () => fail(405, 'Method not allowed', { Allow: 'GET' }));
	app.all('*', async (c) => {
		const incoming = new URL(c.req.url);
		incoming.searchParams.delete('key');
		const headers = Object.fromEntries(
			FORWARDED_HEADERS.map((name) => [name, c.req.header(name)]).filter(([, value]) => value),
		) as Record<string, string>;
		if (!isPublicEndpoint(c.req.path)) headers['API-Key'] = config.apiKey;
		if (config.userAgent) headers['User-Agent'] = config.userAgent;

		const timeout = AbortSignal.timeout(config.timeoutMs);
		try {
			return await proxy(new URL(incoming.pathname + incoming.search, upstream), {
				method: c.req.method,
				headers,
				redirect: 'manual',
				signal: AbortSignal.any([c.req.raw.signal, timeout]),
			});
		} catch {
			return fail(
				timeout.aborted ? 504 : 502,
				timeout.aborted ? 'Upstream timeout' : 'Upstream error',
			);
		}
	});

	return app;
}

function start() {
	const config = parseConfig(
		readFileSync(process.env.AUTH_CONFIG_PATH ?? './contributors.toml', 'utf8'),
		process.env,
	);
	const port = Number(process.env.PORT) || 3000;
	const hostname = process.env.HOST ?? '0.0.0.0';
	const server = serve({ fetch: createApp(config).fetch, hostname, port }, () =>
		console.log(JSON.stringify({ event: 'started', hostname, port })),
	);
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
