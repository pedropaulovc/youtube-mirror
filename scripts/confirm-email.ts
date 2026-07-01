/**
 * Confirm email for a Bluesky account.
 * Usage:
 *   npx tsx scripts/confirm-email.ts <handle> <password>           # request token
 *   npx tsx scripts/confirm-email.ts <handle> <password> <token>   # confirm email
 */
import { AtpAgent } from "@atproto/api";

async function main() {
	const handle = process.argv[2];
	const password = process.argv[3];
	const token = process.argv[4];

	if (!handle || !password) {
		console.error("Usage: npx tsx scripts/confirm-email.ts <handle> <password> [token]");
		process.exit(1);
	}

	const pdsHost = handle.split(".").slice(1).join(".");
	const agent = new AtpAgent({ service: `https://${pdsHost}` });
	await agent.login({ identifier: handle, password });
	const session = agent.session as unknown as { did: string; email?: string; emailConfirmed?: boolean };
	console.log(`Logged in as ${handle} (${session.did})`);
	console.log(`Email confirmed: ${session.emailConfirmed}`);

	if (!token) {
		console.log("Requesting email confirmation token...");
		await agent.com.atproto.server.requestEmailConfirmation();
		console.log("Token sent to email. Re-run with token to confirm.");
		return;
	}

	console.log(`Confirming email with token: ${token}`);
	await agent.com.atproto.server.confirmEmail({ email: session.email!, token });
	console.log("Email confirmed successfully!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
