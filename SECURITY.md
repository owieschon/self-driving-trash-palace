# Security policy

## Supported versions

Until the first stable release, only the current `main` branch receives security fixes.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, or customer data. Use GitHub's private vulnerability reporting for this repository when enabled.

Include the affected contract, reproduction conditions, expected invariant, and observed result. Redact tokens, prompts, tenant identifiers, and trace URLs.

## Security boundaries

The gateway and palace are fictional fixtures. The project must still enforce tenant isolation, scoped tools, human approval, idempotent operations, prompt-injection separation, secret redaction, and deterministic verification as if the boundary were real.
