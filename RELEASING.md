# Releasing

## One-time setup

### Visual Studio Marketplace (publisher `twoguysdev`)

1. Create the publisher at <https://marketplace.visualstudio.com/manage> with the ID `twoguysdev` (it must match `publisher` in `package.json`).
2. Global Azure DevOps personal access tokens are retired on **2026-12-01**, so CI signs in with **Microsoft Entra ID** through GitHub OIDC:
   1. In the Azure portal, create an app registration (for example `explorer-for-penpot-release`).
   2. Under *Certificates & secrets → Federated credentials*, add a **GitHub Actions** credential for `TwoGuysDev/explorer-for-penpot`, entity **Environment**, name `release`.
   3. Give the app access to the Marketplace publisher: add its identity as a member of the `twoguysdev` publisher with the **Contributor** role (Marketplace → Manage → publisher → Members). Check the current VS Code docs ("Publishing Extensions") if the screen differs.
   4. In GitHub → Settings → Environments, create `release` and add the secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.

### Open VSX (Cursor, VSCodium, Windsurf…)

1. Sign in at <https://open-vsx.org> with GitHub, sign the Eclipse publisher agreement and create an access token.
2. Create the namespace once: `npx ovsx create-namespace twoguysdev -p <token>`.
3. Add the token as the `OVSX_PAT` secret of the `release` environment.

## Each release

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. Commit, then tag and push:
   ```sh
   git tag v0.2.0      # or v0.3.0-beta.1 for a pre-release
   git push origin main --tags
   ```
3. The **Release** workflow tests, packages, publishes to both stores and creates the GitHub release with the `.vsix`.

## Manual publishing (fallback)

```sh
npm run package                       # explorer-for-penpot-<version>.vsix
npx vsce publish --azure-credential   # after `az login` with an account that is a publisher member
npx ovsx publish -p <token>
```
