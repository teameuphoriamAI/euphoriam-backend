/**
 * Wraps a promise with a timeout. If the promise doesn't resolve
 * within the specified time, it rejects with a timeout error.
 *
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [message] - Optional custom error message
 * @returns {Promise} - The original promise or timeout rejection
 */
const withTimeout = (promise, ms, message = "Operation timed out") => {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${message} (after ${ms}ms)`));
        }, ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
};

module.exports = {
    withTimeout,
};
