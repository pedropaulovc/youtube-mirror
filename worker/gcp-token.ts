import { signAssertion } from "./oidc-sign";

// Obtain a YouTube-scoped Google access token via Workload Identity Federation,
// so the workers call the Data API with an `Authorization: Bearer` header instead
// of a static API key. Flow:
//   1. self-sign an assertion (aud = the WIF provider resource)
//   2. exchange it at GCP STS for a federated token
//   3. impersonate the youtube-mirror-cf service account for a YouTube access token
// See infra/federation.md for the provider/SA identifiers.
//
// Scope note: youtube.readonly covers playlistItems/videos reads but the comment
// endpoints (commentThreads/comments) reject it with 403 insufficientPermissions —
// they require youtube.force-ssl, which is a superset that also covers the reads.
// Verified empirically against the live API before deploy.

const SUBJECT = "cf-worker:youtube-mirror-youtube-api";
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const STS_ENDPOINT = "https://sts.googleapis.com/v1/token";

interface GcpTokenEnv {
  OIDC_ISSUER_URL: string;
  OIDC_SIGNING_KID: string;
  OIDC_SIGNING_KEY: { get(): Promise<string> };
  GCP_WORKLOAD_PROVIDER: string;
  GCP_SERVICE_ACCOUNT: string;
}

let cache: { token: string; expiresAt: number } | null = null;

export async function getYouTubeAccessToken(env: GcpTokenEnv): Promise<string> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.token;
  }

  const assertion = await signAssertion({
    issuer: env.OIDC_ISSUER_URL,
    subject: SUBJECT,
    audience: env.GCP_WORKLOAD_PROVIDER,
    kid: env.OIDC_SIGNING_KID,
    privateKeyPem: await env.OIDC_SIGNING_KEY.get(),
  });

  // 1. Federated token from STS (only good for impersonating the bound SA).
  const stsRes = await fetch(STS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: env.GCP_WORKLOAD_PROVIDER,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: assertion,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    }).toString(),
  });
  const sts = (await stsRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!sts.access_token) {
    throw new Error(`GCP STS exchange failed: ${sts.error} — ${sts.error_description}`);
  }

  // 2. Impersonate the service account for a YouTube-scoped access token.
  const impRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GCP_SERVICE_ACCOUNT}:generateAccessToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sts.access_token}` },
      body: JSON.stringify({ scope: [YOUTUBE_SCOPE] }),
    },
  );
  const imp = (await impRes.json()) as {
    accessToken?: string;
    expireTime?: string;
    error?: { message?: string };
  };
  if (!imp.accessToken) {
    throw new Error(`SA impersonation failed: ${imp.error?.message ?? impRes.status}`);
  }

  const expiresAt = imp.expireTime
    ? new Date(imp.expireTime).getTime() - 60_000
    : Date.now() + 30 * 60_000;
  cache = { token: imp.accessToken, expiresAt };
  return cache.token;
}
