import { encodeFrame, createFrameDecoder, BridgeRequest, BridgeResponse } from '../src/mcp/protocol';

describe('mcp loopback protocol framing', () => {
  it('encodes a message as one newline-terminated JSON line', () => {
    const req: BridgeRequest = { id: 1, token: 't', method: 'list' };
    const frame = encodeFrame(req);
    expect(frame.endsWith('\n')).toBe(true);
    expect(JSON.parse(frame.trimEnd())).toEqual(req);
  });

  it('decodes multiple messages arriving in one chunk', () => {
    const decode = createFrameDecoder<BridgeResponse>();
    const chunk =
      encodeFrame({ id: 1, ok: true, result: 'a' }) +
      encodeFrame({ id: 2, ok: false, error: 'boom' });
    const msgs = decode(chunk);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ id: 1, ok: true, result: 'a' });
    expect(msgs[1]).toEqual({ id: 2, ok: false, error: 'boom' });
  });

  it('reassembles a message split across chunks', () => {
    const decode = createFrameDecoder<BridgeResponse>();
    const full = encodeFrame({ id: 7, ok: true, result: 42 });
    const half = Math.floor(full.length / 2);
    expect(decode(full.slice(0, half))).toHaveLength(0);
    const msgs = decode(full.slice(half));
    expect(msgs).toEqual([{ id: 7, ok: true, result: 42 }]);
  });
});
