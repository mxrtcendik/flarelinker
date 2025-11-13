# flarelinker

A minimal, production-ready URL shortener built as a Cloudflare Worker. Provides authenticated CRUD APIs, edge-cached redirects, hit tracking, and Cloudflare Access integration.

## Features

- **Fast redirects**: Edge-cached redirects with 60-second TTL for optimal performance
- **Full CRUD API**: Create, read, update, delete, and list short links with pagination
- **Authentication**: Cloudflare Access JWT or bypass token authentication
- **Hit tracking**: Built-in analytics with hit counters and Analytics Engine integration
- **Expiration support**: Optional expiration dates for time-limited links
- **CORS enabled**: Ready for frontend integration
- **Request validation**: Automatic slug generation, URL validation, and size limits (10 KB)
- **Health & metrics**: Built-in health check and metrics endpoints
- **Type-safe**: Full TypeScript support with auto-generated types

## Prerequisites

- Node.js 18+ and npm
- Cloudflare account with Workers enabled
- Cloudflare Access configured (optional, for production auth)
- KV namespaces (production and preview)

## Quick Start

1. **Clone and install**:

   ```bash
   git clone https://github.com/mxrtcendik/flarelinker.git
   cd flarelinker
   npm install
   ```

2. **Configure Wrangler**:

   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   ```

   Edit `wrangler.jsonc` with your configuration values.

3. **Create KV namespaces**:

   ```bash
   npx wrangler kv:namespace create LINKS_KV
   npx wrangler kv:namespace create LINKS_KV --preview
   ```

   Update the IDs in `wrangler.jsonc`.

4. **Generate types**:

   ```bash
   npm run cf-typegen
   ```

   This generates `worker-configuration.d.ts` (auto-generated, do not edit manually).

5. **Set up authentication** (for local testing):

   ```bash
   npx wrangler secret put ACCESS_BYPASS_TOKEN
   ```

6. **Deploy**:
   ```bash
   npm run deploy
   ```

## Configuration

### Wrangler Configuration

The `wrangler.jsonc` file contains your worker configuration:

- **KV Namespaces**: Storage for link records
- **Environment Variables**:
  - `HOMEPAGE`: Redirect URL for root path (`/`)
  - `NOT_FOUND`: Redirect URL for non-existent slugs
  - `ACCESS_TEAM_DOMAIN`: Your Cloudflare Access team domain
  - `ACCESS_AUD`: Cloudflare Access Audience ID
- **Routes**: Domain pattern and zone name for your short links
- **Analytics Engine**: Optional dataset binding for hit tracking

### Authentication

The worker supports two authentication methods:

1. **Cloudflare Access JWT** (production): Uses `CF-Access-Client-*` headers or `CF_Authorization` cookie
2. **Bypass Token** (development/testing): Bearer token set via `wrangler secret put ACCESS_BYPASS_TOKEN`

All API endpoints require authentication except:

- `GET /{slug}` (redirects)
- `GET /robots.txt`
- `GET /api/health`

## API Reference

### Redirects

**GET `/{slug}`**

Redirects to the target URL. Returns 302 redirect or redirects to `NOT_FOUND` if slug doesn't exist or has expired.

**Example**:

```bash
curl https://go.example.com/docs
# → 302 Redirect to https://example.com/docs
```

### Links API

All endpoints require authentication. Include either:

- Cloudflare Access headers, or
- `Authorization: Bearer <bypass-token>` header

#### Create Link

**POST `/api/links`**

Creates a new short link. Auto-generates slug if not provided.

**Request Body**:

```json
{
	"url": "https://example.com/docs",
	"slug": "docs", // Optional, auto-generated if omitted
	"expiresAt": "2025-12-31T23:59:59Z" // Optional ISO 8601 or Unix timestamp
}
```

**Response** (201 Created):

```json
{
	"slug": "docs",
	"url": "https://example.com/docs",
	"hits": 0,
	"createdAt": "2025-01-15T10:30:00Z",
	"updatedAt": "2025-01-15T10:30:00Z",
	"createdBy": "user@example.com"
}
```

#### List Links

**GET `/api/links?limit=50&cursor=...`**

Lists all links with pagination.

**Query Parameters**:

- `limit`: Number of results (default: 50, max: 1000)
- `cursor`: Pagination cursor from previous response

**Response** (200 OK):

```json
{
	"records": [
		{
			"slug": "docs",
			"url": "https://example.com/docs",
			"hits": 42,
			"createdAt": "2025-01-15T10:30:00Z",
			"updatedAt": "2025-01-15T10:30:00Z"
		}
	],
	"cursor": "next-page-cursor",
	"list_complete": false
}
```

#### Get Link

**GET `/api/links/{slug}`**

Retrieves a specific link by slug.

**Response** (200 OK):

```json
{
	"slug": "docs",
	"url": "https://example.com/docs",
	"hits": 42,
	"createdAt": "2025-01-15T10:30:00Z",
	"updatedAt": "2025-01-15T10:30:00Z",
	"expiresAt": null
}
```

#### Update Link

**PATCH `/api/links/{slug}`**

Updates an existing link. Only provided fields are updated.

**Request Body**:

```json
{
	"url": "https://example.com/new-docs", // Optional
	"expiresAt": "2025-12-31T23:59:59Z" // Optional
}
```

**Response** (200 OK): Updated link record

#### Delete Link

**DELETE `/api/links/{slug}`**

Deletes a link.

**Response** (204 No Content)

#### Check Slug Availability

**GET `/api/links/check/{slug}`**

Checks if a slug is available.

**Response** (200 OK):

```json
{
	"slug": "docs",
	"available": false
}
```

### Utility Endpoints

#### Health Check

**GET `/api/health`**

Returns service health status. No authentication required.

**Response** (200 OK):

```json
{
	"ok": true,
	"timestamp": "2025-01-15T10:30:00Z",
	"kv": { "connected": true },
	"analytics": { "configured": true }
}
```

#### Metrics

**GET `/api/metrics`**

Returns aggregate metrics. Requires authentication.

**Response** (200 OK):

```json
{
	"totalHits": 1234,
	"totalLinks": 56
}
```

### Other Endpoints

**GET `/robots.txt`**

Returns robots.txt disallowing all crawlers.

**GET `/`**

Redirects to `HOMEPAGE` environment variable.

## Development

### Scripts

- `npm run dev` — Start local development server
- `npm run deploy` — Deploy to Cloudflare Workers
- `npm test` — Run Vitest test suite in Workers runtime
- `npm run cf-typegen` — Regenerate `worker-configuration.d.ts`

### Testing

The test suite uses Vitest with `@cloudflare/vitest-pool-workers` to run tests in the actual Workers runtime. Tests cover:

- Redirect flows and caching
- CRUD operations
- Authentication and authorization
- Request size validation
- Error handling

Run tests:

```bash
npm test
```

### Project Structure

```
.
├── src/
│   ├── index.ts          # Main worker entry point
│   ├── handlers.ts       # Request handlers (API, redirects)
│   ├── links.ts          # Link CRUD operations
│   ├── auth.ts           # Authentication logic
│   ├── utils.ts          # Utility functions
│   ├── types.ts          # TypeScript type definitions
│   └── constants.ts      # Configuration constants
├── test/
│   ├── index.spec.ts     # Test suite
│   └── env.d.ts          # Test environment types
├── wrangler.jsonc        # Worker configuration
├── wrangler.example.jsonc  # Example configuration template
└── worker-configuration.d.ts  # Auto-generated types
```

### Type Generation

The `worker-configuration.d.ts` file is automatically generated by Wrangler and should not be edited manually. Regenerate it after changing `wrangler.jsonc`:

```bash
npm run cf-typegen
```

## Architecture

- **Storage**: Cloudflare KV for link persistence
- **Caching**: Cloudflare Cache API with 60-second TTL for redirects
- **Analytics**: Cloudflare Analytics Engine for hit tracking
- **Authentication**: Cloudflare Access JWT verification with JWKS caching
- **Runtime**: Cloudflare Workers (edge computing)

## Limitations

- Maximum request body size: 10 KB
- Slug format: 2-64 characters, alphanumeric, underscores, hyphens only
- Redirect cache TTL: 60 seconds
- Pagination limit: Maximum 1000 records per request

## License

[MIT](./LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
