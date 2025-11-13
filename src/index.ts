import { MAX_REQUEST_SIZE, ROBOTS_BODY } from './constants';
import { handleApiRequest, handleRedirect } from './handlers';
import type { Env } from './types';
import { bodyExceedsLimit, generateRequestId, handleCorsPreflight, json } from './utils';

export type { Env } from './types';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		const requestId = generateRequestId();

		if (method === 'OPTIONS' && path.startsWith('/api/')) {
			return handleCorsPreflight(request);
		}

		if ((method === 'POST' || method === 'PATCH') && path.startsWith('/api/')) {
			const contentLengthHeader = request.headers.get('content-length');
			const parsedContentLength = contentLengthHeader !== null ? Number.parseInt(contentLengthHeader, 10) : undefined;
			if (parsedContentLength !== undefined && Number.isFinite(parsedContentLength) && parsedContentLength >= 0) {
				if (parsedContentLength > MAX_REQUEST_SIZE) {
					return json(
						{
							error: 'Request body too large',
							message: `Request body exceeds maximum size of ${MAX_REQUEST_SIZE} bytes`,
							maxSize: MAX_REQUEST_SIZE,
						},
						413,
						requestId,
						request
					);
				}
			} else if (await bodyExceedsLimit(request, MAX_REQUEST_SIZE)) {
				return json(
					{
						error: 'Request body too large',
						message: `Request body exceeds maximum size of ${MAX_REQUEST_SIZE} bytes`,
						maxSize: MAX_REQUEST_SIZE,
					},
					413,
					requestId,
					request
				);
			}
		}

		if (path === '/robots.txt') {
			return new Response(ROBOTS_BODY, {
				headers: { 'content-type': 'text/plain' },
			});
		}

		if (path.startsWith('/api/')) {
			return handleApiRequest(request, env, ctx, requestId);
		}

		if (path === '/' || path === '') {
			return Response.redirect(env.HOMEPAGE, 302);
		}

		if (method !== 'GET') {
			return Response.redirect(env.HOMEPAGE, 302);
		}

		return handleRedirect(request, env, ctx);
	},
};
