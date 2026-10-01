# Release procedure

Repository: `Whiterzi/discord-guildport`. npm package: `discord-guildport`. Executable: `dcgp`. Python distribution: `discord-guildport-server`; import package: `guildport`.

1. Run Python tests, npm tests (including the local Python integration), and the PTY interaction smoke test. Complete the live Discord checklist in `deployment.md` before claiming production readiness.
2. Build the Python distribution with `.venv/bin/python -m build server`.
3. In `cli`, run `npm pack --dry-run`, inspect the file allowlist, and create a tarball using `npm pack`. Install that tarball into a clean prefix and check `dcgp --help` and the offline demo. Only compiled JavaScript, package metadata, README and LICENSE should ship.
4. Push the reviewed source to the public repository. GitHub deploy keys grant repository access; they do not authorize npm publishing.
5. Authenticate as the npm package owner using `npm login`, with any required browser/2FA flow. Review the package name and version. Publish the tested alpha with `npm publish --access public --tag alpha` from `cli`. A dry run or tarball build does not publish it.
6. Verify `npm view discord-guildport@alpha version` and install the registry version in a clean directory. Update README status after successful publication.

The full-screen CLI is version `0.1.0-alpha.2`; its source version does not imply that it has already been published. `/dcgp` uses the npm `alpha` dist-tag, so it begins serving the new CLI after the maintainer publishes that tag. The server remains compatible with CLI alpha.1. Do not point generated commands at an unpublished exact version.

Do not commit `.npmrc`, registry tokens, deployment keys, `.env`, local sessions, runtime databases, logs or actual deployment domains. Configure trusted publishing separately if CI releases are desired; CI currently validates builds only and has no publishing credentials.
