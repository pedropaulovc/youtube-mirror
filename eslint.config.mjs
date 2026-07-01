import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist/**", ".claude/**", "coverage/**", "scripts/**", "worker-configuration.d.ts", "node_modules/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
		},
		rules: {
			// The worker layer intentionally uses structured casts at the
			// KV / AT-Protocol / Cloudflare boundaries.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
	{
		files: ["*.config.ts", "*.config.mjs"],
		rules: {
			"@typescript-eslint/no-unused-vars": "off",
		},
	},
	{
		// Integration tests use `@ts-nocheck`: the workflow introspection API and
		// loosely-typed step payloads make full type-checking impractical there.
		files: ["test/**/*.test.ts"],
		rules: {
			"@typescript-eslint/ban-ts-comment": "off",
		},
	},
);
