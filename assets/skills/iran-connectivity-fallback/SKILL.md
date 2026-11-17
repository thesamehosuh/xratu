---
name: iran-connectivity-fallback
description: Diagnose repeated network failures to a configured AI provider and identify workable next steps. Do not use for isolated failures, authentication errors, or rate limits alone.
---

# Provider connectivity failures

Distinguish repeated timeouts, DNS failures, or connection resets from isolated errors. Investigate 401/403 and 429 responses according to their actual authentication, access, or quota details; do not infer a cause from the status alone.

- Check the endpoint, error, recent configuration changes, and whether other services work. Use bounded, non-destructive diagnostics without exposing credentials.
- DNS, TCP, TLS, and HTTP checks establish different things. Test the actual API operation when authorized and useful; state what was tested and whether the machine's network differs from the user's.
- Consider configured local runtimes and other providers when they fit the user's needs. Verify availability, do not assume a specific product's settings exist, and do not switch providers without authorization.
- When troubleshooting is requested, investigate DNS, proxies, VPNs, firewall, certificates, routing, and provider status as relevant. Respect the user's setup and explain configuration changes before making them.
- Preserve in-progress work and report what remains. Check the outcome before retrying operations that may have side effects.

This skill can guide diagnosis only while an inference backend can respond.
If the active provider cannot answer at all, host retries, provider controls,
or a previously configured local runtime must restore inference first; loading
more instructions cannot repair the failed connection.

For broader service comparisons in Iran, use `iran-dev-access` when available.
