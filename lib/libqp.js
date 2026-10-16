/* eslint no-useless-escape: 0 */

'use strict';

const { Buffer } = require('node:buffer');
const stream = require('node:stream');
const Transform = stream.Transform;

/**
 * Encodes a Buffer into a Quoted-Printable encoded string
 *
 * @param {Buffer} buffer Buffer to convert
 * @returns {String} Quoted-Printable encoded string
 */
function encode(buffer) {
    if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer, 'utf-8');
    }

    return encodeBytes(buffer, true);
}

/**
 * Encodes the bytes of a Buffer. The Encoder stream feeds it one chunk at a time, so it has
 * to be told whether the first byte starts an output line, which a plain encode() call always does
 *
 * @param {Buffer} buffer Buffer to convert
 * @param {Boolean} lineStart True if the first byte starts a line
 * @returns {String} Quoted-Printable encoded string
 */
function encodeBytes(buffer, lineStart) {
    // usable characters that do not need encoding
    let ranges = [
        // https://tools.ietf.org/html/rfc2045#section-6.7
        [0x09], // <TAB>
        [0x0a], // <LF>
        [0x0d], // <CR>
        [0x20, 0x3c], // <SP>!"#$%&'()*+,-./0123456789:;
        [0x3e, 0x7e] // >?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}
    ];
    let result = '';
    let ord;

    for (let i = 0, len = buffer.length; i < len; i++) {
        ord = buffer[i];
        // if the char is in allowed range, then keep as is, unless it is a ws in the end of a line
        // or a hyphen in the start of a line. A line starting with two hyphens reads as a MIME
        // boundary delimiter, so a decoded body that gets encoded again could inject a part
        if (
            checkRanges(ord, ranges) &&
            !((ord === 0x20 || ord === 0x09) && (i === len - 1 || buffer[i + 1] === 0x0a || buffer[i + 1] === 0x0d)) &&
            !(ord === 0x2d && (i === 0 ? lineStart : buffer[i - 1] === 0x0a))
        ) {
            result += String.fromCharCode(ord);
            continue;
        }
        result += '=' + (ord < 0x10 ? '0' : '') + ord.toString(16).toUpperCase();
    }

    return result;
}

/**
 * Decodes a Quoted-Printable encoded string to a Buffer object
 *
 * @param {String|Buffer} str Quoted-Printable encoded string. A Buffer is read byte for byte,
 *        so raw 8-bit bytes in the input are copied to the output unchanged
 * @returns {Buffer} Decoded value
 */
function decode(str) {
    // 'binary' maps every byte to one char code 0-255. A UTF-8 read would collapse raw
    // multi-byte chars into one byte below and turn raw latin1 bytes into U+FFFD
    str = (Buffer.isBuffer(str) ? str.toString('binary') : (str || '').toString())
        // remove invalid whitespace from the end of lines. The leading group keeps this linear,
        // a plain /[\t ]+$/gm rescans the rest of a whitespace run from every position inside it,
        // which is quadratic. The lookahead lists the line terminators multiline $ matches before
        .replace(/(^|[^ \t])[ \t]+(?=[\n\r\u2028\u2029]|$)/g, '$1')
        // remove soft line breaks
        .replace(/\=(?:\r?\n|$)/g, '');

    // every =XX escape decodes into one byte, so count them to size the output.
    // Counted with a loop, a match() would build an array with a string for every escape
    let len = str.length;
    let encodedBytesCount = 0;
    for (let i = str.indexOf('='); i >= 0 && i < len - 2; i = str.indexOf('=', i + 1)) {
        if (hexValue(str.charCodeAt(i + 1)) >= 0 && hexValue(str.charCodeAt(i + 2)) >= 0) {
            encodedBytesCount++;
            i += 2;
        }
    }

    let buffer = Buffer.alloc(len - encodedBytesCount * 2);
    let bufferPos = 0;

    for (let i = 0; i < len; i++) {
        let code = str.charCodeAt(i);
        if (code === 0x3d /* = */ && i < len - 2) {
            let hi = hexValue(str.charCodeAt(i + 1));
            let lo = hexValue(str.charCodeAt(i + 2));
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
 * @param {Number} code Char code
 * @returns {Number} 0-15, or -1 if the char is not a hex digit
 */
function hexValue(code) {
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
 * @param {String} str Quoted-Printable encoded string that might need line wrapping
 * @param {Number} [lineLength=76] Maximum allowed length for a line
 * @returns {String} Soft-wrapped Quoted-Printable encoded string
 */
function wrap(str, lineLength) {
    str = (str || '').toString();
    lineLength = lineLength || 76;

    if (str.length <= lineLength) {
        return str;
    }

    let pos = 0,
        len = str.length,
        match,
        code,
        line,
        maxLength,
        afterSoftBreak = false,
        lineMargin = Math.floor(lineLength / 3),
        result = '';

    // insert soft linebreaks where needed
    while (pos < len) {
        maxLength = lineLength;

        if (afterSoftBreak) {
            afterSoftBreak = false;
            // a line started by a soft break must not begin with a hyphen either, see encode().
            // The escape takes the room of three characters off this line
            if (str.charAt(pos) === '-') {
                result += '=2D';
                pos++;
                maxLength -= 3;
            }
        }

        line = str.substr(pos, maxLength);
        if ((match = line.match(/\r\n/))) {
            line = line.substr(0, match.index + match[0].length);
            result += line;
            pos += line.length;
            continue;
        }

        if (line.substr(-1) === '\n') {
            // nothing to change here
            result += line;
            pos += line.length;
            continue;
        } else if ((match = line.substr(-lineMargin).match(/\n.*?$/))) {
            // truncate to nearest line break
            line = line.substr(0, line.length - (match[0].length - 1));
            result += line;
            pos += line.length;
            continue;
        } else if (line.length > maxLength - lineMargin && (match = line.substr(-lineMargin).match(/[ \t\.,!\?][^ \t\.,!\?]*$/))) {
            // truncate to nearest space
            line = line.substr(0, line.length - (match[0].length - 1));
        } else if (line.match(/\=[\da-f]{0,2}$/i)) {
            // push incomplete encoding sequences to the next line
            if ((match = line.match(/\=[\da-f]{0,1}$/i))) {
                line = line.substr(0, line.length - match[0].length);
            }

            // ensure that utf-8 sequences are not split
            while (line.length > 3 && line.length < len - pos && !line.match(/^(?:=[\da-f]{2}){1,4}$/i) && (match = line.match(/\=[\da-f]{2}$/gi))) {
                code = parseInt(match[0].substr(1, 2), 16);
                if (code < 128) {
                    break;
                }

                line = line.substr(0, line.length - 3);

                if (code >= 0xc0) {
                    break;
                }
            }
        }

        if (pos + line.length < len && line.substr(-1) !== '\n') {
            if (line.length === maxLength && line.match(/\=[\da-f]{2}$/i)) {
                line = line.substr(0, line.length - 3);
            } else if (line.length === maxLength) {
                line = line.substr(0, line.length - 1);
            }
            pos += line.length;
            line += '=\r\n';
            afterSoftBreak = true;
        } else {
            pos += line.length;
        }

        result += line;
    }

    return result;
}

/**
 * Helper function to check if a number is inside provided ranges
 *
 * @param {Number} nr Number to check for
 * @param {Array} ranges An Array of allowed values
 * @returns {Boolean} True if the value was found inside allowed ranges, false otherwise
 */
function checkRanges(nr, ranges) {
    for (let i = ranges.length - 1; i >= 0; i--) {
        if (!ranges[i].length) {
            continue;
        }
        if (ranges[i].length === 1 && nr === ranges[i][0]) {
            return true;
        }
        if (ranges[i].length === 2 && nr >= ranges[i][0] && nr <= ranges[i][1]) {
            return true;
        }
    }
    return false;
}

/**
 * Creates a transform stream for encoding data to Quoted-Printable encoding
 *
 * @constructor
 * @param {Object} options Stream options
 * @param {Number} [options.lineLength=76] Maximum lenght for lines, set to false to disable wrapping
 */
class Encoder extends Transform {
    constructor(options) {
        super();

        // init Transform
        this.options = options || {};

        if (this.options.lineLength !== false) {
            this.options.lineLength = this.options.lineLength || 76;
        }

        this._curLine = '';
        // true until a chunk that does not end with a line break has been encoded
        this._lineStart = true;

        this.inputBytes = 0;
        this.outputBytes = 0;

        Transform.call(this, this.options);
    }

    _transform(chunk, encoding, done) {
        let qp;

        if (encoding !== 'buffer') {
            chunk = Buffer.from(chunk, encoding);
        }

        if (!chunk || !chunk.length) {
            return done();
        }

        this.inputBytes += chunk.length;

        let lineStart = this._lineStart;
        this._lineStart = chunk[chunk.length - 1] === 0x0a;

        if (this.options.lineLength) {
            qp = this._curLine + encodeBytes(chunk, lineStart);
            qp = wrap(qp, this.options.lineLength);
            qp = qp.replace(/(^|\n)([^\n]*)$/, (match, lineBreak, lastLine) => {
                this._curLine = lastLine;
                return lineBreak;
            });

            if (qp) {
                this.outputBytes += qp.length;
                this.push(qp);
            }
        } else {
            qp = encodeBytes(chunk, lineStart);
            this.outputBytes += qp.length;
            this.push(qp, 'ascii');
        }

        done();
    }

    _flush(done) {
        if (this._curLine) {
            this.outputBytes += this._curLine.length;
            this.push(this._curLine, 'ascii');
        }
        done();
    }
}

/**
 * Creates a transform stream for decoding Quoted-Printable encoded strings
 * The input is not actually processed as a stream but concatted and processed as a single input
 *
 * @constructor
 * @param {Object} options Stream options
 */
class Decoder extends Transform {
    constructor(options) {
        options = options || {};
        super(options);

        // init Transform
        this.options = options;
        this._curLine = '';

        this.inputBytes = 0;
        this.outputBytes = 0;

        this.qpChunks = [];
    }

    _transform(chunk, encoding, done) {
        if (!chunk || !chunk.length) {
            return done();
        }

        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        // kept as a binary string, so joining the chunks is the only copy made before decoding
        this.qpChunks.push(chunk.toString('binary'));
        this.inputBytes += chunk.length;

        done();
    }

    _flush(done) {
        if (this.inputBytes) {
            let buf = decode(this.qpChunks.join(''));
            this.outputBytes += buf.length;
            this.push(buf);
        }

        done();
    }
}

// expose to the world
module.exports = {
    encode,
    decode,
    wrap,
    Encoder,
    Decoder
};
