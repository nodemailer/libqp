/* eslint no-await-in-loop:0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import legacy from 'libqp-legacy';

import { encode, decode, wrap, Encoder, Decoder } from '../src/libqp.js';
import { bytes, text, qpInput, chunkSizes, split, pipeChunks, isUtf8, fuzzOptions } from './fixtures/fuzz.js';

// Differential tests against libqp 2.1.3, the last release written in JavaScript (installed as
// the libqp-legacy alias). Applications upgrade from it, so wherever the output differs the
// difference has to be one of the intended fixes, listed with the test that allows it.

const options = fuzzOptions();

// true if a line of a wrapped output ends inside a UTF-8 char that continues on the next line
const splitsUtf8 = (wrapped: string): boolean =>
    wrapped
        .split('=\r\n')
        .slice(0, -1)
        .some(line => !isUtf8(decode(line)));

describe('Compatibility with libqp 2.1.3', () => {
    it('encode() produces the same output', () => {
        fc.assert(
            fc.property(fc.oneof(bytes(), text()), input => {
                assert.strictEqual(encode(input), legacy.encode(input));
            }),
            options
        );
    });

    it('decode() produces the same output for Buffers and strings', () => {
        fc.assert(
            fc.property(fc.oneof(qpInput(), bytes()), input => {
                assert.deepStrictEqual(decode(input), legacy.decode(input));
                assert.deepStrictEqual(decode(input.toString('binary')), legacy.decode(input.toString('binary')));
            }),
            options
        );
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 100 }), input => {
                // chars above 255 are cut to their low byte, as before
                assert.deepStrictEqual(decode(input), legacy.decode(input));
            }),
            options
        );
    });

    it('wrap() produces the same output for ASCII input', () => {
        // 2.1.3 looped forever below a line length of 5 and kept a hyphen escape and the
        // following escape on a line the escape left too little room for below 7
        fc.assert(
            fc.property(bytes(), fc.integer({ min: 7, max: 100 }), (input, lineLength) => {
                const ascii = Buffer.from(input.map(byte => byte % 128));
                const encoded = encode(ascii);
                assert.strictEqual(wrap(encoded, lineLength), legacy.wrap(encoded, lineLength));
            }),
            options
        );
    });

    it('wrap() produces the same output for text unless 2.1.3 split a char', () => {
        // 2.1.3 stopped looking for the start of a char after four escapes, so a line could end
        // inside a char when the line held more than one
        fc.assert(
            fc.property(text(), fc.integer({ min: 16, max: 100 }), (input, lineLength) => {
                const encoded = encode(input);
                const expected = legacy.wrap(encoded, lineLength);
                if (!splitsUtf8(expected)) {
                    assert.strictEqual(wrap(encoded, lineLength), expected);
                }
            }),
            options
        );
    });

    it('the Encoder produces the same output for input written at once', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), fc.integer({ min: 7, max: 100 }), async (input, lineLength) => {
                const ascii = Buffer.from(input.map(byte => byte % 128));
                // the Encoder holds back trailing whitespace and wraps it on its own, and wrap() counts
                // a line break at the start of its input towards the first line, so a wrapped last line
                // can break at another place than 2.1.3, which wrapped the whole chunk at once
                const last = ascii[ascii.length - 1];
                const endsInWhitespace = last === 0x20 || last === 0x09;
                for (const options of [{ lineLength: false as const }, { lineLength }]) {
                    const output = await pipeChunks(new Encoder(options), [ascii]);
                    const expected = await pipeChunks(new legacy.Encoder(options), [ascii]);
                    if (endsInWhitespace && options.lineLength) {
                        assert.deepStrictEqual(decode(output), decode(expected));
                        for (const line of output.toString().split(/\r?\n/)) {
                            assert.ok(line.length <= lineLength, JSON.stringify(line));
                        }
                    } else {
                        assert.deepStrictEqual(output, expected);
                    }
                }
            }),
            options
        );
    });

    it('the Encoder output decodes to the same bytes however the input is split', async () => {
        // 2.1.3 escaped whitespace at the end of every chunk, so its output depended on the chunking
        await fc.assert(
            fc.asyncProperty(bytes(), chunkSizes(), async (input, sizes) => {
                const output = await pipeChunks(new Encoder(), split(input, sizes));
                const expected = await pipeChunks(new legacy.Encoder(), split(input, sizes));
                assert.deepStrictEqual(decode(output), decode(expected));
            }),
            options
        );
    });

    it('the Decoder produces the same output', async () => {
        await fc.assert(
            fc.asyncProperty(qpInput(), chunkSizes(), async (input, sizes) => {
                const output = await pipeChunks(new Decoder(), split(input, sizes));
                assert.deepStrictEqual(output, await pipeChunks(new legacy.Decoder(), split(input, sizes)));
            }),
            options
        );
    });
});
