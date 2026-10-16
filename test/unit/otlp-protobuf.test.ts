import { describe, it, expect } from "vitest";
import { encodeLogsRequest, encodeTraceRequest } from "../../worker/otlp-protobuf";
import { bytes, decode, fixed64le, hex, num, only, str } from "../helpers/protobuf";

describe("encodeLogsRequest", () => {
  it("round-trips a log record's attributes, body, severity, timestamp and ids", () => {
    const json = {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "yt-mirror" } }],
          },
          scopeLogs: [
            {
              scope: { name: "cf" },
              logRecords: [
                {
                  timeUnixNano: "1782964800855000000",
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "hello world" },
                  attributes: [{ key: "http.status", value: { intValue: "200" } }],
                  traceId: "0102030405060708090a0b0c0d0e0f10",
                  spanId: "1112131415161718",
                },
              ],
            },
          ],
        },
      ],
    };

    const req = decode(encodeLogsRequest(json));
    const resourceLogs = decode(bytes(only(req, 1)));

    const resource = decode(bytes(only(resourceLogs, 1)));
    const resAttr = decode(bytes(only(resource, 1)));
    expect(str(only(resAttr, 1))).toBe("service.name");
    const resVal = decode(bytes(only(resAttr, 2)));
    expect(str(only(resVal, 1))).toBe("yt-mirror");

    const scopeLogs = decode(bytes(only(resourceLogs, 2)));
    expect(str(only(decode(bytes(only(scopeLogs, 1))), 1))).toBe("cf"); // scope.name

    const lr = decode(bytes(only(scopeLogs, 2)));
    expect(fixed64le(only(lr, 1))).toBe(1782964800855000000n); // timeUnixNano (fixed64)
    expect(num(only(lr, 2))).toBe(9n); // severityNumber (varint)
    expect(str(only(lr, 3))).toBe("INFO");
    expect(str(only(decode(bytes(only(lr, 5))), 1))).toBe("hello world"); // body.stringValue

    const attr = decode(bytes(only(lr, 6)));
    expect(str(only(attr, 1))).toBe("http.status");
    expect(num(only(decode(bytes(only(attr, 2))), 3))).toBe(200n); // intValue (varint, field 3)

    expect(hex(only(lr, 9))).toBe("0102030405060708090a0b0c0d0e0f10"); // traceId bytes
    expect(hex(only(lr, 10))).toBe("1112131415161718"); // spanId bytes
  });

  it("returns empty bytes for an empty request", () => {
    expect(encodeLogsRequest({}).length).toBe(0);
    expect(encodeLogsRequest({ resourceLogs: [] }).length).toBe(0);
  });
});

describe("encodeTraceRequest", () => {
  it("round-trips a span's ids, name, kind, timestamps and status", () => {
    const json = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "yt-mirror" } }] },
          scopeSpans: [
            {
              scope: { name: "cf" },
              spans: [
                {
                  traceId: "0102030405060708090a0b0c0d0e0f10",
                  spanId: "1112131415161718",
                  parentSpanId: "2122232425262728",
                  name: "fetch",
                  kind: 2,
                  startTimeUnixNano: "1782964800000000000",
                  endTimeUnixNano: "1782964800500000000",
                  status: { code: 2, message: "boom" },
                },
              ],
            },
          ],
        },
      ],
    };

    const req = decode(encodeTraceRequest(json));
    const resourceSpans = decode(bytes(only(req, 1)));
    const scopeSpans = decode(bytes(only(resourceSpans, 2)));
    const span = decode(bytes(only(scopeSpans, 2)));

    expect(hex(only(span, 1))).toBe("0102030405060708090a0b0c0d0e0f10"); // traceId
    expect(hex(only(span, 2))).toBe("1112131415161718"); // spanId
    expect(hex(only(span, 4))).toBe("2122232425262728"); // parentSpanId
    expect(str(only(span, 5))).toBe("fetch"); // name
    expect(num(only(span, 6))).toBe(2n); // kind (SERVER)
    expect(fixed64le(only(span, 7))).toBe(1782964800000000000n); // startTimeUnixNano
    expect(fixed64le(only(span, 8))).toBe(1782964800500000000n); // endTimeUnixNano

    const status = decode(bytes(only(span, 15)));
    expect(str(only(status, 2))).toBe("boom"); // status.message
    expect(num(only(status, 3))).toBe(2n); // status.code (ERROR)
  });

  it("accepts enum names as well as integers", () => {
    const json = {
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ name: "s", kind: "SPAN_KIND_CLIENT", status: { code: "STATUS_CODE_OK" } }] },
          ],
        },
      ],
    };
    const span = decode(bytes(only(decode(bytes(only(decode(bytes(only(decode(encodeTraceRequest(json)), 1))), 2))), 2)));
    expect(num(only(span, 6))).toBe(3n); // SPAN_KIND_CLIENT
    expect(num(only(decode(bytes(only(span, 15))), 3))).toBe(1n); // STATUS_CODE_OK
  });
});
