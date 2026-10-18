// The published 2.1.3 release, the differential tests compare against it. It ships without types
declare module 'libqp-legacy' {
    import type { Transform, TransformOptions } from 'node:stream';

    const libqp: {
        encode(buffer: Buffer | string): string;
        decode(str: string | Buffer): Buffer;
        wrap(str: string, lineLength?: number): string;
        Encoder: new (options?: TransformOptions & { lineLength?: number | false }) => Transform;
        Decoder: new (options?: TransformOptions) => Transform;
    };
    export = libqp;
}
