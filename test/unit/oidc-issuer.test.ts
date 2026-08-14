import { describe, expect, it } from "vitest";
import issuer from "../../worker/oidc-issuer";

const publicJwk = {
	kty: "RSA",
	kid: "production-key12345",
	n: "a".repeat(342),
	e: "AQAB",
	alg: "RS256",
	use: "sig",
};

const env = {
	DEPLOYMENT_ENVIRONMENT: "production" as const,
	ISSUER_URL: "https://youtube-mirror-oidc-issuer.youtube-prod.workers.dev",
	OIDC_SIGNING_KID: publicJwk.kid,
	OIDC_PUBLIC_JWK: JSON.stringify(publicJwk),
};

describe("OIDC issuer environment contract", () => {
	it("publishes only the public JWK supplied by the selected environment", async () => {
		const response = await issuer.fetch(
			new Request(`${env.ISSUER_URL}/.well-known/jwks.json`),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ keys: [publicJwk] });
	});

	it("publishes discovery URLs from the same selected origin", async () => {
		const response = await issuer.fetch(
			new Request(`${env.ISSUER_URL}/.well-known/openid-configuration`),
			env,
		);
		expect(await response.json()).toMatchObject({
			issuer: env.ISSUER_URL,
			jwks_uri: `${env.ISSUER_URL}/.well-known/jwks.json`,
		});
	});

	it("rejects a public JWK whose kid differs from the signing contract", async () => {
		await expect(
			issuer.fetch(new Request(`${env.ISSUER_URL}/.well-known/jwks.json`), {
				...env,
				OIDC_SIGNING_KID: "production-other-key",
			}),
		).rejects.toThrow("does not match");
	});

	it("rejects an issuer URL that is not this worker's workers.dev origin", async () => {
		await expect(
			issuer.fetch(new Request(`${env.ISSUER_URL}/.well-known/jwks.json`), {
				...env,
				ISSUER_URL: "https://example.com",
			}),
		).rejects.toThrow("workers.dev HTTPS origin");
	});
});
