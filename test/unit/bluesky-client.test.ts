import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the record passed to agent.post so we can assert embed/reply shapes.
let lastPostRecord: Record<string, unknown> | null = null;

vi.mock("@atproto/api", () => {
	function AtpAgent() {
		return {
			session: { did: "did:plc:test", handle: "testchannel.selfhosted.social", accessJwt: "jwt" },
			login: vi.fn().mockResolvedValue({}),
			uploadBlob: vi.fn().mockResolvedValue({ data: { blob: { $type: "blob", ref: { $link: "bafthumb" } } } }),
			post: vi.fn().mockImplementation((record: Record<string, unknown>) => {
				lastPostRecord = record;
				return Promise.resolve({ uri: "at://did:plc:test/app.bsky.feed.post/rk", cid: "bafcid" });
			}),
		};
	}
	function RichText(opts: { text: string }) {
		return { text: opts.text, facets: [], detectFacets: vi.fn().mockResolvedValue(undefined) };
	}
	return { AtpAgent, RichText };
});

// Imported after the mock is registered.
const { BlueskyClient } = await import("../../worker/bluesky");

describe("BlueskyClient.createPost", () => {
	beforeEach(() => {
		lastPostRecord = null;
	});

	it("attaches an external link card when given an external embed", async () => {
		const client = new BlueskyClient("testchannel.selfhosted.social", "pw", "https://selfhosted.social");
		await client.createPost("My video", new Date("2026-06-01T00:00:00Z"), {
			external: { uri: "https://www.youtube.com/watch?v=x", title: "My video", description: "desc" },
		});
		const embed = lastPostRecord?.embed as { $type: string; external: { uri: string } };
		expect(embed.$type).toBe("app.bsky.embed.external");
		expect(embed.external.uri).toBe("https://www.youtube.com/watch?v=x");
	});

	it("prefers an images embed over an external card", async () => {
		const client = new BlueskyClient("testchannel.selfhosted.social", "pw", "https://selfhosted.social");
		await client.createPost("post", new Date(), {
			images: [{ blob: { $type: "blob" } as never }],
			external: { uri: "https://x", title: "t", description: "d" },
		});
		const embed = lastPostRecord?.embed as { $type: string };
		expect(embed.$type).toBe("app.bsky.embed.images");
	});

	it("threads a reply with parent and root refs", async () => {
		const client = new BlueskyClient("testchannel.selfhosted.social", "pw", "https://selfhosted.social");
		await client.createPost("reply", new Date(), {
			replyToUri: "at://parent",
			replyToCid: "cidParent",
			replyRootUri: "at://root",
			replyRootCid: "cidRoot",
		});
		const reply = lastPostRecord?.reply as { root: { uri: string }; parent: { uri: string } };
		expect(reply.parent.uri).toBe("at://parent");
		expect(reply.root.uri).toBe("at://root");
	});

	it("defaults the reply root to the parent when no root is given", async () => {
		const client = new BlueskyClient("testchannel.selfhosted.social", "pw", "https://selfhosted.social");
		await client.createPost("reply", new Date(), { replyToUri: "at://p", replyToCid: "c" });
		const reply = lastPostRecord?.reply as { root: { uri: string } };
		expect(reply.root.uri).toBe("at://p");
	});
});
