# Releasing

## One-time setup

### Visual Studio Marketplace (publisher `TwoGuysDev`)

The publisher exists at <https://marketplace.visualstudio.com/manage/publishers/twoguysdev>. Its ID must match `publisher` in `package.json`.

CI publishes with **Trusted Publishing** (GitHub OIDC): no token is stored anywhere.

1. In the publisher page, open **Trusted Publishing** and add a policy for GitHub Actions:
   - owner / organization: `TwoGuysDev`
   - repository: `explorer-for-penpot`
   - workflow file: `release.yml`
   - environment: `release` (if the form asks for one)
2. In GitHub → repository **Settings → Environments**, create the `release` environment. Optionally restrict it to tags `v*` and require an approval.

### Open VSX (Cursor, VSCodium, Windsurf…)

1. Sign in at <https://open-vsx.org> with GitHub, sign the Eclipse publisher agreement and create an access token.
2. Create the namespace once: `npx ovsx create-namespace TwoGuysDev -p <token>`.
3. Add the token as the `OVSX_PAT` secret of the `release` environment.

## Each release

1. Update `CHANGELOG.md` (move *Unreleased* to the version and date) and bump `version` in `package.json`.
2. Commit, then tag and push:
   ```sh
   git tag v0.2.1      # or v0.3.0-beta.1 for a pre-release
   git push origin main --tags
   ```
3. The **Release** workflow tests, packages, publishes to both stores and creates the GitHub release with the `.vsix`.

The Marketplace credential from Trusted Publishing lasts 15 minutes and each GitHub OIDC token can be exchanged once, so a failed run is retried by re-running the workflow, not by reusing a token.

## Manual publishing (fallback)

```sh
npm run package                       # explorer-for-penpot-<version>.vsix
npx vsce publish --azure-credential   # after `az login` with an account that is a publisher member
npx ovsx publish -p <token>
```
