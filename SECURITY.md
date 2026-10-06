# Security

quarterdeck runs commands on the machine it is installed on. Please report vulnerabilities privately.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue for a security problem.

Include the commit you tested, how to reproduce it, and what an attacker gains. Never include your login token, CLI credentials or conversation transcripts.

## Scope

In scope: authentication and session handling, the `Host` / `Origin` checks, the permission flow, file and attachment APIs, and anything that lets a web page or another tailnet device act without the login token.

Out of scope: exposing the port to the public internet (unsupported), and behavior of the Claude Code, Codex or Gemini CLIs themselves.

Only the latest commit on `main` is supported. This is a personal project maintained on a best-effort basis.
