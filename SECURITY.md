# Security policy

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials or customer information in public
issues or pull requests. Use GitHub's private vulnerability reporting at:

https://github.com/Booyaka101/shoptill-pos/security/advisories/new

If private reporting is unavailable, do not fall back to a public report with
exploit details. Ask the maintainer for a private channel without including
sensitive information.

Include the affected version, a minimal reproduction using synthetic data,
the expected security boundary and the impact. Do not test shops without the
owner's permission. No response-time SLA or bug bounty is offered.

## Supported versions

Security fixes target the latest release and current main branch. Older
releases do not have a separate maintenance commitment. Main may contain
unreleased changes; test upgrades in a disposable shop before rollout.

## Safe operation

- Use HTTPS for production and give staff only the permissions they need.
- Treat device tokens as passwords. Revoke lost or compromised devices.
- Do not use Docker demo passwords in production or expose the demo stack to
  the internet. Its HTTP authentication exception is for local development.
- Never import real customer data into development or CI fixtures.
- Multisite is unsupported. Revoke ShopTill device credentials before network
  conversion, as described in the README.
- ShopTill records tender; recording a card payment does not process a card.
  Never enter card numbers, CVVs or other payment secrets in order notes.

Tests and secret scans reduce risk but are not a security certification or a
substitute for backups and operational review.
