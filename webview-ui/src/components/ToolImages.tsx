import type { Step } from '../types';
import { t, tf } from '../i18n';

/** Images a tool returned with its result (an MCP screenshot, mostly).
 *
 *  `dir="ltr"` on the wrapper regardless of locale: the caption may embed a URL
 *  or a path, and an RTL paragraph would reorder it. Capped at MAX_RENDERED so
 *  a server that returns twenty screenshots cannot flood the transcript; the
 *  remainder is stated rather than hidden. */

const MAX_RENDERED_TOOL_IMAGES = 4;

export function ToolImages({ call, result }: { call: Step; result?: Step }) {
    const images = result?.images ?? call.images;
    if (!images?.length) return null;
    const shown = images.slice(0, MAX_RENDERED_TOOL_IMAGES);
    const hidden = images.length - shown.length;
    return (
        <div className="tool-images" dir="ltr">
            {shown.map((img, i) => (
                <figure key={`${img.mimeType}-${i}`} className="tool-image">
                    <img src={img.dataUrl} alt={img.caption ?? t('toolImageAlt')} loading="lazy" />
                    {img.caption && <figcaption dir="ltr">{img.caption}</figcaption>}
                </figure>
            ))}
            {hidden > 0 && <span className="tool-images-more">{tf('toolImagesMore', { count: String(hidden) })}</span>}
        </div>
    );
}

