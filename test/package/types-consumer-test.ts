import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The suite runs through tsx, which strips the types instead of checking them, and
// `npm run typecheck` checks the types in src/. These tests type-check a consumer against
// the built declarations in dist/ the way an installed copy is resolved: the package is
// linked into a temporary project so that the specifiers go through the package.json
// exports map.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');

// The idioms consumers use: the default export object, the named exports and the deep import,
// with option objects built from values that may be undefined, which only compiles under
// exactOptionalPropertyTypes when every optional property is declared with `| undefined`
const consumer = `
import libqp from 'libqp';
import { encode, decode, wrap, Encoder, Decoder } from 'libqp';
import type { EncoderOptions, DecoderOptions } from 'libqp';
import deep from 'libqp/lib/libqp';

declare const maybeNumber: number | undefined;
declare const maybeBoolean: boolean | undefined;

const encoded: string = libqp.encode('tere') + encode(Buffer.from('tere')) + encode(new Uint8Array([0x41]));
const decoded: Buffer = libqp.decode(encoded);
const fromBuffer: Buffer = decode(Buffer.from(encoded));
const wrapped: string = wrap(encoded, 76) + wrap(encoded) + deep.wrap(encoded);

const options: EncoderOptions = { lineLength: maybeNumber, binary: maybeBoolean, highWaterMark: maybeNumber };
const encoder: Encoder = new libqp.Encoder(options);
const plain = new Encoder({ lineLength: false });
const decoderOptions: DecoderOptions = { highWaterMark: 1024 };
const decoder: Decoder = new Decoder(decoderOptions);
encoder.pipe(decoder);

const counters: number = encoder.inputBytes + encoder.outputBytes + decoder.inputBytes + decoder.outputBytes;
const lineLength: number | false | undefined = plain.options.lineLength;
void [decoded, fromBuffer, wrapped, counters, lineLength];
`;

// the CommonJS idioms, as written in a TypeScript CommonJS project
const cjsConsumer = `
import libqp = require('libqp');
import deep = require('libqp/lib/libqp');

const encoded: string = libqp.encode('tere');
const decoder: libqp.Decoder = new deep.Decoder();
void [encoded, decoder, libqp.default.wrap(encoded)];
`;

// what the declarations must not expose
const internalConsumer = `
import { Encoder, Decoder } from 'libqp';

const encoder = new Encoder();
encoder._curLine;
encoder._heldByte;
encoder._lastByte;
encoder._encodeSlices;
new Decoder().qpChunks;
`;

const node16 = { module: 'node16', moduleResolution: 'node16' };
const resolutions: Array<{ name: string; compilerOptions: { [key: string]: unknown }; type?: string }> = [
    { name: 'node16 ES module project', compilerOptions: node16, type: 'module' },
    { name: 'node16 CommonJS project', compilerOptions: node16 },
    { name: 'bundler resolution', compilerOptions: { module: 'esnext', moduleResolution: 'bundler' }, type: 'module' },
    // the resolution of TypeScript projects that predate the exports map, served by typesVersions
    { name: 'node10 resolution', compilerOptions: { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' } }
];

// Type-checks a consumer source against the built declarations in dist/. With expectedErrors
// the consumer must fail to compile, and every listed message must be among the errors
const typeCheckConsumer = (source: string, compilerOptions: { [key: string]: unknown }, type?: string, expectedErrors?: string[]): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libqp-types-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
        // link the package itself and the node typings a real consumer has, so that
        // the specifiers resolve the way they do in an installed project
        fs.symlinkSync(root, path.join(dir, 'node_modules', 'libqp'), 'dir');
        fs.symlinkSync(path.join(root, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'dir');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
        fs.writeFileSync(path.join(dir, 'consumer.ts'), source);
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    lib: ['ES2023'],
                    types: ['node'],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noEmit: true,
                    skipLibCheck: false,
                    esModuleInterop: true,
                    ...compilerOptions
                },
                include: ['consumer.ts']
            })
        );

        const result = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
        const output = result.stdout + result.stderr;
        if (expectedErrors) {
            assert.notStrictEqual(result.status, 0, 'tsc accepted a consumer that must not compile');
            for (const expected of expectedErrors) {
                assert.ok(output.includes(expected), 'tsc did not report "' + expected + '"\n' + output);
            }
            return;
        }
        assert.strictEqual(result.status, 0, 'tsc reported\n' + output);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

describe('Built package types', { timeout: 120 * 1000 }, () => {
    for (const resolution of resolutions) {
        it('type-checks a consumer with ' + resolution.name, () => {
            typeCheckConsumer(consumer, resolution.compilerOptions, resolution.type);
        });
    }

    it('type-checks a CommonJS consumer that uses import = require()', () => {
        typeCheckConsumer(cjsConsumer, node16);
    });

    it('strips the internal members from the declarations', () => {
        typeCheckConsumer(internalConsumer, node16, 'module', [
            "Property '_curLine' does not exist on type 'Encoder'",
            "Property '_heldByte' does not exist on type 'Encoder'",
            "Property '_lastByte' does not exist on type 'Encoder'",
            "Property '_encodeSlices' does not exist on type 'Encoder'",
            "Property 'qpChunks' does not exist on type 'Decoder'"
        ]);
    });
});
