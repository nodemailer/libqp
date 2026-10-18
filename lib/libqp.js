'use strict';

// The pre-TypeScript entry point. Node resolves `libqp/lib/libqp` through the exports map and
// never loads this file, but bundlers that resolve paths on disk and ignore the exports map
// (@yao/pkg, which EmailEngine is built with) still need a file at the old path.
module.exports = require('../dist/cjs/libqp.js');
