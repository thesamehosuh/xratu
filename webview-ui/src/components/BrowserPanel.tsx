import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, Globe, LoaderCircle, Monitor, RotateCw, X } from 'lucide-react';
import type { BrowserCommand, BrowserFrame, BrowserState } from '../../../src/browserTypes';
import type { FromExtensionMessage } from '../types';
import { getLocale, t, tOrRaw } from '../i18n';
import { postMessage } from '../vscode';

interface Props { visible: boolean; panelClass: string; sessionKey: string | null }

export function BrowserPanel({ visible, panelClass, sessionKey }: Props) {
    const [state, setState] = useState<BrowserState | null>(null);
    const [frame, setFrame] = useState<BrowserFrame | null>(null);
    const [url, setUrl] = useState('');
    const [error, setError] = useState<{ key: string; detail: string } | null>(null);
    const stateRef = useRef(state);
    const image = useRef<HTMLImageElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const typing = useRef<HTMLTextAreaElement>(null);
    const composing = useRef(false);
    const requestedViewportMode = useRef<'fill' | 'fixed' | null>(null);
    const wheel = useRef<{ x: number; y: number; deltaX: number; deltaY: number } | null>(null);
    const wheelTimer = useRef<ReturnType<typeof setTimeout>>();
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    stateRef.current = state;
    const command = useCallback((command: BrowserCommand) => {
        const current = stateRef.current;
        if (!current) return;
        setError(null);
        postMessage({ type: 'browserCommand', sessionId: current.sessionId, browserId: current.browserId, command });
    }, []);

    useEffect(() => {
        setState(null); stateRef.current = null; setFrame(null); setError(null); setUrl('');
        requestedViewportMode.current = null;
        const handler = (event: MessageEvent<FromExtensionMessage>) => {
            const msg = event.data;
            if (msg.type === 'browserState') {
                if (sessionKey && msg.state.sessionId !== sessionKey) return;
                if (msg.state.browserId !== stateRef.current?.browserId || msg.state.viewport.width !== stateRef.current?.viewport.width || msg.state.viewport.height !== stateRef.current?.viewport.height) setFrame(null);
                if (msg.state.url !== stateRef.current?.url) setUrl(msg.state.url === 'about:blank' ? '' : msg.state.url);
                stateRef.current = msg.state; setState(msg.state);
                if (msg.state.viewportMode === requestedViewportMode.current) requestedViewportMode.current = null;
                if (msg.state.status === 'closed') { setFrame(null); setError(null); }
            } else if (msg.type === 'browserFrame') {
                const current = stateRef.current;
                if (msg.frame.sessionId !== current?.sessionId || msg.frame.browserId !== current.browserId) return;
                if (msg.frame.width !== current.viewport.width || msg.frame.height !== current.viewport.height) {
                    postMessage({ type: 'browserFrameAck', sessionId: msg.frame.sessionId, browserId: msg.frame.browserId, frameId: msg.frame.frameId });
                    return;
                }
                setFrame(msg.frame);
                // Bound host traffic even when a hidden panel's image does not repaint.
                if (!visibleRef.current) postMessage({ type: 'browserFrameAck', sessionId: msg.frame.sessionId, browserId: msg.frame.browserId, frameId: msg.frame.frameId });
            } else if (msg.type === 'browserActionError') {
                if (msg.sessionId === stateRef.current?.sessionId && msg.browserId === stateRef.current.browserId) setError({ key: msg.errorKey, detail: msg.detail });
            }
        };
        window.addEventListener('message', handler);
        postMessage({ type: 'browserGetState' });
        return () => { window.removeEventListener('message', handler); clearTimeout(wheelTimer.current); wheelTimer.current = undefined; wheel.current = null; };
    }, [sessionKey]);

    useEffect(() => {
        if (!frame || !image.current || !visible) return;
        // Identical JPEGs do not fire another load event. Acknowledge each
        // frame after decoding so an idle page never stalls backpressure.
        const ack = () => postMessage({ type: 'browserFrameAck', sessionId: frame.sessionId, browserId: frame.browserId, frameId: frame.frameId });
        void image.current.decode().then(ack, ack);
    }, [frame, visible]);

    const sessionId = state?.sessionId, browserId = state?.browserId;
    useEffect(() => {
        if (!sessionId || !browserId) return;
        postMessage({ type: 'browserVisible', sessionId, browserId, visible });
        return () => postMessage({ type: 'browserVisible', sessionId, browserId, visible: false });
    }, [visible, sessionId, browserId]);

    const fit = useCallback((force = false) => {
        const rect = content.current?.getBoundingClientRect();
        const current = stateRef.current;
        if (!visibleRef.current || !rect || !rect.width || !rect.height || !current || current.status !== 'ready') return;
        if (!force && (requestedViewportMode.current === 'fixed' || current.viewportMode !== 'fill')) return;
        const width = Math.max(240, Math.min(2560, Math.floor(rect.width)));
        const height = Math.max(240, Math.min(2560, Math.floor(rect.height)));
        if (width !== current.viewport.width || height !== current.viewport.height || current.viewportMode !== 'fill') command({ action: 'resize', width, height, mode: 'fill', expectedMode: force ? undefined : current.viewportMode });
    }, [command]);
    useEffect(() => {
        if (!visible || state?.status !== 'ready' || state.viewportMode !== 'fill' || !content.current) return;
        let timer: ReturnType<typeof setTimeout>;
        const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(fit, 150); });
        observer.observe(content.current);
        return () => { clearTimeout(timer); observer.disconnect(); };
    }, [visible, state?.status, state?.viewportMode, fit]);

    const point = (event: MouseEvent | React.WheelEvent) => {
        const rect = image.current?.getBoundingClientRect();
        if (!rect || !state || !rect.width || !rect.height) return null;
        return { x: Math.min(state.viewport.width - 1, Math.max(0, (event.clientX - rect.left) * state.viewport.width / rect.width)),
            y: Math.min(state.viewport.height - 1, Math.max(0, (event.clientY - rect.top) * state.viewport.height / rect.height)) };
    };
    const press = (event: KeyboardEvent) => {
        if (composing.current || event.nativeEvent.isComposing) return;
        // Printable/IME input uses the textarea's input event, not synthetic key names.
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const modifiers = [event.ctrlKey && 'Control', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
        command({ action: 'press', key: [...modifiers, event.key === ' ' ? 'Space' : event.key].join('+') });
    };
    const ready = state?.status === 'ready';
    const starting = state?.status === 'starting';
    const Back = getLocale() === 'fa' ? ArrowRight : ArrowLeft;
    const Forward = getLocale() === 'fa' ? ArrowLeft : ArrowRight;
    const errorKey = error?.key ?? state?.errorKey;
    const errorDetail = error?.detail ?? state?.errorDetail;
    return <section id="surface-panel-browser" role="tabpanel" aria-labelledby="surface-tab-browser" aria-hidden={!visible || undefined} className={`browser-pane ${panelClass}`}>
        <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); if (url.trim()) command({ action: ready ? 'navigate' : 'open', url }); }}>
            <div className="browser-navigation">
                <button type="button" className="icon-btn" title={t('browserBack')} aria-label={t('browserBack')} disabled={!ready} onClick={() => command({ action: 'back' })}><Back size={15} /></button>
                <button type="button" className="icon-btn" title={t('browserForward')} aria-label={t('browserForward')} disabled={!ready} onClick={() => command({ action: 'forward' })}><Forward size={15} /></button>
                <button type="button" className="icon-btn" title={t('browserReload')} aria-label={t('browserReload')} disabled={!ready || starting} onClick={() => command({ action: 'reload' })}>{state?.loading ? <LoaderCircle size={15} className="spinning" /> : <RotateCw size={15} />}</button>
            </div>
            <input className="browser-address" dir="ltr" aria-label={t('browserAddress')} placeholder={t('browserAddressHint')} value={url} onChange={event => setUrl(event.target.value)} disabled={!state || starting} spellCheck={false} />
            <button className="browser-go" type="submit" disabled={!state || starting || !url.trim()} aria-label={t('browserGo')} title={t('browserGo')}><ArrowRight size={15} /></button>
        </form>
        <div className="browser-options">
            <span className="browser-page-title" dir="auto">{state?.title || t('surfaceBrowser')}</span>
            <label className="browser-viewport-picker"><Monitor size={13} /><select aria-label={t('browserViewport')} disabled={!ready} value={state?.viewportMode === 'fill' ? 'fill' : state?.viewport.width === 390 ? 'mobile' : state?.viewport.width === 1280 ? 'desktop' : 'custom'} onChange={event => {
                requestedViewportMode.current = event.target.value === 'fill' ? 'fill' : 'fixed';
                if (event.target.value === 'fill') fit(true);
                else command({ action: 'resize', ...(event.target.value === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 }) });
            }}>
                <option value="fill">{t('browserFit')}</option>
                <option value="desktop">{t('browserDesktop')}</option><option value="mobile">{t('browserMobile')}</option><option value="custom" hidden>{t('browserCustom')}</option>
            </select></label>
            {ready && <span className="browser-dimensions" dir="ltr">{state.viewport.width} × {state.viewport.height}</span>}
            <button type="button" className="icon-btn" aria-label={t('browserClose')} title={t('browserClose')} disabled={!ready && !starting} onClick={() => command({ action: 'close' })}><X size={14} /></button>
        </div>
        {errorKey && <div className="browser-error" role="alert"><strong>{tOrRaw(errorKey)}</strong>{errorDetail && <span dir="auto">{errorDetail}</span>}</div>}
        <div className="browser-content" ref={content}>
            {ready && frame ? <div className="browser-viewport" style={{ maxWidth: state.viewport.width, aspectRatio: `${state.viewport.width} / ${state.viewport.height}` }} onClick={event => { const target = point(event); if (target) { command({ action: 'click', ...target }); typing.current?.focus({ preventScroll: true }); } }}
                onWheel={event => {
                    const target = point(event); if (!target) return;
                    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.viewport.height : 1;
                    wheel.current = { ...target, deltaX: Math.max(-10000, Math.min(10000, (wheel.current?.deltaX ?? 0) + event.deltaX * scale)), deltaY: Math.max(-10000, Math.min(10000, (wheel.current?.deltaY ?? 0) + event.deltaY * scale)) };
                    if (wheelTimer.current) return;
                    wheelTimer.current = setTimeout(() => { if (wheel.current) command({ action: 'scroll', ...wheel.current }); wheel.current = null; wheelTimer.current = undefined; }, 50);
                }}>
                <img ref={image} src={`data:image/jpeg;base64,${frame.data}`} alt={t('browserPage')} draggable={false} />
                <textarea ref={typing} className="browser-keyboard" aria-label={t('browserKeyboard')} onKeyDown={press} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; if (event.currentTarget.value) command({ action: 'type', text: event.currentTarget.value }); event.currentTarget.value = ''; }} onInput={event => { if (!composing.current && event.currentTarget.value) { command({ action: 'type', text: event.currentTarget.value }); event.currentTarget.value = ''; } }} />
            </div> : <div className="browser-empty">
                {starting ? <LoaderCircle size={30} className="spinning" /> : <Globe size={30} />}
                <h2>{t(starting ? 'browserStarting' : ready ? 'browserWaiting' : 'browserEmptyTitle')}</h2>
                <p>{t(ready ? 'browserWaitingHint' : 'browserEmptyHint')}</p>
                {!ready && !starting && <code dir="ltr">http://localhost:3000</code>}
            </div>}
        </div>
        <footer className="browser-footer"><span className={`browser-status-dot${ready ? ' ready' : ''}`} />{t(ready ? 'browserShared' : 'browserLocal')}</footer>
    </section>;
}
