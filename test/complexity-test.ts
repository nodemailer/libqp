/* eslint no-await-in-loop:0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode, wrap, Encoder, Decoder } from '../src/libqp.js';
import { pipeChunks, split } from './fixtures/fuzz.js';

// libqp handles untrusted input, so every function has to run in time linear in the size of its
// input. Each test times an adversarial input at two sizes, eight times apart: linear work takes
// about eight times as long for the larger one, quadratic work 64 times. The best of a few runs is
// compared, so that a garbage collection or a busy CI machine does not fail the test.

const SCALE = 8;
// well above the linear 8, well below the quadratic 64
const MAX_RATIO = 24;

const bestOf = async (run: () => unknown | Promise<unknown>): Promise<number> => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
        const start = process.hrtime.bigint();
        await run();
        best = Math.min(best, Number(process.hrtime.bigint() - start));
    }
    return best;
};

// times run() on make(size) and on make(size * SCALE)
const assertLinear = async (label: string, size: number, make: (size: number) => string | Buffer, run: (input: any) => unknown): Promise<void> => {
    const small = make(size);
    const large = make(size * SCALE);
    // warm up, so that the first measurement does not include the compilation of the code
    await run(small);
    const ratio = (await bestOf(() => run(large))) / Math.max(await bestOf(() => run(small)), 1);
    assert.ok(ratio < MAX_RATIO, `${label}: ${SCALE} times the input took ${ratio.toFixed(1)} times as long`);
};

const repeat = (unit: string) => (size: number) => unit.repeat(Math.ceil(size / unit.length));

describe('Linear time', { timeout: 120 * 1000 }, () => {
    const decodeInputs: Array<[string, (size: number) => string]> = [
        ['a run of spaces', size => ' '.repeat(size) + 'x'],
        ['a run of tabs', size => '\t'.repeat(size) + 'x'],
        ['alternating spaces and tabs', repeat(' \t')],
        ['a run of "="', repeat('=')],
        ['soft line breaks', repeat('=\r\n')],
        ['whitespace in front of soft line breaks', repeat(' =\r\n')],
        ['incomplete escapes', repeat('=A')],
        ['escapes', repeat('=C3=B5')],
        ['line breaks', repeat('\r\n')],
        ['whitespace lines', repeat(' \t\r\n')]
    ];
    for (const [label, make] of decodeInputs) {
        it('decode() of ' + label, async () => {
            await assertLinear(label, 64 * 1024, make, decode);
        });
    }

    const wrapInputs: Array<[string, (size: number) => string]> = [
        ['a line without spaces', repeat('a')],
        ['escapes', repeat('=C3=B5')],
        ['continuation bytes', repeat('=80')],
        ['hyphens', repeat('-')],
        ['line breaks', repeat('\n')],
        ['spaces', repeat(' ')],
        ['a run of "="', repeat('=')],
        ['punctuation', repeat('.,!?')]
    ];
    for (const [label, make] of wrapInputs) {
        it('wrap() of ' + label, async () => {
            await assertLinear(label, 32 * 1024, make, input => wrap(input, 76));
        });
    }

    it('encode() of every byte value', async () => {
        await assertLinear('every byte', 64 * 1024, size => Buffer.from(Array.from({ length: size }, (_, i) => i % 256)), encode);
    });

    it('the Encoder with one byte chunks', async () => {
        await assertLinear('one byte chunks', 4 * 1024, repeat('a -\t\r\n'), input => pipeChunks(new Encoder(), split(Buffer.from(input), [1])));
    });

    it('the Encoder with one large chunk of whitespace', async () => {
        await assertLinear('whitespace', 64 * 1024, repeat(' '), input => pipeChunks(new Encoder(), [Buffer.from(input)]));
    });

    it('the Decoder with one byte chunks', async () => {
        await assertLinear('one byte chunks', 4 * 1024, repeat('=C3 =\r\n'), input => pipeChunks(new Decoder(), split(Buffer.from(input), [1])));
    });

    // the Decoder looks back from every line feed to find out if it may decode up to it
    const decoderInputs: Array<[string, (size: number) => string]> = [
        ['line feeds it may not decode up to', repeat('==\n')],
        ['whitespace in front of a line feed', size => '=' + ' '.repeat(size) + '\n'],
        ['whitespace lines', repeat(' \t\r\n')]
    ];
    for (const [label, make] of decoderInputs) {
        it('the Decoder with one byte chunks of ' + label, async () => {
            await assertLinear(label, 4 * 1024, make, input => pipeChunks(new Decoder(), split(Buffer.from(input), [1])));
        });
        it('the Decoder with one large chunk of ' + label, async () => {
            await assertLinear(label, 64 * 1024, make, input => pipeChunks(new Decoder(), [Buffer.from(input)]));
        });
    }
});
