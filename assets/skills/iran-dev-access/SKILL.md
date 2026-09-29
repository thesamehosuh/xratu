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
  presets for them (Settings -> API keys, Iranian providers group). The
  preset list is Xratu's current offering (Kaya AI, Avalai, Metis AI, Liara
  AI, ArvanCloud AI, Navaan, GapGPT), not a live status board - treat it as
  "these are wired in and take rial", and let the user's own probe decide
  which is up today. They serve frontier models over OpenAI-compatible
  endpoints and need no VPN. Their pricing is tracked in Toman in the Usage
  page.
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

## Registries and package managers (the "can I docker pull?" question)

No blanket claims - probe, and know the failure modes:

- **Docker Hub** restricts sanctioned regions in its terms, and pulls from
  Iranian networks are exactly where users hit 403s and timeouts. The
  working answer is a pull-through mirror: many teams run an internal
  registry mirror, and Iranian cloud providers (e.g. ArvanCloud) offer
  registry mirroring. Configure the mirror in the Docker daemon; don't
  document workarounds that misrepresent the account or region.
- **npm, PyPI, GitHub** are often reachable but intermittently throttled or
  filtered - worth a probe when the user reports trouble. For npm/PyPI,
  point at the org's configured mirror if the public registry fails; don't
  invent mirror URLs, use whatever the user's team already runs.

## Payments

- International cards and payment processors don't work with Iranian
  accounts - the answer is the rial-priced domestic route (gateways above,
  Iranian PaaS) or self-hosting, never disguising where a payment comes
  from.

## Tone and register

Practical and neutral, same as `iran-connectivity-fallback` - you are
mapping the working roads, not commenting on the roadblocks. Never speculate
about policy, sanctions, or geography as the cause of a failure. If the
answer is in Persian, it follows `natural-farsi` (colloquial register).

## Sibling skill

A configured provider failing mid-session with timeouts/network errors is
`iran-connectivity-fallback`'s job (fallback to what's already configured).
This skill is for "what should I use instead" questions up front.
