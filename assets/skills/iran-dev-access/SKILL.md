---
name: iran-dev-access
description: Use when the user asks which AI or developer services work from Iran, what to use instead of a blocked service (OpenAI, Anthropic, Vercel, Netlify, international payments), how to pay in rial, or when a signup/checkout for an international service fails — answers with working alternatives (domestic gateways, local models, Iranian PaaS) and probes reachability instead of guessing.
---

# Developer services from Iran: what works and what to use instead

## The shape of the answer

For every "can I use X from Iran?" question, deliver **working
alternatives**, not circumvention:

1. **Probe before claiming.** Reachability changes and differs per network -
   verify with a lightweight request (`curl -sI https://service.example`)
   before telling the user a service works or doesn't. Report what you
   measured ("the endpoint didn't answer from this machine"), never a
   confident "X is banned in Iran" - policy, outage, and ISP issues are
   indistinguishable from inside the extension host.
2. **Prefer what already works over what is blocked.** The practical path
   everyone actually uses is domestic services and local models - that is
   what this skill maps.
3. **No circumvention.** No VPN/proxy/DNS setup guides, no account-creation
   tricks, no payment workarounds that misrepresent the user's country or
   identity. If the only way to use a service is to fake something, name
   the alternative instead.

## AI models and APIs

- International first-party APIs (OpenAI, Anthropic, Gemini) are generally
  not reachable or not signable-up from Iranian networks - verify per
  network before asserting.
- **Domestic gateways are the practical answer** and Xratu has first-class
  presets for them (Settings -> API keys, Iranian providers group): Kaya AI,
  Avalai, Metis AI, Liara AI, ArvanCloud AI, Navaan, GapGPT. They serve
  frontier models over OpenAI-compatible endpoints, take rial payment, and
  need no VPN. Their pricing is tracked in Toman in the Usage page.
- **Local models are the zero-dependency answer** - see the
  `local-llm-low-ram` skill. Anything a 7-8B model can do works fully
  offline.

## Hosting and deploy

- Vercel/Netlify/Render signups commonly fail from Iranian networks
  (payment and signup checks) - don't fight them; the alternatives are
  first-class:
  - Iranian PaaS: **Liara**, **ArvanCloud** (same accounts already used for
    their AI gateways).
  - **GitHub Pages** and **Cloudflare Pages** for static front-ends - probe
    before promising.
  - Your own VPS anywhere that accepts the user's payment method.
- Docker Hub, npm, PyPI, GitHub: normally reachable (still worth a probe
  when the user reports trouble); registry rate limits have public mirrors.

## Payments

- International cards and payment processors don't work with Iranian
  accounts - the answer is the rial-priced domestic route (gateways above,
  Iranian PaaS) or self-hosting, never disguising where a payment comes
  from.

## Tone

Same as the connectivity skill: practical, neutral, no speculation about
why something is unreachable. You are mapping the working roads, not
commenting on the roadblocks.
