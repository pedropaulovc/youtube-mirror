// Standalone OIDC issuer for Cloudflare Worker federation.
// The selected GitHub Environment supplies this Worker with its public key. The
// matching private key stays in that environment's Cloudflare Secrets Store.

interface Env {
	DEPLOYMENT_ENVIRONMENT: "production" | "ppe";
	ISSUER_URL: string;
	OIDC_PUBLIC_JWK: string;
	OIDC_SIGNING_KID: string;
}

interface PublicJwk {
	kty: "RSA";
	kid: string;
	n: string;
	e: string;
	alg: "RS256";
	use: "sig";
}

interface IssuerConfiguration {
	environment: "production" | "ppe";
	issuerUrl: string;
	signingKid: string;
	jwkSource: string;
	jwk: PublicJwk;
}

let cachedConfiguration: IssuerConfiguration | undefined;

function configuration(env: Env): IssuerConfiguration {
	if (
		cachedConfiguration?.environment === env.DEPLOYMENT_ENVIRONMENT &&
		cachedConfiguration.issuerUrl === env.ISSUER_URL &&
		cachedConfiguration.signingKid === env.OIDC_SIGNING_KID &&
		cachedConfiguration.jwkSource === env.OIDC_PUBLIC_JWK
	) {
		return cachedConfiguration;
	}
	if (env.DEPLOYMENT_ENVIRONMENT !== "production" && env.DEPLOYMENT_ENVIRONMENT !== "ppe") {
		throw new Error("Invalid deployment environment");
	}

	let issuer: URL;
	try {
		issuer = new URL(env.ISSUER_URL);
	} catch {
		throw new Error("Invalid OIDC issuer URL");
	}
	if (
		issuer.protocol !== "https:" ||
		issuer.origin !== env.ISSUER_URL ||
		!issuer.hostname.startsWith("youtube-mirror-oidc-issuer.") ||
		!issuer.hostname.endsWith(".workers.dev")
	) {
		throw new Error("OIDC issuer URL must be this Worker's workers.dev HTTPS origin");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(env.OIDC_PUBLIC_JWK);
	} catch {
		throw new Error("OIDC public JWK is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("OIDC public JWK is not an object");
	}
	const jwk = parsed as Record<string, unknown>;
	if (
		jwk.kty !== "RSA" ||
		jwk.kid !== env.OIDC_SIGNING_KID ||
		jwk.alg !== "RS256" ||
		jwk.use !== "sig" ||
		typeof jwk.n !== "string" ||
		jwk.n.length < 256 ||
		typeof jwk.e !== "string" ||
		jwk.e.length === 0
	) {
		throw new Error("OIDC public JWK does not match the configured RS256 signing kid");
	}

	cachedConfiguration = {
		environment: env.DEPLOYMENT_ENVIRONMENT,
		signingKid: env.OIDC_SIGNING_KID,
		jwkSource: env.OIDC_PUBLIC_JWK,
		issuerUrl: issuer.origin,
		jwk: {
			kty: "RSA",
			kid: env.OIDC_SIGNING_KID,
			n: jwk.n,
			e: jwk.e,
			alg: "RS256",
			use: "sig",
		},
	};
	return cachedConfiguration;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const selected = configuration(env);
		const path = new URL(request.url).pathname;

		if (request.method === "GET" && path === "/.well-known/openid-configuration") {
			return Response.json(
				{
					issuer: selected.issuerUrl,
					jwks_uri: `${selected.issuerUrl}/.well-known/jwks.json`,
					response_types_supported: ["id_token"],
					subject_types_supported: ["public"],
					id_token_signing_alg_values_supported: ["RS256"],
				},
				{ headers: { "Cache-Control": "public, max-age=3600" } },
			);
		}

		if (request.method === "GET" && path === "/.well-known/jwks.json") {
			return Response.json(
				{ keys: [selected.jwk] },
				{ headers: { "Cache-Control": "public, max-age=3600" } },
			);
		}

		return new Response("Not found", { status: 404 });
	},
};
