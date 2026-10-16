import { afterEach, describe, expect, it, vi } from "vitest";
import gateway from "../../worker/telemetry-gateway";
import { bytes, decode, only, str } from "../helpers/protobuf";

// Mock the signer so this suite exercises the gateway's OTLP forwarding path, not
// RS256 signing (covered in oidc-sign.test.ts).
vi.mock("../../worker/oidc-sign", () => ({
  signAssertion: vi.fn(async () => "header.payload.signature"),
}));

const ENVIRONMENT_KEY = "deployment.environment.name";

const baseEnv = {
  TENANT_ID: "6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8",
  APP_CLIENT_ID: "585e33f6-df1c-4998-bf9d-dcbe3c585d99",
  OTLP_TRACES_ENDPOINT: "https://monitor.example/otlp/v1/traces",
  OTLP_METRICS_ENDPOINT: "https://monitor.example/otlp/v1/metrics",
  OTLP_LOGS_ENDPOINT: "https://monitor.example/otlp/v1/logs",
  OIDC_ISSUER_URL: "https://issuer.example",
  OIDC_SIGNING_KID: "test-kid",
  OIDC_SIGNING_KEY: { get: async () => "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" },
  GATEWAY_FEDERATION_SUBJECT: "youtube-mirror-telemetry-gateway",
  INGEST_BEARER: "ingest-secret",
};

const ctx = {} as ExecutionContext;

// Stub Entra + Azure Monitor; return the protobuf bodies forwarded per endpoint.
function captureUpstream(): Map<string, Uint8Array> {
  const forwarded = new Map<string, Uint8Array>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://login.microsoftonline.com/")) {
      return new Response(JSON.stringify({ access_token: "entra-token", expires_in: 3600 }), { status: 200 });
    }
    forwarded.set(target, init?.body as Uint8Array);
    return new Response("{}", { status: 200 });
  });
  return forwarded;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function otlpPost(path: string, body: BodyInit): Request {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${baseEnv.INGEST_BEARER}`, "Content-Type": "application/json" },
    body,
  });
}

// Decode each ResourceLogs/ResourceSpans (request field 1) → its Resource (field 1)
// → string-valued attributes as ordered [key, value] pairs.
function resourceAttributes(request: Uint8Array): [string, string][][] {
  return decode(request)
    .filter((f) => f.field === 1)
    .map((batch) => {
      const resource = decode(bytes(only(decode(bytes(batch)), 1)));
      return resource
        .filter((f) => f.field === 1)
        .map((attr) => {
          const kv = decode(bytes(attr));
          return [str(only(kv, 1)), str(only(decode(bytes(only(kv, 2))), 1))];
        });
    });
}

describe("telemetry gateway deployment environment label", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stamps the configured environment on every log resource, replacing payload labels", async () => {
    const forwarded = captureUpstream();
    const body = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "youtube-mirror-channel" } },
              { key: ENVIRONMENT_KEY, value: { stringValue: "ppe" } },
              { key: "cloudflare.script_name", value: { stringValue: "youtube-mirror-channel" } },
            ],
          },
          scopeLogs: [{ logRecords: [{ body: { stringValue: "hello" } }] }],
        },
        { scopeLogs: [{ logRecords: [{ body: { stringValue: "no resource" } }] }] },
      ],
    });

    const response = await gateway.fetch(
      otlpPost("/v1/logs", await gzip(body)),
      { ...baseEnv, DEPLOYMENT_ENVIRONMENT: "production" },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(resourceAttributes(forwarded.get(baseEnv.OTLP_LOGS_ENDPOINT)!)).toEqual([
      [
        ["service.name", "youtube-mirror-channel"],
        ["cloudflare.script_name", "youtube-mirror-channel"],
        [ENVIRONMENT_KEY, "production"],
      ],
      [[ENVIRONMENT_KEY, "production"]],
    ]);
  });

  it("stamps the configured environment on every span resource, replacing payload labels", async () => {
    const forwarded = captureUpstream();
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: ENVIRONMENT_KEY, value: { stringValue: "production" } },
              { key: "service.name", value: { stringValue: "youtube-mirror-item" } },
              { key: ENVIRONMENT_KEY, value: { stringValue: "staging" } },
            ],
          },
          scopeSpans: [{ spans: [{ name: "kv_get" }] }],
        },
        { resource: {}, scopeSpans: [{ spans: [{ name: "kv_put" }] }] },
      ],
    });

    const response = await gateway.fetch(
      otlpPost("/v1/traces", body),
      { ...baseEnv, DEPLOYMENT_ENVIRONMENT: "ppe" },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(resourceAttributes(forwarded.get(baseEnv.OTLP_TRACES_ENDPOINT)!)).toEqual([
      [
        ["service.name", "youtube-mirror-item"],
        [ENVIRONMENT_KEY, "ppe"],
      ],
      [[ENVIRONMENT_KEY, "ppe"]],
    ]);
  });
});
