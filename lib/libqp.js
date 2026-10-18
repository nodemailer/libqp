'use strict';

// The pre-TypeScript entry point. Node resolves `libqp/lib/libqp` through the exports map and
// never loads this file, but resolvers that look for the path on disk and ignore the exports map
// (webpack 4, browserify, and @yao/pkg, which warns about the import without it) still find it.
module.exports = require('../dist/cjs/libqp.js');
