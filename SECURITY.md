# Security

Explorer for Penpot handles a Penpot access token. If you find a way the token could leak, or a way design data could run code in VS Code, please **do not open a public issue**. Report it privately through [GitHub security advisories](https://github.com/TwoGuysDev/explorer-for-penpot/security/advisories/new).

What the extension does with your token:

- stores it only in VS Code's secret storage;
- sends it only to the Penpot server configured in `penpotExplorer.serverUrl`, in the `Authorization` header;
- never logs it or sends it anywhere else.

If you think your token was exposed, revoke it in Penpot (Your account → Integrations → Access tokens) and create a new one.
