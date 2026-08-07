Vercel deployment & environment setup for automatic packaging

This doc explains how to configure Vercel so the Packager web UI can automatically publish a ZIP to GitHub, trigger CI to build .deb/.rpm, and let users download built packages.

1) Vercel project
- Import the repository (e.g., sidx1-scratch/packager-ci) into Vercel.
- Build Command: npm run build-prod
- Output Directory: dist

2) Environment variables (Vercel Dashboard → Project → Settings → Environment Variables)
- GITHUB_TOKEN: a Personal Access Token with `repo` scope (for public repos `public_repo` may suffice). This token is used by /api/publish-release and /api/download-latest when proxying private assets.
- GITHUB_REPO (optional): owner/repo to use when different from the default (defaults to sidx1-scratch/packager-ci).

Notes on tokens
- Personal Access Tokens (PATs) can be long-lived if you set them as such; prefer a dedicated machine account or GitHub App for production.
- If you cannot or do not want to store a token on Vercel, make the repository public and create Releases via the GitHub UI; the CI workflow will still run and the UI will poll/download artifacts without a token.

3) Testing the flow
- Deploy your Vercel site.
- In the Packager UI: enable Linux target, set package name and version, enable "Automatically publish ZIP...", and click Pack.
- On success, the UI will create a Release via /api/publish-release, CI will run, and the UI will poll for the built package. When ready, it will open the .rpm/.deb link.

4) Troubleshooting
- If the UI says publish failed, check Vercel function logs and ensure GITHUB_TOKEN has correct permissions.
- If packages never appear, check the Actions run for the Release and inspect logs/errors in the build-packages job.

5) Security recommendation
- Use a dedicated machine user with a PAT or a GitHub App with installation tokens in production to avoid tying the token to a personal account.

References
- docs/BUILD_PACKAGES.md — general CI packaging flow
