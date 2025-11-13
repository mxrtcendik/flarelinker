import { SLUG_PATTERN } from './constants';
import type { AccessIdentity, Env, LinkRecord, Maybe } from './types';
import { generateSlug, isExpired, isHttpsUrl, isRecord, kvKey, normalizeExpiry, wouldCreateRedirectLoop } from './utils';

export async function getLink(env: Env, slug: string): Promise<LinkRecord | null> {
	if (!SLUG_PATTERN.test(slug)) return null;
	const result = await env.LINKS_KV.get(kvKey(slug));
	if (!result) return null;
	try {
		const record = JSON.parse(result) as LinkRecord;
		if (isExpired(record)) return null;
		return record;
	} catch {
		return null;
	}
}

export async function createLink(env: Env, body: unknown, identity: Maybe<AccessIdentity>, request: Request) {
	if (!isRecord(body)) {
		return { error: 'Body must be an object', message: 'Request body must be a JSON object', status: 400 } as const;
	}

	const targetUrl = typeof body.url === 'string' ? body.url.trim() : '';
	if (!targetUrl) {
		return {
			error: "Property 'url' is required",
			message: 'The url field is required and must be a non-empty string',
			status: 400,
		} as const;
	}

	let slug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : generateSlug();
	if (!SLUG_PATTERN.test(slug)) {
		return {
			error: 'Slug must be 2-64 characters and use letters, numbers, _ or -',
			message:
				'Slug must be between 2 and 64 characters and contain only letters (a-z, A-Z), numbers (0-9), underscores (_), or hyphens (-)',
			status: 400,
		} as const;
	}

	if (!isHttpsUrl(targetUrl)) {
		return {
			error: 'URL must be a valid http(s) URL',
			message:
				'URL must start with http:// or https:// and be a valid URL. Dangerous protocols (javascript:, data:, etc.) are not allowed.',
			status: 400,
		} as const;
	}

	const requestUrl = new URL(request.url);
	if (wouldCreateRedirectLoop(targetUrl, requestUrl.origin)) {
		return {
			error: 'URL cannot redirect to itself or the same domain',
			message: 'The target URL cannot point to the same domain as the shortener to prevent redirect loops',
			status: 400,
		} as const;
	}

	const userProvidedSlug = typeof body.slug === 'string' && body.slug.trim();
	let attempts = 0;
	const maxAttempts = 5;
	let key = kvKey(slug);
	let existing = await env.LINKS_KV.get(key);

	while (existing && !userProvidedSlug && attempts < maxAttempts) {
		slug = generateSlug();
		key = kvKey(slug);
		existing = await env.LINKS_KV.get(key);
		attempts++;
	}

	if (existing) {
		if (userProvidedSlug) {
			return {
				error: 'Slug already exists',
				message: `The slug "${slug}" is already in use. Please choose a different slug or use the /api/links/check/{slug} endpoint to check availability.`,
				status: 409,
			} as const;
		}
		return {
			error: 'Unable to generate unique slug after multiple attempts',
			message: 'Failed to generate a unique slug after 5 attempts. Please try again.',
			status: 500,
		} as const;
	}

	const now = new Date().toISOString();
	const expiresAtResult = normalizeExpiry(body.expiresAt);
	if (expiresAtResult.error) {
		return { error: expiresAtResult.error, message: expiresAtResult.error, status: 400 } as const;
	}

	const record: LinkRecord = {
		slug,
		url: targetUrl,
		hits: 0,
		createdAt: now,
		updatedAt: now,
		createdBy: identity?.email ?? identity?.sub,
		updatedBy: identity?.email ?? identity?.sub,
		expiresAt: expiresAtResult.value,
	};

	await env.LINKS_KV.put(
		key,
		JSON.stringify(record),
		expiresAtResult.value ? { expiration: Math.floor(Date.parse(expiresAtResult.value) / 1000) } : undefined
	);
	await purgeCacheForSlug(request, slug);

	return { record } as const;
}

export async function updateLink(env: Env, slug: string, body: unknown, identity: Maybe<AccessIdentity>, request: Request) {
	if (!isRecord(body)) {
		return { error: 'Body must be an object', message: 'Request body must be a JSON object', status: 400 } as const;
	}

	const key = kvKey(slug);
	const record = await getLink(env, slug);
	if (!record) {
		return { error: 'Link not found', message: `Link with slug "${slug}" does not exist or has expired`, status: 404 } as const;
	}

	let changed = false;

	if (typeof body.url === 'string') {
		const nextUrl = body.url.trim();
		if (!isHttpsUrl(nextUrl)) {
			return {
				error: 'URL must be a valid http(s) URL',
				message:
					'URL must start with http:// or https:// and be a valid URL. Dangerous protocols (javascript:, data:, etc.) are not allowed.',
				status: 400,
			} as const;
		}
		const requestUrl = new URL(request.url);
		if (wouldCreateRedirectLoop(nextUrl, requestUrl.origin)) {
			return {
				error: 'URL cannot redirect to itself or the same domain',
				message: 'The target URL cannot point to the same domain as the shortener to prevent redirect loops',
				status: 400,
			} as const;
		}
		record.url = nextUrl;
		changed = true;
	}

	if ('expiresAt' in body) {
		const expiresAtResult = normalizeExpiry(body.expiresAt);
		if (expiresAtResult.error) {
			return { error: expiresAtResult.error, message: expiresAtResult.error, status: 400 } as const;
		}
		record.expiresAt = expiresAtResult.value;
		changed = true;
	}

	if (!changed) {
		return {
			error: 'No supported fields to update',
			message: 'At least one of the following fields must be provided: url, expiresAt',
			status: 400,
		} as const;
	}

	record.updatedAt = new Date().toISOString();
	record.updatedBy = identity?.email ?? identity?.sub ?? record.updatedBy;

	await env.LINKS_KV.put(
		key,
		JSON.stringify(record),
		record.expiresAt ? { expiration: Math.floor(Date.parse(record.expiresAt) / 1000) } : undefined
	);
	await purgeCacheForSlug(request, slug);

	return { record } as const;
}

export async function deleteLink(env: Env, slug: string, request: Request): Promise<boolean> {
	const key = kvKey(slug);
	const existing = await env.LINKS_KV.get(key);
	if (!existing) return false;
	await env.LINKS_KV.delete(key);
	await purgeCacheForSlug(request, slug);
	return true;
}

export async function checkSlugAvailability(env: Env, slug: string): Promise<boolean> {
	const key = kvKey(slug);
	const existing = await env.LINKS_KV.get(key);
	if (!existing) return false;
	try {
		const record = JSON.parse(existing) as LinkRecord;
		return !isExpired(record);
	} catch {
		return true;
	}
}

export async function incrementHits(env: Env, record: LinkRecord): Promise<void> {
	record.hits += 1;
	record.updatedAt = new Date().toISOString();
	await env.LINKS_KV.put(
		kvKey(record.slug),
		JSON.stringify(record),
		record.expiresAt ? { expiration: Math.floor(Date.parse(record.expiresAt) / 1000) } : undefined
	);
}

export async function trackHit(env: Env, slug: string, request: Request): Promise<void> {
	if (!env.ANALYTICS) return;
	try {
		await env.ANALYTICS.writeDataPoint({
			blobs: [
				slug,
				request.headers.get('cf-connecting-ip') ?? '',
				request.headers.get('referer') ?? '',
				request.headers.get('user-agent') ?? '',
			],
			doubles: [1],
		});
	} catch {}
}

async function purgeCacheForSlug(request: Request, slug: string): Promise<void> {
	try {
		const url = new URL(request.url);
		url.pathname = `/${slug}`;
		url.search = '';
		url.hash = '';
		const cacheKey = new Request(url.toString(), { method: 'GET' });
		await caches.default.delete(cacheKey);
	} catch {}
}
