/**
 * Single-flight, latest-wins runner for disposable writes.
 *
 * At most one `run` is in flight. Values sent meanwhile collapse to the
 * newest one, which runs when the current call settles (resolve or reject —
 * a failed save must not strand the newer value). Built for viewport
 * persistence: a throttle alone lets requests overlap once one of them is
 * slow, and on 2026-08-28 that overlap filled the server's DB pool.
 */
export function createLatestWins<T>(run: (value: T) => Promise<void>): {
    send: (value: T) => void;
    cancel: () => void;
    inFlight: () => boolean;
} {
    let active = false;
    let pending: { value: T } | null = null;

    const start = (value: T) => {
        active = true;
        let promise: Promise<void>;
        try {
            promise = run(value);
        } catch (e) {
            promise = Promise.reject(e);
        }
        promise.then(settle, settle);
    };

    const settle = () => {
        active = false;
        if (pending) {
            const { value } = pending;
            pending = null;
            start(value);
        }
    };

    return {
        send(value: T) {
            if (active) {
                pending = { value };
                return;
            }
            start(value);
        },
        cancel() {
            pending = null;
        },
        inFlight: () => active
    };
}
