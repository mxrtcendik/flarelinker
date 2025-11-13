import { getIdentity, isAuthorized } from './auth';
import { CACHE_TTL_SECONDS, KV_PREFIX, SLUG_PATTERN } from './constants';
import { checkSlugAvailability, createLink, deleteLink, getLink, incrementHits, trackHit, updateLink } from './links';
import type { Env } from './types';
import { clampLimit, corsHeaders, extractSlug, isExpired, json, methodNotAllowed, readJson, redirectResponse } from './utils';

export async function handleRedirect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const slug = extractSlug(request);
	if (!slug) {
		return redirectResponse(env.NOT_FOUND, 'no-store');
	}

	const cache = caches.default;
	const cacheKey = new Request(request.url, {
		method: 'GET',
		headers: request.headers,
	});

	const cachedResponse = await cache.match(cacheKey);
	if (cachedResponse) {
		return cachedResponse;
	}

	const record = await getLink(env, slug);

	if (!record || isExpired(record)) {
		return redirectResponse(env.NOT_FOUND, 'no-store');
	}

	const redirect = redirectResponse(record.url, `public, max-age=${CACHE_TTL_SECONDS}`);
	await cache.put(cacheKey, redirect.clone());

	ctx.waitUntil(trackHit(env, slug, request));
	ctx.waitUntil(incrementHits(env, record));

	return redirect;
}

export async function handleApiRequest(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
	const { pathname, searchParams } = new URL(request.url);
	const method = request.method.toUpperCase();

	if (!(await isAuthorized(request, env))) {
		return json(
			{ error: 'Unauthorized', message: 'Authentication required. Provide a valid Cloudflare Access token or bypass token.' },
			401,
			requestId,
			request
		);
	}

	if (pathname === '/api/health') {
		return handleHealth(env, requestId, request);
	}

	if (pathname === '/api/metrics' && method === 'GET') {
		return handleMetrics(env, requestId, request);
	}

	const checkMatch = pathname.match(/^\/api\/links\/check\/([^\/]+)$/);
	if (checkMatch && method === 'GET') {
		const slug = decodeURIComponent(checkMatch[1]);
		if (!SLUG_PATTERN.test(slug)) {
			return json(
				{ error: 'Invalid slug format', message: 'Slug must be 2-64 characters and use letters, numbers, underscores, or hyphens' },
				400,
				requestId,
				request
			);
		}
		const exists = await checkSlugAvailability(env, slug);
		return json({ slug, available: !exists }, 200, requestId, request);
	}

	if (pathname === '/api/links') {
		switch (method) {
			case 'GET':
				return handleListLinks(env, searchParams.get('cursor') ?? undefined, searchParams.get('limit') ?? undefined, requestId, request);
			case 'POST': {
				const body = await readJson(request);
				if (!body) return json({ error: 'Invalid JSON body', message: 'Request body must be valid JSON' }, 400, requestId, request);
				const identity = await getIdentity(request, env);
				const result = await createLink(env, body, identity, request);
				if (result.error) return json({ error: result.error, message: result.message }, result.status ?? 400, requestId, request);
				return json(result.record, 201, requestId, request);
			}
			default:
				return methodNotAllowed(request, requestId);
		}
	}

	const slugMatch = pathname.match(/^\/api\/links\/([^\/]+)$/);
	if (slugMatch) {
		const slug = decodeURIComponent(slugMatch[1]);
		if (!SLUG_PATTERN.test(slug)) {
			return json(
				{ error: 'Invalid slug format', message: 'Slug must be 2-64 characters and use letters, numbers, underscores, or hyphens' },
				400,
				requestId,
				request
			);
		}
		const identity = await getIdentity(request, env);

		if (method === 'GET') {
			const record = await getLink(env, slug);
			if (!record || isExpired(record))
				return json({ error: 'Not found', message: 'Link does not exist or has expired' }, 404, requestId, request);
			return json(record, 200, requestId, request);
		}

		if (method === 'PATCH') {
			const body = await readJson(request);
			if (!body) return json({ error: 'Invalid JSON body', message: 'Request body must be valid JSON' }, 400, requestId, request);
			const result = await updateLink(env, slug, body, identity, request);
			if (result.error) return json({ error: result.error, message: result.message }, result.status ?? 400, requestId, request);
			return json(result.record, 200, requestId, request);
		}

		if (method === 'DELETE') {
			const deleted = await deleteLink(env, slug, request);
			if (!deleted) return json({ error: 'Not found', message: 'Link does not exist or has expired' }, 404, requestId, request);
			return new Response(null, { status: 204, headers: corsHeaders(request, requestId) });
		}

		return methodNotAllowed(request, requestId);
	}

	return json({ error: 'Not found', message: 'Endpoint not found' }, 404, requestId, request);
}
async function handleListLinks(env: Env, cursor?: string, limitParam?: string, requestId?: string, request?: Request): Promise<Response> {
	const limit = clampLimit(limitParam);
	const list = await env.LINKS_KV.list({ prefix: KV_PREFIX, cursor, limit });
	const records = [];
	for (const key of list.keys) {
		const slug = key.name.slice(KV_PREFIX.length);
		const record = await getLink(env, slug);
		if (record) records.push(record);
	}
	const cursorValue = 'cursor' in list ? list.cursor ?? null : null;
	return json({ records, cursor: cursorValue, list_complete: list.list_complete }, 200, requestId, request);
}

export async function handleHealth(env: Env, requestId: string, request?: Request): Promise<Response> {
	const health: { ok: boolean; timestamp: string; kv?: { connected: boolean }; analytics?: { configured: boolean } } = {
		ok: true,
		timestamp: new Date().toISOString(),
	};

	try {
		await env.LINKS_KV.list({ prefix: KV_PREFIX, limit: 1 });
		health.kv = { connected: true };
	} catch (error) {
		health.ok = false;
		health.kv = { connected: false };
	}

	health.analytics = { configured: Boolean(env.ANALYTICS) };

	return json(health, health.ok ? 200 : 503, requestId, request);
}

async function handleMetrics(env: Env, requestId?: string, request?: Request): Promise<Response> {
	const list = await env.LINKS_KV.list({ prefix: KV_PREFIX });
	let totalHits = 0;
	let totalLinks = 0;
	for (const key of list.keys) {
		const slug = key.name.slice(KV_PREFIX.length);
		const record = await getLink(env, slug);
		if (!record) continue;
		totalHits += record.hits;
		totalLinks += 1;
	}
	return json({ totalHits, totalLinks }, 200, requestId, request);
}
