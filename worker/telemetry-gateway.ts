interface Env {
  TENANT_ID: string;
  APP_CLIENT_ID: string;
  OTLP_INGESTION_ENDPOINT: string;
  GATEWAY_ISSUER_URL: string;
  GATEWAY_FEDERATION_SUBJECT: string;
  GATEWAY_SIGNING_KID: string;
  GATEWAY_SIGNING_KEY: string;
  INGEST_BEARER: string;
  APP_INSTRUMENTATION_KEY: string;
}

const GATEWAY_PUBLIC_JWK = {
  kty: "RSA",
  kid: "5bc80ce2",
  n: "rpSEaNqV82DO5pjHAnI90s29akyT2gh3ZjZwZmNc5mygKghFJo65_sM6XhUYZIbyUwj4R1jQR5Y6xx_lfmrpd5-zZHNeluV1UK-ohf6bqJwdguVzzxgRNL7EULNdqQhh2IdzaHqdV4g1AZJxEDody3hr79a5CR9QY1vgJ73R_fTIEPzhgC2Uy25QHV7Q3MXgrDeSiPtCyod69dZtDXR6LRH0D9jIax2_jPeZROLQY4Xtj8TC8CtKf6ZCu-x4vNckVuVFbKEKRtdcYKPsSPlPiY966QtPK7ZD8-3ozcW4mhPmPgIm0hRbvrQI2_BE--xmtBZaiy9Mbr3gQPdkWxTzjQ",
  e: "AQAB",
  alg: "RS256",
  use: "sig",
};

let tokenCache: { token: string; expiresAt: number } | null = null;


function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function mintAssertionJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", kid: env.GATEWAY_SIGNING_KID, typ: "JWT" };
  const payload = {
    iss: env.GATEWAY_ISSUER_URL,
    sub: env.GATEWAY_FEDERATION_SUBJECT,
    aud: "api://AzureADTokenExchange",
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  };

  const encoder = new TextEncoder();
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)).buffer as ArrayBuffer);
  const payloadB64 = base64url(encoder.encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(env.GATEWAY_SIGNING_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64url(signature)}`;
}

export async function getEntraToken(env: Env): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const assertion = await mintAssertionJwt(env);

  const body = new URLSearchParams({
    client_id: env.APP_CLIENT_ID,
    grant_type: "client_credentials",
    scope: "https://monitor.azure.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    throw new Error(
      `Entra token exchange failed: ${data.error} — ${data.error_description}`,
    );
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in! - 60) * 1000,
  };

  return tokenCache.token;
}

function oidcDiscovery(env: Env): Response {
  return Response.json(
    {
      issuer: env.GATEWAY_ISSUER_URL,
      jwks_uri: `${env.GATEWAY_ISSUER_URL}/.well-known/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}

function jwksEndpoint(): Response {
  return Response.json(
    { keys: [GATEWAY_PUBLIC_JWK] },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}

async function forwardOtlp(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.INGEST_BEARER}`) {
    return new Response("OK", { status: 200 });
  }

  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength === 0) {
    return new Response("OK", { status: 200 });
  }

  let body: string;
  const firstBytes = new Uint8Array(rawBytes.slice(0, 2));
  if (firstBytes[0] === 0x1f && firstBytes[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    body = await new Response(ds.readable).text();
  } else {
    body = new TextDecoder().decode(rawBytes);
  }

  if (!body || body.length === 0) {
    return new Response("OK", { status: 200 });
  }

  const contentType = request.headers.get("Content-Type") || "";
  console.log(JSON.stringify({
    tag: "gateway-ingest",
    contentType,
    bodyLength: body.length,
    bodySample: body.slice(0, 2000),
  }));

  const trackEnvelopes = translateToTrackEnvelopes(body, env);
  if (trackEnvelopes.length === 0) {
    return new Response("OK", { status: 200 });
  }

  const trackBody = trackEnvelopes.map((e) => JSON.stringify(e)).join("\n");

  const upstream = await fetch(
    `${env.OTLP_INGESTION_ENDPOINT}/v2.1/track`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: trackBody,
    },
  );

  const upstreamBody = await upstream.text();
  if (!upstream.ok) {
    console.log(JSON.stringify({
      tag: "gateway-upstream-error",
      status: upstream.status,
      body: upstreamBody.slice(0, 500),
    }));
  }

  return new Response(upstreamBody, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

interface TrackEnvelope {
  name: string;
  time: string;
  iKey: string;
  tags: Record<string, string>;
  data: { baseType: string; baseData: Record<string, unknown> };
}

function attrValue(v: Record<string, unknown>): unknown {
  return v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? JSON.stringify(v);
}

function attrMap(attrs: Array<{ key: string; value: Record<string, unknown> }>): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const a of attrs || []) {
    m[a.key] = attrValue(a.value);
  }
  return m;
}

function resourceRole(resource: { attributes?: Array<{ key: string; value: Record<string, unknown> }> }): string {
  const attrs = attrMap(resource.attributes || []);
  return (attrs["service.name"] || attrs["cloudflare.script_name"] || "unknown") as string;
}

function kvlistToMessage(kvlist: { values: Array<{ key: string; value: Record<string, unknown> }> }): { message: string; properties: Record<string, unknown> } {
  const props: Record<string, unknown> = {};
  let message = "";
  for (const kv of kvlist.values || []) {
    const val = attrValue(kv.value);
    props[kv.key] = val;
    if (kv.key === "message") message = val as string;
  }
  return { message: message || JSON.stringify(props), properties: props };
}

function parseStack(stack: string): Array<{ level: number; method: string; fileName: string; line: number }> {
  return stack.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line, i) => {
      const match = line.match(/^at\s+(.+?)\s+\((.+):(\d+):\d+\)$/)
        || line.match(/^at\s+()(.*):(\d+):\d+$/);
      if (!match) return { level: i, method: line.slice(3), fileName: "", line: 0 };
      return { level: i, method: match[1] || "<anonymous>", fileName: match[2], line: parseInt(match[3], 10) };
    });
}

function severityNumberToLevel(sn: number): number {
  if (sn >= 17) return 4;
  if (sn >= 13) return 3;
  if (sn >= 9) return 1;
  if (sn >= 5) return 2;
  return 0;
}


function translateToTrackEnvelopes(body: string, env: Env): TrackEnvelope[] {
  const iKey = env.APP_INSTRUMENTATION_KEY;
  const envelopes: TrackEnvelope[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return envelopes;
  }

  const resourceLogs = parsed.resourceLogs as Array<Record<string, unknown>> | undefined;
  if (resourceLogs) {
    for (const rl of resourceLogs) {
      const role = resourceRole(rl.resource as { attributes?: Array<{ key: string; value: Record<string, unknown> }> });
      const scopeLogs = rl.scopeLogs as Array<Record<string, unknown>> || [];
      for (const sl of scopeLogs) {
        const logRecords = sl.logRecords as Array<Record<string, unknown>> || [];
        for (const lr of logRecords) {
          const timeNano = lr.timeUnixNano as string || lr.observedTimeUnixNano as string || "0";
          const timeMs = Number(BigInt(timeNano) / 1000000n);
          const sevNum = (lr.severityNumber as number) || 9;
          const bodyField = lr.body as Record<string, unknown> | undefined;
          let message = "telemetry";
          let properties: Record<string, unknown> = {};

          if (bodyField?.kvlistValue) {
            const kv = kvlistToMessage(bodyField.kvlistValue as { values: Array<{ key: string; value: Record<string, unknown> }> });
            message = kv.message;
            properties = kv.properties;
          } else if (bodyField?.stringValue) {
            message = bodyField.stringValue as string;
          }

          const logAttrs = attrMap(lr.attributes as Array<{ key: string; value: Record<string, unknown> }> || []);

          const traceId = lr.traceId as string || "";
          const spanId = lr.spanId as string || "";

          const tags = {
            "ai.cloud.role": role,
            "ai.cloud.roleInstance": role,
            ...(traceId ? { "ai.operation.id": traceId } : {}),
            ...(spanId ? { "ai.operation.parentId": spanId } : {}),
          };

          envelopes.push({
            name: "Microsoft.ApplicationInsights.Message",
            time: new Date(timeMs).toISOString(),
            iKey,
            tags,
            data: {
              baseType: "MessageData",
              baseData: {
                ver: 2,
                message,
                severityLevel: severityNumberToLevel(sevNum),
                properties: { ...properties, ...logAttrs },
              },
            },
          });

          if (sevNum >= 17) {
            const allProps = { ...properties, ...logAttrs };
            const stack = allProps.stack as string | undefined;
            envelopes.push({
              name: "Microsoft.ApplicationInsights.Exception",
              time: new Date(timeMs).toISOString(),
              iKey,
              tags,
              data: {
                baseType: "ExceptionData",
                baseData: {
                  ver: 2,
                  exceptions: [{
                    typeName: (allProps.exceptionType as string) || "Error",
                    message,
                    hasFullStack: !!stack,
                    ...(stack ? { parsedStack: parseStack(stack) } : {}),
                  }],
                  properties: allProps,
                },
              },
            });
          }
        }
      }
    }
  }

  const resourceSpans = parsed.resourceSpans as Array<Record<string, unknown>> | undefined;
  if (resourceSpans) {
    for (const rs of resourceSpans) {
      const role = resourceRole(rs.resource as { attributes?: Array<{ key: string; value: Record<string, unknown> }> });
      const scopeSpans = rs.scopeSpans as Array<Record<string, unknown>> || [];
      for (const ss of scopeSpans) {
        const spans = ss.spans as Array<Record<string, unknown>> || [];
        for (const span of spans) {
          const startNano = span.startTimeUnixNano as string || "0";
          const endNano = span.endTimeUnixNano as string || startNano;
          const startMs = Number(BigInt(startNano) / 1000000n);
          const durationMs = Number((BigInt(endNano) - BigInt(startNano)) / 1000000n);
          const spanAttrs = attrMap(span.attributes as Array<{ key: string; value: Record<string, unknown> }> || []);
          const spanKind = span.kind as number || 0;
          const traceId = span.traceId as string || "";
          const spanId = span.spanId as string || "";
          const parentSpanId = span.parentSpanId as string || "";

          const isRoot = spanKind === 1 || spanKind === 2 && !parentSpanId
            || (spanAttrs["cloudflare.handler_type"] as string) !== undefined;

          if (isRoot) {
            const entrypoint = spanAttrs["cloudflare.entrypoint"] as string;
            const rpcMethod = spanAttrs["jsrpc.method"] as string;
            const rawHandler = (spanAttrs["cloudflare.handler_type"] as string) || span.name as string || "worker";
            const handlerType = entrypoint
              ? `${role} ${entrypoint}${rpcMethod ? `.${rpcMethod}` : ""}`
              : `${role} ${rawHandler}`;
            const outcome = spanAttrs["cloudflare.outcome"] as string || "ok";
            const isWorkflowRun = (spanAttrs["jsrpc.method"] as string) === "run";
            const success = outcome === "ok"
              || (isWorkflowRun && (outcome === "exception" || outcome === "canceled"));

            envelopes.push({
              name: "Microsoft.ApplicationInsights.Request",
              time: new Date(startMs).toISOString(),
              iKey,
              tags: {
                "ai.cloud.role": role,
                "ai.cloud.roleInstance": role,
                "ai.operation.id": traceId,
                ...(parentSpanId && parentSpanId !== traceId ? { "ai.operation.parentId": parentSpanId } : {}),
                "ai.operation.name": handlerType,
              },
              data: {
                baseType: "RequestData",
                baseData: {
                  ver: 2,
                  id: spanId,
                  name: handlerType,
                  duration: formatDuration(durationMs),
                  success,
                  responseCode: success ? "200" : "500",
                  properties: spanAttrs,
                },
              },
            });
            continue;
          }

          const depType = (spanAttrs["db.system.name"] as string)
            || (spanAttrs["rpc.system"] as string)
            || (spanAttrs["messaging.system"] as string)
            || (spanKind === 3 ? "HTTP" : "InProc");
          const target = (spanAttrs["server.address"] as string)
            || (spanAttrs["db.system.name"] as string)
            || (span.name as string)
            || "";
          const spanName = enrichSpanName(span.name as string || "span", spanAttrs);

          envelopes.push({
            name: "Microsoft.ApplicationInsights.RemoteDependency",
            time: new Date(startMs).toISOString(),
            iKey,
            tags: {
              "ai.cloud.role": role,
              "ai.cloud.roleInstance": role,
              "ai.operation.id": traceId,
              "ai.operation.parentId": parentSpanId,
            },
            data: {
              baseType: "RemoteDependencyData",
              baseData: {
                ver: 2,
                name: spanName,
                duration: formatDuration(durationMs),
                success: (span.status as Record<string, unknown>)?.code !== 2,
                type: depType,
                target,
                id: spanId,
                properties: spanAttrs,
              },
            },
          });
        }
      }
    }
  }

  return envelopes;
}

function enrichSpanName(baseName: string, attrs: Record<string, unknown>): string {
  const kvKeys = attrs["cloudflare.kv.query.keys"] as string;
  if (kvKeys) return `${baseName} ${kvKeys}`;

  const kvPrefix = attrs["cloudflare.kv.query.prefix"] as string;
  if (kvPrefix) return `${baseName} ${kvPrefix}*`;

  const urlFull = attrs["url.full"] as string;
  if (urlFull) {
    const method = (attrs["http.request.method"] as string) || "HTTP";
    try {
      const u = new URL(urlFull);
      return `${method} ${u.host}${u.pathname}`;
    } catch {
      return `${method} ${urlFull.slice(0, 80)}`;
    }
  }

  const rpcMethod = attrs["jsrpc.method"] as string;
  if (rpcMethod) return `jsrpc.${rpcMethod}`;

  return baseName;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${days}.${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}0000`;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      return oidcDiscovery(env);
    }

    if (request.method === "GET" && path === "/.well-known/jwks.json") {
      return jwksEndpoint();
    }

    if (request.method === "POST" && (path === "/v1/logs" || path === "/v1/traces")) {
      return forwardOtlp(request, env);
    }

    return new Response("OK", { status: 200 });
  },
};
