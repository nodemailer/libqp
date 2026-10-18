// Builds the package.
//
// 1. Compiles src/ twice with tsc: once as ES modules into dist/esm and once as
//    CommonJS into dist/cjs. Each output directory gets its own package.json
//    that pins the module format.
// 2. Patches the CommonJS entry point so that `require('libqp')` keeps the shape
//    the pre-TypeScript CommonJS source had, see ENTRY_POINT_SHIM.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = require.resolve('typescript/bin/tsc');

function runTsc(project, ...args) {
    const result = spawnSync(process.execPath, [tsc, '-p', project, ...args], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

// The entry point combines a default export with named runtime exports. It keeps its
// named exports, and its default export is made to be the exports object itself. Before
// the TypeScript build `require('libqp')` had no default export, so `import libqp from
// 'libqp'` in a CommonJS compiled consumer resolved to the exports object. Pointing
// `default` at the exports object keeps that. The alias is non-enumerable so that the
// enumerable keys of the module are the five exports, as before.
const ENTRY_POINT_MODULE = 'libqp.js';
const ENTRY_POINT_SHIM = "Object.defineProperty(exports, 'default', { value: exports, enumerable: false, writable: true, configurable: true });\n";

// Appends a shim to a compiled module, ahead of the source map comment if there is one
function writePatched(file, shim) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/\bexports\.default\s*=/.test(source)) {
        throw new Error(path.basename(file) + ' has no default export to patch');
    }
    const mapComment = source.lastIndexOf('//# sourceMappingURL=');
    const patched = mapComment === -1 ? source + shim : source.slice(0, mapComment) + shim + source.slice(mapComment);
    fs.writeFileSync(file, patched);
}

function build() {
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

    runTsc('tsconfig.esm.json');
    // The ES module compile has already type-checked the same sources
    runTsc('tsconfig.cjs.json', '--noCheck');

    for (const [format, type] of [
        ['esm', 'module'],
        ['cjs', 'commonjs']
    ]) {
        fs.writeFileSync(path.join(root, 'dist', format, 'package.json'), JSON.stringify({ type }, null, 4) + '\n');
    }

    writePatched(path.join(root, 'dist', 'cjs', ENTRY_POINT_MODULE), ENTRY_POINT_SHIM);
}

build();
