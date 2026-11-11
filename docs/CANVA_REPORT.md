# Canva report: API and share-link embed

Access date for every source below: **2026-11-10** (the day this report was written).
All statements are paraphrased. Anything I could not confirm is marked **UNCONFIRMED**.

Two options were asked about (Requirement 20):

- **Option A:** the Canva Connect API (called "Canva REST APIs" in the current docs).
- **Option B:** a Canva public-link embed (an iframe or link pointing at a Canva design).

A third path, not an "option to build", is **Option C: export from Canva and upload the file** through the admin. It is the one this site supports.

## Verdict

| Option | Clean chapter | Private | Phone-friendly | Build on it? |
|---|---|---|---|---|
| A. Connect API | No. Needs a Canva developer app, OAuth, tokens and a server holding a secret. | Partly. The data stays in the owner's Canva account, but the secret and refresh tokens need a safe home, and this site is static with no server. | Not applicable, it only fetches files. | **No** |
| B. Public-link embed | No. Third-party page inside an iframe, with Canva's frame and behavior. | **No.** Embedding makes the design public. | UNCONFIRMED. Not tested on a phone for this report. | **No** |
| C. Export and upload | Yes. The file is self-hosted, compressed by the build, no third-party requests. | Yes. Nothing is public on Canva, nothing is called from the page. | Yes. Same pipeline as any photo, video or PDF. | **Yes (already built)** |

Per Requirement 20.4 the site is not built on Canva, because no option A or B verdict is positive. Per Requirement 20.5 the admin accepts Canva exports regardless: PNG/JPG, PDF and MP4 upload already works through the admin upload path (Requirements 13.8 and 20.5; limits in the guide).

## Option A: Canva Connect API

### Access and OAuth

- The API is OAuth 2.0 only. Apps acting for a user use the authorization-code flow with PKCE and get a short-lived access token plus a single-use refresh token. Service apps use the client-credentials flow. Source: [Canva authentication docs](https://www.canva.dev/docs/connect/authentication/), accessed 2026-11-10.
- An app needs a client ID and a client secret created in the Developer Portal, and at least one redirect URL for user-based apps. Same source.
- The app type (public, private, or service) is chosen at creation and cannot be changed afterwards. Same source.
- Private apps ("restricted to your Canva team") are offered only on a Canva Enterprise plan. Source: [Quickstart](https://www.canva.dev/docs/connect/quickstart), accessed 2026-11-10. Note: that fetched page was the MCP variant of the quickstart; the app-type options it lists are the portal's general ones. The same wording for the REST APIs is UNCONFIRMED.
- A public app that uses preview APIs will not pass Canva's review. Source: [REST API overview](https://www.canva.dev/docs/connect/), accessed 2026-11-10.
- A Canva account used for the Developer Portal is described by a third-party summary as needing MFA enabled. That is UNCONFIRMED against Canva's own page. Source: [dlt docs summary](https://dlthub.com/context/source/canva), accessed 2026-11-10.
- Sources agree there is no static API key; every call runs under a token a person authorized. Source: [Activepieces guide](https://www.activepieces.com/blog/canva-api-how-the-connect-api-works-2026-guide), accessed 2026-11-10 (third party, so treat as secondary; matches the official docs above).

### Plan requirements

- Service apps draw on a team API credit pool; the team must buy credits before the app can make requests. Source: [Canva authentication docs](https://www.canva.dev/docs/connect/authentication/), accessed 2026-11-10. The price of credits: UNCONFIRMED (not read).
- Autofill requires a plan that includes it, such as Pro, Teams or Enterprise. Source: [Autofill guide](https://canva.dev/docs/connect/autofill-guide/), accessed 2026-11-10 (from a search snippet; page not fetched). Autofill is not needed for this site.
- Export of lossy PNG, transparent PNG and pro-quality exports need a plan with premium features; on the Free plan those requests fail, and Free-plan image upscaling is capped at a factor of 1.125. Source: [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/), accessed 2026-11-10.
- Whether a plain Free account can create an app and call basic endpoints at all (design list, export in regular quality): UNCONFIRMED. The developer prerequisites page says anyone with a standard Canva account can open the Developer Portal. Source: [Apps prerequisites](https://www.canva.dev/docs/apps/prerequisites/), accessed 2026-11-10 (search snippet; applies to the Apps SDK portal access, not necessarily to REST API calls).

### Rate limits

- Export creation: 20 requests per minute per user for public/private apps, 100 per minute per app for service apps. Additional throttles: 750 per 5 minutes and 5,000 per day per app; 75 per 5 minutes per document; 75 per 5 minutes and 500 per day per user. Download URLs expire after 24 hours. Source: [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/), accessed 2026-11-10.
- Export status check: 120 requests per minute per user. Source: [Get design export job](https://canva.dev/docs/connect/api-reference/exports/get-design-export-job/), accessed 2026-11-10 (search snippet).
- These limits are far above what a one-person album needs. They are not the obstacle.

### Export quality through the API

- Formats: JPG, PNG, GIF, PPTX, MP4, PDF, CSV and HTML. JPG has a quality setting 1 to 100. PNG is lossless by default. Image width and height up to 25,000 px. MP4 targets 480p, 720p, 1080p or 4K with the design's own aspect ratio. Source: [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/), accessed 2026-11-10.
- Quality is as good as the manual download. The API gives no advantage over exporting by hand and uploading.

### Privacy and phone friendliness

- Using the API would put a client secret and long-lived refresh token somewhere. This site is static hosting with a GitHub-backed admin and no server, so there is no safe place for the secret. Putting it in browser code would break the rule above ("don't include it in a client-side bundle"). Source: [Quickstart](https://www.canva.dev/docs/connect/quickstart), accessed 2026-11-10 (the secret-handling advice, stated there for the MCP flow). This is an architectural judgment, not a Canva statement.
- The API only returns files, so visitors on a phone would see the same exported file as in option C. Phone friendliness depends on the file, not the API.

### Verdict for option A

Not clean (a developer app, OAuth and credentials to maintain). Not private-by-default for a static site (secret handling). Phone-friendliness is neutral. Gain over manual export: none. **Do not build.**

## Option B: share-link / public-link embed

### How it works

- A "public view link" lets anyone who has it view the design. It can be deleted to make the design private again. Source: [Share your design as a public view link](https://www.canva.com/en_gb/help/sharing-your-design-as-a-public-view-link/), accessed 2026-11-10 (search snippet).
- Embedding a design needs the design to be made public, and the user confirms this when choosing Embed. Embeds can be unpublished. Source: [Embedding designs and unpublishing embeds](https://www.canva.com/help/embed-designs/), accessed 2026-11-10 (search snippet; the full page could not be fetched, it returned an unsupported-browser message).
- Sharing options include "Only you can access" (default) and "Anyone with the link". Source: [Sharing designs via email or links](https://www.canva.com/en_gb/help/share-via-link-or-email/), accessed 2026-11-10 (search snippet).
- Private embeds on allow-listed domains are an Enterprise admin control. Source: [Admin controls on sharing and publishing](https://www.canva.com/en_gb/help/admin-control-sharing-publishing-content-for-enterprise/), accessed 2026-11-10 (search snippet). Not available to a personal account (inferred; UNCONFIRMED whether lower plans have anything similar).

### Privacy

- The design is publicly reachable by anyone who has the link. A secondary source advises treating "anyone with the link" as internet-wide access and not as a private channel. Source: [Cloudspress](https://www.cloudspress.com/how-to-share-canva-designs-without-exposing-private-links-or-personal-information/), accessed 2026-11-10 (third party opinion).
- The album is meant to be a private gift. A public design contradicts that, and the link cannot be hidden from visitors who open the page source. **Fails the "private" test.**
- Embedding also loads Canva's third-party page and scripts into the album. Whether it sets cookies or tracking: UNCONFIRMED. See [Canva privacy](https://www.canva.com/en_in/trust/privacy/) (accessed 2026-11-10, not read in detail).

### Export quality and "clean" look

- The embed is a rendered view in Canva's own frame, so the look and controls are Canva's, not the album's. Exact frame chrome, branding and whether it can be hidden: UNCONFIRMED.
- It does not let the build compress, cache offline (the service worker cannot cache a cross-origin frame in a dependable way; this is an engineering inference), or keep the album working without Canva being reachable. **Fails "clean".**

### Phone friendliness

- Whether a Canva embed scales and scrolls well on a 390 px wide phone: UNCONFIRMED. I did not test an actual embed. It depends on the design's aspect ratio and Canva's viewer. Treat as not shown to be phone-friendly.

### Verdict for option B

Not clean, not private, phone-friendliness unconfirmed. **Do not build.**

## Option C: Canva export, then upload (what the site does)

- Canva can download designs as PNG/JPG, PDF and MP4. Free plan downloads work; quality controls, compression and transparent PNG are for paid plans. Source: [Choose the right download file type](https://www.canva.com/help/download-file-types/), accessed 2026-11-10 (search snippet). Transparent downloads need Pro, Teams, Business, Education or Nonprofits: [Download design with transparent background](https://www.canva.com/en_gb/help/transparent-background/), accessed 2026-11-10 (snippet).
- A paid plan can raise size and quality settings on JPG/PNG if a download looks blurry: [Downloaded design looks blurry](https://www.canva.com/help/blurry-design/), accessed 2026-11-10 (snippet).
- Practical advice for the guide: export PNG or JPG for pages, PDF only if the page count is fine, MP4 for animated pages (mind the 25 MB video limit). A transparent PNG is accepted; the admin fills it white before converting to JPEG.
- Verdict: clean, private, phone-friendly. Already supported (Requirements 13.8, 20.5).

## Open items and limits of this research

- Canva's help center pages block direct fetching (unsupported-client response). Help center claims therefore come from search-result snippets and are labeled as such. Re-check them in a browser before relying on a detail.
- Plan names and limits change over time. This is a snapshot from 2026-11-10.
- Items marked UNCONFIRMED: Free-account access to the REST API, credit pricing, developer MFA rule, embed frame chrome and tracking, embed on phone.
- None of the UNCONFIRMED items can change the verdict: option A has no gain over option C, and option B is public.

## Sources (all accessed 2026-11-10)

- https://www.canva.dev/docs/connect/
- https://www.canva.dev/docs/connect/authentication/
- https://www.canva.dev/docs/connect/quickstart
- https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/
- https://canva.dev/docs/connect/api-reference/exports/get-design-export-job/
- https://canva.dev/docs/connect/autofill-guide/
- https://www.canva.dev/docs/apps/prerequisites/
- https://www.canva.com/help/embed-designs/
- https://www.canva.com/en_gb/help/sharing-your-design-as-a-public-view-link/
- https://www.canva.com/en_gb/help/share-via-link-or-email/
- https://www.canva.com/en_gb/help/admin-control-sharing-publishing-content-for-enterprise/
- https://www.canva.com/help/download-file-types/
- https://www.canva.com/en_gb/help/transparent-background/
- https://www.canva.com/help/blurry-design/
- https://www.canva.com/en_in/trust/privacy/
- https://dlthub.com/context/source/canva
- https://www.activepieces.com/blog/canva-api-how-the-connect-api-works-2026-guide
- https://www.cloudspress.com/how-to-share-canva-designs-without-exposing-private-links-or-personal-information/
