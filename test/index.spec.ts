import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_REQUEST_SIZE } from '../src/constants';
import worker from '../src/index';
import type { LinkRecord } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const API_ORIGIN = 'https://worker.test';
const AUTH_HEADER = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

describe('URL shortener worker', () => {
	beforeEach(async () => {
		env.ACCESS_BYPASS_TOKEN = 'test-token';
		env.ACCESS_AUD = env.ACCESS_AUD ?? 'test-aud';
		env.ACCESS_TEAM_DOMAIN = env.ACCESS_TEAM_DOMAIN ?? 'example.cloudflareaccess.com';
		const list = await env.LINKS_KV.list({ prefix: 'link:' });
		for (const key of list.keys) {
			await env.LINKS_KV.delete(key.name);
		}
	});

	it('creates a short link via API and redirects', async () => {
		await apiRequest('/api/links', {
			method: 'POST',
			headers: AUTH_HEADER,
			body: JSON.stringify({ slug: 'docs', url: 'https://example.com/docs' }),
		});

		const request = new IncomingRequest(`${API_ORIGIN}/docs`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://example.com/docs');
	});

	it('prevents unauthenticated access to APIs', async () => {
		const response = await apiRequest('/api/links');
		expect(response.status).toBe(401);
	});

	it('lists links with metadata', async () => {
		await apiRequest('/api/links', {
			method: 'POST',
			headers: AUTH_HEADER,
			body: JSON.stringify({ slug: 'gh', url: 'https://github.com' }),
		});

		const response = await apiRequest('/api/links', { headers: { authorization: 'Bearer test-token' } });
		const payload = (await response.json()) as { records: LinkRecord[]; cursor: string | null; list_complete: boolean };

		expect(response.status).toBe(200);
		expect(payload.records).toHaveLength(1);
		expect(payload.records[0]).toMatchObject({
			slug: 'gh',
			url: 'https://github.com',
			hits: 0,
		});
	});

	it('updates a link and increments hit counters', async () => {
		await apiRequest('/api/links', {
			method: 'POST',
			headers: AUTH_HEADER,
			body: JSON.stringify({ slug: 'blog', url: 'https://example.com/blog' }),
		});

		const updateResponse = await apiRequest('/api/links/blog', {
			method: 'PATCH',
			headers: AUTH_HEADER,
			body: JSON.stringify({ url: 'https://example.com/new-blog' }),
		});
		expect(updateResponse.status).toBe(200);

		const redirect = new IncomingRequest(`${API_ORIGIN}/blog`);
		const ctx = createExecutionContext();
		await worker.fetch(redirect, env, ctx);
		await waitOnExecutionContext(ctx);

		const getResponse = await apiRequest('/api/links/blog', { headers: { authorization: 'Bearer test-token' } });
		const record = (await getResponse.json()) as LinkRecord;

		expect(record.url).toBe('https://example.com/new-blog');
		expect(record.hits).toBeGreaterThan(0);
	});

	it('deletes a link', async () => {
		await apiRequest('/api/links', {
			method: 'POST',
			headers: AUTH_HEADER,
			body: JSON.stringify({ slug: 'delete-me', url: 'https://example.com/delete' }),
		});

		const deleteResponse = await apiRequest('/api/links/delete-me', {
			method: 'DELETE',
			headers: { authorization: 'Bearer test-token' },
		});

		expect(deleteResponse.status).toBe(204);

		const getResponse = await apiRequest('/api/links/delete-me', {
			headers: { authorization: 'Bearer test-token' },
		});

		expect(getResponse.status).toBe(404);
	});

	it('rejects oversized bodies without content-length header', async () => {
		const padding = 'a'.repeat(MAX_REQUEST_SIZE + 1);
		const payload = JSON.stringify({ slug: 'oversized', url: 'https://example.com', padding });
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(payload));
				controller.close();
			},
		});
		const request = new IncomingRequest(`${API_ORIGIN}/api/links`, {
			method: 'POST',
			headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
			body: stream,
			duplex: 'half',
		} as RequestInit<IncomingRequestCfProperties>);
		request.headers.delete('content-length');

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(413);
		const body = await response.json();
		expect(body).toMatchObject({
			error: 'Request body too large',
			maxSize: MAX_REQUEST_SIZE,
		});
	});
});

async function apiRequest(path: string, init?: RequestInit) {
	const request = new IncomingRequest(`${API_ORIGIN}${path}`, init as RequestInit<IncomingRequestCfProperties>);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
