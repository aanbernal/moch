# Deploying the album

Status: **nothing in this document has been run.** No account exists, no git
remote is configured, nothing has been pushed or deployed. Every step below is
for Angel to do, or for Kiro to do only after Angel explicitly confirms that
step (Requirements 21.5 and 22).

## 1. How it fits together

```
Angel (phone/laptop)
   │  admin page commits to main (GitHub Git Data API)
   ▼
Private GitHub repo ──push to main──▶ GitHub Actions (.github/workflows/deploy.yml)
                                         │ npm ci → npm run build (guards, media, Eleventy, verify)
                                         ▼
                                      dist/ ──wrangler pages deploy──▶ Cloudflare Pages (pages.dev)
```

- The repo is private, so photos and letters are never public in GitHub.
- GitHub Actions does the build because it can install `ffmpeg` and `poppler-utils`.
  Cloudflare's own Git build does not guarantee those tools, so the Cloudflare
  project is a **Direct Upload** project and receives only the finished `dist/`.
- The NFC URL is the Pages site root (for example `https://album-ab12cd34.pages.dev/`).
  It stays the same when chapters are added, edited or removed.
- Privacy relies on `noindex` and an unguessable address. It is not authentication.

### Build settings (the values Cloudflare would ask for)

| Setting | Value |
|---|---|
| Build command | `npm run build` (run by GitHub Actions, not by Cloudflare) |
| Publish (output) directory | `dist` |
| Production branch | `main` |
| Node version | 24 |

If the Cloudflare dashboard shows these fields, it is because you chose a Git
integration. Do not do that for this project. Use Direct Upload (step 3).

## 2. Cost: $0 recurring

- Cloudflare Pages free plan: no charge for bandwidth, 25 MiB per file, 20,000
  files per deployment. Served videos are capped far below that and originals
  never reach `dist/`.
- GitHub private repo on a free account, plus GitHub Actions free allowance of
  2,000 minutes per month. A build with a warm cache takes about 1 to 3 minutes,
  and a cold build up to about 8 minutes.
- No custom server, no database, no paid plan, no custom domain required.
- Limits and prices change. Re-check the Cloudflare and GitHub pricing pages
  before relying on this, and note the date you checked.

## 3. One-time setup

Do these in order. Steps 1 to 7 change no code except step 5; step 8 is the
only one that publishes anything.

### Step 1. GitHub account and private repository

1. Create or sign in to a GitHub account that Angel owns.
2. Create a new repository, set to **Private**. Do not add a README, license or
   `.gitignore` (the local repo already has its history). Suggested name:
   `album` (any name works; you will put it in `content/site.json`).
3. Do not push yet. Copy the repository URL for step 8.

### Step 2. Cloudflare account and Pages project

1. Create a free Cloudflare account and verify the email.
2. Choose a project name that cannot be guessed: `album-` followed by 8 random
   lowercase letters or digits, for example `album-k3x9q2vd`. Generate it
   randomly (a password manager works) and do not use a name tied to Karla,
   Angel or the story. This name becomes the public address
   `https://<name>.pages.dev/`.
3. In the dashboard open Workers & Pages, create a Pages project, and choose
   **Direct Upload** (not "Connect to Git"). Use the random name from above.
   Upload any placeholder file if the dashboard insists on a first upload; the
   first workflow run replaces it.
4. Production branch: `main`.
5. Write down the **Account ID** (shown in the dashboard sidebar or the Pages
   overview).

### Step 3. Cloudflare API token for the workflow

1. In the Cloudflare dashboard open My Profile, then API Tokens, then Create
   Token, using a custom token.
2. Give it only the permission needed to deploy Pages: Account, Cloudflare Pages,
   Edit. Scope it to this single account. Name it `album-deploy`.
3. Copy the token once. Treat it as a password.

### Step 4. GitHub repository secrets and variable

In the GitHub repo open Settings, Secrets and variables, Actions.

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | the token from step 3 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 2 |
| Variable (not secret) | `CF_PROJECT` | the random project name, e.g. `album-k3x9q2vd` |

`deploy.yml` reads these as `secrets.CLOUDFLARE_API_TOKEN`,
`secrets.CLOUDFLARE_ACCOUNT_ID` and `vars.CF_PROJECT`. A wrong name here makes
the deploy step fail while the build step still passes.

### Step 5. Point the admin at the repo: `content/site.json`

Edit the `repo` object (it currently holds `REPLACE_` placeholders):

```json
"repo": {
  "owner": "<Angel's GitHub username>",
  "name": "<repository name from step 1>",
  "branch": "main"
}
```

Until this is replaced the build prints a warning and the admin refuses to run
with "Configura el repositorio". Commit this change locally before the initial
push.

### Step 6. Fine-grained personal access token for the admin page

The admin page writes to the repo with a token Angel creates once.

1. GitHub, Settings, Developer settings, Personal access tokens, Fine-grained
   tokens, Generate new token.
2. Resource owner: Angel's account. Repository access: **Only select
   repositories**, and pick the album repo only.
3. Repository permissions:
   - **Contents: Read and write** (needed to publish chapters).
   - **Actions: Read-only** (lets the admin show a failed build; without it the
     admin falls back to polling `build.json` only).
   - Leave every other permission at "No access". Metadata read is added
     automatically.
4. Set an expiry you can live with (for example 90 days) and put a reminder in
   a calendar. When it expires, create a new one and paste it into the admin.
5. Keep the token out of the repo, chat and screenshots. The admin encrypts it
   in the browser with Angel's password. Revoking the token on GitHub ends all
   admin access.

### Step 7. Check before pushing

Run locally in `album-site/`:

```
npm ci
npm test
npm run build
npm run preview
```

Open the preview URL on a phone-sized viewport and confirm the cover, a chapter
page and `/admin/` load. Confirm `dist/` has `robots.txt` with `Disallow: /`, no
`sitemap.xml`, and `_headers`.

### Step 8. Initial push (explicit confirmation required)

**Do not run this until Angel has said, in so many words, that Kiro (or he) may
push to GitHub.** Pushing starts the first workflow run and publishes the site
at the `pages.dev` address.

Before running it, verify:

- [ ] Steps 1 to 6 are done and `content/site.json` `repo` is real and committed.
- [ ] The Setlog guard passes (`npm run guard`) and `dist/` has no `setlog` text.
- [ ] Angel has approved which chapters and photos are included.
- [ ] The remote URL points at the private repo, not a public one.

Then:

```
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Nothing in this project runs these commands on its own.

## 4. First-deploy checklist

1. Watch the run in the repo's Actions tab. The first run has a cold cache and
   can take up to about 8 to 10 minutes.
2. The run uploads an artifact named `OPEN_ITEMS` (kept 30 days). Download it
   from the run page; the copy of `OPEN_ITEMS.md` in the repo can be stale
   after admin edits.
3. When green, open `https://<CF_PROJECT>.pages.dev/` on a phone.
4. Test steps:
   - The cover loads and "Abrir" goes to the table of contents.
   - Next, previous and table-of-contents controls work; swipe works.
   - A chapter deep link survives a reload.
   - A video plays with sound after tapping play.
   - Airplane mode after one visit still shows pages already read.
   - `/robots.txt` shows `Disallow: /`; `/sitemap.xml` returns 404; page source
     has `noindex,nofollow,noarchive`.
   - `/build.json` shows the commit sha of the push.
   - `/admin/` asks for a token and password, shows no chapter data before
     unlocking, then a small test edit publishes and appears in a few minutes.
5. Only after all of that, write the root URL to the NFC keychain. This project
   never programs a tag.

## 5. Day-to-day publishing

Angel adds or edits chapters in `/admin/`. Each publish is a commit to `main`.
Two quick publishes end in one deploy of the latest commit (workflow
`concurrency` cancels the older run). Expected time to live: about 2 to 4
minutes warm, up to about 10 cold (cache evicted after 7 days idle).

## 6. Rollback

Pick the smallest tool that works. None of these change the NFC URL.

1. **Undo a content change (most common):** in the GitHub repo open the commit
   list, open the bad commit, choose Revert (or revert in the web UI), and merge
   it to `main`. The workflow rebuilds and redeploys the previous content.
2. **Roll back the live site immediately:** in the Cloudflare dashboard open the
   Pages project, Deployments, choose an earlier good deployment, and use
   "Rollback to this deployment". Note that the next push to `main` will deploy
   again, so also revert the commit (option 1).
3. **A failed build changes nothing:** if the build or guard fails, the deploy
   step does not run and the previous deployment stays live. Fix or revert the
   cause and push again.
4. **Lost or leaked admin token:** revoke it at GitHub, Settings, Developer
   settings, Fine-grained tokens, then create a new one (step 6). "Olvidar este
   dispositivo" in the admin clears the stored encrypted token on that device.
5. **Leaked Cloudflare token:** roll or delete it in Cloudflare, create a new one
   and update the `CLOUDFLARE_API_TOKEN` secret.
6. **Take the site down:** in Cloudflare, delete the Pages project (the address
   stops working, and the same address cannot be assumed to be available again),
   or delete the latest deployments. Revoke the tokens as well.

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Build step fails | Read the log. Guard exit 3 means a Setlog item; exit 4 means a missing tool; exit 1 names the chapter and file. Fix the content and push again. |
| Build passes, deploy step fails | Wrong or expired `CLOUDFLARE_API_TOKEN`, wrong `CLOUDFLARE_ACCOUNT_ID`, `CF_PROJECT` unset or misspelled, or the Pages project does not exist yet. |
| Deploy fails with "project not found" | The Pages project from step 2 was not created as Direct Upload, or the name differs from `CF_PROJECT`. |
| Admin says "Configura el repositorio" | `content/site.json` `repo` still has `REPLACE_` values (step 5). |
| Admin says token invalid or no permission | Token expired, or not scoped to this repo with Contents: Read and write (step 6). |
| Admin cannot show build failures | Token lacks Actions: Read-only. Publishing still works. |
| Site does not update | Check the Actions tab for a failed or still-running job; then hard-reload (the service worker caches pages). |
| Actions minutes exhausted | The free allowance resets monthly. Builds are small, so this is unlikely. |

## 8. Verify before first use: workflow action versions

The action versions in `.github/workflows/deploy.yml` were chosen from memory
and the workflow has never run. Before the first push, check each against its
official page, and update `deploy.yml` if a major version has moved on or been
deprecated:

- `actions/checkout@v4`
- `actions/setup-node@v4` (and that Node 24 is available on the runner)
- `actions/cache@v4`
- `actions/upload-artifact@v4`
- `cloudflare/wrangler-action@v3` (and that `pages deploy dist --project-name=… --branch=main` is still the supported command)
- `runs-on: ubuntu-latest` still provides `apt-get` access to `ffmpeg` and `poppler-utils`

Also keep `PIPELINE_VERSION` in `deploy.yml` equal to the constant in
`lib/paths.mjs`; a unit test checks this.
