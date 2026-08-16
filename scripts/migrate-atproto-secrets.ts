import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";
import { atProtoSecretValues } from "./secret-values.js";
import { synchronizeSecretStoreEntries } from "./secrets-store.js";

function requireSecret(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Required migration secret ${name} is not set`);
	return value;
}

async function main(): Promise<void> {
	const expected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, expected);
	const token = requireSecret("CLOUDFLARE_API_TOKEN");
	const values = environment.channelIds.flatMap((channelId) =>
		atProtoSecretValues(
			environment.name,
			channelId,
			requireSecret(`ATPROTO_PASSWORD_${channelId}`),
			requireSecret(`ATPROTO_PASSWORD_${channelId}_RT`),
		),
	);
	await synchronizeSecretStoreEntries(environment, token, values);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Could not migrate ATProto Secrets Store entries");
	process.exitCode = 1;
});
