# Contributing

Issues and pull requests are welcome. This is a personal project, so reviews are best-effort.

```bash
npm install
npm run typecheck
npm test          # unit tests; no network or accounts needed
npm run build
```

- Do not run `npm run test:e2e` unless you mean to: it runs real turns on your logged-in accounts.
- Any change to `src/shared/protocol.ts` must follow [docs/protocol.md](docs/protocol.md): new fields are optional, nothing is removed or narrowed, and new server behavior gets a feature name.
- Keep fixtures free of personal data. Use `/Users/alice`, `deck-host.example.ts.net` and `acme-app`.
- UI strings are Korean for now; keep new strings consistent with the existing ones.
- Add or update tests next to the code you change (`*.test.ts`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for an overview.
