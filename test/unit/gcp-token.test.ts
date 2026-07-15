import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the signer so this suite exercises the STS + impersonation orchestration,
// not RS256 signing (covered in oidc-sign.test.ts).
vi.mock("../../worker/oidc-sign", () => ({
	signAssertion: vi.fn(async () => "header.payload.signature"),
}));

const ENV = {
	OIDC_ISSUER_URL: "https://issuer.example/",
	OIDC_SIGNING_KID: "03c90718",
	OIDC_SIGNING_KEY: { get: async () => "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" },
	GCP_WORKLOAD_PROVIDER: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/cloudflare-workers/providers/youtube-mirror-oidc",
	GCP_SERVICE_ACCOUNT: "youtube-mirror-cf@youtube-mirror-501119.iam.gserviceaccount.com",
	KV: null as unknown as KVNamespace,
};

const tokenStore = new Map<string, string>();

function tokenKv(): KVNamespace {
	return {
		get: vi.fn(async (key: string, type?: string) => {
			const value = tokenStore.get(key);
			if (!value) return null;
			return type === "json" ? JSON.parse(value) : value;
		}),
		put: vi.fn(async (key: string, value: string) => {
			tokenStore.set(key, value);
		}),
	} as unknown as KVNamespace;
}

function stsOk() {
	return new Response(JSON.stringify({ access_token: "federated-token" }), { status: 200 });
}
function impOk(token = "ya29.sa-access-token") {
	return new Response(JSON.stringify({ accessToken: token, expireTime: "2999-01-01T00:00:00Z" }), { status: 200 });
}

describe("getYouTubeAccessToken", () => {
	beforeEach(() => {
		vi.resetModules();
		tokenStore.clear();
		ENV.KV = tokenKv();
	});
	afterEach(() => vi.restoreAllMocks());

	it("exchanges an assertion at STS then impersonates the SA for a youtube.force-ssl token", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			calls.push({ url: String(url), init: init as RequestInit });
			return String(url).includes("sts.googleapis.com") ? stsOk() : impOk();
		});

		const { getYouTubeAccessToken } = await import("../../worker/gcp-token");
		const token = await getYouTubeAccessToken(ENV);

		expect(token).toBe("ya29.sa-access-token");

		// STS request: token-exchange with our signed assertion as subject_token.
		const sts = calls.find((c) => c.url.includes("sts.googleapis.com"))!;
		const stsBody = new URLSearchParams(String(sts.init!.body));
		expect(stsBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
		expect(stsBody.get("subject_token")).toBe("header.payload.signature");
		expect(stsBody.get("audience")).toBe(ENV.GCP_WORKLOAD_PROVIDER);

		// Impersonation request: SA in the URL, federated token as Bearer, youtube.force-ssl scope.
		const imp = calls.find((c) => c.url.includes("generateAccessToken"))!;
		expect(imp.url).toContain(ENV.GCP_SERVICE_ACCOUNT);
		expect((imp.init!.headers as Record<string, string>).Authorization).toBe("Bearer federated-token");
		expect(JSON.parse(String(imp.init!.body)).scope).toEqual(["https://www.googleapis.com/auth/youtube.force-ssl"]);
	});

	it("caches the token across calls (no second exchange)", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			String(url).includes("sts.googleapis.com") ? stsOk() : impOk(),
		);

		const { getYouTubeAccessToken } = await import("../../worker/gcp-token");
		await getYouTubeAccessToken(ENV);
		await getYouTubeAccessToken(ENV);

		expect(fetchMock).toHaveBeenCalledTimes(2); // STS + impersonation once, not twice
	});

	it("reuses the persisted token after a fresh module load", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			String(url).includes("sts.googleapis.com") ? stsOk() : impOk(),
		);

		const firstModule = await import("../../worker/gcp-token");
		await firstModule.getYouTubeAccessToken(ENV);
		vi.resetModules();
		const freshModule = await import("../../worker/gcp-token");
		await freshModule.getYouTubeAccessToken(ENV);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(ENV.KV.get).toHaveBeenCalled();
	});

	it("throws when STS rejects the assertion", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad audience" }), { status: 400 }),
		);
		const { getYouTubeAccessToken } = await import("../../worker/gcp-token");
		await expect(getYouTubeAccessToken(ENV)).rejects.toThrow(/STS exchange failed/);
	});
});
