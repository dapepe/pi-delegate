# Security policy

The trust boundary and known limitations are documented in
[docs/security.md](docs/security.md). Read them before delegating private source.
Model tool restrictions are **not an operating-system sandbox**. Only install
this project and its dependencies from sources you trust.

## Reporting a vulnerability

Do not post credentials, private source code, or exploitable details in a public
issue. On a published fork, use GitHub's **Security → Report a vulnerability**
when the repository owner has enabled private vulnerability reporting. Otherwise,
use a private contact method supplied by that repository's owner. This source
package intentionally does not invent a maintainer email or promise a response SLA.
Repository owners should enable private reporting before public distribution.

Include the version, operating system, Node version, a minimal synthetic
reproduction, expected boundary, observed behavior, and suggested mitigation.
Remove API keys, request bodies, private paths, and private run artifacts.

## Supported release policy

This initial public source release has no guaranteed support or security-response
window. Review dependency updates and release validation before using it. CI
must never receive live provider keys for untrusted pull requests. Paid smoke
checks are manual, opt-in, and use only the supplied public fixture.
