import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			miniflare: {
				serviceBindings: {
					OIDC_SIGNING_KEY: { name: "test-secret-worker", entrypoint: "TestSecret" },
					FIRECRAWL_API_TOKEN: { name: "test-secret-worker", entrypoint: "TestSecret" },
				},
				workers: [
					{
						name: "test-secret-worker",
						modules: true,
						script: `
							import { WorkerEntrypoint } from "cloudflare:workers";
							export class TestSecret extends WorkerEntrypoint {
								async get() { return "test-api-token"; }
							}
							export default { fetch() { return new Response("ok"); } };
						`,
						compatibilityDate: "2025-10-08",
						compatibilityFlags: ["nodejs_compat"],
					},
				],
			},
		}),
	],
	test: {
		include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
		// NOTE: v8/istanbul coverage is unsupported under @cloudflare/vitest-pool-workers
		// (it needs node:inspector/promises, absent in the Workers runtime). We gate on
		// `vitest run` instead. See Cloudflare vitest-integration known-issues.
	},
});
