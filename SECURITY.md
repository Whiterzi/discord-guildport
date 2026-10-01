# Security

This is an experimental bot relay. Authentication and per-user authorization are security boundaries. Do not deploy it as a generic Discord API proxy, distribute a bot token to clients, or use Discord user tokens.

For a security report, use GitHub's private vulnerability reporting on this repository when enabled. If that option is unavailable, open an issue requesting a private contact without posting exploit details, credentials or private messages.

Operators should run a single instance with HTTPS, private encrypted host storage, explicit channel opt-in and current supported dependencies. See `docs/privacy.md` for retained data and limitations.
