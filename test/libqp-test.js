'use strict';

const { Buffer } = require('node:buffer');
const test = require('node:test');
const assert = require('node:assert').strict;

const libqp = require('../lib/libqp');

test('Encoding tests', async t => {
    await t.test('simple string', async () => {
        const encoded = libqp.encode('tere jõgeva');

        assert.strictEqual(encoded, 'tere j=C3=B5geva');
    });

    await t.test('stream', async () => {
        let input = 'tere jõgeva';
        let encoder = new libqp.Encoder();

        let encoded = await new Promise((resolve, reject) => {
            let chunks = [];
            encoder.on('readable', () => {
                let chunk;

                while ((chunk = encoder.read()) !== null) {
                    chunks.push(chunk);
                }
            });
            encoder.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });
            encoder.on('Error', err => {
                reject(err);
            });

            encoder.end(Buffer.from(input));
        });

        assert.strictEqual(encoded, 'tere j=C3=B5geva');
    });
});
