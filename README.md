# libqp

Encode and decode quoted-printable strings according to [RFC2045](https://tools.ietf.org/html/rfc2045#section-6.7).

## Usage

Install with npm

```
npm install libqp
```

libqp requires Node.js 20 or newer. It is written in TypeScript and ships both an ES module and a CommonJS build, each with type declarations.

```javascript
// ES modules
import libqp from 'libqp';
// or
import { encode, decode, wrap, Encoder, Decoder } from 'libqp';

// CommonJS
const libqp = require('libqp');
```

### Encode values

Encode Buffer objects or unicode strings with

```
libqp.encode(val) → String
```

Where

- **val** is a Buffer, an Uint8Array or an unicode string (encoded as UTF-8)

`encode` escapes whitespace at the end of a line and a hyphen at the start of a line, so the output never contains a line that could be read as a MIME boundary.

**Example**

```javascript
libqp.encode('jõgeva');
// j=C3=B5geva
```

### Decode values

Decode Quoted-Printable encoded strings with

```
libqp.decode(str) → Buffer
```

Where

- **str** is a Quoted-Printable encoded string, Buffer or Uint8Array. A Buffer is read byte for byte, so raw 8-bit bytes in the input are kept as they are. A char of a string is read as the low byte of its char code, so pass a binary string (`buf.toString('binary')`) rather than a unicode one

**Example**

```javascript
libqp.decode('j=C3=B5geva').toString();
// jõgeva
```

### Wrap encoded values

Quoted-Printable encoded lines are limited to 76 characters but `encode` method might return lines longer than the limit.

To enforce soft line breaks on lines longer than 76 (or any other length) characters, use `wrap`

```
libqp.wrap(str[, lineLength]) → String
```

Where

- **str** is a Quoted-Printable encoded string
- **lineLength** (defaults to 76) is the maximum allowed line length. Any longer line will be soft wrapped. Values below 4 are raised to 4, the shortest line that fits an escape sequence and a soft line break. Every line is wrapped on its own and a line break does not count towards the line length

**Example**

```javascript
libqp.wrap('abc j=C3=B5geva', 10);
// abc j=\r\n
// =C3=B5geva
```

### Transform Streams

`libqp` makes it possible to encode and decode streams with `libqp.Encoder` and `libqp.Decoder` constructors.

### Encoder Stream

Create new Encoder Stream with

```
const encoder = new libqp.Encoder([options])
```

Where

- **options** is the optional stream options object with additional options:
    - **lineLength** if you want to use any other line length than the default 76 characters (or set to `false` to turn the soft wrapping off completely)
    - **binary** set to `true` if the input is binary data. A CR or LF that is not part of a CRLF pair is then encoded, so that line ending conversions on the way can not change the data

**Example**

The following example script reads in a file, encodes it to Quoted-Printable and saves the output to a file.

```javascript
import fs from 'node:fs';
import { Encoder } from 'libqp';

const source = fs.createReadStream('source.txt');
const encoded = fs.createWriteStream('encoded.txt');

source.pipe(new Encoder()).pipe(encoded);
```

### Decoder Stream

Create new Decoder Stream with

```
const decoder = new libqp.Decoder([options])
```

Where

- **options** is the optional stream options object

The Decoder collects its input and decodes it once the input ends, so escape sequences and soft line breaks split between chunks are decoded correctly.

**Example**

The following example script reads in a file in Quoted-Printable encoding, decodes it and saves the output to a file.

```javascript
import fs from 'node:fs';
import { Decoder } from 'libqp';

const encoded = fs.createReadStream('encoded.txt');
const dest = fs.createWriteStream('dest.txt');

encoded.pipe(new Decoder()).pipe(dest);
```

## License

**MIT**
