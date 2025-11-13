import { JSON_HEADERS, KV_PREFIX, SLUG_PATTERN } from './constants';
import type { LinkRecord, Maybe } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isHttpsUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return false;
		}
		const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
		const lowerValue = value.toLowerCase().trim();
		for (const protocol of dangerousProtocols) {
			if (lowerValue.startsWith(protocol)) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export function isExpired(record: LinkRecord): boolean {
	if (!record.expiresAt) return false;
	const expiresAt = new Date(record.expiresAt);
	return expiresAt.getTime() < Date.now();
}

export function wouldCreateRedirectLoop(targetUrl: string, shortUrlOrigin: string): boolean {
	try {
		const target = new URL(targetUrl);
		const short = new URL(shortUrlOrigin);
		return target.hostname === short.hostname || target.origin === short.origin;
	} catch {
		return false;
	}
}

export function generateSlug(length = 6): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let slug = '';
	const buffer = new Uint8Array(length);
	crypto.getRandomValues(buffer);
	for (let i = 0; i < length; i += 1) {
		slug += alphabet[buffer[i] % alphabet.length];
	}
	return slug;
}

export function normalizeExpiry(input: unknown): { value: string | null | undefined; error?: string } {
	if (input === undefined) return { value: undefined };
	if (input === null || input === false) return { value: null };
	if (input === '') return { value: undefined };
	let date: Date;
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) {
			return { value: undefined, error: 'expiresAt must be a finite number of seconds since epoch' };
		}
		date = new Date(input * 1000);
	} else if (typeof input === 'string') {
		const trimmed = input.trim();
		if (!trimmed) {
			return { value: undefined };
		}
		date = new Date(trimmed);
		if (Number.isNaN(date.getTime())) {
			return { value: undefined, error: 'expiresAt must be a valid ISO date string or unix timestamp' };
		}
	} else {
		return { value: undefined, error: 'expiresAt must be a string, number, null, or undefined' };
	}
	if (date.getTime() < Date.now()) {
		return { value: undefined, error: 'expiresAt cannot be in the past' };
	}
	return { value: date.toISOString() };
}

export function extractSlug(request: Request): Maybe<string> {
	const url = new URL(request.url);
	const trimmed = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
	if (!trimmed) return undefined;
	const slug = trimmed.split('/')[0];
	return slug && SLUG_PATTERN.test(slug) ? slug : undefined;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		return await request.json<Record<string, unknown>>();
	} catch {
		return null;
	}
}

export function generateRequestId(): string {
	return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function kvKey(slug: string): string {
	return `${KV_PREFIX}${slug}`;
}

export async function bodyExceedsLimit(request: Request, limit: number): Promise<boolean> {
	const clone = request.clone();
	if (!clone.body) {
		return false;
	}
	const reader = clone.body.getReader();
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			total += value.byteLength ?? value.length ?? 0;
			if (total > limit) {
				return true;
			}
		}
	}
	return false;
}

export function clampLimit(raw?: string): number {
	const parsed = raw ? parseInt(raw, 10) : NaN;
	if (Number.isNaN(parsed) || parsed < 1) return 25;
	return Math.min(parsed, 100);
}

export function corsHeaders(request: Request, requestId?: string): Headers {
	const headers = new Headers();
	const origin = request.headers.get('origin');
	if (origin) {
		headers.set('Access-Control-Allow-Origin', origin);
		headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
		headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, CF-Access-Jwt-Assertion');
		headers.set('Access-Control-Max-Age', '86400');
	}
	if (requestId) {
		headers.set('X-Request-ID', requestId);
	}
	return headers;
}

export function handleCorsPreflight(request: Request): Response {
	const headers = corsHeaders(request);
	return new Response(null, { status: 204, headers });
}

export function json(body: unknown, status = 200, requestId?: string, request?: Request): Response {
	const headers = new Headers(JSON_HEADERS);
	if (requestId) {
		headers.set('X-Request-ID', requestId);
	}
	if (request) {
		const cors = corsHeaders(request, requestId);
		cors.forEach((value, key) => {
			if (key.startsWith('Access-Control-')) {
				headers.set(key, value);
			}
		});
	}
	return new Response(JSON.stringify(body), {
		status,
		headers,
	});
}

export function methodNotAllowed(request: Request, requestId?: string): Response {
	return json({ error: 'Method not allowed', message: 'The HTTP method used is not allowed for this endpoint' }, 405, requestId, request);
}

export function redirectResponse(location: string, cacheControl?: string): Response {
	const headers = new Headers({ Location: location });
	if (cacheControl) headers.set('Cache-Control', cacheControl);
	return new Response(null, {
		status: 302,
		headers,
	});
}
