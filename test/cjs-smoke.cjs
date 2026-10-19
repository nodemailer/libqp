'use strict';

// Loads the CommonJS build the way EmailEngine's @yao-pkg/pkg binary does. Run with
// --no-experimental-require-module (`npm run test:cjs`) so an ES module anywhere in the
// require() graph fails here instead of being loaded through require(esm).

const assert = require('node:assert/strict');
const pkg = require('../package.json');

const libqp = require('../' + pkg.exports['.'].require);

assert.strictEqual(libqp.default, libqp);
assert.deepStrictEqual(Object.keys(libqp).sort(), ['Decoder', 'Encoder', 'decode', 'encode', 'wrap']);
assert.strictEqual(require('../lib/libqp.js'), libqp);
assert.strictEqual(libqp.encode('tere jõgeva'), 'tere j=C3=B5geva');
assert.strictEqual(libqp.decode('tere j=C3=B5geva=\r\n!').toString(), 'tere jõgeva!');
assert.strictEqual(libqp.wrap('abc=C3=B5def', 7), 'abc=\r\n=C3=B5=\r\ndef');

let streamed = false;
process.on('exit', () => assert.ok(streamed, 'the stream round trip did not finish'));

const encoder = new libqp.Encoder({ lineLength: 10 });
const chunks = [];
encoder.on('data', chunk => chunks.push(chunk));
encoder.on('end', () => {
    const encoded = Buffer.concat(chunks).toString();
    assert.ok(
        encoded.split('\r\n').every(line => line.length <= 10),
        encoded
    );

    const decoder = new libqp.Decoder();
    const decoded = [];
    decoder.on('data', chunk => decoded.push(chunk));
    decoder.on('end', () => {
        assert.strictEqual(Buffer.concat(decoded).toString(), 'tere jõgeva, tere jõgeva');
        streamed = true;
        console.log('CommonJS build loads and works without require(esm)');
    });
    decoder.end(encoded);
});
encoder.end(Buffer.from('tere jõgeva, tere jõgeva'));
