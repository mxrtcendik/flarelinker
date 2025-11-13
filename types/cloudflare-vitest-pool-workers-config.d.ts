declare module '@cloudflare/vitest-pool-workers/config' {
	import type { UserConfigExport } from 'vitest';

	export function defineWorkersConfig(config: UserConfigExport): UserConfigExport;
}
