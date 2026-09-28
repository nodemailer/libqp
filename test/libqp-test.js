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

test('Decoding tests', async t => {
    // Example taken from RFC2045 section 6.7
    const encoded = "Now's the time =\r\n" + 'for all folk to come=\r\n' + ' to the aid of their country.';
    const expectedDecoded = "Now's the time for all folk to come to the aid of their country.";

    await t.test('simple string', async () => {
        const decoded = libqp.decode(encoded).toString();
        assert.strictEqual(decoded, expectedDecoded);
    });

    await t.test('stream', async () => {
        const decoder = new libqp.Decoder();

        const decoded = await new Promise((resolve, reject) => {
            const chunks = [];
            decoder.on('readable', () => {
                let chunk;

                while ((chunk = decoder.read()) !== null) {
                    chunks.push(chunk);
                }
            });
            decoder.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });
            decoder.on('Error', err => {
                reject(err);
            });

            decoder.end(Buffer.from(encoded));
        });

        assert.strictEqual(decoded, expectedDecoded);
    });

    await t.test('stream, multiple chunks', async () => {
        const encodedChunk1Length = 3;
        const encodedChunk1 = encoded.substring(0, encodedChunk1Length);
        const encodedChunk2 = encoded.substring(encodedChunk1Length);

        const decoder = new libqp.Decoder();

        const decoded = await new Promise((resolve, reject) => {
            const chunks = [];
            decoder.on('readable', () => {
                let chunk;

                while ((chunk = decoder.read()) !== null) {
                    chunks.push(chunk);
                }
            });
            decoder.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });
            decoder.on('Error', err => {
                reject(err);
            });

            decoder.write(Buffer.from(encodedChunk1));
            decoder.end(Buffer.from(encodedChunk2));
        });

        assert.strictEqual(decoded, expectedDecoded);
    });

    await t.test('stream, space at end of chunk', async () => {
        const encodedChunk1Length = encoded.indexOf(' ') + 1;
        const encodedChunk1 = encoded.substring(0, encodedChunk1Length);
        const encodedChunk2 = encoded.substring(encodedChunk1Length);

        const decoder = new libqp.Decoder();

        const decoded = await new Promise((resolve, reject) => {
            const chunks = [];
            decoder.on('readable', () => {
                let chunk;

                while ((chunk = decoder.read()) !== null) {
                    chunks.push(chunk);
                }
            });
            decoder.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });
            decoder.on('Error', err => {
                reject(err);
            });

            decoder.write(Buffer.from(encodedChunk1));
            decoder.end(Buffer.from(encodedChunk2));
        });

        assert.strictEqual(decoded, expectedDecoded);
    });

    await t.test('stream, soft line break equals sign at end of chunk', async () => {
        const encodedChunk1Length = encoded.indexOf('=') + 1;
        const encodedChunk1 = encoded.substring(0, encodedChunk1Length);
        const encodedChunk2 = encoded.substring(encodedChunk1Length);

        const decoder = new libqp.Decoder();

        const decoded = await new Promise((resolve, reject) => {
            const chunks = [];
            decoder.on('readable', () => {
                let chunk;

                while ((chunk = decoder.read()) !== null) {
                    chunks.push(chunk);
                }
            });
            decoder.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });
            decoder.on('Error', err => {
                reject(err);
            });

            decoder.write(Buffer.from(encodedChunk1));
            decoder.end(Buffer.from(encodedChunk2));
        });

        assert.strictEqual(decoded, expectedDecoded);
    });

    await t.test('stream, CR at end of chunk', async () => {
        const encodedChunk1Length = encoded.indexOf('\r') + 1;
        const encodedChunk1 = encoded.substring(0, encodedChunk1Length);
        const encodedChunk2 = encoded.substring(encodedChunk1Length);

        const decoder = new libqp.Decoder();

        const decoded = await new Promise((resolve, reject) => {
            const chunks = [];
            decoder.on('readable', () => {
                let chunk;

                while ((chunk = decoder.read()) !== null) {
                    chunks.push(chunk);
                }
            });
            decoder.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });
            decoder.on('Error', err => {
                reject(err);
            });

            decoder.write(Buffer.from(encodedChunk1));
            decoder.end(Buffer.from(encodedChunk2));
        });

        assert.strictEqual(decoded, expectedDecoded);
    });
});

test('Raw 8-bit bytes in Quoted-Printable input', async t => {
    const decodeStream = async chunks =>
        await new Promise((resolve, reject) => {
            const decoder = new libqp.Decoder();
            const output = [];
            decoder.on('data', chunk => output.push(chunk));
            decoder.on('end', () => resolve(Buffer.concat(output)));
            decoder.on('error', reject);
            for (const chunk of chunks) {
                decoder.write(chunk);
            }
            decoder.end();
        });

    // "caf\xC3\xA9 \xE2\x82\xAC =C3=A9", raw UTF-8 bytes mixed with an escape
    const utf8Input = Buffer.concat([Buffer.from('caf'), Buffer.from([0xc3, 0xa9, 0x20, 0xe2, 0x82, 0xac]), Buffer.from(' =C3=A9')]);
    const utf8Expected = Buffer.from('café € é');

    // "caf\xE9 =E9", a raw latin1 byte next to the same byte escaped
    const latin1Input = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' =E9')]);
    const latin1Expected = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xe9]);

    await t.test('decode() keeps raw UTF-8 bytes from a Buffer', async () => {
        assert.deepStrictEqual(libqp.decode(utf8Input), utf8Expected);
    });

    await t.test('decode() keeps raw latin1 bytes from a Buffer', async () => {
        assert.deepStrictEqual(libqp.decode(latin1Input), latin1Expected);
    });

    await t.test('decode() of a binary string still maps char codes to bytes', async () => {
        assert.deepStrictEqual(libqp.decode(latin1Input.toString('binary')), latin1Expected);
    });

    await t.test('Decoder keeps raw UTF-8 bytes', async () => {
        assert.deepStrictEqual(await decodeStream([utf8Input]), utf8Expected);
    });

    await t.test('Decoder keeps raw latin1 bytes', async () => {
        assert.deepStrictEqual(await decodeStream([latin1Input]), latin1Expected);
    });

    await t.test('Decoder keeps raw bytes and escapes split byte by byte', async () => {
        const chunks = [];
        for (let i = 0; i < utf8Input.length; i++) {
            chunks.push(utf8Input.subarray(i, i + 1));
        }
        assert.deepStrictEqual(await decodeStream(chunks), utf8Expected);
    });

    await t.test('Decoder handles an escape split across chunks', async () => {
        // split inside "=C3", once after "=" and once after "=C"
        const input = Buffer.from('ab=C3=A9=\r\ncd');
        const expected = Buffer.from('abécd');
        assert.deepStrictEqual(await decodeStream([input.subarray(0, 3), input.subarray(3)]), expected);
        assert.deepStrictEqual(await decodeStream([input.subarray(0, 4), input.subarray(4)]), expected);
        // soft line break split between "=" and CRLF
        assert.deepStrictEqual(await decodeStream([input.subarray(0, 9), input.subarray(9)]), expected);
    });
});
