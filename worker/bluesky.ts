import { AtpAgent, RichText } from "@atproto/api";
import type { AppBskyRichtextFacet, BlobRef } from "@atproto/api";
import { NonRetryableError } from "cloudflare:workflows";
import type { BlueskyAccountConfig, CachedSession } from "./types";
import { log, warn, error, verbose } from "./log";
import { MAX_IMAGE_SIZE, SESSION_TTL, BLUESKY_LABELER_DID, BLUESKY_PUBLIC_API, DEFAULT_PDS_URL, PLC_DIRECTORY_URL, PDS_CACHE_TTL } from "./constants";

export interface PostResult {
	uri: string;
	cid: string;
}

export interface UploadedMedia {
	blob: BlobRef;
	aspectRatio?: { width: number; height: number };
	altText?: string;
}

export interface ExternalCard {
	uri: string;
	title: string;
	description: string;
	thumb?: BlobRef;
}

export class BlueskyClient {
	private agent: AtpAgent;
	private handle: string;
	private password: string;

	constructor(handle: string, password: string, service: string) {
		this.handle = handle;
		this.password = password;
		// `service` is the account's resolved PDS endpoint (see resolvePdsUrl). It must
		// NOT be inferred from the handle: custom-domain handles (e.g. "alice.com") don't
		// host the account's PDS, so slicing the handle would point auth at the wrong host.
		this.agent = new AtpAgent({
			service,
			fetch: async (url, init) => {
				const response = await globalThis.fetch(url, init);
				if (response.status === 429) {
					const headers = Object.fromEntries(response.headers.entries());
					error({ tag: "bsky-ratelimit", method: init?.method ?? "GET", url, headers, message: `429 rate limited: ${init?.method ?? "GET"} ${url}` });
				}
				return response;
			},
		});
	}

	getDid(): string {
		return this.agent.session!.did;
	}

	async resolveHandle(handle: string): Promise<string> {
		const res = await this.agent.resolveHandle({ handle });
		return res.data.did;
	}

	async login(): Promise<void> {
		verbose({ tag: "login", handle: this.handle, serviceUrl: String(this.agent.serviceUrl), message: `${this.handle}: logging in` });
		try {
			await this.agent.login({ identifier: this.handle, password: this.password });
		} catch (err: unknown) {
			const retryAfter = this.getRetryAfter(err);
			if (!retryAfter) throw err;
			log({ tag: "login", handle: this.handle, retryAfterSec: retryAfter, message: `${this.handle}: rate limited, waiting ${retryAfter}s before retry` });
			await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
			await this.agent.login({ identifier: this.handle, password: this.password });
		}
		verbose({ tag: "login", handle: this.handle, did: this.agent.session!.did, message: `${this.handle}: logged in` });
	}

	async tryResumeCachedSession(cached: CachedSession): Promise<boolean> {
		this.agent.sessionManager.session = {
			accessJwt: cached.accessJwt,
			refreshJwt: "",
			did: cached.did,
			handle: cached.handle,
			active: true,
		};
		try {
			await this.agent.com.atproto.server.getSession();
			verbose({ tag: "login", handle: this.handle, did: cached.did, message: `${this.handle}: resumed cached session` });
			return true;
		} catch (err) {
			const status = (err as { status?: number }).status;
			const message = err instanceof Error ? err.message : String(err);
			log({ tag: "login", handle: this.handle, status, error: message, message: `${this.handle}: cached session failed, falling back to login` });
			this.agent.sessionManager.session = undefined;
			return false;
		}
	}

	getSessionForCache(): CachedSession {
		const session = this.agent.session!;
		return { accessJwt: session.accessJwt, did: session.did, handle: session.handle };
	}

	private getRetryAfter(err: unknown): number | null {
		const headers = (err as { headers?: { [key: string]: string } }).headers;
		if (!headers) return null;
		const val = headers["retry-after"] ?? headers["x-ratelimit-after"];
		if (!val) return null;
		const seconds = Number(val);
		return Number.isFinite(seconds) ? seconds : null;
	}

	async uploadImage(imageUrl: string): Promise<UploadedMedia> {
		const response = await fetch(imageUrl);
		if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

		const data = new Uint8Array(await response.arrayBuffer());
		if (data.byteLength > MAX_IMAGE_SIZE) {
			warn({ tag: "uploadImage", url: imageUrl, bytes: data.byteLength, maxSize: MAX_IMAGE_SIZE, message: `image exceeds ${MAX_IMAGE_SIZE} byte limit (${data.byteLength}): ${imageUrl}` });
			throw new Error(`Image exceeds size limit: ${imageUrl}`);
		}
		const mimeType = response.headers.get("Content-Type") ?? "image/jpeg";
		const uploadResult = await this.uploadBlobWithRetry(data, mimeType, imageUrl);
		return { blob: uploadResult.data.blob };
	}

	// The PDS intermittently returns transient 5xx from uploadBlob. Without a retry
	// the caller catches the throw and silently drops the image, posting without it.
	// Retry transient failures; rethrow client errors (4xx) immediately.
	private async uploadBlobWithRetry(data: Uint8Array, encoding: string, url: string) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.agent.uploadBlob(data, { encoding });
			} catch (err) {
				const status = (err as { status?: number }).status;
				const transient = status === undefined || status === 429 || status >= 500;
				if (!transient || attempt >= 2) throw err;
				const delayMs = 500 * (attempt + 1);
				warn({ tag: "uploadImage", url, attempt, status, message: `transient uploadBlob failure (${String(err)}), retrying in ${delayMs}ms: ${url}` });
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}

	async createPost(
		text: string,
		createdAt: Date,
		options?: {
			images?: UploadedMedia[];
			external?: ExternalCard;
			replyToUri?: string;
			replyToCid?: string;
			replyRootUri?: string;
			replyRootCid?: string;
			facets?: AppBskyRichtextFacet.Main[];
		},
	): Promise<PostResult> {
		// Detect facets (clickable links + hashtags). Auto-detected MENTIONS are dropped:
		// mirrored YouTube text can contain strings like `@someone.com` that resolve to a
		// real Bluesky handle, which would tag/notify an unrelated user. Explicit mentions
		// (e.g. commenter attribution) are supplied via `options.facets`.
		const rt = new RichText({ text });
		await rt.detectFacets(this.agent);

		const isMention = (f: AppBskyRichtextFacet.Main): boolean =>
			(f.features ?? []).some((ft) => ft.$type === "app.bsky.richtext.facet#mention");
		const detected = ((rt.facets ?? []) as AppBskyRichtextFacet.Main[]).filter((f) => !isMention(f));
		const manual = options?.facets ?? [];
		const overlapsManual = (f: AppBskyRichtextFacet.Main): boolean =>
			manual.some((m) => !(m.index.byteEnd <= f.index.byteStart || m.index.byteStart >= f.index.byteEnd));
		const facets = [...detected.filter((f) => !overlapsManual(f)), ...manual]
			.sort((a, b) => a.index.byteStart - b.index.byteStart);

		const record: { [key: string]: unknown } = {
			text: rt.text,
			createdAt: createdAt.toISOString(),
		};
		if (facets.length > 0) {
			record.facets = facets;
		}

		// Media embed (images) takes precedence; otherwise external link card.
		if (options?.images && options.images.length > 0) {
			record.embed = {
				$type: "app.bsky.embed.images",
				images: options.images.map((img) => ({
					alt: img.altText ?? "",
					image: img.blob,
					aspectRatio: img.aspectRatio,
				})),
			};
		} else if (options?.external) {
			record.embed = {
				$type: "app.bsky.embed.external",
				external: {
					uri: options.external.uri,
					title: options.external.title,
					description: options.external.description,
					...(options.external.thumb ? { thumb: options.external.thumb } : {}),
				},
			};
		}

		// Reply reference
		if (options?.replyToUri && options?.replyToCid) {
			record.reply = {
				root: {
					uri: options.replyRootUri ?? options.replyToUri,
					cid: options.replyRootCid ?? options.replyToCid,
				},
				parent: { uri: options.replyToUri, cid: options.replyToCid },
			};
		}

		const result = await this.agent.post(record as Parameters<AtpAgent["post"]>[0]);
		return { uri: result.uri, cid: result.cid };
	}

	async updateProfile(fields: {
		displayName?: string;
		description?: string;
		avatar?: BlobRef;
		banner?: BlobRef;
	}): Promise<void> {
		const did = this.agent.session!.did;
		const existing = await this.agent.com.atproto.repo.getRecord({
			repo: did,
			collection: "app.bsky.actor.profile",
			rkey: "self",
		});
		const profileRecord = existing.data.value as { [key: string]: unknown };

		if (fields.displayName !== undefined) profileRecord.displayName = fields.displayName;
		if (fields.description !== undefined) profileRecord.description = fields.description;
		if (fields.avatar !== undefined) profileRecord.avatar = fields.avatar;
		if (fields.banner !== undefined) profileRecord.banner = fields.banner;

		await this.agent.com.atproto.repo.putRecord({
			repo: did,
			collection: "app.bsky.actor.profile",
			rkey: "self",
			record: profileRecord,
		});
	}

	async updatePinnedPost(pinnedPost: { uri: string; cid: string } | null): Promise<void> {
		const did = this.agent.session!.did;
		const existing = await this.agent.com.atproto.repo.getRecord({
			repo: did,
			collection: "app.bsky.actor.profile",
			rkey: "self",
		});
		const profileRecord = existing.data.value as { [key: string]: unknown };

		if (pinnedPost) {
			profileRecord.pinnedPost = { uri: pinnedPost.uri, cid: pinnedPost.cid };
		} else {
			delete profileRecord.pinnedPost;
		}

		await this.agent.com.atproto.repo.putRecord({
			repo: did,
			collection: "app.bsky.actor.profile",
			rkey: "self",
			record: profileRecord,
		});
	}

	async uploadBlobFromUrl(url: string): Promise<BlobRef> {
		const uploaded = await this.uploadImage(url);
		return uploaded.blob;
	}

	async deleteRecord(uri: string): Promise<void> {
		const parts = uri.split("/");
		const rkey = parts[parts.length - 1];
		const collection = parts[parts.length - 2];
		await this.agent.com.atproto.repo.deleteRecord({
			repo: this.agent.session!.did,
			collection,
			rkey,
		});
	}
}

/**
 * Resolve a handle to its PDS service endpoint: handle → DID → DID document →
 * `#atproto_pds` service. Falls back to the default entryway when any step fails
 * (e.g. handle temporarily unresolvable). Never derives the host from the handle.
 */
export async function resolvePdsUrl(handle: string): Promise<string> {
	return (await resolvePds(handle)).url;
}

/**
 * Resolve a handle's PDS via its DID document. `confirmed` is false when we fell
 * back to the default PDS because DID/PLC resolution failed (unknown handle, doc
 * fetch timeout/error, or no `#atproto_pds` service) — callers must not cache an
 * unconfirmed result, or a transient outage would pin self-hosted accounts to the
 * wrong PDS for the full cache TTL.
 */
async function resolvePds(handle: string): Promise<{ url: string; confirmed: boolean }> {
	const fallback = { url: DEFAULT_PDS_URL, confirmed: false };
	const did = await resolveHandleToDid(handle);
	if (!did) return fallback;

	const docUrl = did.startsWith("did:plc:")
		? `${PLC_DIRECTORY_URL}/${did}`
		: did.startsWith("did:web:")
			? `https://${decodeURIComponent(did.slice("did:web:".length)).replace(/:/g, "/")}/.well-known/did.json`
			: null;
	if (!docUrl) return fallback;

	const res = await fetchWithTimeout(docUrl, 5000);
	if (!res || !res.ok) return fallback;
	const doc = await res.json<{ service?: { id: string; type: string; serviceEndpoint: string }[] }>().catch(() => null);
	const pds = doc?.service?.find(
		(s) => s.id.endsWith("#atproto_pds") || s.type === "AtprotoPersonalDataServer",
	)?.serviceEndpoint;
	if (!pds) return fallback;
	return { url: pds, confirmed: true };
}

/** Resolve the PDS for an account, caching confirmed resolutions in KV to skip the round-trips. */
async function getPdsUrl(kv: KVNamespace, account: string): Promise<string> {
	const cacheKey = `pds:${account}`;
	const cached = await kv.get(cacheKey, "text");
	if (cached) return cached;
	const { url, confirmed } = await resolvePds(account);
	// Never cache a fallback: a transient DID/PLC failure would otherwise mis-route
	// every login for this account until the TTL expires.
	if (confirmed) await kv.put(cacheKey, url, { expirationTtl: PDS_CACHE_TTL });
	return url;
}

export async function getAuthenticatedClient(
	kv: KVNamespace,
	env: { [key: string]: SecretsStoreSecret },
	config: BlueskyAccountConfig,
): Promise<BlueskyClient> {
	const cacheKey = `session:${config.atProtoAccount}`;
	const cached = await kv.get<CachedSession>(cacheKey, "json");
	const service = await getPdsUrl(kv, config.atProtoAccount);
	verbose({ tag: "login", handle: config.atProtoAccount, cacheKey, service, hasCachedSession: !!cached, message: `${config.atProtoAccount}: getAuthenticatedClient cacheKey=${cacheKey} service=${service} hasCached=${!!cached}` });

	if (cached) {
		const client = new BlueskyClient(config.atProtoAccount, "", service);
		const resumed = await client.tryResumeCachedSession(cached);
		if (resumed) return client;
	}

	const secret = env[config.passwordKey];
	if (!secret) {
		const err = new NonRetryableError(`Secret not found for binding: ${config.passwordKey}`);
		error({ tag: "login", account: config.atProtoAccount, message: err.message, exceptionType: "NonRetryableError", stack: err.stack });
		throw err;
	}
	const password = await secret.get();

	const client = new BlueskyClient(config.atProtoAccount, password, service);
	try {
		await client.login();
	} catch (caught) {
		const msg = caught instanceof Error ? caught.message : String(caught);
		if (msg.includes("Authentication") || msg.includes("Invalid identifier or password")) {
			const err = new NonRetryableError(`Login failed for ${config.atProtoAccount}: ${msg}`);
			error({ tag: "login", account: config.atProtoAccount, message: err.message, exceptionType: "NonRetryableError", stack: err.stack });
			throw err;
		}
		throw caught;
	}

	await kv.put(cacheKey, JSON.stringify(client.getSessionForCache()), { expirationTtl: SESSION_TTL });
	return client;
}

export interface ModerationLabel {
	src: string;
	uri: string;
	val: string;
	cts: string;
	exp?: string;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await fetch(url, { signal: controller.signal });
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Resolve a Bluesky handle to a DID via the public API. Null if unresolvable. */
export async function resolveHandleToDid(handle: string): Promise<string | null> {
	const url = `${BLUESKY_PUBLIC_API}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await fetchWithTimeout(url, 5000);
		if (res && res.ok) {
			const data = await res.json<{ did: string }>();
			return data.did;
		}
		if (res && res.status === 400) return null; // permanent: invalid/unknown handle
		if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
	}
	return null;
}

/** Query moderation labels for a DID from Bluesky's official labeler. */
export async function queryModerationLabels(did: string): Promise<ModerationLabel[]> {
	const params = new URLSearchParams({ uriPatterns: did, sources: BLUESKY_LABELER_DID });
	const res = await fetchWithTimeout(
		`${BLUESKY_PUBLIC_API}/xrpc/com.atproto.label.queryLabels?${params}`,
		5000,
	);
	if (!res || !res.ok) return [];
	const data = await res.json<{ labels: ModerationLabel[] }>();
	return data.labels;
}
