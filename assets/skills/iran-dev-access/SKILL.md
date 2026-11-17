---
name: iran-dev-access
description: Research availability, payment options, and alternatives for AI and developer services from Iran, or diagnose signup and access problems.
---

# Developer services from Iran

Evaluate the service the user asks about and practical alternatives using current evidence rather than a fixed provider list.

- Separate network reachability, API functionality, signup, regional eligibility, payment support, pricing, and data handling. Success at one does not prove the others. Check current official provider documentation and terms; use relevant independent evidence where helpful.
- When useful and authorized, run a bounded connection or API probe. State what was tested, from which network, and what the result establishes. An HTTP response alone does not establish signup, payment, or authenticated API access; an error alone does not identify its cause.
- Compare options against the user's needs, including existing services, domestic providers, local models, hosting, and payment methods where relevant. Verify current model availability, costs, and features; distinguish unverified options from confirmed ones.
- If diagnosing access, consider DNS, VPN, proxy, firewall, routing, provider status, and account errors as relevant. Respect the user's setup and avoid assumptions about their network or product configuration.
- Preserve the user's stated location and account details accurately. Do not suggest misrepresenting identity or eligibility. Explain meaningful service or payment limitations with sources rather than guessing.

## Dependencies and model files

For failed `npm install`, `pip install`, `docker pull`, or model downloads,
identify the exact package, image, revision, and failing host. Registry metadata,
artifact storage, authentication, and redirects can take different routes;
a successful homepage or package search does not establish a working download.

- Inspect current project/user registry and proxy configuration first. Keep
  private registry scopes and credentials on their intended hosts. Prefer a
  per-command override or scoped project setting over a global change; record
  how to restore any changed value. Never print tokens from config files.
- Look up current publisher or mirror documentation. Domestic mirrors are
  candidates to test from the affected network, not guaranteed substitutes.
  [Liara](https://docs.liara.ir/mirrors/about/) documents npm, PyPI, and
  container mirrors. [Shecan](https://shecan.ir/) describes selective DNS-based
  routing; DNS routing does not establish account or payment eligibility.
- Distinguish Docker Desktop, a local daemon, and a remote Docker context.
  Shell proxy variables do not prove the daemon uses that route; Docker
  Desktop ignores daemon.json proxy settings. Use its own proxy controls.
  See [Docker proxy configuration](https://docs.docker.com/engine/daemon/proxy/).
- Preserve versions, lockfile integrity hashes, TLS verification, and image
  digests. Do not disable certificate verification or add untrusted package
  indexes to make a download succeed. A mirror may lack a version or artifact;
  report that instead of silently substituting a different dependency.
- Retry the actual failing operation once after an evidence-based change.
  Reuse saved model-download progress through `native-downloads` when available.
  Before preparing an offline bundle, identify the target OS, architecture,
  runtime version, and required artifacts, then verify it without network
  access. A warm cache alone is not proof of an offline-ready project.

For repeated failures of a configured model provider, use `iran-connectivity-fallback` when available.
