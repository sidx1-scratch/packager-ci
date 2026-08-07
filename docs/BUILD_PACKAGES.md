Building .deb and .rpm packages via GitHub Actions

This repository includes a GitHub Actions workflow (.github/workflows/build-packages.yml) that will build .deb and .rpm packages from a release ZIP asset.

How it works

1. Publish a GitHub Release for this repository and attach a ZIP asset containing the packaged application (the output of the Packager web UI). The workflow will look for the first ZIP asset in the release.
2. When the release is published the workflow runs on ubuntu-latest, installs fpm and rpm build tools, extracts the ZIP, and runs fpm to create .deb and .rpm artifacts.
3. The generated .deb/.rpm files are uploaded as workflow artifacts. Download them from the Actions run summary.

Recommendations

- Name the ZIP asset something descriptive and ending with .zip (the workflow picks the first .zip it finds).
- Use semantic release tags (v1.2.3) so generated package versions match the release tag.
- If you need custom package metadata (maintainer, description), set them in the Packager UI before creating the ZIP asset.

Advanced

- You can modify the workflow to select a specific asset by filename or pattern if you publish multiple assets.
- CI is the recommended place to build OS packages because serverless environments (Vercel) cannot install system packaging tools like rpm/rpmbuild/fpm.
