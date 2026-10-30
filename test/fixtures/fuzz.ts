import fc from 'fast-check';
import { buffer } from 'node:stream/consumers';
import type { Transform } from 'node:stream';

// Shared setup of the property-based tests. fast-check generates the inputs, and when a property
// fails it shrinks the input to a minimal counterexample and reports the seed that reproduces it.
//
// FUZZ_ITERATIONS sets the number of generated inputs per property (300 by default, the CI fuzz
// job runs many more), FUZZ_SEED fixes the seed. The default seed is fixed so that `npm test` is
// reproducible; FUZZ_SEED=random draws a new one on every run.
export const fuzzOptions = (): { numRuns: number; seed?: number } => {
    const numRuns = Number(process.env.FUZZ_ITERATIONS) || 300;
    const seed = process.env.FUZZ_SEED === 'random' ? undefined : Number(process.env.FUZZ_SEED) || 42;
    return seed === undefined ? { numRuns } : { numRuns, seed };
};

// Bytes that exercise the special cases of the format: hyphens (MIME boundaries), whitespace and
// line breaks, the "=" escape char, hex digits, UTF-8 lead and continuation bytes, and the edges
// of the byte range
const SPECIAL_BYTES = [
    0x2d, 0x20, 0x09, 0x0d, 0x0a, 0x3d, 0x41, 0x46, 0x61, 0x66, 0x30, 0x39, 0x2e, 0xc3, 0xb5, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x00, 0x7f, 0xff
];

export const bytes = (maxLength = 300): fc.Arbitrary<Buffer> =>
    fc
        .array(fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SPECIAL_BYTES) }, { weight: 1, arbitrary: fc.integer({ min: 0, max: 255 }) }), { maxLength })
        .map(list => Buffer.from(list));

// Text built from the fragments that matter for the format, mixed with arbitrary code points
const TEXT_FRAGMENTS = ['-', '--', ' ', '\t', '\r\n', '\n', '\r', '=', '.', 'a', 'õ', '€', '😀', '=C3', '=\r\n'];

export const text = (maxLength = 120): fc.Arbitrary<string> =>
    fc
        .array(fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...TEXT_FRAGMENTS) }, { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 3 }) }), {
            maxLength
        })
        .map(list => list.join(''));

// Quoted-Printable looking input that is not necessarily valid: escapes (also broken and lowercase
// ones, and ones that soft line breaks split, like "==\nA=\nB"), soft line breaks, whitespace in
// front of line breaks, and raw bytes
const QP_FRAGMENTS = ['=', '==', '=A', '=3D', '=C3', '=c3', '=4', '=G1', '=\r\n', '=\n', ' \r\n', '\t\n', ' ', '\t', '\r', '\n', 'a', '-', '\xe9', '\xff'];

export const qpInput = (maxLength = 120): fc.Arbitrary<Buffer> =>
    fc
        .array(
            fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...QP_FRAGMENTS) }, { weight: 1, arbitrary: fc.string({ unit: 'binary-ascii', maxLength: 3 }) }),
            {
                maxLength
            }
        )
        .map(list => Buffer.from(list.join(''), 'latin1'));

// Chunk sizes to split a stream input with, the last size repeats until the input is used up
export const chunkSizes = (): fc.Arbitrary<number[]> => fc.array(fc.integer({ min: 1, max: 16 }), { minLength: 1, maxLength: 8 });

export const split = (input: Buffer, sizes: number[]): Buffer[] => {
    const chunks: Buffer[] = [];
    for (let pos = 0, i = 0; pos < input.length; i++) {
        const size = sizes[Math.min(i, sizes.length - 1)] as number;
        chunks.push(input.subarray(pos, pos + size));
        pos += size;
    }
    return chunks;
};

export const pipeChunks = async (stream: Transform, chunks: Buffer[]): Promise<Buffer> => {
    const output = buffer(stream);
    for (const chunk of chunks) {
        stream.write(chunk);
    }
    stream.end();
    return await output;
};

// the lines of an output, split at every line break a reader might honour
export const linesOf = (output: string): string[] => output.split(/\r\n|\r|\n/);

// true if the bytes are well-formed UTF-8
export const isUtf8 = (input: Buffer): boolean => Buffer.from(input.toString('utf-8'), 'utf-8').equals(input);
