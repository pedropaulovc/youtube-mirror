# Workload identity federation

Production and PPE have separate Cloudflare identities. A Worker in one account must not be able to reuse the other account's issuer, signing key, provider, or gateway bearer.

| Environment | Cloudflare account | OIDC Worker | GCP provider ID | Azure federated credential |
|---|---|---|---|---|
| Production | `c6f17a1f1124bf50cba0f5e495aef9ba` | `youtube-mirror-oidc-issuer` in production | `youtube-mirror-oidc-production` | `cf-worker-federation-production` |
| PPE | `b846acaf5be2e542781751bd94a63153` | `youtube-mirror-oidc-issuer` in PPE | `youtube-mirror-oidc-ppe` | `cf-worker-federation-ppe` |

The Worker names match because Cloudflare account boundaries keep them separate. Each GitHub Environment supplies its own `WORKERS_DEV_SUBDOMAIN`, `OIDC_ISSUER_URL`, `OIDC_SIGNING_KID`, and `OIDC_PUBLIC_JWK`. The signing kid must start with `production-` or `ppe-`, as appropriate. `scripts/verify-environment.ts` checks that the workers.dev subdomain belongs to the selected account and that discovery serves the expected JWK.

The private RSA key is the `OIDC_SIGNING_KEY` GitHub Environment secret. The deployment copies it into that environment's Secrets Store as `youtube-mirror-oidc-signing-key`. Never copy a keypair between environments.

## GCP provider setup

Both providers may impersonate `GCP_SERVICE_ACCOUNT`, but they are separate provider resources with separate issuer URLs.

For each environment:

1. Create an OIDC provider in the `cloudflare-workers` pool. Use provider ID `youtube-mirror-oidc-production` or `youtube-mirror-oidc-ppe`.
2. Set its issuer URI to that environment's `OIDC_ISSUER_URL`.
3. Map `google.subject` to `assertion.sub`.
4. Grant only subject `cf-worker:youtube-mirror-youtube-api` permission to impersonate the service account. Do not grant the whole pool.
5. Put the provider resource name in that GitHub Environment's `GCP_WORKLOAD_PROVIDER`. It must end with the matching provider ID.
6. Put the impersonation target in `GCP_SERVICE_ACCOUNT`.

The Worker exchanges its assertion at GCP STS, then requests a service account token with scope `https://www.googleapis.com/auth/youtube.force-ssl`. The YouTube comment APIs reject the narrower readonly scope.

## Azure provider setup

Create two federated credentials on the managed identity selected by each environment's `AZURE_APP_CLIENT_ID`:

| Credential | Issuer | Subject | Audience |
|---|---|---|---|
| `cf-worker-federation-production` | production `OIDC_ISSUER_URL` | `cf-worker:youtube-mirror-telemetry-gateway` | `api://AzureADTokenExchange` |
| `cf-worker-federation-ppe` | PPE `OIDC_ISSUER_URL` | `cf-worker:youtube-mirror-telemetry-gateway` | `api://AzureADTokenExchange` |

Set `AZURE_TENANT_ID`, `AZURE_APP_CLIENT_ID`, and all three `OTLP_*_ENDPOINT` variables separately in `production` and `ppe`. They may select different Azure destinations. If policy allows a shared DCR, keep the two federated credentials and Cloudflare gateway bearers separate anyway.

## Provisioning order

Provision PPE first, then production:

1. Activate the account's workers.dev subdomain. Record only the subdomain in `WORKERS_DEV_SUBDOMAIN`.
2. Create a KV namespace and Secrets Store in that account. Record their IDs in `KV_NAMESPACE_ID` and `SECRETS_STORE_ID` in the matching GitHub Environment.
3. Generate a new RSA keypair. Store the private key as GitHub secret `OIDC_SIGNING_KEY`; store the public JWK as variable `OIDC_PUBLIC_JWK`; store its environment-prefixed kid as `OIDC_SIGNING_KID`.
4. Set `OIDC_ISSUER_URL` and `TELEMETRY_GATEWAY_ORIGIN` to the two Workers' exact origins under that subdomain.
5. Create the environment's GCP provider and Azure federated credential.
6. Generate a new `GATEWAY_INGEST_BEARER`. Do not reuse the other environment's bearer.
7. Set `ENABLE_SCHEDULES=false` until state and credentials are ready.
8. Run the environment deployment. It deploys the issuer first, verifies discovery and JWKS, uploads the gateway secret with the selected account ID, deploys the gateway, configures destinations, then deploys item, delete, profile, and channel.

## Verification

These checks read the selected GitHub Environment. They do not need literal resource IDs in the repository.

```bash
# Load the environment variables and secrets into the shell first.
npm run verify:production
npm run verify:ppe

curl --fail "$OIDC_ISSUER_URL/.well-known/openid-configuration" | jq
curl --fail "$OIDC_ISSUER_URL/.well-known/jwks.json" | jq --arg kid "$OIDC_SIGNING_KID" \
  -e '.keys | length == 1 and .[0].kid == $kid'
```

The verifier checks the account allowlist, KV and store ownership, workers.dev subdomain ownership, active Secrets Store metadata across every page, deployed binding IDs, discovery origin, and full JWK. For telemetry, send an authenticated OTLP logs and traces payload to `TELEMETRY_GATEWAY_ORIGIN`. A request with the wrong bearer can be accepted and dropped, so HTTP status alone is not proof; confirm the record in the selected Azure destination.

## Retiring the old federation

Keep the old GCP provider and Azure federated credential until production has completed token exchanges through both new providers. Then remove only the youtube-mirror provider, its obsolete service-account binding, and its Azure credential from the retired source deployment. Do not remove federation resources used by twitter-mirror or another service.
