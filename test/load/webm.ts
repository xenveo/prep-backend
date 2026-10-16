// A small but real WebM/Opus file (mono, 48 kHz, silent 20 ms frames), built in memory so the
// load test needs no fixture or encoder. Same container and codec as Chrome's MediaRecorder.

const OPUS_SILENT_FRAME = [0xf8, 0xff, 0xfe];
const FRAME_MS = 20;

/** EBML element: id bytes, shortest size vint, payload. */
function el(id: number[], ...children: Buffer[]): Buffer {
  const data = Buffer.concat(children);
  return Buffer.concat([Buffer.from(id), vint(data.length), data]);
}

function vint(n: number): Buffer {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const b = Buffer.alloc(len);
  b.writeUIntBE(n, 0, len);
  b[0] |= 0x80 >> (len - 1);
  return b;
}

function uint(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function float(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
}

const ascii = (s: string) => Buffer.from(s, 'ascii');

function opusHead(): Buffer {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1; // version
  b[9] = 1; // channels
  b.writeUInt16LE(312, 10); // pre-skip
  b.writeUInt32LE(48_000, 12); // input sample rate
  return b;
}

export function silentWebm(durationMs = 2000): Buffer {
  const header = el(
    [0x1a, 0x45, 0xdf, 0xa3],
    el([0x42, 0x86], uint(1)), // EBMLVersion
    el([0x42, 0xf7], uint(1)), // EBMLReadVersion
    el([0x42, 0xf2], uint(4)), // EBMLMaxIDLength
    el([0x42, 0xf3], uint(8)), // EBMLMaxSizeLength
    el([0x42, 0x82], ascii('webm')), // DocType
    el([0x42, 0x87], uint(4)), // DocTypeVersion
    el([0x42, 0x85], uint(2)), // DocTypeReadVersion
  );
  const info = el(
    [0x15, 0x49, 0xa9, 0x66],
    el([0x2a, 0xd7, 0xb1], uint(1_000_000)), // TimecodeScale: 1 ms
    el([0x4d, 0x80], ascii('preppilot-load')), // MuxingApp
    el([0x57, 0x41], ascii('preppilot-load')), // WritingApp
    el([0x44, 0x89], float(durationMs)), // Duration
  );
  const tracks = el(
    [0x16, 0x54, 0xae, 0x6b],
    el(
      [0xae], // TrackEntry
      el([0xd7], uint(1)), // TrackNumber
      el([0x73, 0xc5], uint(1)), // TrackUID
      el([0x83], uint(2)), // TrackType: audio
      el([0x86], ascii('A_OPUS')), // CodecID
      el([0x63, 0xa2], opusHead()), // CodecPrivate
      el(
        [0xe1], // Audio
        el([0xb5], float(48_000)), // SamplingFrequency
        el([0x9f], uint(1)), // Channels
      ),
    ),
  );
  const blocks: Buffer[] = [];
  for (let t = 0; t < durationMs; t += FRAME_MS) {
    // SimpleBlock: track 1, relative timecode, keyframe flag, Opus packet.
    blocks.push(
      el(
        [0xa3],
        Buffer.from([0x81, t >> 8, t & 0xff, 0x80, ...OPUS_SILENT_FRAME]),
      ),
    );
  }
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], uint(0)), ...blocks);
  return Buffer.concat([
    header,
    el([0x18, 0x53, 0x80, 0x67], info, tracks, cluster),
  ]);
}
