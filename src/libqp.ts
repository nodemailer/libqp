import { Transform, type TransformCallback, type TransformOptions } from 'node:stream';

// the shortest line wrap() can make progress with: a complete =XX sequence and the soft break
const MIN_LINE_LENGTH = 4;

// 1 for every byte value that is written as is: <TAB>, <LF>, <CR> and the printable ASCII
// range except "=", https://tools.ietf.org/html/rfc2045#section-6.7
const QP_LITERAL = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    QP_LITERAL[i] = i === 0x09 || i === 0x0a || i === 0x0d || (i >= 0x20 && i <= 0x7e && i !== 0x3d) ? 1 : 0;
}

const HEX_DIGITS = Buffer.from('0123456789ABCDEF', 'latin1');

const isWhitespace = (c: number | undefined): boolean => c === 0x20 || c === 0x09;

/**
 * Encodes a Buffer into a Quoted-Printable encoded string
 *
 * @param buffer Buffer to convert, a string is encoded as UTF-8
 * @returns Quoted-Printable encoded string
 */
export function encode(buffer: Buffer | Uint8Array | string): string {
    return encodeBytes(typeof buffer === 'string' ? Buffer.from(buffer, 'utf-8') : buffer);
}

/**
 * Encodes bytes that may be followed by more input
 *
 * @param buffer Bytes to encode
 * @param [next] The byte that follows the buffer, whitespace before it is kept literal unless it
 *        is a line break. Without it the buffer ends the input and its trailing whitespace is encoded
 * @param [binary] Keep only CRLF pairs literal. A lone CR or LF is data, not a line break, and
 *        anything that rewrites line endings on the way would change it
 * @param [previous] The byte before the buffer. Without it the buffer starts a line
 * @returns Quoted-Printable encoded string
 */
function encodeBytes(buffer: Uint8Array, next?: number, binary?: boolean, previous?: number): string {
    const len = buffer.length;
    // every byte takes three characters at most
    const output = Buffer.allocUnsafe(len * 3);
    let pos = 0;

    for (let i = 0; i < len; i++) {
        const ord = buffer[i];
        const preceding = i > 0 ? buffer[i - 1] : previous;
        const following = i + 1 < len ? buffer[i + 1] : next;
        // in binary data only a CR followed by LF, or an LF that follows CR, is a line break
        const loneLineBreak = binary && (ord === 0x0d ? following !== 0x0a : ord === 0x0a && preceding !== 0x0d);
        // if the char is in allowed range, then keep as is, unless it is a ws in the end of a line
        // or a hyphen in the start of a line. A line starting with two hyphens reads as a MIME
        // boundary delimiter, so a decoded body that gets encoded again could inject a part. A lone
        // CR counts as a line break here, a relay may turn it into CRLF
        if (
            QP_LITERAL[ord] &&
            !loneLineBreak &&
            !(isWhitespace(ord) && (following === undefined || following === 0x0a || following === 0x0d)) &&
            !(ord === 0x2d && (preceding === undefined || preceding === 0x0a || preceding === 0x0d))
        ) {
            output[pos++] = ord;
            continue;
        }
        output[pos++] = 0x3d; // =
        output[pos++] = HEX_DIGITS[Math.floor(ord / 16)];
        output[pos++] = HEX_DIGITS[ord % 16];
    }

    return output.toString('latin1', 0, pos);
}

/**
 * Decodes a Quoted-Printable encoded string to a Buffer object
 *
 * @param str Quoted-Printable encoded string. A Buffer is read byte for byte, so raw 8-bit bytes
 *        in the input are copied to the output unchanged. A char of a string is copied as the low
 *        byte of its char code, so a string should only hold chars below 256 ('binary')
 * @returns Decoded value
 */
export function decode(str: string | Buffer | Uint8Array): Buffer {
    // 'binary' maps every byte to one char code 0-255. A UTF-8 read would collapse raw
    // multi-byte chars into one byte below and turn raw latin1 bytes into U+FFFD
    let input: string;
    if (str instanceof Uint8Array) {
        input = (Buffer.isBuffer(str) ? str : Buffer.from(str.buffer, str.byteOffset, str.byteLength)).toString('binary');
    } else {
        input = (str || '').toString();
    }

    input = input
        // remove invalid whitespace from the end of lines. The leading group keeps this linear,
        // a plain /[\t ]+$/gm rescans the rest of a whitespace run from every position inside it,
        // which is quadratic. The lookahead lists the line terminators multiline $ matches before
        .replace(/(^|[^ \t])[ \t]+(?=[\n\r\u2028\u2029]|$)/g, '$1')
        // remove soft line breaks
        .replace(/[=](?:\r?\n|$)/g, '');

    // every =XX escape decodes into one byte, so count them to size the output.
    // Counted with a loop, a match() would build an array with a string for every escape
    const len = input.length;
    let encodedBytesCount = 0;
    for (let i = input.indexOf('='); i >= 0 && i < len - 2; i = input.indexOf('=', i + 1)) {
        if (hexValue(input.charCodeAt(i + 1)) >= 0 && hexValue(input.charCodeAt(i + 2)) >= 0) {
            encodedBytesCount++;
            i += 2;
        }
    }

    const buffer = Buffer.alloc(len - encodedBytesCount * 2);
    let bufferPos = 0;

    for (let i = 0; i < len; i++) {
        const code = input.charCodeAt(i);
        if (code === 0x3d /* = */ && i < len - 2) {
            const hi = hexValue(input.charCodeAt(i + 1));
            const lo = hexValue(input.charCodeAt(i + 2));
            if (hi >= 0 && lo >= 0) {
                buffer[bufferPos++] = hi * 16 + lo;
                i += 2;
                continue;
            }
        }
        buffer[bufferPos++] = code;
    }

    return buffer;
}

/**
 * Helper function to read the value of a hex digit
 *
 * @param code Char code
 * @returns 0-15, or -1 if the char is not a hex digit
 */
function hexValue(code: number): number {
    if (code >= 0x30 && code <= 0x39) {
        return code - 0x30; // 0-9
    }
    if (code >= 0x41 && code <= 0x46) {
        return code - 0x41 + 10; // A-F
    }
    if (code >= 0x61 && code <= 0x66) {
        return code - 0x61 + 10; // a-f
    }
    return -1;
}

/**
 * Adds soft line breaks to a Quoted-Printable string
 *
 * @param str Quoted-Printable encoded string that might need line wrapping
 * @param [lineLength=76] Maximum allowed length for a line, at least 4
 * @returns Soft-wrapped Quoted-Printable encoded string
 */
export function wrap(str: string, lineLength?: number): string {
    str = (str || '').toString();
    // a line has to hold a complete =XX sequence plus the soft break, shorter lengths
    // (or a negative one) would loop without consuming input
    lineLength = Math.max(Number(lineLength) || 76, MIN_LINE_LENGTH);

    if (str.length <= lineLength) {
        return str;
    }

    // every line is wrapped on its own, a line break does not count towards the line length
    const parts = str.split(/(\r?\n)/);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = wrapLine(parts[i] as string, lineLength);
    }
    return parts.join('');
}

/**
 * Adds soft line breaks to one line of a Quoted-Printable string
 *
 * @param str Quoted-Printable encoded line, without line breaks
 * @param lineLength Maximum allowed length for a line, at least MIN_LINE_LENGTH
 * @returns Soft-wrapped line
 */
function wrapLine(str: string, lineLength: number): string {
    const len = str.length;
    const lineMargin = Math.floor(lineLength / 3);
    let pos = 0;
    let result = '';

    // every pass either ends with the rest of the line or consumes input
    for (;;) {
        // a line started by a soft break must not begin with a hyphen either, see encodeBytes().
        // The escape takes the place of the hyphen, as if the input held it
        const escapeHyphen = pos > 0 && str.charCodeAt(pos) === 0x2d;
        if (len - pos + (escapeHyphen ? 2 : 0) <= lineLength) {
            // the rest fits on a line
            result += escapeHyphen ? '=2D' + str.substr(pos + 1) : str.substr(pos);
            break;
        }
        let line = escapeHyphen ? '=2D' + str.substr(pos + 1, lineLength - 3) : str.substr(pos, lineLength);
        let match: RegExpMatchArray | null;

        if ((match = line.substr(-lineMargin).match(/[ \t.,!?][^ \t.,!?]*$/))) {
            // truncate to nearest space
            line = line.substr(0, line.length - (match[0].length - 1));
        } else if (/[=][\da-f]{0,2}$/i.test(line)) {
            // push an incomplete encoding sequence to the next line and ensure that utf-8
            // sequences are not split
            line = trimUtf8Sequence(line.replace(/[=][\da-f]?$/i, ''));
        }

        // make room for the soft break, without splitting an encoding sequence
        if (line.length === lineLength) {
            line = line.substr(0, line.length - (/[=][\da-f]{2}$/i.test(line) ? 3 : 1));
        }

        // the escape stands for one char of the input
        pos += escapeHyphen ? line.length - 2 : line.length;
        result += line + '=\r\n';
    }

    return result;
}

/**
 * Cuts the escapes of a trailing UTF-8 sequence off a line, so that a soft line break does not
 * split the sequence. A line that holds nothing but the sequence, after the escape of a hyphen
 * that starts the line, is kept whole
 *
 * @param line Quoted-Printable encoded line that ends with an escape
 * @returns The line without the escapes of its last multi-byte sequence
 */
function trimUtf8Sequence(line: string): string {
    let end = line.length;
    while (end >= 3 && line.charCodeAt(end - 3) === 0x3d /* = */) {
        const hi = hexValue(line.charCodeAt(end - 2));
        const lo = hexValue(line.charCodeAt(end - 1));
        if (hi < 0 || lo < 0) {
            break;
        }
        const code = hi * 16 + lo;
        if (code < 0x80) {
            break;
        }
        end -= 3;
        if (code >= 0xc0) {
            // the lead byte of the sequence
            break;
        }
    }
    return end > (line.startsWith('=2D') ? 3 : 0) ? line.substr(0, end) : line;
}

/**
 * Options for the Quoted-Printable encoder stream, on top of the Transform stream options
 */
export interface EncoderOptions extends TransformOptions {
    /** Maximum length for lines (76 by default), set to false to disable wrapping */
    lineLength?: number | false | undefined;
    /** The input is binary data: a CR or LF that is not part of a CRLF pair is encoded */
    binary?: boolean | undefined;
}

/**
 * Options for the Quoted-Printable decoder stream, the Transform stream options
 */
export type DecoderOptions = TransformOptions;

// Converts a chunk of a stream to bytes. A stream only hands over a string when its decodeStrings
// option is off, and then the encoding is the one the chunk was written with
const toBuffer = (chunk: Buffer | string, encoding: BufferEncoding | 'buffer'): Buffer =>
    typeof chunk === 'string' ? Buffer.from(chunk, encoding as BufferEncoding) : chunk;

// Input is encoded and wrapped this many bytes at a time. wrap() works on strings, and a large
// chunk handed over at once, such as a whole Buffer attachment, would be held several times over
// as intermediate strings
const ENCODE_SLICE_SIZE = 64 * 1024;

/**
 * Creates a transform stream for encoding data to Quoted-Printable encoding
 */
export class Encoder extends Transform {
    options: EncoderOptions;
    inputBytes: number;
    outputBytes: number;
    /** The last line of the output so far, kept until it is known whether it needs a soft break @internal */
    _curLine: string;
    /** The last byte of the input so far when it is not encoded yet, see _transform @internal */
    _heldByte: number | undefined;
    /** The last byte encoded so far, undefined while nothing is @internal */
    _lastByte: number | undefined;

    /**
     * @param [options] Stream options
     * @param [options.lineLength=76] Maximum length for lines, set to false to disable wrapping
     * @param [options.binary=false] Encode every CR or LF that is not part of a CRLF pair
     */
    constructor(options?: EncoderOptions) {
        const opts = options || {};
        super(opts);

        this.options = opts;

        if (this.options.lineLength !== false) {
            this.options.lineLength = this.options.lineLength || 76;
        }

        this._curLine = '';
        this._heldByte = undefined;
        this._lastByte = undefined;

        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    /** @internal */
    override _transform(chunk: Buffer | string, encoding: BufferEncoding | 'buffer', done: TransformCallback): void {
        let buf = toBuffer(chunk, encoding);

        if (!buf || !buf.length) {
            return done();
        }

        this.inputBytes += buf.length;

        if (this._heldByte !== undefined) {
            this._encodeSlices(Buffer.of(this._heldByte), buf[0]);
            this._heldByte = undefined;
        }

        // Whitespace is encoded when it ends a line, and the end of the input counts as one, and a
        // binary CR is a line break only when LF follows. Hold back such a last byte until it is
        // known what follows it, so the output does not depend on where the input was split. Every
        // other byte depends only on its neighbours, which _encodeSlices passes on
        const last = buf[buf.length - 1];
        if (isWhitespace(last) || (this.options.binary && last === 0x0d)) {
            this._heldByte = last;
            buf = buf.subarray(0, buf.length - 1);
        }

        // the bytes before a held back one only need to know it follows them
        this._encodeSlices(buf, this._heldByte);
        done();
    }

    /** @internal */
    override _flush(done: TransformCallback): void {
        if (this._heldByte !== undefined) {
            this._encodeSlices(Buffer.of(this._heldByte), undefined);
            this._heldByte = undefined;
        }
        if (this._curLine) {
            // it can end with a CR that was not wrapped yet
            const qp = wrap(this._curLine, this.options.lineLength as number);
            this.outputBytes += qp.length;
            this.push(qp, 'ascii');
            this._curLine = '';
        }
        done();
    }

    /**
     * Encodes the input in slices of ENCODE_SLICE_SIZE bytes. Each slice is told the bytes around
     * it, so a slice is encoded as if the input was not split
     *
     * @param buf Bytes to encode
     * @param next The byte that follows buf, undefined when it is not known
     * @internal
     */
    _encodeSlices(buf: Buffer, next: number | undefined): void {
        for (let start = 0; start < buf.length; start += ENCODE_SLICE_SIZE) {
            const end = Math.min(start + ENCODE_SLICE_SIZE, buf.length);
            let qp = encodeBytes(buf.subarray(start, end), end < buf.length ? buf[end] : next, this.options.binary, this._lastByte);
            this._lastByte = buf[end - 1];

            if (this.options.lineLength) {
                qp = this._curLine + qp;
                // a CR at the end is a line break if LF follows, so it is wrapped once that is known
                const cr = qp.endsWith('\r') ? '\r' : '';
                qp = wrap(cr ? qp.slice(0, -1) : qp, this.options.lineLength);
                // the last line is kept until it is known whether it needs a soft break
                const lastLF = qp.lastIndexOf('\n');
                this._curLine = qp.substring(lastLF + 1) + cr;
                qp = qp.substring(0, lastLF + 1);
            }

            if (qp) {
                this.outputBytes += qp.length;
                this.push(qp, 'ascii');
            }
        }
    }
}

/**
 * Creates a transform stream for decoding Quoted-Printable encoded strings.
 *
 * Decodes byte by byte as the input arrives, in the three steps of decode(), each run as a small
 * state machine: whitespace in front of a line break is removed, then soft line breaks, then
 * escapes are decoded. Across chunks it carries only what the next bytes can still change: a run
 * of whitespace that may turn out to end a line, a "=" (or "=" and a CR) that may start a soft
 * line break, and a "=" (or "=" and a hex digit) that may start an escape. Escapes and soft line
 * breaks split across chunks or lines decode the same as unsplit input ("==\nA=\nB" is the single
 * byte 0xAB), and the output equals decode() of the whole input however the input is split.
 */
export class Decoder extends Transform {
    options: DecoderOptions;
    inputBytes: number;
    outputBytes: number;
    /**
     * Whitespace that ends the input so far, as [byte, count] runs: dropped when a line break or the
     * end of the input follows, passed on otherwise
     * @internal
     */
    _blanks: number[];
    /** @internal */
    _blankCount: number;
    /** Soft line break step: 0, or 1 after a "=", or 2 after "=" and a CR @internal */
    _soft: number;
    /** Escape step: 0, or 1 after a "=", or 2 after "=" and a hex digit @internal */
    _escape: number;
    /** The hex digit after "=" in escape step 2 @internal */
    _escapeHigh: number;
    /** @internal */
    _out: Buffer;
    /** @internal */
    _outPos: number;
    /** Input bytes of the current chunk not processed yet, the current one included @internal */
    _left: number;

    /**
     * @param [options] Stream options
     */
    constructor(options?: DecoderOptions) {
        const opts = options || {};
        super(opts);

        this.options = opts;

        this.inputBytes = 0;
        this.outputBytes = 0;

        this._blanks = [];
        this._blankCount = 0;
        this._soft = 0;
        this._escape = 0;
        this._escapeHigh = 0;
        this._out = Buffer.alloc(0);
        this._outPos = 0;
        this._left = 0;
    }

    /** @internal */
    override _transform(chunk: Buffer | string, encoding: BufferEncoding | 'buffer', done: TransformCallback): void {
        if (!chunk || !chunk.length) {
            return done();
        }

        const buf = toBuffer(chunk, encoding);
        this.inputBytes += buf.length;

        // all output comes from input bytes: those of this chunk and those held back before it, at
        // most four bytes of a soft line break and an escape, and whitespace (room made when it is kept)
        this._begin(buf.length + 4);
        for (let i = 0; i < buf.length; i++) {
            this._left = buf.length - i;
            this._trim(buf[i] as number);
        }
        this._left = 0;
        this._end();

        done();
    }

    /** @internal */
    override _flush(done: TransformCallback): void {
        this._begin(4);
        // whitespace at the end of the input is removed
        this._blanks = [];
        this._blankCount = 0;
        if (this._soft === 2) {
            // "=" and a CR at the end are no soft line break
            this._unescape(0x3d);
            this._unescape(0x0d);
        }
        // a "=" at the end is a soft line break and is removed
        this._soft = 0;
        if (this._escape >= 1) {
            this._emit(0x3d);
        }
        if (this._escape === 2) {
            this._emit(this._escapeHigh);
        }
        this._escape = 0;
        this._end();

        done();
    }

    /** Step 1, whitespace in front of a line break @internal */
    _trim(byte: number): void {
        if (byte === 0x20 || byte === 0x09) {
            const runs = this._blanks;
            if (runs.length && runs[runs.length - 2] === byte) {
                runs[runs.length - 1]++;
            } else {
                runs.push(byte, 1);
            }
            this._blankCount++;
            return;
        }
        if (this._blankCount) {
            if (byte !== 0x0a && byte !== 0x0d) {
                // not at the end of a line: the whitespace is kept
                this._reserve(this._blankCount);
                const runs = this._blanks;
                for (let r = 0; r < runs.length; r += 2) {
                    for (let n = runs[r + 1] as number; n > 0; n--) {
                        this._soften(runs[r] as number);
                    }
                }
            }
            this._blanks = [];
            this._blankCount = 0;
        }
        this._soften(byte);
    }

    /** Step 2, soft line breaks: "=" followed by LF or CR LF @internal */
    _soften(byte: number): void {
        if (this._soft === 1) {
            if (byte === 0x0a) {
                this._soft = 0;
                return;
            }
            if (byte === 0x0d) {
                this._soft = 2;
                return;
            }
            this._soft = 0;
            this._unescape(0x3d);
        } else if (this._soft === 2) {
            this._soft = 0;
            if (byte === 0x0a) {
                return;
            }
            this._unescape(0x3d);
            this._unescape(0x0d);
        }
        if (byte === 0x3d) {
            this._soft = 1;
            return;
        }
        this._unescape(byte);
    }

    /** Step 3, escapes: "=" followed by two hex digits @internal */
    _unescape(byte: number): void {
        if (this._escape === 1) {
            if (hexValue(byte) >= 0) {
                this._escape = 2;
                this._escapeHigh = byte;
                return;
            }
            this._escape = 0;
            this._emit(0x3d);
        } else if (this._escape === 2) {
            this._escape = 0;
            const low = hexValue(byte);
            if (low >= 0) {
                this._emit(hexValue(this._escapeHigh) * 16 + low);
                return;
            }
            this._emit(0x3d);
            this._emit(this._escapeHigh);
        }
        if (byte === 0x3d) {
            this._escape = 1;
            return;
        }
        this._emit(byte);
    }

    /** @internal */
    _begin(size: number): void {
        this._out = Buffer.allocUnsafe(size);
        this._outPos = 0;
    }

    /** Makes room for `size` more bytes besides the rest of the current chunk @internal */
    _reserve(size: number): void {
        const needed = this._outPos + size + this._left + 4;
        if (needed > this._out.length) {
            const out = Buffer.allocUnsafe(Math.max(this._out.length * 2, needed));
            this._out.copy(out, 0, 0, this._outPos);
            this._out = out;
        }
    }

    /** @internal */
    _emit(byte: number): void {
        this._out[this._outPos++] = byte;
    }

    /** @internal */
    _end(): void {
        if (this._outPos) {
            this.outputBytes += this._outPos;
            this.push(this._out.subarray(0, this._outPos));
        }
        this._out = Buffer.alloc(0);
        this._outPos = 0;
    }
}

const libqp = {
    encode,
    decode,
    wrap,
    Encoder,
    Decoder
};

export default libqp;
