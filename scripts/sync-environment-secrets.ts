import { createPrivateKey } from "node:crypto";
import {
	environmentFromArgs,
	parseDeploymentEnvironment,
	type DeploymentEnvironment,
} from "./deployment-environment.js";
import { deploymentSecretValues } from "./secret-values.js";
import { synchronizeSecretStoreEntries } from "./secrets-store.js";

function requireSecret(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Required environment secret ${name} is not set`);
	return value;
}

function validateSigningKey(environment: DeploymentEnvironment): string {
	const signingKey = requireSecret("OIDC_SIGNING_KEY");
	let publicKey: JsonWebKey;
	try {
		publicKey = createPrivateKey(signingKey).export({ format: "jwk" });
	} catch {
		throw new Error("OIDC_SIGNING_KEY is not a valid private key");
	}
	if (
		publicKey.kty !== "RSA" ||
		publicKey.n !== environment.oidcPublicJwk.n ||
		publicKey.e !== environment.oidcPublicJwk.e
	) {
		throw new Error("OIDC_SIGNING_KEY does not match OIDC_PUBLIC_JWK");
	}
	return signingKey;
}

async function main(): Promise<void> {
	const expected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, expected);
	const token = requireSecret("CLOUDFLARE_API_TOKEN");
	// ATProto passwords are synchronized by provision-account directly from its
	// 1Password-backed state; CI never receives them.
	const values = deploymentSecretValues(
		validateSigningKey(environment),
		requireSecret("FIRECRAWL_API_TOKEN"),
	);
	await synchronizeSecretStoreEntries(environment, token, values);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Could not synchronize Secrets Store entries");
	process.exitCode = 1;
});
