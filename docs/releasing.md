# Release procedure

Repository: `Whiterzi/discord-guildport`. npm package: `discord-guildport`. Executable: `dcgp`. Python distribution: `discord-guildport-server`; import package: `guildport`.

CLI **0.1.0** is the first release without an alpha suffix. It includes full-screen chat, searchable server/channel menus, history pagination, Shift+Enter support in compatible terminals (Ctrl+J fallback), and prompt cancellation/terminal restoration. The Python relay remains **0.1.0a5**, a prerelease intended for small deployments; this CLI release does not change its capacity limits. Server 0.1.0a5 or newer is recommended for the permission-query latency fix.

## Validate the release

1. Run Python tests, npm tests (including the local Python integration), and the PTY interaction smoke test. Complete the live Discord checklist in `deployment.md` for each relay deployment.
2. For a Python server release, build its distribution with `.venv/bin/python -m build server`. The CLI can be published independently.
3. In `cli`, run `npm pack --dry-run`, inspect the file allowlist, and create a tarball using `npm pack`. Install that tarball into a clean prefix and check `dcgp --version`, `dcgp --help` and the offline demo. Only compiled JavaScript, package metadata, README and LICENSE should ship. Run `scripts/smoke_interactive.py` with `GUILDPORT_TEST_CLI` pointing to the installed `dist/main.js` to test the packaged client.
4. Push the reviewed source to the public repository and verify CI. GitHub deploy keys grant repository access; they do not authorize npm publishing.

## Publish from the maintainer's checkout

Use Node.js 22.13 or newer. Start at the repository root, with a clean checkout:

```sh
git pull --ff-only
cd cli
npm ci
npm pkg get name version publishConfig
npm publish --dry-run
npm publish
```

Confirm the package name is `discord-guildport` and the version is `0.1.0`. `publishConfig` already sets `access: public` and `tag: latest`; the explicit equivalent is `npm publish --access public --tag latest`. `prepack` compiles TypeScript automatically. If this machine is not authenticated, run `npm login` as the package owner and complete any browser/2FA prompt. The package is unscoped, so it publishes as `discord-guildport` rather than under an organization scope. A dry run, source push or tarball build does not publish it.

Verify the registry and installed executable after publication:

```sh
npm view discord-guildport@latest version
npm install --global discord-guildport@latest
dcgp --version
```

Both version checks should report `0.1.0`. Also test a clean installation without an existing global CLI:

```sh
npx --yes --package=discord-guildport@0.1.0 dcgp --version
```

Existing sessions remain compatible. Publishing `latest` does not move the `alpha` tag. Existing `/dcgp` deployments still generate commands using `@alpha`; update those commands to `@latest` and deploy the bot only after the registry confirms `0.1.0` is available. Until then, keep the deployed command working with its current tag. Do not point generated commands at an unpublished exact version.

Do not commit `.npmrc`, registry tokens, deployment keys, `.env`, local sessions, runtime databases, logs or actual deployment domains. Configure trusted publishing separately if CI releases are desired; CI currently validates builds only and has no publishing credentials.
