import { describe, it, expect } from "vitest";
import { signAssertion } from "../../worker/oidc-sign";

function pkcs8ToPem(der: ArrayBuffer): string {
	const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
	return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

function b64urlToBytes(s: string): Uint8Array {
	return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
function b64urlToJson(s: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

describe("signAssertion", () => {
	it("produces an RS256 JWT with the given claims that verifies against the public key", async () => {
		const pair = (await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const pem = pkcs8ToPem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);

		const jwt = await signAssertion({
			issuer: "https://issuer.example/",
			subject: "cf-worker:youtube-mirror-youtube-api",
			audience: "//iam.googleapis.com/projects/1/.../providers/youtube-mirror-oidc",
			kid: "03c90718",
			privateKeyPem: pem,
			ttlSeconds: 300,
		});

		const [h, p, sig] = jwt.split(".");
		expect(b64urlToJson(h)).toMatchObject({ alg: "RS256", kid: "03c90718", typ: "JWT" });

		const payload = b64urlToJson(p);
		expect(payload.iss).toBe("https://issuer.example/");
		expect(payload.sub).toBe("cf-worker:youtube-mirror-youtube-api");
		expect(payload.aud).toBe("//iam.googleapis.com/projects/1/.../providers/youtube-mirror-oidc");
		expect((payload.exp as number) - (payload.iat as number)).toBe(300);

		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			pair.publicKey,
			b64urlToBytes(sig),
			new TextEncoder().encode(`${h}.${p}`),
		);
		expect(ok).toBe(true);
	});

	it("signatures differ from a mismatched key (rejects forgery)", async () => {
		const [a, b] = await Promise.all([
			crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]),
			crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]),
		]) as CryptoKeyPair[];
		const pem = pkcs8ToPem((await crypto.subtle.exportKey("pkcs8", a.privateKey)) as ArrayBuffer);
		const jwt = await signAssertion({ issuer: "i", subject: "s", audience: "aud", kid: "k", privateKeyPem: pem });
		const [h, p, sig] = jwt.split(".");

		// verifying with the OTHER key pair's public key must fail
		const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", b.publicKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
		expect(ok).toBe(false);
	});
});
