/** Protobuf and archive-stream encoders for building test input. */

export const varint = (v: number | bigint): number[] => {
  let x = BigInt(v);
  const out: number[] = [];
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) b |= 0x80;
    out.push(b);
  } while (x > 0n);
  return out;
};
export const varintField = (field: number, v: number | bigint): number[] => [...varint(field * 8), ...varint(v)];
export const lenField = (field: number, body: ReadonlyArray<number>): number[] => [
  ...varint(field * 8 + 2), ...varint(body.length), ...body,
];
export const fixedField = (field: number, wire: 1 | 5, raw: ArrayBuffer): number[] => [
  ...varint(field * 8 + wire), ...new Uint8Array(raw),
];
export const f64 = (n: number): ArrayBuffer => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, n, true);
  return v.buffer;
};
export const f32 = (n: number): ArrayBuffer => {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, n, true);
  return v.buffer;
};
export const i64 = (n: bigint): ArrayBuffer => {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigInt64(0, n, true);
  return v.buffer;
};

/** One archived-object record: length-prefixed ArchiveInfo, then the payloads. */
export const record = (
  identifier: number | bigint | undefined,
  messages: ReadonlyArray<{ readonly type: number; readonly payload: ReadonlyArray<number> }>
): number[] => {
  const info = [
    ...(identifier === undefined ? [] : varintField(1, identifier)),
    ...messages.flatMap((m) => lenField(2, [...varintField(1, m.type), ...varintField(3, m.payload.length)])),
  ];
  return [...varint(info.length), ...info, ...messages.flatMap((m) => m.payload)];
};
