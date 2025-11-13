/// <reference types="../worker-configuration" />

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		ACCESS_BYPASS_TOKEN?: string;
	}
}
