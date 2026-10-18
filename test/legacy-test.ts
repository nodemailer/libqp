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

// 2.1.3 kept a hyphen after a lone CR literal, a relay that turns the CR into CRLF would start a
// line with it. In 2.1.3 output "\r" is followed by "-" only there, CRLF pairs are followed by "\n"
const escapeHyphenAfterCr = (encoded: string): string => encoded.replace(/\r-/g, '\r=2D');

// Checks a wrapped output against 2.1.3, a line at a time. 2.1.3 wrapped the input as one line,
// counting line breaks as chars, so a line next to a line break was broken earlier than needed. It
// also broke the rest of a line at a space when the rest fitted, so its output for a line can hold
// one more soft break, in front of the last piece. Lines for which `skip` holds are not compared
const assertWrapsLike2_1_3 = (actual: string, encoded: string, lineLength: number, skip?: (expected: string) => boolean): void => {
    const parts = encoded.split(/(\r?\n)/);
    for (let i = 0; i < parts.length; i += 2) {
        const part = parts[i] as string;
        const wrapped = wrap(part, lineLength);
        const expected = legacy.wrap(part, lineLength);
        if (wrapped !== expected && !skip?.(expected)) {
            // the soft break 2.1.3 added, and the hyphen escape behind it
            const merged = expected.replace(/[=]\r\n(=2D)?((?:(?![=]\r\n)[^])*)$/, (_, hyphen: string | undefined, rest: string) => (hyphen ? '-' : '') + rest);
            assert.strictEqual(wrapped, merged, JSON.stringify(part));
        }
        parts[i] = wrapped;
    }
    assert.strictEqual(actual, parts.join(''));
};

describe('Compatibility with libqp 2.1.3', () => {
    it('encode() produces the same output', () => {
        fc.assert(
            fc.property(fc.oneof(bytes(), text()), input => {
                assert.strictEqual(encode(input), escapeHyphenAfterCr(legacy.encode(input)));
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

    it('wrap() produces the same output for ASCII input, but for needless soft breaks', () => {
        // 2.1.3 looped forever below a line length of 5 and kept a hyphen escape and the
        // following escape on a line the escape left too little room for below 7
        fc.assert(
            fc.property(bytes(), fc.integer({ min: 7, max: 100 }), (input, lineLength) => {
                const ascii = Buffer.from(input.map(byte => byte % 128));
                const encoded = encode(ascii);
                assertWrapsLike2_1_3(wrap(encoded, lineLength), encoded, lineLength);
            }),
            options
        );
    });

    it('wrap() produces the same output for text unless 2.1.3 split a char, but for needless soft breaks', () => {
        // 2.1.3 stopped looking for the start of a char after four escapes, so a line could end
        // inside a char when the line held more than one
        fc.assert(
            fc.property(text(), fc.integer({ min: 16, max: 100 }), (input, lineLength) => {
                const encoded = encode(input);
                assertWrapsLike2_1_3(wrap(encoded, lineLength), encoded, lineLength, splitsUtf8);
            }),
            options
        );
    });

    it('the Encoder produces the same output for input written at once', async () => {
        await fc.assert(
            fc.asyncProperty(bytes(), fc.integer({ min: 7, max: 100 }), async (input, lineLength) => {
                const ascii = Buffer.from(input.map(byte => byte % 128));
                const unwrapped = escapeHyphenAfterCr(legacy.encode(ascii));
                assert.strictEqual((await pipeChunks(new Encoder({ lineLength: false }), [ascii])).toString(), unwrapped);
                assertWrapsLike2_1_3((await pipeChunks(new Encoder({ lineLength }), [ascii])).toString(), unwrapped, lineLength);
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
