/**
 * Manually re-mirror a single YouTube item by triggering one MirrorItemWorkflow
 * instance via the Cloudflare Workflows REST API. For manual ops / debugging only.
 *
 * The workflow hydrates the item from this `{channelId, kind, itemId}` reference
 * (it reads the ChannelConfig from KV and re-fetches the item from YouTube/Firecrawl),
 * so the payload below is exactly what it expects.
 *
 * Requirements:
 *   - CLOUDFLARE_API_TOKEN env var (Workflows edit permission).
 *   - ACCOUNT_ID below must be set to your Cloudflare account ID.
 *   - The channel's ChannelConfig must already be seeded in KV
 *     (`users:{channelId}` — see scripts/seed-channel.ts); the workflow reads it.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... npx tsx scripts/mirror-item.ts <channelId> <kind> <itemId>
 *   # kind ∈ { video | community }
 *   # comments carry parent/video context only the poller has — re-run the channel
 *   # poll to re-mirror them; a manual comment trigger is rejected by the workflow.
 */
import process from "node:process";

const ACCOUNT_ID = "REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID";
const WORKFLOW_NAME = "mirror-item";

const token = process.env.CLOUDFLARE_API_TOKEN;
const [channelId, kind, itemId] = process.argv.slice(2);

if (!token) {
	console.error("CLOUDFLARE_API_TOKEN env var is required.");
	process.exit(1);
}
if (!channelId || !kind || !itemId) {
	console.error("Usage: npx tsx scripts/mirror-item.ts <channelId> <kind> <itemId>");
	process.exit(1);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workflows/${WORKFLOW_NAME}/instances`;

const res = await fetch(url, {
	method: "POST",
	headers: {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({ params: { channelId, kind, itemId } }),
});

const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);
