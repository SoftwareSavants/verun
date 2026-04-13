# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Verun, please report it privately. Do not open a public issue.

**Email:** security@software-savants.com

Include:
- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix (optional but appreciated)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

Verun runs entirely on your local machine. It does not operate a server, collect telemetry, or transmit data. Security concerns most likely involve:

- Local privilege escalation through the Tauri IPC bridge
- Unsafe handling of git operations or shell commands
- Vulnerabilities in bundled dependencies

## Supported versions

We only support the latest release. Update regularly to stay current with security fixes.
