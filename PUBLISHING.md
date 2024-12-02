## Publishing ultravox-client to npm

The ultravox-client for web is available on [npm](https://www.npmjs.com/package/ultravox-client).

To publish a new version:

1. **Version Bump** → Increment the version number in `package.json`.
1. **Error Check** → Run `pnpm publish --dry-run --git-checks=false` and deal with any errors or unexpected includes.
1. **Merge to main** → Open a PR in GitHub and get the changes merged.
1. **Publish** → Switch back to `main` branch, use `git pull` to pull down your changes and finally run `pnpm publish`.
1. **Tag/Release** → Create a new tag and release in GitHub please.
