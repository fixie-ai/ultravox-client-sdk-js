## Publishing ultravox-client to npm

The ultravox-client for web is available on [npm](https://www.npmjs.com/package/ultravox-client).

Publishing is handled by the [release workflow](.github/workflows/release.yml), which uses npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm authenticates the workflow
itself via OIDC, so there are no npm tokens to store or refresh.

To publish a new version:

1. **Use Example** → Use the included example application (`pnpm serve-example`) to make test calls.
1. **Version Bump** → Increment the version number in `package.json`.
1. **Error Check** → Run `pnpm publish --dry-run --git-checks=false` and deal with any errors or unexpected includes.
1. **Merge to main** → Open a PR in GitHub and get the changes merged.
1. **Release** → Create a new tag and release in GitHub. The tag must match the version in
   `package.json` (e.g. `0.6.0`); publishing the release triggers the workflow, which runs the
   tests and publishes to npm.

### One-time setup

The workflow works because of two pieces of configuration:

- This repository is configured as a trusted publisher for the package on npmjs.com: package
  **Settings** → **Trusted Publisher** → GitHub Actions, with organization `fixie-ai`,
  repository `ultravox-client-sdk-js`, workflow filename `release.yml`, and environment
  `release`.
- The repository has a `release` environment (repo **Settings** → **Environments**) whose
  protection rules require reviewer approval, so every publish needs an explicit human
  sign-off even when the release was created by an authorized account. Its deployment tag
  pattern (`[0-9]*.[0-9]*.[0-9]*`, Ruby `File.fnmatch` syntax) limits which refs may deploy;
  note that release-triggered runs match against the _tag_, not a branch.
