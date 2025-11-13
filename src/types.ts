export type Maybe<T> = T | undefined;

export type LinkRecord = {
	slug: string;
	url: string;
	hits: number;
	createdAt: string;
	updatedAt: string;
	createdBy?: string;
	updatedBy?: string;
	expiresAt?: string | null;
};

export type AccessIdentity = {
	sub: string;
	email?: string;
	name?: string;
};

export type Jwk = {
	kid: string;
	kty: 'RSA';
	n: string;
	e: string;
	alg: 'RS256';
	use: 'sig';
};

export type JwksResponse = {
	keys: Jwk[];
};

export type JwksCacheEntry = {
	fetchedAt: number;
	jwks: JwksResponse;
};

export interface Env {
	LINKS_KV: KVNamespace;
	HOMEPAGE: string;
	NOT_FOUND: string;
	ANALYTICS?: AnalyticsEngineDataset;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
	ACCESS_BYPASS_TOKEN?: string;
}

declare global {
	var __JWKS_CACHE: Map<string, JwksCacheEntry> | undefined;
}

