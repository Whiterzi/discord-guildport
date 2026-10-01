# Release procedure

Repository: `Whiterzi/discord-guildport`. npm package: `discord-guildport`. Executable: `dcgp`. Python distribution: `discord-guildport-server`; import package: `guildport`.

CLI **0.1.0** is the first release without an alpha suffix. It includes full-screen chat, searchable server/channel menus, history pagination, Shift+Enter support in compatible terminals (Ctrl+J fallback), and prompt cancellation/terminal restoration. The Python relay is **0.1.0a6** (web client included), a prerelease intended for small deployments; this CLI release does not change its capacity limits. Server 0.1.0a5 or newer is recommended for the permission-query latency fix.

## Validate the release

1. Run `npm ci --prefix web` and `npm run build --prefix web`. Run Python tests, CLI npm tests (including the local Python integration), the PTY interaction smoke test, and `npm test --prefix web` (install Chromium with `cd web && npx playwright install chromium` first). Complete the live Discord checklist in `deployment.md` for each relay deployment.
2. For a Python server release, build its distribution with `.venv/bin/python -m build server`. Inspect the wheel for the compiled web assets. The CLI can be published independently; web-only changes do not require republishing the CLI.
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

npm may scan a new publication before it becomes installable, typically for several minutes. During processing, `latest` can still point to the old version; do not repeatedly republish. Wait for the registry to expose the intended version before installing it. See the [npm publish-time scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

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

Existing sessions remain compatible. Publishing `latest` does not move the `alpha` tag. Server 0.1.0a6 generates `/dcgp` commands using `@latest`, after verifying CLI 0.1.0 publication. Older deployments may still use `@alpha`. Do not point generated commands at an unpublished exact version.

Do not commit `.npmrc`, registry tokens, deployment keys, `.env`, local sessions, runtime databases, logs or actual deployment domains. Configure trusted publishing separately if CI releases are desired; CI currently validates builds only and has no publishing credentials.
