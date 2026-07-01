# Workload Identity Federation — youtube-mirror

The Cloudflare workers authenticate to Azure and GCP without long-lived cloud
secrets. They mint a short-lived RS256 JWT (self-signed with the private key held
in the Secrets Store, bound as `OIDC_SIGNING_KEY`) and exchange it at each cloud's
token service. Both clouds validate that JWT against **one shared OIDC issuer**.

None of the values below are secrets (they're resource identifiers). The only
secrets are the `OIDC_SIGNING_KEY` Secrets Store entry (RSA private key) and the
`INGEST_BEARER` wrangler secret — never committed.

## Shared OIDC issuer

- Worker: `youtube-mirror-oidc-issuer` (`worker/oidc-issuer.ts`)
- Issuer URL: `https://youtube-mirror-oidc-issuer.pedro-18e.workers.dev`
- Serves `/.well-known/openid-configuration` and `/.well-known/jwks.json`
- Signing key id (kid): `03c90718` — must match `OIDC_SIGNING_KID` on minting workers
- Public key lives in `worker/oidc-issuer.ts`; private key is the `OIDC_SIGNING_KEY` Secrets Store entry

## Azure (telemetry → Azure Monitor DCR)

- Tenant: `6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8`
- User-assigned managed identity: `mi-youtube-mirror-cloudflare-wu2`
  (rg `rg-youtube-mirror-wu2`), clientId `585e33f6-df1c-4998-bf9d-dcbe3c585d99`
- Federated credential `cf-worker-federation`:
  issuer = shared issuer URL, subject = `cf-worker:youtube-mirror-telemetry-gateway`,
  audience = `api://AzureADTokenExchange`
- Role: MI has **Monitoring Metrics Publisher** on DCR `managed-ai-youtube-mirror-wu2-dcr`
- Token exchange: `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://monitor.azure.com/.default`
- DCR OTLP endpoints wired into `wrangler.mirror-telemetry-gateway.jsonc`

## GCP (YouTube API — project youtube-mirror)

- Project: `youtube-mirror-501119` (display "youtube-mirror", number `410438001325`)
- Workload identity pool: `cloudflare-workers`
- OIDC provider: `youtube-mirror-oidc`, issuer-uri = shared issuer URL,
  attribute mapping `google.subject=assertion.sub`
- STS audience (the `aud` a worker must stamp when exchanging at GCP):
  `//iam.googleapis.com/projects/410438001325/locations/global/workloadIdentityPools/cloudflare-workers/providers/youtube-mirror-oidc`
- Service account (impersonation target): `youtube-mirror-cf@youtube-mirror-501119.iam.gserviceaccount.com`
- Binding: whole pool → `roles/iam.workloadIdentityUser` on that SA
- Token scope requested on impersonation: `https://www.googleapis.com/auth/youtube.force-ssl`
  (youtube.readonly is rejected by commentThreads/comments with 403 insufficientPermissions;
  force-ssl is a superset that also covers playlistItems/videos reads — verified live)

This **replaces the static YouTube Data API key**. The workers mint an SA access token
(`worker/gcp-token.ts`) and call the Data API with `Authorization: Bearer`. The mirror
only does public-by-ID reads (uploads playlist, `videos.list?id=`, `commentThreads.list?videoId=`),
which a service-account token can perform — the "no YouTube channel" limitation only
affects user-context operations (`mine=true`, uploads), which we never call.
