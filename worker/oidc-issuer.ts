// Standalone OIDC issuer for Cloudflare-worker → cloud federation.
//
// Publishes the discovery document + JWKS that external token services fetch to
// validate the self-signed client assertions our workers mint:
//   - Azure Entra (telemetry gateway → Azure Monitor DCR)
//   - GCP STS (YouTube Data API access via Workload Identity Federation)
//
// This worker holds ONLY the public key. Signing happens in the workers that mint
// tokens (they read the private key from the OIDC_SIGNING_KEY Secrets Store entry). The kid
// here must match the kid those workers stamp in their JWT header.

interface Env {
  ISSUER_URL: string;
}

const PUBLIC_JWK = {
  kty: "RSA",
  kid: "03c90718",
  n: "2vvv7F-W8HekKbKG60LaSaEXKI1kkU3a9KX-4J58gLrMBJ66IEN8X9f01sggiU2BAwqCq-ul9e4XAhGqCk16oyavUFFD9K_1ylc2RcRNnttZpeD3gc7rT5L5KV21ILZvEz2ceDIfoZdIKDG-Of-EpEYHOiLzxxwnDgDD8KhRqLyirbi31koHhCGna91KP0JcAv9pDlZR-E6pIcwuq11I35IQ0zrJJlsBC3e1GUYHbQOjuK4ZiWmBUjPtZt2LExH6oSYxtDWFEtmMulKamYWpn-__SdII6KYjgWdd2JU8SAEr3V1iYYk_LB3D4wYCpxxUXxnBfewJS7vlWDhlh-EDKQ",
  e: "AQAB",
  alg: "RS256",
  use: "sig",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      return Response.json(
        {
          issuer: env.ISSUER_URL,
          jwks_uri: `${env.ISSUER_URL}/.well-known/jwks.json`,
          response_types_supported: ["id_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        },
        { headers: { "Cache-Control": "public, max-age=3600" } },
      );
    }

    if (request.method === "GET" && path === "/.well-known/jwks.json") {
      return Response.json(
        { keys: [PUBLIC_JWK] },
        { headers: { "Cache-Control": "public, max-age=3600" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
