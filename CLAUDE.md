# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

libqp is a zero-dependency library that encodes and decodes quoted-printable (RFC 2045, section 6.7). It is part of the Nodemailer family (used by libmime, mailsplit, imapflow, WildDuck, EmailEngine) and decodes untrusted email content, so correctness and resistance to pathological input (ReDoS, quadratic loops, endless loops, MIME boundary injection) matter more than usual. See `SECURITY.md` for what counts as a vulnerability.

Written in TypeScript in `src/libqp.ts` and published as a dual package: ES modules in `dist/esm/` and CommonJS in `dist/cjs/`, each with its own declarations. `dist/` is gitignored and built by `prepare`. The setup mirrors `../nodemailer` and `../imapflow`.

## Commands

- `npm test` builds (`pretest`), then runs every `test/**/*-test.ts` with `node --import tsx --test`.
- Single file: `node --import tsx --test test/libqp-test.ts`; single test: add `--test-name-pattern="never splits"`.
- `npm run test:coverage` runs the suite under c8, gated at 100% lines/statements/functions and 95% branches (`.c8rc.json`).
- `npm run test:bun` runs the same suite under Bun.
- Besides the unit tests, the suite has property-based tests (`test/property-test.ts`, fast-check, shared arbitraries in `test/fixtures/fuzz.ts`), differential tests against the published 2.1.3 (`test/legacy-test.ts`, installed as `libqp-legacy`) and scaling tests that catch quadratic regressions by comparing runtimes at two input sizes (`test/complexity-test.ts`). `FUZZ_ITERATIONS` and `FUZZ_SEED` (a number or `random`) tune the property runs.
- `npm run test:fuzz` runs the property and differential tests with 20k inputs and a random seed. `npm run test:mutation` runs mutation testing (`scripts/mutation-test.js`, slow, not in CI).
- `npm run lint` runs `tsc --noEmit` over `src/` and `test/`, then ESLint (`eslint.config.js`, copied from nodemailer).
- `npm run format` / `npm run format:check` (Prettier, `.prettierrc`, 160 columns).
- `npm run update` refreshes dependencies with ncu; `.ncurc.cjs` keeps `@types/node` on 20.x and TypeScript below 7.

## Module format and compatibility

- `engines.node >= 20`. Source is compiled twice from the same file (`tsconfig.esm.json`, `tsconfig.cjs.json`), so `src/` must not use `import.meta`, `require`, `__dirname` or top-level `await`. `erasableSyntaxOnly` and `exactOptionalPropertyTypes` are on: declare every optional property as `T | undefined`.
- `src/libqp.ts` has named exports plus a default export object. `scripts/build.js` patches the CommonJS output so `require('libqp').default` is the exports object itself (non-enumerable), keeping `Object.keys(require('libqp'))` the same five names as the pre-TypeScript build. CommonJS consumers such as EmailEngine (bundled with `@yao/pkg`) depend on this shape.
- `package.json` `exports` maps `.`, `./lib/libqp` and `./lib/libqp.js` (the old deep import path) to both builds; `typesVersions` serves node10-resolution TypeScript consumers. `lib/libqp.js` (with `lib/package.json` marking it CommonJS) re-exports the CommonJS build for bundlers that resolve paths on disk and ignore `exports`; without it a `@yao/pkg` binary fails on `require('libqp/lib/libqp')`.
- `test/package/` loads the built `dist/` through the exports map in both formats and type-checks consumers against the shipped declarations. Internal stream state is marked `@internal` and stripped (`stripInternal`); the package test checks it stays out of the `.d.ts`.

## Architecture notes

These span several functions and are easy to break:

- `encode()` and the `Encoder` stream share `encodeBytes(buffer, next, binary, previous)`. `next`/`previous` are the bytes around the buffer so a chunk is encoded as if the input was not split. `encode()` never wraps; `wrap()` adds soft line breaks. The `Encoder` keeps the unfinished last line in `_curLine`, holds back trailing whitespace (and, with `binary`, a trailing CR) in `_remainingBytes` until it knows what follows, and encodes in 64 KB slices.
- Hyphen rule: no output line may start with a literal `-` (a `--` line reads as a MIME boundary). Enforced in `encodeBytes` (after an LF or at input start) and in `wrap` (after a soft break, emitting `=2D`). Keep both in sync.
- `wrap()` raises line lengths below 4 to 4 so it always makes progress, never splits an `=XX` escape, and cuts a trailing multi-byte UTF-8 sequence to the next line (`trimUtf8Sequence`).
- `decode()` works on `binary` (latin1) strings so raw 8-bit bytes pass through; a string argument is read as the low byte of each char code (historical behavior, keep it). The whitespace-stripping regex is written to be linear; a naive `/[\t ]+$/gm` is quadratic. `Decoder` buffers all input and decodes once in `_flush`, deliberately.
- ESLint's `no-div-regex` forbids regex literals starting with `=`; write `[=]` instead.

## Releases

release-please (`.github/workflows/release.yaml`) cuts releases from Conventional Commits on `master` and publishes to npm through trusted publishing. Never edit `CHANGELOG.md` or the `package.json` version by hand.
