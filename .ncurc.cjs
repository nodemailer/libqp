'use strict';

module.exports = {
    upgrade: true,
    // libqp-legacy is the published 2.1.3 release the differential tests compare against on
    // purpose, it must not be bumped
    reject: ['libqp-legacy'],
    target: name => {
        // @types/node stays on the 20.x line so the compiler rejects APIs that do
        // not exist on Node 20, the oldest supported version
        if (name === '@types/node') {
            return 'minor';
        }
        // typescript-eslint declares a peer range that excludes TypeScript 7
        if (name === 'typescript') {
            return 'minor';
        }
        return 'latest';
    }
};
