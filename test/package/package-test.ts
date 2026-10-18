/* eslint no-await-in-loop:0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests exercise the compiled output in dist/ (built by the pretest script) through
// the package.json exports map, the same way an installed copy of the package is loaded.
// Node resolves the package name to the package itself when the specifier is used from
// inside the package.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Non-literal specifiers keep TypeScript from resolving the built types at type-check time,
// when dist/ may not exist yet
const packageName: string = 'libqp';
const deepImports = [packageName + '/lib/libqp', packageName + '/lib/libqp.js'];

const API = ['Decoder', 'Encoder', 'decode', 'encode', 'wrap'];

// what a TypeScript or Babel compiled `import libqp from 'libqp'` reads
const importDefault = (mod: any) => (mod && mod.__esModule ? mod : { default: mod });

// the API calls a consumer of the old CommonJS source made, run against a loaded module
const exercise = async (libqp: any): Promise<void> => {
    assert.strictEqual(libqp.encode('tere jõgeva'), 'tere j=C3=B5geva');
    assert.strictEqual(libqp.decode('tere j=C3=B5geva').toString(), 'tere jõgeva');
    assert.strictEqual(libqp.wrap('abc j=C3=B5geva', 10), 'abc j=\r\n=C3=B5geva');

    const encoder = new libqp.Encoder({ lineLength: 10 });
    const decoder = new libqp.Decoder();
    const chunks: Buffer[] = [];
    decoder.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise(resolve => decoder.on('end', resolve));
    encoder.pipe(decoder);
    encoder.end(Buffer.from('tere jõgeva '.repeat(5)));
    await done;
    assert.strictEqual(Buffer.concat(chunks).toString(), 'tere jõgeva '.repeat(5));
};

describe('Built package', () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'libqp.js')), format + ' entry point');
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'libqp.d.ts')), format + ' type declarations');
        }
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'esm', 'package.json'), 'utf8')), { type: 'module' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('points every export map entry and the main field at an existing file', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        for (const target of [pkg.main, pkg.types]) {
            assert.ok(fs.existsSync(path.join(root, target)), 'missing ' + target);
        }
        for (const [subpath, entry] of Object.entries(pkg.exports)) {
            for (const target of typeof entry === 'string' ? [entry] : Object.values(entry as Record<string, string>)) {
                assert.ok(fs.existsSync(path.join(root, target)), subpath + ' points at a missing file ' + target);
            }
        }
    });

    describe('CommonJS build', () => {
        it('resolves require() to the CommonJS entry point', () => {
            assert.strictEqual(require.resolve(packageName), path.join(root, 'dist', 'cjs', 'libqp.js'));
            for (const specifier of deepImports) {
                assert.strictEqual(require.resolve(specifier), path.join(root, 'dist', 'cjs', 'libqp.js'), specifier);
            }
        });

        it('keeps the module shape of the pre-TypeScript build', () => {
            const libqp = require(packageName);
            // the five exports are the enumerable keys, the default alias is the module itself
            assert.deepStrictEqual(Object.keys(libqp).sort(), API);
            assert.strictEqual(libqp.default, libqp);
            for (const specifier of deepImports) {
                assert.strictEqual(require(specifier), libqp, specifier);
            }
        });

        it('keeps a file at the old deep import path for bundlers that ignore the exports map', () => {
            // for resolvers that look for `libqp/lib/libqp` on disk, Node never loads this file
            assert.strictEqual(require(path.join(root, 'lib', 'libqp.js')), require(packageName));
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'lib', 'package.json'), 'utf8')), { type: 'commonjs' });
            assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files.includes('lib'));
        });

        it('works the way the pre-TypeScript build did', async () => {
            await exercise(require(packageName));
        });

        it('serves the same module to a transpiled default import and a named import', () => {
            const libqp = require(packageName);
            const viaDefault = importDefault(libqp).default;
            assert.strictEqual(viaDefault.encode, libqp.encode);
            const original = libqp.encode;
            viaDefault.encode = () => 'stubbed';
            try {
                assert.strictEqual(libqp.encode(), 'stubbed');
            } finally {
                viaDefault.encode = original;
            }
        });

        it('loads in a plain CommonJS process outside of the test runner', () => {
            // the way a CommonJS application, or one bundled with pkg, loads the package
            const script = [
                "const libqp = require('libqp');",
                "const { encode, Decoder } = require('libqp/lib/libqp');",
                "if (encode !== libqp.encode || typeof Decoder !== 'function') throw new Error('shape');",
                "process.stdout.write(libqp.encode('õ') + ' ' + Object.keys(libqp).sort().join(','));"
            ].join('\n');
            const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
            assert.strictEqual(result.status, 0, result.stderr);
            assert.strictEqual(result.stdout, '=C3=B5 ' + API.join(','));
        });
    });

    describe('ES module build', () => {
        it('resolves import to the ES module entry point', async () => {
            const direct = await import(new URL('../../dist/esm/libqp.js', import.meta.url).href);
            const byName = await import(packageName);
            assert.strictEqual(byName.encode, direct.encode);
            for (const specifier of deepImports) {
                assert.strictEqual((await import(specifier)).encode, direct.encode, specifier);
            }
            assert.notStrictEqual(byName.encode, require(packageName).encode, 'import loaded the CommonJS build');
        });

        it('exposes named and default exports', async () => {
            const libqp = await import(packageName);
            for (const name of API) {
                assert.strictEqual(typeof libqp[name], 'function', name);
                assert.strictEqual(libqp.default[name], libqp[name], 'default.' + name);
            }
            assert.deepStrictEqual(Object.keys(libqp.default).sort(), API);
        });

        it('works the way the CommonJS build does', async () => {
            await exercise((await import(packageName)).default);
        });
    });
});
