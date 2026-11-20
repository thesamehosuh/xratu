import anthropic from '../assets/provider-icons/anthropic.svg';
import cerebras from '../assets/provider-icons/cerebras.svg';
import codex from '../assets/provider-icons/codex.svg';
import cohere from '../assets/provider-icons/cohere.svg';
import deepseek from '../assets/provider-icons/deepseek.svg';
import fireworks from '../assets/provider-icons/fireworks.svg';
import google from '../assets/provider-icons/google.svg';
import groq from '../assets/provider-icons/groq.svg';
import huggingface from '../assets/provider-icons/huggingface.svg';
import llamacpp from '../assets/provider-icons/llamacpp.svg';
import lmstudio from '../assets/provider-icons/lmstudio.svg';
import mistral from '../assets/provider-icons/mistral.svg';
import moonshot from '../assets/provider-icons/moonshot.svg';
import nvidia from '../assets/provider-icons/nvidia.svg';
import ollama from '../assets/provider-icons/ollama.svg';
import openai from '../assets/provider-icons/openai.svg';
import opencode from '../assets/provider-icons/opencode.svg';
import opencodeGo from '../assets/provider-icons/opencode-go.svg';
import openrouter from '../assets/provider-icons/openrouter.svg';
import perplexity from '../assets/provider-icons/perplexity.svg';
import sambanova from '../assets/provider-icons/sambanova.svg';
import together from '../assets/provider-icons/together.svg';
import vllm from '../assets/provider-icons/vllm.svg';
import xai from '../assets/provider-icons/xai.svg';
import zai from '../assets/provider-icons/zai.svg';
import { Server } from 'lucide-react';

const icons = new Map(Object.entries({
    anthropic, cerebras, codex, cohere, deepseek, fireworks, google, groq, huggingface,
    llamacpp, lmstudio, mistral, moonshot, nvidia, ollama, openai, opencode, openrouter,
    perplexity, sambanova, together, vllm, xai, zai, 'opencode-go': opencodeGo,
    'chatgpt-codex': codex, 'fireworks-ai': fireworks, 'google-vertex': google, 'llama-cpp': llamacpp,
    'lm-studio': lmstudio, 'moonshotai': moonshot, 'moonshotai-cn': moonshot,
    'togetherai': together, 'zai-coding-plan': zai,
}));

export function ProviderIcon({ id, label }: { id?: string; label: string }) {
    const icon = id ? icons.get(id.toLowerCase()) : undefined;
    if (icon) return <span className="provider-brand-icon provider-brand-logo" aria-hidden="true" style={{ maskImage: `url("${icon}")` }} />;

    const initials = (label.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 2)
        .map(word => Array.from(word)[0]).join('').toUpperCase();
    return <span className="provider-brand-icon provider-brand-initials" aria-hidden="true" data-initials={initials}>
        {!initials && <Server size={12} />}
    </span>;
}
