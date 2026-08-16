import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import { renderConfigForDirectory } from "./deployment-config.js";
import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";

const CONFIG_FILES = [
	"wrangler.mirror-oidc-issuer.jsonc",
	"wrangler.mirror-telemetry-gateway.jsonc",
	"wrangler.mirror-item.jsonc",
	"wrangler.mirror-delete.jsonc",
	"wrangler.mirror-profile.jsonc",
	"wrangler.mirror-channel.jsonc",
] as const;

async function main(): Promise<void> {
	const expected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, expected);
	const outputDirectory = join(".wrangler", "deploy", environment.name);
	await mkdir(outputDirectory, { recursive: true });

	for (const configPath of CONFIG_FILES) {
		const source = await readFile(configPath, "utf8");
		const parsed = parseConfigFileTextToJson(configPath, source);
		if (parsed.error || !parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) {
			throw new Error(`Could not parse ${configPath} as JSONC`);
		}
		const outputPath = join(outputDirectory, basename(configPath));
		const rendered = renderConfigForDirectory(configPath, parsed.config, environment, outputDirectory);
		await writeFile(outputPath, `${JSON.stringify(rendered, null, "\t")}\n`);
		console.log(outputPath);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Could not render deployment configs");
	process.exitCode = 1;
});
