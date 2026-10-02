# Security

## Reporting a problem

Please report security problems privately, through this repository's **Security → Report a vulnerability** page (GitHub private vulnerability reporting). Don't open a public issue for them.

## How this project is secured

This is a single-user backend. If you deploy your own copy, these are the things to know:

- **The URLs are the credentials.** The MCP endpoint is `/mcp/<path-secret>` and the ingest endpoint is `/ingest/<ingest-path-secret>` plus an `X-Ingest-Key` header. Each secret is 64 random characters (384 bits), compared in constant time. A wrong secret gets the same 404 as an unknown path. Treat the output of `npm run url` and `npm run ingest-url` like passwords.
- **Secrets live only in SSM Parameter Store** (SecureString): the three endpoint secrets, the Oura client credentials and the Oura token pair. They are never in the repository, in Lambda environment variables or in the logs. `scripts/rotate-secret.sh` replaces one and recycles the running instances.
- **Keep the Function URL hostname private too.** The Function URL has no AWS auth (`AuthType: NONE`); reserved concurrency caps cost, but anyone who knows the hostname can occupy that concurrency with junk requests.
- **`deploy.env` is personal** (budget email, time zone) and git-ignored. Copy `deploy.env.example`.
- **The Lambda role is minimal:** read its own SSM parameters, write only the token parameter, and `Query`/`PutItem`/`DeleteItem`/`BatchWriteItem` on its one table.
- **Health data stays in your account:** one DynamoDB table with point-in-time recovery, retained if the stack is deleted. Logs hold counts, metric names and error messages (an error can quote a rejected value), never secrets or URL paths, and expire after 14 days.
