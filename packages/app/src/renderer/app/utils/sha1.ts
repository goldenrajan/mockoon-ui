/**
 * Minimal SHA-1 implementation for environments where Web Crypto is unavailable.
 * Returns the lowercase hex digest of the provided message.
 *
 * Based on the SHA-1 algorithm described in FIPS PUB 180-4.
 */
export function sha1(message: string): string {
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);
  const messageLength = messageBytes.length;

  const wordsCount = (((messageLength + 8) >> 6) << 4) + 16;
  const words = new Uint32Array(wordsCount);

  for (let index = 0; index < messageLength; index += 1) {
    words[index >> 2] |= messageBytes[index] << (24 - ((index & 3) << 3));
  }

  words[messageLength >> 2] |= 0x80 << (24 - ((messageLength & 3) << 3));

  const bitLength = messageLength * 8;
  words[wordsCount - 1] = bitLength >>> 0;
  words[wordsCount - 2] = Math.floor(bitLength / 0x100000000) >>> 0;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let blockStart = 0; blockStart < wordsCount; blockStart += 16) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = words[blockStart + i] >>> 0;
    }

    for (let i = 16; i < 80; i += 1) {
      const value = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((value << 1) | (value >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;

      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp =
        (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;

      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');
}
