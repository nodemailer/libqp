# Changelog

## [3.0.1](https://github.com/nodemailer/libqp/compare/v3.0.0...v3.0.1) (2026-10-18)


### Bug Fixes

* escape a hyphen after a lone CR and stop wrap() from adding needless soft breaks ([1bc3c8e](https://github.com/nodemailer/libqp/commit/1bc3c8e66fa114877b95d5c280b5f2eed23420cf))

## [3.0.0](https://github.com/nodemailer/libqp/compare/v2.1.3...v3.0.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* requires Node.js 20 or newer.

### Features

* rewrite in TypeScript with ES module and CommonJS builds ([eeb28aa](https://github.com/nodemailer/libqp/commit/eeb28aab2f7055f7d7f3decd8878c476acb581e5))

## [2.1.3](https://github.com/nodemailer/libqp/compare/v2.1.2...v2.1.3) (2026-10-16)


### Bug Fixes

* decode trailing whitespace in linear time and never start an encoded line with a hyphen ([9ece8c1](https://github.com/nodemailer/libqp/commit/9ece8c11826b88509afd968d5bc5b83f5f447e18))

## [2.1.2](https://github.com/nodemailer/libqp/compare/v2.1.1...v2.1.2) (2026-09-28)


### Bug Fixes

* **decoder:** keep raw 8-bit bytes intact when decoding ([7bbdcbe](https://github.com/nodemailer/libqp/commit/7bbdcbeac4475e5e16b7f24a578ed6209de133a8))

## [2.1.1](https://github.com/nodemailer/libqp/compare/v2.1.0...v2.1.1) (2024-11-29)


### Bug Fixes

* **decode-stream:** Fix issue where some whitespace characters were lost ([2231159](https://github.com/nodemailer/libqp/commit/2231159f38e865ef8cf4f7f8bf28cabc00217ffe))

## [2.1.0](https://github.com/nodemailer/libqp/compare/v2.0.1...v2.1.0) (2024-02-23)


### Features

* **deploy:** Added autodeploy system ([def1b22](https://github.com/nodemailer/libqp/commit/def1b2282e9304a5c330e1e92f3db619179bcd3b))
