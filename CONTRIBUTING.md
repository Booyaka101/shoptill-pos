# Contributing to ShopTill

Bug reports, documentation improvements and focused pull requests are welcome.
Please be respectful and keep discussion about the work.

## Report a problem

For vulnerabilities, follow [SECURITY.md](SECURITY.md), not a public issue.
For other bugs, include the ShopTill, WordPress, WooCommerce, PHP and browser
versions, order storage mode (HPOS or legacy), tax settings, reproduction
steps, expected behavior and actual behavior.

Use synthetic test data. Never attach customer records, database exports,
device tokens, passwords, payment details or unredacted browser storage.

## Development

Follow the local setup and testing instructions in [README.md](README.md).
Use Node.js 24 and Docker Compose for the CI-equivalent setup. Demo passwords
are public test fixtures, not production defaults. Keep the stack on localhost
and never use it for real transactions or import production customer data.

Before submitting a change:

```sh
cd app
npm ci
npx vitest run tests/unit
npm run build
npm audit
```

Run affected integration or browser tests against a disposable shop. These
tests create, modify and delete data. The CI workflow documents the full
fixture setup, PHP checks, server tests, tax parity and browser regressions.

Keep changes small, add regression tests for bug fixes and update the
changelog for user-visible changes. Rebuild the committed till bundle when
changing app source. Never commit credentials or local exports. Changes go
through pull requests with passing CI; a merge is not a deployment.

## License

Unless explicitly stated otherwise, contributions are provided under the
project's GPL-2.0-or-later license. Keep third-party notices intact and only
contribute code and assets you have permission to share.
