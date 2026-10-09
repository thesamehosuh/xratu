/**
 * The manual-code slot of a browser sign-in.
 *
 * A loopback callback and a hand-pasted code are two ways to deliver the SAME
 * value, and the flow races them. The subtlety this exists for: the paste
 * usually arrives seconds AFTER the race starts, so the "pasted" side must be
 * a promise that is ALREADY PENDING when the race is built. Reading a possibly-
 * undefined promise into `Promise.race` resolves the race immediately with
 * `undefined` - which looks exactly like "the user pasted nothing" and kills
 * the flow before the browser has even redirected.
 */
export interface ManualCodeSlot {
    /** Pending until a code is submitted (or the flow is torn down). */
    readonly promise: Promise<string>;
    /** Deliver a pasted code. Later submissions are ignored - the first one
     *  wins the race, and re-resolving would be a silent no-op at best. */
    submit(code: string): void;
    /** Settle the slot with '' so a cancelled flow releases the race. */
    release(): void;
}

export function createManualCodeSlot(): ManualCodeSlot {
    let settle!: (code: string) => void;
    let settled = false;
    const promise = new Promise<string>((resolve) => {
        settle = (code: string) => {
            if (settled) return;
            settled = true;
            resolve(code);
        };
    });
    return {
        promise,
        submit: (code: string) => settle(code),
        release: () => settle(''),
    };
}