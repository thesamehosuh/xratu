import { useState } from 'react';
import { t } from '../i18n';

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactAccount(value: string): string {
    return value.replace(emailPattern, email => {
        const [name, domain] = email.split('@');
        return `${name.slice(0, 1)}•••@${domain}`;
    }).replace(/\s*·\s*oaiapp_[\w-]+/gi, '');
}

export function PrivateAccount({ value }: { value: string }) {
    const [revealed, setRevealed] = useState(false);
    const masked = redactAccount(value);
    if (masked === value) return <bdi dir="auto">{value}</bdi>;
    return <button type="button" className="private-account" onClick={() => setRevealed(!revealed)}
        aria-label={t(revealed ? 'hideEmail' : 'revealEmail')} aria-pressed={revealed}>
        <bdi dir="auto">{revealed ? value.replace(/\s*·\s*oaiapp_[\w-]+/gi, '') : masked}</bdi>
    </button>;
}
