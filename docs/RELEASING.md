# Releasing Token Envy

Token Envy publishes from GitHub Actions with npm trusted publishing. The
release workflow uses short-lived OIDC credentials; it does not use an
`NPM_TOKEN` secret. npm automatically generates provenance for public packages
published from the public GitHub repository.

## One-time bootstrap

npm requires a package to exist before a trusted publisher can be attached.
The first release is therefore the only publish made from an authenticated
maintainer session.

1. Create the public `provos/tokenenvy` GitHub repository, add it as `origin`,
   and push `main`. The repository coordinates must exactly match
   `package.json`.
2. Use Node.js 22.14 or newer and npm 11.5.1 or newer. Sign in with
   `npm login --auth-type=web` and ensure account-level 2FA is enabled.
3. Run the release gates:

   ```bash
   npm run check
   npm test
   npm run test:package
   npm audit --omit=dev
   ```

4. Confirm `tokenenvy` is still available, inspect the tarball, and publish the
   first public version:

   ```bash
   npm view tokenenvy
   npm pack --dry-run
   npm publish --access public
   ```

5. Attach the GitHub Actions trusted publisher to the now-existing package:

   ```bash
   npm trust github tokenenvy \
     --repo provos/tokenenvy \
     --file publish.yml \
     --env npm \
     --allow-publish
   ```

   The equivalent npmjs.com settings are: GitHub owner `provos`, repository
   `tokenenvy`, workflow filename `publish.yml`, environment `npm`, and allowed
   action `npm publish`.

6. In the GitHub repository settings, configure the `npm` environment with the
   desired deployment reviewers and tag protection. After one trusted release
   succeeds, disallow token-based package publishing and revoke any obsolete
   automation tokens.

## Subsequent releases

1. Update and commit the version in `package.json` and `package-lock.json`.
2. Push the release commit to `main`.
3. Create and publish a GitHub Release tagged `v<package version>` from that
   commit. The workflow rejects a tag that does not exactly match
   `package.json`.
4. Confirm the Actions job completed, then verify the registry version and
   provenance:

   ```bash
   npm view tokenenvy version
   npm audit signatures
   ```

The trusted publisher is case-sensitive and permits only one configured
provider per package. It requires the workflow to run on a GitHub-hosted runner
with `id-token: write` permission.
