/* eslint no-await-in-loop:0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { encode, decode, wrap, Encoder, Decoder } from '../src/libqp.js';
import { bytes, text, qpInput, chunkSizes, split, pipeChunks, linesOf, isUtf8, fuzzOptions } from './fixtures/fuzz.js';

// Property-based tests: instead of fixed examples, every property is checked against generated
// input, see test/fixtures/fuzz.ts for the generators and the FUZZ_ITERATIONS and FUZZ_SEED knobs

const options = fuzzOptions();

const lineLengths = fc.integer({ min: -2, max: 100 });

// the line length wrap() actually uses for a requested one
const effectiveLength = (lineLength: number): number => Math.max(lineLength || 76, 4);

// Checks the structure every encoded output must have: only the chars the format allows, escapes
// with uppercase hex digits, no whitespace in front of a line break or at the end, and no line
// that starts with a hyphen. With wrapped output a soft line break "=" may end a line
const assertWellFormed = (output: string, label: string): void => {
    assert.ok(!/[^\t\r\n\x20-\x7e]/.test(output), label + ': char outside the allowed range');
    assert.ok(!/[=](?![0-9A-F]{2}|\r\n)/.test(output), label + ': "=" is not an escape or a soft line break');
    assert.ok(!/[ \t](?:\r|\n|$)/.test(output), label + ': whitespace at the end of a line');
    assert.ok(!/(?:^|\n)-/.test(output), label + ': line starts with a hyphen');
};

// A decoder written from the description of the format, independent of the one in src/: strip the
// whitespace at the end of every line, drop the soft line breaks, then read the =XX escapes left
// to right. It works on the bytes, where the implementation works on a binary string with regexes
const modelDecode = (input: Buffer): Buffer => {
    const isWs = (c: number | undefined) => c === 0x20 || c === 0x09;
    const isBreak = (c: number | undefined) => c === undefined || c === 0x0a || c === 0x0d;
    const stripped: number[] = [];
    for (let i = 0; i < input.length; i++) {
        if (isWs(input[i])) {
            let end = i;
            while (isWs(input[end])) {
                end++;
            }
            if (!isBreak(input[end])) {
                stripped.push(...input.subarray(i, end));
            }
            i = end - 1;
            continue;
        }
        stripped.push(input[i] as number);
    }
    const joined: number[] = [];
    for (let i = 0; i < stripped.length; i++) {
        if (stripped[i] === 0x3d) {
            if (i === stripped.length - 1) {
                continue;
            }
            if (stripped[i + 1] === 0x0a) {
                i++;
                continue;
            }
            if (stripped[i + 1] === 0x0d && stripped[i + 2] === 0x0a) {
                i += 2;
                continue;
            }
        }
        joined.push(stripped[i] as number);
    }
    const isHex = (c: number | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(String.fromCharCode(c));
    const output: number[] = [];
    for (let i = 0; i < joined.length; i++) {
        if (joined[i] === 0x3d && isHex(joined[i + 1]) && isHex(joined[i + 2])) {
            output.push(parseInt(String.fromCharCode(joined[i + 1] as number, joined[i + 2] as number), 16));
            i += 2;
            continue;
        }
        output.push(joined[i] as number);
    }
    return Buffer.from(output);
};

describe('Properties of encode()', () => {
    it('round trips any bytes through decode()', () => {
        fc.assert(
            fc.property(bytes(), input => {
                assert.deepStrictEqual(decode(encode(input)), input);
            }),
            options
        );
    });

    it('round trips any text through decode()', () => {
        fc.assert(
            fc.property(text(), input => {
                assert.strictEqual(decode(encode(input)).toString(), Buffer.from(input).toString());
            }),
            options
        );
    });

    it('produces well-formed output', () => {
        fc.assert(
            fc.property(bytes(), input => {
                assertWellFormed(encode(input), 'encode');
            }),
            options
        );
    });

    it('keeps a printable ASCII char literal unless it is "=", a hyphen at a line start or trailing whitespace', () => {
        fc.assert(
            fc.property(fc.string({ unit: fc.constantFrom('a', 'Z', '0', '.', '~', '-', ' ', '\t', '=') }), input => {
                const expected = input.replace(/[=]/g, '=3D').replace(/^-/, '=2D').replace(/ $/, '=20').replace(/\t$/, '=09');
                assert.strictEqual(encode(input), expected);
            }),
            options
        );
    });

    it('treats a string as its UTF-8 bytes', () => {
        fc.assert(
            fc.property(text(), input => {
                assert.strictEqual(encode(input), encode(Buffer.from(input, 'utf-8')));
            }),
            options
        );
    });
});

describe('Properties of decode()', () => {
    it('matches an independent model of the format', () => {
        fc.assert(
            fc.property(qpInput(), input => {
                assert.deepStrictEqual(decode(input), modelDecode(input));
            }),
            options
        );
    });

    it('matches the model for arbitrary bytes', () => {
        fc.assert(
            fc.property(bytes(), input => {
                assert.deepStrictEqual(decode(input), modelDecode(input));
            }),
            options
        );
    });

    it('reads a Buffer, a Uint8Array and a binary string the same way', () => {
        fc.assert(
            fc.property(qpInput(), input => {
                const expected = decode(input);
                assert.deepStrictEqual(decode(new Uint8Array(input)), expected);
                assert.deepStrictEqual(decode(input.toString('binary')), expected);
            }),
            options
        );
    });

    it('never throws and never produces more bytes than it was given', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 200 }), input => {
                const decoded = decode(input);
                assert.ok(Buffer.isBuffer(decoded));
                assert.ok(decoded.length <= input.length);
            }),
            options
        );
    });
});

describe('Properties of wrap()', () => {
    it('round trips any bytes through encode(), wrap() and decode()', () => {
        fc.assert(
            fc.property(bytes(), lineLengths, (input, lineLength) => {
                assert.deepStrictEqual(decode(wrap(encode(input), lineLength)), input);
            }),
            options
        );
    });

    it('keeps every line within the line length', () => {
        fc.assert(
            fc.property(bytes(), lineLengths, (input, lineLength) => {
                const max = effectiveLength(lineLength);
                for (const line of linesOf(wrap(encode(input), lineLength))) {
                    assert.ok(line.length <= max, `line ${JSON.stringify(line)} is longer than ${max}`);
                }
            }),
            options
        );
    });

    it('produces well-formed output', () => {
        fc.assert(
            fc.property(bytes(), lineLengths, (input, lineLength) => {
                assertWellFormed(wrap(encode(input), lineLength), 'wrap');
            }),
            options
        );
    });

    it('only adds soft line breaks', () => {
        fc.assert(
            fc.property(bytes(), lineLengths, (input, lineLength) => {
                const encoded = encode(input);
                const wrapped = wrap(encoded, lineLength);
                // wrap() escapes the hyphen behind a soft break, so hyphens are compared unescaped
                const unescapeHyphens = (value: string) => value.replace(/[=]2D/g, '-');
                assert.strictEqual(unescapeHyphens(wrapped.replace(/[=]\r\n/g, '')), unescapeHyphens(encoded));
            }),
            options
        );
    });

    it('returns input that fits on a line as is', () => {
        fc.assert(
            fc.property(bytes(30), fc.integer({ min: 4, max: 100 }), (input, lineLength) => {
                const encoded = encode(input);
                fc.pre(encoded.length <= lineLength);
                assert.strictEqual(wrap(encoded, lineLength), encoded);
            }),
            options
        );
    });

    it('never splits an escape sequence', () => {
        fc.assert(
            fc.property(bytes(), lineLengths, (input, lineLength) => {
                for (const line of wrap(encode(input), lineLength).split('=\r\n')) {
                    assert.ok(!/[=][0-9A-F]?$/.test(line), `line ${JSON.stringify(line)} ends inside an escape`);
                }
            }),
            options
        );
    });

    it('never splits a UTF-8 char when a line fits the longest escaped char after an escaped hyphen', () => {
        fc.assert(
            fc.property(text(), fc.integer({ min: 16, max: 100 }), (input, lineLength) => {
                for (const line of wrap(encode(input), lineLength).split('=\r\n')) {
                    assert.ok(isUtf8(decode(line)), `line ${JSON.stringify(line)} splits a char`);
                }
            }),
            options
        );
    });
});

describe('Properties of the Encoder', () => {
    it('without wrapping, produces the same output as encode() however the input is split', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), chunkSizes(), async (input, sizes) => {
                const output = await pipeChunks(new Encoder({ lineLength: false }), split(input, sizes));
                assert.strictEqual(output.toString(), encode(input));
            }),
            options
        );
    });

    it('with wrapping, round trips any bytes into well-formed lines', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), chunkSizes(), lineLengths, async (input, sizes, lineLength) => {
                const output = (await pipeChunks(new Encoder({ lineLength }), split(input, sizes))).toString();
                assert.deepStrictEqual(decode(output), input);
                assertWellFormed(output, 'Encoder');
                const max = effectiveLength(lineLength);
                for (const line of linesOf(output)) {
                    assert.ok(line.length <= max, `line ${JSON.stringify(line)} is longer than ${max}`);
                }
            }),
            options
        );
    });

    it('with binary, keeps only CRLF pairs literal and does not depend on the chunking', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), chunkSizes(), async (input, sizes) => {
                const output = (await pipeChunks(new Encoder({ lineLength: false, binary: true }), split(input, sizes))).toString();
                assert.strictEqual(output, (await pipeChunks(new Encoder({ lineLength: false, binary: true }), [input])).toString());
                assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(output), 'lone CR or LF in the output');
                assert.deepStrictEqual(decode(output), input);
                assertWellFormed(output, 'binary Encoder');
            }),
            options
        );
    });

    it('counts the bytes it reads and writes', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), chunkSizes(), fc.option(lineLengths, { nil: undefined }), async (input, sizes, lineLength) => {
                const encoder = new Encoder({ lineLength });
                const output = await pipeChunks(encoder, split(input, sizes));
                assert.strictEqual(encoder.inputBytes, input.length);
                assert.strictEqual(encoder.outputBytes, output.length);
            }),
            options
        );
    });
});

describe('Properties of the Decoder', () => {
    it('produces the same output as decode() however the input is split', async () => {
        await fc.assert(
            fc.asyncProperty(qpInput(), chunkSizes(), async (input, sizes) => {
                const decoder = new Decoder();
                const output = await pipeChunks(decoder, split(input, sizes));
                assert.deepStrictEqual(output, decode(input));
                assert.strictEqual(decoder.inputBytes, input.length);
                assert.strictEqual(decoder.outputBytes, output.length);
            }),
            options
        );
    });

    it('round trips the Encoder output', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), chunkSizes(), chunkSizes(), fc.boolean(), async (input, encodeSizes, decodeSizes, binary) => {
                const encoded = await pipeChunks(new Encoder({ binary }), split(input, encodeSizes));
                assert.deepStrictEqual(await pipeChunks(new Decoder(), split(encoded, decodeSizes)), input);
            }),
            options
        );
    });
});
