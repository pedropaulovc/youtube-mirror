import { expect } from "vitest";

// A minimal, self-contained protobuf reader — no external dependency — so OTLP
// protobuf output can be validated by decoding it back and asserting the OTLP
// structure round-trips (field numbers, wire types, bytes/enum/timestamp coding).

export interface Field {
  field: number;
  wire: number;
  value: bigint | Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

export function decode(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, next] = readVarint(buf, pos);
    pos = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 0x7n);
    if (wire === 0) {
      const [v, p] = readVarint(buf, pos);
      pos = p;
      fields.push({ field, wire, value: v });
    } else if (wire === 1) {
      fields.push({ field, wire, value: buf.slice(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      const [len, p] = readVarint(buf, pos);
      pos = p;
      const n = Number(len);
      fields.push({ field, wire, value: buf.slice(pos, pos + n) });
      pos += n;
    } else if (wire === 5) {
      fields.push({ field, wire, value: buf.slice(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

export const bytes = (f: Field): Uint8Array => f.value as Uint8Array;
export const str = (f: Field): string => new TextDecoder().decode(f.value as Uint8Array);
export const num = (f: Field): bigint => f.value as bigint;
export const fixed64le = (f: Field): bigint => {
  const b = f.value as Uint8Array;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
};
export const hex = (f: Field): string =>
  Array.from(f.value as Uint8Array).map((b) => b.toString(16).padStart(2, "0")).join("");

export const only = (fields: Field[], field: number): Field => {
  const match = fields.filter((f) => f.field === field);
  expect(match.length).toBe(1);
  return match[0];
};
