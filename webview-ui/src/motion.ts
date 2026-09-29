/* Shared motion helpers. The webview's motion language ("stream & settle")
   lives in theme.css; these exist only where CSS on VS Code 1.90's Chromium
   122 cannot go: <details> height animation, and reduced-motion gates for
   JS-driven motion (CSS keeps its own global kill switch). */

export function prefersReducedMotion(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
}

/** Grow a just-opened <details> body from zero to its natural height instead
 *  of popping it in - step pills, thinking bodies, approval items and
 *  decision records all share one delegated hook (see installDetailsMotion).
 *  Closing stays instant: the browser hides the body before any listener can
 *  run, and delaying the native close with controlled state is how pills end
 *  up desynced from their <details>. */
export function animateDetailsOpen(details: HTMLDetailsElement, durationMs = 220): void {
    if (prefersReducedMotion()) return;
    const body = Array.from(details.children).find(
        (el): el is HTMLElement => el instanceof HTMLElement && el.tagName !== 'SUMMARY'
    );
    if (!body || body.dataset.motionAnim === '1') return;
    let to = body.scrollHeight;
    if (to <= 0) return;
    body.dataset.motionAnim = '1';
    body.style.overflow = 'hidden';
    let anim = body.animate(
        [
            { height: '0px', opacity: '0' },
            { height: `${to}px`, opacity: '1' },
        ],
        { duration: durationMs, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
    let raf = 0;
    const done = () => {
        cancelAnimationFrame(raf);
        delete body.dataset.motionAnim;
        body.style.overflow = '';
    };
    const arm = () => {
        anim.onfinish = done;
        anim.oncancel = done;
    };
    arm();
    // Content can outgrow the measured height while the reveal is in flight
    // (live tool output, async shiki diffs): retarget from the CURRENT visual
    // height to the new natural height instead of animating to a stale target
    // and snapping when the animation releases. One scrollHeight read per
    // frame for the length of the reveal - cheaper than a ResizeObserver on
    // a box whose own height is animation-controlled.
    const tick = () => {
        if (body.dataset.motionAnim !== '1') return;
        const natural = body.scrollHeight;
        if (natural > to + 1 && anim.playState === 'running') {
            const from = body.getBoundingClientRect().height;
            const timing = anim.effect?.getComputedTiming();
            const total = Number(timing?.endTime ?? durationMs);
            const current = Number(anim.currentTime ?? 0);
            const remaining = Math.max(30, total - current);
            to = natural;
            anim.onfinish = null;
            anim.oncancel = null;
            anim.cancel();
            anim = body.animate(
                [
                    { height: `${from}px`, opacity: '1' },
                    { height: `${to}px`, opacity: '1' },
                ],
                { duration: Math.min(remaining, 160), easing: 'linear' }
            );
            arm();
        }
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
}

/** A `toggle` also fires when React MOUNTS a details with `open` set - the
 *  attribute change is queued as a task and lands after the insert, so the
 *  delegated listener sees it like any other open (verified: default-open
 *  terminal/edit pills emit it on arrival). Animating those is wrong twice
 *  over: the pill is born open (there is nothing to reveal) and its body's
 *  async content (shiki diffs, live tool output) has not settled, so the
 *  measured height is short - the reveal stops half way and jumps to full
 *  height when the animation releases. Only a press on a summary marks a
 *  details as a real toggle; every other open is left instant. */
const pressed = new WeakSet<HTMLDetailsElement>();

export function installDetailsMotion(): void {
    document.addEventListener(
        'click',
        (e) => {
            const el = e.target;
            if (el instanceof Element) {
                const details = el.closest('details');
                if (details) pressed.add(details);
            }
        },
        true
    );
    // `toggle` does not bubble, so listen in the capture phase on document:
    // one listener covers every <details> in the app, including ones mounted
    // later (messages, tool pills, overlay pages).
    document.addEventListener(
        'toggle',
        (e) => {
            const target = e.target;
            if (!(target instanceof HTMLDetailsElement)) return;
            if (!pressed.delete(target)) return;
            if (target.open) animateDetailsOpen(target);
        },
        true
    );
}
