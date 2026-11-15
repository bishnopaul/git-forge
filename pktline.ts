// pktline.ts: the git smart-protocol framing. A pkt-line is a 4-hex-digit length (counting the
// length digits themselves) plus payload; 0000 is flush, 0001 is the v2 delimiter, 0002 the
// response-end marker. Readers here are tolerant: a malformed stream raises, and the HTTP layer
// turns that into a refusal rather than a crash.

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse pkt-lines from the front of `buf`; returns the packets and the unconsumed remainder. */
export function readPkts(buf: Buffer, offset = 0): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let cursor = offset;
  while (cursor + 4 <= buf.length) {
    const header = buf.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`malformed pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      cursor += 4;
      return { packets, rest: buf.subarray(cursor) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > buf.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buf.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  if (cursor !== buf.length) throw new Error('trailing bytes after the last pkt-line');
  return { packets, rest: buf.subarray(cursor) };
}

/** The payloads of the data packets, as utf8 text with the trailing newline stripped. */
export function pktTexts(packets: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

/** Frame bytes as sideband packets: band byte + at most 65515 data bytes per packet. */
export function sidebandPackets(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) return Buffer.alloc(0);
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}
