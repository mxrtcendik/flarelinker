import type { Env, AccessIdentity, Maybe, Jwk, JwksResponse, JwksCacheEntry } from './types';
import { JWKS_TTL_MS } from './constants';

const encoder = new TextEncoder();

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
	const bypassToken = env.ACCESS_BYPASS_TOKEN;
	const authHeader = request.headers.get('authorization');
	if (bypassToken && authHeader === `Bearer ${bypassToken}`) {
		return true;
	}

	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return false;
	const payload = await verifyAccessJwt(token, env);
	return Boolean(payload);
}

export async function getIdentity(request: Request, env: Env): Promise<Maybe<AccessIdentity>> {
	const bypassToken = env.ACCESS_BYPASS_TOKEN;
	const authHeader = request.headers.get('authorization');
	if (bypassToken && authHeader === `Bearer ${bypassToken}`) {
		return { sub: 'bypass-token' };
	}

	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return undefined;
	return verifyAccessJwt(token, env);
}

async function verifyAccessJwt(token: string, env: Env): Promise<Maybe<AccessIdentity>> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return undefined;
		const [headerB64, payloadB64, signatureB64] = parts;

		const headerJson = decodeBase64Url(headerB64);
		const payloadJson = decodeBase64Url(payloadB64);
		if (!headerJson || !payloadJson) return undefined;

		const header = JSON.parse(headerJson) as { alg: string; kid: string };
		if (header.alg !== 'RS256' || !header.kid) return undefined;

		const payload = JSON.parse(payloadJson) as { aud?: string | string[]; exp?: number; sub?: string; email?: string; name?: string };

		if (!(await verifyJwsSignature(header.kid, headerB64, payloadB64, signatureB64, env))) {
			return undefined;
		}

		if (!payload.exp || payload.exp * 1000 < Date.now()) return undefined;
		if (!payload.aud) return undefined;

		const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (!aud.includes(env.ACCESS_AUD)) return undefined;

		return {
			sub: payload.sub ?? 'unknown',
			email: payload.email,
			name: payload.name,
		};
	} catch {
		return undefined;
	}
}

async function verifyJwsSignature(kid: string, header: string, payload: string, signature: string, env: Env): Promise<boolean> {
	const jwk = await getJwkForKid(env, kid);
	if (!jwk) return false;
	const publicKey = await importPublicKey(jwk);
	if (!publicKey) return false;
	const signatureBytes = decodeBase64UrlToBytes(signature);
	if (!signatureBytes) return false;
	const data = encoder.encode(`${header}.${payload}`);
	return crypto.subtle.verify(
		{
			name: 'RSASSA-PKCS1-v1_5',
		},
		publicKey,
		signatureBytes,
		data
	);
}

async function getJwkForKid(env: Env, kid: string): Promise<Jwk | undefined> {
	const cacheKey = env.ACCESS_TEAM_DOMAIN;
	if (!globalThis.__JWKS_CACHE) {
		globalThis.__JWKS_CACHE = new Map<string, JwksCacheEntry>();
	}

	const cache = globalThis.__JWKS_CACHE;
	const existing = cache.get(cacheKey);
	const now = Date.now();

	if (!existing || now - existing.fetchedAt > JWKS_TTL_MS) {
		const jwks = await fetchJwks(env);
		cache.set(cacheKey, { jwks, fetchedAt: now });
	}

	const entry = cache.get(cacheKey);
	return entry?.jwks.keys.find((k) => k.kid === kid);
}

async function fetchJwks(env: Env): Promise<JwksResponse> {
	const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, {
		headers: {
			'User-Agent': 'flarelinker/1.0',
		},
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch JWKS (${res.status})`);
	}
	return (await res.json()) as JwksResponse;
}

async function importPublicKey(jwk: Jwk): Promise<CryptoKey | null> {
	try {
		return crypto.subtle.importKey(
			'jwk',
			{
				...jwk,
				ext: true,
			},
			{
				name: 'RSASSA-PKCS1-v1_5',
				hash: 'SHA-256',
			},
			false,
			['verify']
		);
	} catch {
		return null;
	}
}

function decodeBase64Url(input: string): string | null {
	try {
		const decoded = decodeBase64UrlToBytes(input);
		if (!decoded) return null;
		return new TextDecoder().decode(decoded);
	} catch {
		return null;
	}
}

function decodeBase64UrlToBytes(input: string): Uint8Array | null {
	try {
		const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
}

