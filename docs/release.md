<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Releasing

Part of the [Token Pace documentation](../README.md#documentation).

One tag push publishes everywhere: a GitHub release with the `.vsix` attached, the Visual
Studio Marketplace and Open VSX. This page is the recipe and the account upkeep around it —
the two things that fail silently are an expired token and a store page that nobody
re-published.

## The recipe

Everything below happens on `roadmap-1.0`, and nothing is pushed before Frederik says so.

1. **Gates green.** `npx tsc --noEmit -p .`, `node build.mjs`,
   `CI=true TZ=UTC LANG=en_US.UTF-8 HOME=$(mktemp -d) npm test`, `node scripts/check-privacy.mjs`.
2. **CHANGELOG.** A new section at the top, written for a reader of the store page, not for a
   reader of the diff.
3. **Version.** `npm version <x.y.z> --no-git-tag-version` — the tag comes from git, not from
   npm, so the working tree stays the single place the number is decided.
4. **Package and try it.** `npm run package` builds, runs the privacy check and writes
   `token-pace-<x.y.z>.vsix`; install it into the isolated profile *and* the real one
   (`code --install-extension token-pace-<x.y.z>.vsix`, then *Restart Extensions*) and look at
   the result in a real window before any of it leaves the machine.
5. **Commit and push** the release commit to `roadmap-1.0` and `main`.
6. **Tag.** `git tag v<x.y.z> && git push origin v<x.y.z>`. The tag push is what triggers
   `.github/workflows/release.yml`; a push of the branch alone publishes nothing.
7. **Watch the run.** The workflow type-checks, builds, tests, runs the privacy check,
   packages, creates the GitHub release, then publishes to the Marketplace and to Open VSX.
   Each publish step is `if: env.<TOKEN> != ''`, so a missing secret **skips** the step
   instead of failing the job — a green run is not by itself proof that anything was
   published. Read the step list.
8. **Confirm on both stores.** Open VSX usually shows the new version after a few minutes,
   the Marketplace after roughly ten. Without a login:
   `https://open-vsx.org/api/frederik/token-pace` returns the published version as JSON, and
   the Marketplace answers a `POST` to
   `https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery` with filter
   type 7 for `frederik.token-pace` and flags 1.

**The store overview is the packaged `README.md`.** It is only ever updated by publishing a
new version — editing the file on GitHub changes nothing on either store page. That is why a
docs-only release (1.2.3 was one) is a normal release with a version bump, a CHANGELOG entry
and a tag.

Relative links in the README are rewritten by `vsce` against the repository URL, so every
`docs/*.md` and `media/*.png` link on the store page resolves against
`https://github.com/mfvdp/VS-Code_Token-Usage` — and only if that file exists **on the default
branch**. A picture or a docs page added in a release commit that has not reached `main` is a
404 on the store page.

## The two secrets

Both live in the repository's *Settings → Secrets and variables → Actions*.

| Secret | For | Where it comes from |
|---|---|---|
| `VSCE_PAT` | Visual Studio Marketplace (`vsce publish`) | An Azure DevOps **personal access token** for the organisation that owns the publisher, scope *Marketplace → Manage*, "All accessible organizations" |
| `OVSX_PAT` | Open VSX (`ovsx publish`) | An access token created in the Open VSX user settings of the account that owns the namespace |

Azure DevOps personal access tokens always expire — a year at most, and the page offers much
shorter defaults. When it has expired the Marketplace step does not stop the release: the
token is still present, so the step runs, `vsce` fails on an authentication error, and what
you get is one red step at the end of an otherwise finished release, with the GitHub release
and Open VSX already done. The expiry date is deliberately **not** written here — this is a
public repository and nothing about the tokens belongs in it. Look it up before a release in
Azure DevOps under *User settings → Personal access tokens*, and renew the token *before* a
release rather than during one.

`ovsx publish` needs the **namespace to exist**; `release.yml` has no create-namespace step.
The namespace `frederik` was created by hand once (Open VSX → *Namespaces* → create, with the
account that holds `OVSX_PAT`). A brand-new namespace, or a publisher name change, has to be
created again by hand before the first publish under it.

## Publisher verification on the Marketplace

The publisher `frederik` is **not verified** yet, so the store page shows the name without a
verified badge. Verification is a domain check, not a company check:

1. Open the publisher's [manage page](https://marketplace.visualstudio.com/manage) and sign in
   with the account that owns the publisher.
2. Choose *Verify* beside the publisher name and enter the domain to verify: **`pdvfm.de`**.
3. The page hands out a **TXT record**. Add it to the DNS zone of `pdvfm.de` at the name the
   page states (`_vsmarketplace` or the apex, whichever it asks for) with the value it shows,
   verbatim and unquoted.
4. Wait for the record to propagate — minutes with a low TTL, up to a day with a long one —
   then press *Verify* again on the same page.
5. The badge appears on the store page once the check passes. The record has to stay in the
   zone: the Marketplace re-checks it, and removing it removes the badge.

The domain must match the `publisher` account, not the extension: nothing in `package.json`
changes, and no re-publish is needed for the badge to appear.

## When something goes wrong

* **A publish step was skipped.** Its secret is missing or empty. Add it and re-run the
  workflow from the GitHub UI — a re-run of the same tag republishes the same `.vsix`.
* **The Marketplace step failed on authentication.** `VSCE_PAT` has expired or lost its
  Marketplace scope. Renew it, fill in the expiry line above, re-run the workflow.
* **Open VSX rejects the namespace.** The namespace does not exist yet, or `OVSX_PAT` belongs
  to an account without access to it. Create it, then re-run.
* **The store page still shows the old text.** Nothing published, or the version was not
  bumped — the stores refuse a second upload of a version they already have.
* **A picture or a docs link 404s on the store page.** The file is not on the default branch.
  Push it to `main` and republish.
