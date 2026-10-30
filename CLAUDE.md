# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

libqp is a zero-dependency library that encodes and decodes quoted-printable (RFC 2045, section 6.7). It is part of the Nodemailer family (used by libmime, mailsplit, imapflow, WildDuck, EmailEngine) and decodes untrusted email content, so correctness and resistance to pathological input (ReDoS, quadratic loops, endless loops, MIME boundary injection) matter more than usual. See `SECURITY.md` for what counts as a vulnerability.

Written in TypeScript in `src/libqp.ts` and published as a dual package: ES modules in `dist/esm/` and CommonJS in `dist/cjs/`, each with its own declarations. `dist/` is gitignored and built by `prepare`. The setup mirrors `../nodemailer` and `../imapflow`.

## Commands

- `npm test` builds (`pretest`), then runs every `test/**/*-test.ts` with `node --import tsx --test --test-concurrency=1`. Files run one at a time so the timing comparisons in `test/complexity-test.ts` are not skewed by other files competing for the CPU.
- Single file: `node --import tsx --test test/libqp-test.ts`; single test: add `--test-name-pattern="never splits"`.
- `npm run test:coverage` runs the suite under c8, gated at 100% lines/statements/functions and 95% branches (`.c8rc.json`).
- `npm run test:bun` runs the same suite under Bun.
- `npm run test:cjs` builds, then loads the CommonJS build (and `lib/libqp.js`) and exercises the main API with `--no-experimental-require-module` (`test/cjs-smoke.cjs`). CI runs it on Node 22 and 24.
- Besides the unit tests, the suite has property-based tests (`test/property-test.ts`, fast-check, shared arbitraries in `test/fixtures/fuzz.ts`), differential tests against the published 2.1.3 (`test/legacy-test.ts`, installed as `libqp-legacy`) and scaling tests that catch quadratic regressions by comparing runtimes at two input sizes (`test/complexity-test.ts`). `FUZZ_ITERATIONS` and `FUZZ_SEED` (a number or `random`) tune the property runs.
- `npm run test:fuzz` runs the property and differential tests with 20k inputs and a random seed. `npm run test:mutation` runs mutation testing (`scripts/mutation-test.js`, slow, not in CI).
- `npm run lint` runs `tsc --noEmit` over `src/` and `test/`, then ESLint (`eslint.config.js`, the shared flat config from nodemailer; the only local addition treats `lib/**/*.js` as CommonJS).
- `npm run format` / `npm run format:check` (Prettier, `.prettierrc`, 160 columns).
- `npm run update` refreshes dependencies with ncu; `.ncurc.cjs` keeps `@types/node` on 20.x and TypeScript below 7.

## Module format and compatibility

- `engines.node >= 20`, see Platform constraints below. Source is compiled twice from the same file (`tsconfig.esm.json`, `tsconfig.cjs.json`), so `src/` must not use `import.meta`, `require`, `__dirname` or top-level `await`. `erasableSyntaxOnly` and `exactOptionalPropertyTypes` are on: declare every optional property as `T | undefined`.
- `src/libqp.ts` has named exports plus a default export object. `scripts/build.js` patches the CommonJS output so `require('libqp').default` is the exports object itself (non-enumerable), keeping `Object.keys(require('libqp'))` the same five names as the pre-TypeScript build. CommonJS consumers such as EmailEngine (bundled with `@yao-pkg/pkg`) depend on this shape.
- `package.json` `exports` maps `.`, `./lib/libqp` and `./lib/libqp.js` (the old deep import path) to both builds; `typesVersions` serves node10-resolution TypeScript consumers. `lib/libqp.js` (with `lib/package.json` marking it CommonJS) re-exports the CommonJS build for resolvers that look for the path on disk and ignore `exports` (webpack 4, browserify; `@yao-pkg/pkg` prints a "Cannot find module" warning without it, though the binary works). When testing a pkg build, install real `node_modules`: a symlinked `node_modules` makes pkg miss files the exports map points at, and the binary fails at runtime.
- `test/package/` loads the built `dist/` through the exports map in both formats and type-checks consumers against the shipped declarations. Internal stream state is marked `@internal` and stripped (`stripInternal`); the package test checks it stays out of the `.d.ts`.

## Platform constraints

Both rules come from EmailEngine, which ships as a `@yao-pkg/pkg` binary: pkg snapshots a CommonJS module graph and cannot load ES modules.

- **Node.js 20 is the minimum supported version.** Runtime code, tests and tooling must work on Node 20, 22 and 24 (`engines.node` is `>=20.0.0`, `@types/node` stays on the 20.x line).
- **Everything that reaches runtime must be genuinely CommonJS-loadable.** `require()` of the CommonJS build and of every runtime dependency must work with `--no-experimental-require-module`. Node 22+ (and 20.19) can `require()` an ES module by default, which hides an ESM-only dependency until the pkg binary fails. A CommonJS entry that only wraps a dynamic `import()` does not count.
- **Check:** `npm run test:cjs`. Run it after `npm run update` or any dependency change; CI runs it on Node 22 and 24.
- There are no runtime dependencies. Should one ever be added, it must be CommonJS; never add or upgrade to an ESM-only dependency, and when a dependency's next major is ESM-only, pin the last CommonJS major in `.ncurc.cjs` (`reject`, or a `target` of `minor`/`patch`) with a comment giving the reason.

## Architecture notes

These span several functions and are easy to break:

- `encode()` and the `Encoder` stream share `encodeBytes(buffer, next, binary, previous)`. `next`/`previous` are the bytes around the buffer so a chunk is encoded as if the input was not split. `encode()` never wraps; `wrap()` adds soft line breaks. The `Encoder` keeps the unfinished last line in `_curLine`, holds back a trailing whitespace byte (and, with `binary`, a trailing CR) in `_heldByte` until it knows what follows, keeps an unwrapped trailing CR in `_curLine` until it knows whether LF follows, and encodes in 64 KB slices. With wrapping, its output equals `wrap(encode(input))` however the input is split; a property test checks this.
- Hyphen rule: no output line may start with a literal `-` (a `--` line reads as a MIME boundary). Enforced in `encodeBytes` (at input start and after an LF or a lone CR, which a relay may turn into CRLF) and in `wrapLine` (after a soft break, emitting `=2D`, which takes up room on the line as if the input held it). Keep both in sync.
- `wrap()` raises line lengths below 4 to 4 so it always makes progress, and wraps every hard line on its own (`wrapLine`), so a line break never counts towards the line length and the rest of a line is kept whole when it fits. It never splits an `=XX` escape and cuts a trailing multi-byte UTF-8 sequence to the next line (`trimUtf8Sequence`). It differs from 2.1.3 only by leaving out needless soft breaks; `test/legacy-test.ts` checks exactly that.
- `decode()` works on `binary` (latin1) strings so raw 8-bit bytes pass through; a string argument is read as the low byte of each char code (historical behavior, keep it). The whitespace-stripping regex is written to be linear; a naive `/[\t ]+$/gm` is quadratic. `Decoder` decodes up to the last line feed that later input cannot change (`lastLineBreak`): a hard line break, or a soft one whose escape cannot be completed by the next line (`==\nA=\nB` is the single byte 0xAB). Only the input after that point is held, and its output equals `decode()` of the whole input however the input is split; a property test checks this.
- ESLint's `no-div-regex` forbids regex literals starting with `=`; write `[=]` instead.

## Releases

release-please (`.github/workflows/release.yaml`) cuts releases from Conventional Commits on `master` and publishes to npm through trusted publishing. Never edit `CHANGELOG.md` or the `package.json` version by hand.

## CI

`.github/workflows/test.yml` runs lint, format check and the suite on Node 20, 22, 24 and 26 (plus `npm run test:cjs` on 22 and 24) (`npm ci`, so keep `package-lock.json` committed and in sync), the suite under Bun, and the coverage gate on Node 24. Actions are pinned to commit SHAs with the version in a trailing comment; update both together.

## Conventions

These mirror the conventions used across Postal Systems projects (see `../emailengine`).

**Git commits**

- Use Conventional Commits: `fix:` (patch release), `feat:` (minor release), and `chore:`/`build:`/`docs:`/`ci:`/`refactor:`/`style:`/`test:` for changes that should not trigger a release. release-please derives the version and changelog from these prefixes.
- Do **not** list Claude or any AI assistant as a co-author or co-contributor in commit messages or PR descriptions (no `Co-Authored-By` trailer).
- Append `[skip ci]` to commits that do not change runtime behavior (docs, comments, formatting) to avoid spending CI minutes. Never add it to a `fix:` or `feat:` commit, those must run so the release workflow triggers. GitHub reads the marker off the HEAD commit of a push only, so when a push mixes the two, the release-triggering commit has to be last. Do not use it on commits that change tooling or CI either, they need a run to prove the change.

**Code and docs style**

- No emojis anywhere in code or documentation, printable ASCII only.
- Use a single hyphen-minus (`-`) as a dash. Never use double hyphens (`--`), em dashes, or en dashes in prose.
- devDependencies are pinned to exact versions (no `^` or `~`); install with `npm install -D -E`.

**Before committing code changes**

1. `npm run format` and `npm run lint`
2. `npm test` (and `npm run test:coverage` when `src/` changes, the gate is 100% lines)
3. For non-trivial changes, consider `/simplify` and `/security-review`. This library decodes untrusted input, so anything in `decode()`, `wrap()` or the stream classes is security-sensitive.

**After pushing**

- Check the workflow runs for the push (`gh run list --branch <branch>`) and report their status. If a run fails for an unrelated or infrastructure reason (checkout reporting "account suspended", HTTP 403, other auth errors), check <https://www.githubstatus.com/> for an active GitHub incident before assuming the change caused it.
