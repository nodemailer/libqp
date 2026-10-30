/* eslint no-await-in-loop:0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buffer } from 'node:stream/consumers';

import libqp, { encode, decode, wrap, Encoder, Decoder, type EncoderOptions } from '../src/libqp.js';

type Chunk = Buffer | string;

const collect = async (stream: Encoder | Decoder, chunks: Chunk[]): Promise<Buffer> => {
    const output = buffer(stream);
    for (const chunk of chunks) {
        stream.write(chunk);
    }
    stream.end();
    return await output;
};

const encodeStream = async (chunks: Chunk[], options?: EncoderOptions): Promise<string> => (await collect(new Encoder(options), chunks)).toString();

const decodeStream = async (chunks: Chunk[]): Promise<Buffer> => await collect(new Decoder(), chunks);

// splits the input into chunks of the given size
const split = (input: Buffer, size: number): Buffer[] => {
    const chunks: Buffer[] = [];
    for (let i = 0; i < input.length; i += size) {
        chunks.push(input.subarray(i, i + size));
    }
    return chunks;
};

const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

// Example taken from RFC2045 section 6.7
const rfcEncoded = "Now's the time =\r\nfor all folk to come=\r\n to the aid of their country.";
const rfcDecoded = "Now's the time for all folk to come to the aid of their country.";

describe('Module exports', () => {
    it('exposes the API as named exports and as a default export object', () => {
        assert.deepStrictEqual(Object.keys(libqp).sort(), ['Decoder', 'Encoder', 'decode', 'encode', 'wrap']);
        assert.strictEqual(libqp.encode, encode);
        assert.strictEqual(libqp.decode, decode);
        assert.strictEqual(libqp.wrap, wrap);
        assert.strictEqual(libqp.Encoder, Encoder);
        assert.strictEqual(libqp.Decoder, Decoder);
    });
});

describe('encode()', () => {
    it('encodes a unicode string as UTF-8', () => {
        assert.strictEqual(encode('tere jõgeva'), 'tere j=C3=B5geva');
        assert.strictEqual(encode('€'), '=E2=82=AC');
    });

    it('encodes a Buffer and a Uint8Array the same way', () => {
        const bytes = Buffer.from('tere jõgeva');
        assert.strictEqual(encode(bytes), 'tere j=C3=B5geva');
        assert.strictEqual(encode(new Uint8Array(bytes)), 'tere j=C3=B5geva');
    });

    it('returns an empty string for empty input', () => {
        assert.strictEqual(encode(''), '');
        assert.strictEqual(encode(Buffer.alloc(0)), '');
    });

    it('keeps the printable ASCII range except "=" literal', () => {
        let printable = '';
        for (let i = 0x21; i <= 0x7e; i++) {
            printable += String.fromCharCode(i);
        }
        assert.strictEqual(encode(printable), printable.replace('=', '=3D'));
    });

    it('escapes every other byte with uppercase hex digits', () => {
        const encoded = encode(allBytes);
        for (let i = 0; i < 256; i++) {
            const literal = i === 0x09 || i === 0x0a || i === 0x0d || (i >= 0x20 && i <= 0x7e && i !== 0x3d);
            const escape = '=' + (i < 0x10 ? '0' : '') + i.toString(16).toUpperCase();
            if (!literal) {
                assert.ok(encoded.includes(escape), 'byte ' + i + ' is not escaped');
            }
        }
        assert.ok(!/[=][0-9A-F]?[a-f]/.test(encoded), 'escapes use uppercase hex');
        assert.deepStrictEqual(decode(encoded), allBytes);
    });

    it('escapes whitespace at the end of a line and at the end of the input', () => {
        assert.strictEqual(encode('a \r\nb\t\nc '), 'a=20\r\nb=09\nc=20');
        assert.strictEqual(encode('a \rb'), 'a=20\rb');
        assert.strictEqual(encode('a b\tc'), 'a b\tc');
        assert.strictEqual(encode(' '), '=20');
    });

    it('keeps line breaks literal', () => {
        assert.strictEqual(encode('a\r\nb\nc\rd'), 'a\r\nb\nc\rd');
    });

    it('does not wrap long lines', () => {
        const input = 'a'.repeat(200);
        assert.strictEqual(encode(input), input);
    });
});

describe('decode()', () => {
    it('decodes the RFC 2045 example', () => {
        assert.strictEqual(decode(rfcEncoded).toString(), rfcDecoded);
    });

    it('decodes valid escapes and keeps invalid ones', () => {
        assert.strictEqual(decode('=41=42=43').toString(), 'ABC');
        assert.strictEqual(decode('=c3=a9').toString(), 'é');
        assert.strictEqual(decode('=4G=4').toString(), '=4G=4');
        assert.strictEqual(decode('==41').toString(), '=A');
        assert.strictEqual(decode('=').toString(), '');
        assert.strictEqual(decode('a=4').toString(), 'a=4');
        assert.strictEqual(decode('a=\r\nb=\nc=').toString(), 'abc');
    });

    it('decodes the escape of every byte', () => {
        assert.deepStrictEqual(decode(encode(allBytes)), allBytes);
        let lowercase = '';
        for (let i = 0; i < 256; i++) {
            lowercase += '=' + (i < 0x10 ? '0' : '') + i.toString(16);
        }
        assert.deepStrictEqual(decode(lowercase), allBytes);
    });

    it('returns an empty Buffer for empty input', () => {
        for (const input of ['', Buffer.alloc(0), null, undefined]) {
            const decoded = decode(input as string);
            assert.ok(Buffer.isBuffer(decoded));
            assert.strictEqual(decoded.length, 0);
        }
    });

    it('reads a Uint8Array byte for byte', () => {
        const input = Buffer.from('caf\xe9 =E9 =\r\nx', 'latin1');
        const view = new Uint8Array(input.length + 4).fill(0x41);
        view.set(input, 2);
        assert.deepStrictEqual(decode(view.subarray(2, 2 + input.length)), Buffer.from('caf\xe9 \xe9 x', 'latin1'));
    });

    it('removes whitespace from the end of lines', () => {
        assert.strictEqual(decode('abc  \r\ndef \t\nghi  ').toString(), 'abc\r\ndef\nghi');
        assert.strictEqual(decode('   \n   ').toString(), '\n');
        assert.strictEqual(decode('a  b').toString(), 'a  b');
        assert.strictEqual(decode('a =20\r\n').toString(), 'a  \r\n');
    });

    it('treats a soft line break with trailing whitespace as a soft line break', () => {
        assert.strictEqual(decode('foo= \t\r\nbar').toString(), 'foobar');
    });

    it('keeps whitespace in front of a soft line break', () => {
        assert.strictEqual(decode('foo =\r\nbar').toString(), 'foo bar');
    });

    it('handles a long run of whitespace in linear time', () => {
        // the trim used to be quadratic on a run that does not end the line, 50 KB took 2 seconds
        for (const chr of [' ', '\t']) {
            const input = chr.repeat(500 * 1024) + 'x';
            const start = Date.now();
            const decoded = decode(input).toString('binary');
            const duration = Date.now() - start;
            assert.strictEqual(decoded, input);
            assert.ok(duration < 500, `decoding took ${duration} ms`);
        }
    });

    it('handles a long run of "=" signs in linear time', () => {
        const input = '='.repeat(1024 * 1024);
        const start = Date.now();
        assert.strictEqual(decode(input).length, input.length - 1);
        const duration = Date.now() - start;
        assert.ok(duration < 500, `decoding took ${duration} ms`);
    });

    it('sizes the output for a body made of escapes', () => {
        const count = 1024 * 1024;
        const decoded = decode('=41'.repeat(count));
        assert.strictEqual(decoded.length, count);
        assert.strictEqual(decoded[0], 0x41);
        assert.strictEqual(decoded[count - 1], 0x41);
    });
});

describe('Raw 8-bit bytes in Quoted-Printable input', () => {
    // "caf\xC3\xA9 \xE2\x82\xAC =C3=A9", raw UTF-8 bytes mixed with an escape
    const utf8Input = Buffer.concat([Buffer.from('caf'), Buffer.from([0xc3, 0xa9, 0x20, 0xe2, 0x82, 0xac]), Buffer.from(' =C3=A9')]);
    const utf8Expected = Buffer.from('café € é');

    // "caf\xE9 =E9", a raw latin1 byte next to the same byte escaped
    const latin1Input = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' =E9')]);
    const latin1Expected = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xe9]);

    it('decode() keeps raw UTF-8 bytes from a Buffer', () => {
        assert.deepStrictEqual(decode(utf8Input), utf8Expected);
    });

    it('decode() keeps raw latin1 bytes from a Buffer', () => {
        assert.deepStrictEqual(decode(latin1Input), latin1Expected);
    });

    it('decode() of a binary string still maps char codes to bytes', () => {
        assert.deepStrictEqual(decode(latin1Input.toString('binary')), latin1Expected);
    });

    it('Decoder keeps raw UTF-8 bytes', async () => {
        assert.deepStrictEqual(await decodeStream([utf8Input]), utf8Expected);
    });

    it('Decoder keeps raw latin1 bytes', async () => {
        assert.deepStrictEqual(await decodeStream([latin1Input]), latin1Expected);
    });

    it('Decoder keeps raw bytes and escapes split byte by byte', async () => {
        assert.deepStrictEqual(await decodeStream(split(utf8Input, 1)), utf8Expected);
    });
});

describe('wrap()', () => {
    it('adds soft line breaks', () => {
        assert.strictEqual(wrap('abc j=C3=B5geva', 10), 'abc j=\r\n=C3=B5geva');
    });

    it('returns short input as is', () => {
        assert.strictEqual(wrap('abc', 10), 'abc');
        assert.strictEqual(wrap(''), '');
    });

    it('keeps every line within the default 76 chars', () => {
        const wrapped = wrap(encode('õ'.repeat(200) + ' ' + 'a'.repeat(300)));
        for (const line of wrapped.split('\r\n')) {
            assert.ok(line.length <= 76, `line too long: ${line.length}`);
        }
        assert.strictEqual(decode(wrapped).toString(), 'õ'.repeat(200) + ' ' + 'a'.repeat(300));
    });

    it('breaks at a space near the end of the line', () => {
        assert.strictEqual(wrap('aaaa bbbb cccc', 10), 'aaaa bbbb=\r\n cccc');
    });

    it('keeps existing line breaks', () => {
        const input = 'a'.repeat(10) + '\r\n' + 'b'.repeat(10) + '\n' + 'c'.repeat(5);
        assert.strictEqual(wrap(input, 12), input);
    });

    it('never splits an escape sequence', () => {
        const encoded = encode(Buffer.alloc(100, 0xff));
        for (let lineLength = 4; lineLength < 20; lineLength++) {
            const wrapped = wrap(encoded, lineLength);
            for (const line of wrapped.split('=\r\n')) {
                assert.match(line, /^(?:=FF)*$/, 'line ' + JSON.stringify(line) + ' for length ' + lineLength);
            }
        }
    });

    it('never splits a UTF-8 sequence', () => {
        // a line used to be cut after four escapes even when they did not make one char
        assert.strictEqual(wrap(encode('€€€'), 20), '=E2=82=AC=\r\n=E2=82=AC=E2=82=AC');
        for (const chr of ['õ', '€', '😀']) {
            const input = chr.repeat(50);
            for (let lineLength = 14; lineLength <= 80; lineLength++) {
                const wrapped = wrap(encode(input), lineLength);
                for (const line of wrapped.split('=\r\n')) {
                    assert.ok(line.length <= lineLength);
                    assert.strictEqual(decode(line).toString(), chr.repeat(decode(line).length / Buffer.byteLength(chr)), 'split at ' + lineLength);
                }
                assert.strictEqual(decode(wrapped).toString(), input);
            }
        }
    });

    it('keeps a line that holds nothing but one UTF-8 sequence whole', () => {
        assert.strictEqual(wrap('=E2=82=AC=E2=82=AC', 10), '=E2=82=AC=\r\n=E2=82=AC');
    });

    it('keeps a UTF-8 sequence on the line of a hyphen escape that holds nothing else', () => {
        assert.strictEqual(wrap('=F0=90=80=80\t-=F0=90=80=80=00', 16), '=F0=90=80=80\t=\r\n=2D=F0=90=80=80=\r\n=00');
    });

    it('moves an incomplete escape at the end of the input to its own line', () => {
        assert.strictEqual(wrap('abcdefg=C', 8), 'abcdefg=\r\n=C');
    });

    it('returns input exactly as long as the line length as is', () => {
        // even with a space where a longer line would be broken
        assert.strictEqual(wrap('abcd e', 6), 'abcd e');
    });

    it('keeps the rest of a line whole when it fits', () => {
        // even with a space in its last third, where a longer line would be broken
        assert.strictEqual(wrap('abcdefghijk lm', 9), 'abcdefgh=\r\nijk lm');
        assert.strictEqual(wrap('abcdefghijklm no', 9), 'abcdefgh=\r\nijklm no');
        assert.strictEqual(wrap('abcdefghijklm no\nx', 9), 'abcdefgh=\r\nijklm no\nx');
    });

    it('starts the line after a hard line break with the full line length', () => {
        assert.strictEqual(wrap('ab\r\n' + 'c'.repeat(12), 6), 'ab\r\nccccc=\r\nccccc=\r\ncc');
        assert.strictEqual(wrap('abcd\nefghijklmnop', 6), 'abcd\nefghi=\r\njklmn=\r\nop');
    });

    it('cuts a UTF-8 sequence only at a lead byte and leaves invalid escapes in place', () => {
        // =C0 is a lead byte, the sequence starts there
        assert.strictEqual(wrap('a=C3=C0=B5bbbbbbbb', 10), 'a=C3=\r\n=C0=B5bbb=\r\nbbbbb');
        // =Cz is not an escape, so it ends the sequence search
        assert.strictEqual(wrap('a=C3=Cz=B5bbbbbbbb', 8), 'a=C3=Cz=\r\n=B5bbbb=\r\nbbbb');
    });

    it('does not count a line break towards the line length', () => {
        // a line that fits is followed by its line break, not by a soft one
        assert.strictEqual(wrap('aaaaaaa\nbb', 7), 'aaaaaaa\nbb');
        assert.strictEqual(wrap('aaaaaaa\r\nbb', 7), 'aaaaaaa\r\nbb');
        assert.strictEqual(wrap('aaaaaa\r\nbb', 7), 'aaaaaa\r\nbb');
        // and the line after it starts with the full line length
        assert.strictEqual(wrap('ab\ncdefghi', 7), 'ab\ncdefghi');
        assert.strictEqual(wrap('\n=2D-=20', 7), '\n=2D-=20');
        assert.strictEqual(wrap('ab\n' + 'c'.repeat(12), 6), 'ab\nccccc=\r\nccccc=\r\ncc');
    });

    it('treats a missing, zero or invalid line length as 76', () => {
        const input = 'a'.repeat(200);
        const expected = wrap(input, 76);
        assert.strictEqual(expected.split('\r\n')[0]?.length, 76);
        for (const lineLength of [undefined, 0, NaN, 'abc']) {
            assert.strictEqual(wrap(input, lineLength as number), expected);
        }
        assert.strictEqual(wrap(input, '20' as unknown as number), wrap(input, 20));
    });

    it('raises a line length below 4 to 4 instead of looping forever', () => {
        // these used to hang
        const inputs = [encode('tere jõgeva -x'), '-'.repeat(20), '=C3=B5=C3=B5', 'abc=C', 'a'.repeat(30)];
        for (const lineLength of [-5, 1, 2, 3, 4]) {
            for (const input of inputs) {
                const wrapped = wrap(input, lineLength);
                assert.strictEqual(wrapped, wrap(input, 4));
                for (const line of wrapped.split('\r\n')) {
                    assert.ok(line.length <= 4, `line too long: ${JSON.stringify(line)}`);
                }
                assert.deepStrictEqual(decode(wrapped), decode(input));
            }
        }
    });
});

describe('Hyphens at the start of a line', () => {
    it('encode() escapes a hyphen that starts a line', () => {
        // two hyphens at the start of a line would read as a MIME boundary delimiter
        assert.strictEqual(encode('--boundary\r\n-x'), '=2D-boundary\r\n=2Dx');
        assert.strictEqual(encode('\n-'), '\n=2D');
    });

    it('encode() keeps a hyphen inside a line', () => {
        assert.strictEqual(encode('a-b --c'), 'a-b --c');
    });

    it('encode() escapes a hyphen after a lone CR', () => {
        // a relay that turns the CR into CRLF would start a line with the hyphen
        assert.strictEqual(encode('a\r--b'), 'a\r=2D-b');
        assert.strictEqual(encode(Buffer.from('a\r--b')), 'a\r=2D-b');
    });

    it('wrap() escapes a hyphen that a soft line break would move to the start of a line', () => {
        const input = 'a'.repeat(75) + '-x';
        const wrapped = wrap(encode(input));
        assert.strictEqual(wrapped, 'a'.repeat(75) + '=\r\n=2Dx');
        assert.strictEqual(decode(wrapped).toString(), input);
    });

    it('wrap() leaves a hyphen alone where it did not add the line break', () => {
        // at the start of the input, and after a hard line break that follows a soft one
        assert.strictEqual(wrap('-' + 'a'.repeat(10), 6), '-aaaa=\r\naaaaaa');
        assert.strictEqual(wrap('abcdefgh\r\n-abc', 6), 'abcde=\r\nfgh\r\n-abc');
    });

    it('wrap() fills a line that starts with an escaped hyphen', () => {
        // the escape leaves exactly the shortest line length for the rest of the line
        assert.strictEqual(wrap('abcdef-ghijklmno', 7), 'abcdef=\r\n=2Dghi=\r\njklmno');
    });

    it('wrap() keeps every line within the line length when escaping', () => {
        for (const lineLength of [4, 5, 6, 7, 10, 76]) {
            const input = '-'.repeat(300);
            const wrapped = wrap(encode(input), lineLength);
            const lines = wrapped.split('\r\n');
            assert.ok(lines.length > 3);
            for (const line of lines) {
                assert.ok(line.length <= lineLength, `line too long: ${line.length}`);
                assert.notStrictEqual(line.charAt(0), '-');
            }
            assert.strictEqual(decode(wrapped).toString(), input);
        }
    });

    it('wrap() escapes a hyphen that ends the input after a soft line break', () => {
        assert.strictEqual(wrap('aaaaaaa-', 8), 'aaaaaaa-');
        assert.strictEqual(wrap('aaaaaaaa-', 8), 'aaaaaaa=\r\na-');
        assert.strictEqual(wrap('aaaaaaa-', 7.5), 'aaaaaaa=\r\n=2D');
        // the escape leaves too little room for anything else when the line is shorter than 7
        assert.strictEqual(wrap('aaaaa-a', 6), 'aaaaa=\r\n=2Da');
        assert.strictEqual(wrap('aaa-a', 4), 'aaa=\r\n=2Da');
        assert.strictEqual(wrap('aaa-ab', 4), 'aaa=\r\n=2D=\r\nab');
        assert.strictEqual(wrap('aaa--', 4), 'aaa=\r\n=2D-');
    });

    it('Encoder escapes a hyphen at the start of a chunk only when it starts a line', async () => {
        for (const options of [{}, { lineLength: false as const }]) {
            assert.strictEqual(await encodeStream(['-a'], options), '=2Da');
            assert.strictEqual(await encodeStream(['ab\n', '-c'], options), 'ab\n=2Dc');
            assert.strictEqual(await encodeStream(['ab', '-c'], options), 'ab-c');
            assert.strictEqual(await encodeStream(['ab\n ', '-c'], options), 'ab\n -c');
        }
    });

    it('Encoder output never starts a line with a hyphen', async () => {
        // a body that decodes to a boundary delimiter followed by the headers of a part
        const input = 'text\r\n--boundary\r\nContent-Type: application/x-evil; name=evil.exe\r\n\r\n' + '-'.repeat(200) + '\r\n';
        for (const options of [{}, { lineLength: false as const }, { binary: true }]) {
            const encoded = await encodeStream(split(Buffer.from(input), 7), options);
            assert.ok(!/(^|\n)-/.test(encoded), `line starts with a hyphen: ${JSON.stringify(encoded)}`);
            assert.strictEqual(decode(encoded).toString(), input);
        }
    });
});

describe('Encoder', () => {
    it('encodes a stream', async () => {
        assert.strictEqual(await encodeStream([Buffer.from('tere jõgeva')]), 'tere j=C3=B5geva');
    });

    it('encodes string chunks in their encoding', async () => {
        assert.strictEqual(await encodeStream(['tere jõgeva']), 'tere j=C3=B5geva');
        const encoder = new Encoder();
        const output = buffer(encoder);
        encoder.end('dGVyZQ==', 'base64');
        assert.strictEqual((await output).toString(), 'tere');
    });

    it('encodes string chunks of a stream that does not decode strings', async () => {
        assert.strictEqual(await encodeStream(['tere jõgeva'], { decodeStrings: false }), 'tere j=C3=B5geva');
    });

    it('produces no output for empty input', async () => {
        assert.strictEqual(await encodeStream([]), '');
        assert.strictEqual(await encodeStream([Buffer.alloc(0)]), '');
    });

    it('wraps lines at 76 chars by default', async () => {
        const input = Buffer.from('õ'.repeat(200));
        const encoded = await encodeStream(split(input, 13));
        assert.strictEqual(encoded, wrap(encode(input)));
        for (const line of encoded.split('\r\n')) {
            assert.ok(line.length <= 76);
        }
    });

    it('wraps lines at a custom length', async () => {
        const input = Buffer.from('a'.repeat(100));
        const encoded = await encodeStream([input], { lineLength: 10 });
        assert.strictEqual(encoded, wrap(encode(input), 10));
    });

    it('does not wrap with lineLength false', async () => {
        const input = Buffer.from('a'.repeat(200));
        assert.strictEqual(await encodeStream([input], { lineLength: false }), 'a'.repeat(200));
    });

    it('keeps the stream options', () => {
        const encoder = new Encoder({ highWaterMark: 5, lineLength: 20 });
        assert.strictEqual(encoder.writableHighWaterMark, 5);
        assert.strictEqual(encoder.options.lineLength, 20);
        assert.strictEqual(new Encoder().options.lineLength, 76);
        assert.strictEqual(new Encoder({ lineLength: false }).options.lineLength, false);
    });

    it('counts input and output bytes', async () => {
        const encoder = new Encoder();
        const output = await collect(encoder, [Buffer.from('jõgeva '), Buffer.from('x')]);
        assert.strictEqual(encoder.inputBytes, 9);
        assert.strictEqual(encoder.outputBytes, output.length);
        assert.strictEqual(output.toString(), 'j=C3=B5geva x');
    });

    it('produces the same output however the input is split', async () => {
        // whitespace at the end of a chunk is held back until it is known whether a line break follows
        const input = Buffer.from('a \r\nb\t \nc  d \t' + ' '.repeat(10) + '\r\n-e õ\r\n \n ');
        for (const options of [{ lineLength: false as const }, { lineLength: false as const, binary: true }]) {
            const expected = await encodeStream([input], options);
            for (let size = 1; size <= input.length; size++) {
                assert.strictEqual(await encodeStream(split(input, size), options), expected, 'chunk size ' + size);
            }
        }
        assert.strictEqual(await encodeStream(split(input, 1), { lineLength: false }), encode(input));
    });

    it('encodes whitespace at the end of the input', async () => {
        assert.strictEqual(await encodeStream(['a', ' ', '\t']), 'a =09');
        assert.strictEqual(await encodeStream(['  ']), ' =20');
        assert.strictEqual(await encodeStream(['a ', '\r\n']), 'a=20\r\n');
    });

    it('wraps held back whitespace with the line it ends', async () => {
        // found by the differential fuzz run, the last line fits without a soft break
        assert.strictEqual(await encodeStream([Buffer.from('\n-- ')], { lineLength: 7 }), '\n=2D-=20');
    });

    it('wraps a CR at the end of a chunk once it is known whether LF follows', async () => {
        const input = Buffer.from('-\0\r\n-\0\rx');
        const expected = wrap(encode(input), 6);
        assert.strictEqual(expected, '=2D=00\r\n=2D=\r\n=00\rx');
        assert.strictEqual(await encodeStream(split(input, 1), { lineLength: 6 }), expected);
        // and at the end of the input
        assert.strictEqual(await encodeStream(['abcdef', '\r'], { lineLength: 6 }), wrap('abcdef\r', 6));
    });

    it('ignores empty chunks', async () => {
        // an empty chunk after held back whitespace does not end the input
        assert.strictEqual(await encodeStream(['a ', Buffer.alloc(0), '', 'b']), 'a b');
        assert.strictEqual(await encodeStream(['a ', Buffer.alloc(0)]), 'a=20');
    });

    it('encodes a chunk larger than the slice size', async () => {
        const input = Buffer.alloc(200 * 1024, 'aõ -\r\n');
        const encoded = await encodeStream([input]);
        assert.strictEqual(encoded, wrap(encode(input)));
        assert.deepStrictEqual(decode(encoded), input);
        assert.strictEqual(await encodeStream([input], { lineLength: false }), encode(input));
    });

    it('encodes a whitespace run longer than the slice size', async () => {
        const input = Buffer.concat([Buffer.from('a'), Buffer.alloc(100 * 1024, ' '), Buffer.from('\r\nb')]);
        const encoded = await encodeStream([input], { lineLength: false });
        assert.deepStrictEqual(decode(encoded), input);
        assert.ok(encoded.endsWith('=20\r\nb'));
    });

    describe('binary option', () => {
        it('encodes a CR or LF that is not part of a CRLF pair', async () => {
            assert.strictEqual(await encodeStream(['a\rb\nc\r\nd\n\re'], { binary: true }), 'a=0Db=0Ac\r\nd=0A=0De');
        });

        it('encodes a trailing CR', async () => {
            assert.strictEqual(await encodeStream(['a\r'], { binary: true }), 'a=0D');
            assert.strictEqual(await encodeStream(['a\r', '\nb'], { binary: true }), 'a\r\nb');
            assert.strictEqual(await encodeStream(['a\r', 'b'], { binary: true }), 'a=0Db');
        });

        it('keeps CRLF pairs split across chunks', async () => {
            const input = Buffer.from('a\r\nb \r\n\r\r\n\n');
            const expected = 'a\r\nb=20\r\n=0D\r\n=0A';
            for (let size = 1; size <= input.length; size++) {
                assert.strictEqual(await encodeStream(split(input, size), { binary: true, lineLength: false }), expected, 'chunk size ' + size);
            }
        });

        it('round trips arbitrary bytes', async () => {
            // every byte value, next to every other in a varying order
            const input = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919 + Math.floor(i / 256)) % 256));
            const encoded = await encodeStream(split(input, 333), { binary: true });
            assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(encoded), 'lone CR or LF in the output');
            assert.deepStrictEqual(decode(encoded), input);
        });
    });
});

describe('Decoder', () => {
    it('decodes a stream', async () => {
        assert.strictEqual((await decodeStream([Buffer.from(rfcEncoded)])).toString(), rfcDecoded);
    });

    it('decodes string chunks', async () => {
        assert.strictEqual((await decodeStream([rfcEncoded])).toString(), rfcDecoded);
    });

    it('produces no output for empty input', async () => {
        assert.strictEqual((await decodeStream([])).length, 0);
        assert.strictEqual((await decodeStream([Buffer.alloc(0)])).length, 0);
    });

    it('decodes the same however the input is split', async () => {
        const input = Buffer.from(rfcEncoded + '\r\nab=C3=A9=\r\ncd  \r\n=\nx');
        const expected = decode(input);
        for (let size = 1; size <= input.length; size++) {
            assert.deepStrictEqual(await decodeStream(split(input, size)), expected, 'chunk size ' + size);
        }
    });

    it('decodes the input as it arrives', () => {
        const line = 'a='.repeat(24) + '=3D=\r\n';
        const decoder = new Decoder();
        for (let i = 0; i < 1000; i++) {
            decoder.write(line);
            assert.deepStrictEqual(decoder.read(), decode(line), 'line ' + i);
        }
        decoder.end();
    });

    it('holds back no more than an unfinished escape for lines that end in soft line breaks', () => {
        // shapes a decoder that cuts its input only at line feeds has to hold whole
        for (const line of ['a=\r\n', 'abc==\r\n', 'abc=A=\r\n', 'a=\n']) {
            const decoder = new Decoder();
            let written = '';
            let read = 0;
            for (let i = 0; i < 1000; i++) {
                decoder.write(line);
                written += line;
                let chunk: Buffer | null;
                while ((chunk = decoder.read()) !== null) {
                    read += chunk.length;
                }
                // at most "=" and a hex digit of an escape the next line may complete are missing
                assert.ok(decode(written).length - read <= 2, JSON.stringify(line) + ' line ' + i);
            }
            decoder.end();
        }
    });

    it('decodes lines while their end is split from the rest', () => {
        const decoder = new Decoder();
        for (const chunk of ['ab=C3=A9', ' \t', '\r', '\n', 'cd=', '\r', '\n', 'ef', '\n']) {
            decoder.write(chunk);
        }
        assert.strictEqual(decoder.read().toString(), 'ab\u00e9\r\ncdef\n');
        decoder.end();
    });

    it('holds back a line that the next line may still change', () => {
        const decoder = new Decoder();
        decoder.write('==\n');
        decoder.write('A=\n');
        assert.strictEqual(decoder.read(), null);
        decoder.write('B\n');
        assert.deepStrictEqual(decoder.read(), Buffer.from([0xab, 0x0a]));
        decoder.end();
    });

    it('decodes escapes and soft line breaks the same however the input is split', async () => {
        const inputs = [
            '==\nA=\nB',
            '==\r\nA=\r\nB',
            'x=A=\nB',
            'x=a=\r\nb',
            '=4=\n1',
            '=\n=\n=\nAB',
            '\n=\nA',
            '=\nAB',
            'a= \t\r \nB',
            'a==  \r\nAB',
            'ab=\r\r\nCD',
            'ab=\rC\nD',
            '=3D=\nx',
            '= =\nAB',
            'ab  =\n\nx  ',
            '  \n=\n=41',
            '=C3=\n=A9 \n',
            'ab=\r',
            'ab=4=\r',
            'ab \t'
        ];
        for (const text of inputs) {
            for (const prefix of ['', 'line\r\n', 'line=\r\n']) {
                const input = Buffer.from(prefix + text, 'latin1');
                const expected = decode(input);
                for (let size = 1; size <= input.length; size++) {
                    assert.deepStrictEqual(await decodeStream(split(input, size)), expected, JSON.stringify(prefix + text) + ' chunk size ' + size);
                }
                for (let at = 1; at < input.length; at++) {
                    assert.deepStrictEqual(
                        await decodeStream([input.subarray(0, at), input.subarray(at)]),
                        expected,
                        JSON.stringify(prefix + text) + ' split at ' + at
                    );
                }
            }
        }
    });

    it('decodes long input the same as decode() for random chunk sizes', async () => {
        const fragments = ['=', '==', '=A', '=3D', '=c3', '=\r\n', '=\n', ' ', '\t', '\r', '\n', ' \r\n', 'a', 'B', '\xe9'];
        // a fixed seed keeps the test reproducible
        let seed = 1;
        const random = (max: number): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % max;
        };
        for (let run = 0; run < 50; run++) {
            const input = Buffer.from(Array.from({ length: 2000 }, () => fragments[random(fragments.length)]).join(''), 'latin1');
            const chunks: Buffer[] = [];
            for (let pos = 0; pos < input.length;) {
                const size = 1 + random(run % 2 ? 8 : 512);
                chunks.push(input.subarray(pos, pos + size));
                pos += size;
            }
            assert.deepStrictEqual(await decodeStream(chunks), decode(input), 'run ' + run);
        }
    });

    it('keeps the stream options', () => {
        assert.strictEqual(new Decoder({ highWaterMark: 7 }).writableHighWaterMark, 7);
    });

    it('counts input and output bytes', async () => {
        const decoder = new Decoder();
        const output = await collect(decoder, [Buffer.from('j=C3=B5'), Buffer.from('geva')]);
        assert.strictEqual(decoder.inputBytes, 11);
        assert.strictEqual(decoder.outputBytes, output.length);
        assert.strictEqual(output.toString(), 'jõgeva');
    });
});

describe('Round trips', () => {
    it('round trips text through the streams', async () => {
        const input = Buffer.from('Tere jõgeva! ' + '€'.repeat(100) + '\r\n--boundary\r\n' + 'a '.repeat(100) + '\r\n');
        const encoded = await encodeStream(split(input, 17));
        assert.deepStrictEqual(await decodeStream(split(Buffer.from(encoded), 5)), input);
    });
});
