const { Transform } = require('node:stream');

function createContentLengthVerifier(expectedBytes) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        throw new RangeError('Expected content length must be a non-negative safe integer.');
    }

    let receivedBytes = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            receivedBytes += chunk.length;
            if (receivedBytes > expectedBytes) {
                const error = new Error('Downloaded file exceeded its expected size.');
                error.code = 'RESULT_SIZE_MISMATCH';
                callback(error);
                return;
            }
            callback(null, chunk);
        },
        flush(callback) {
            if (receivedBytes !== expectedBytes) {
                const error = new Error('Downloaded file did not match its expected size.');
                error.code = 'RESULT_SIZE_MISMATCH';
                callback(error);
                return;
            }
            callback();
        },
    });
}

module.exports = { createContentLengthVerifier };
