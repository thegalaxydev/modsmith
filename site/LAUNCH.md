# Website launch and indexing checklist

The website is generated from `site/` and deployed to GitHub Pages by `.github/workflows/site.yml`. Its address is set once in `site/site.config.mjs` (`origin` and `basePath`) and used for canonical URLs, social previews, the sitemap and structured data.

Production address: <https://thegalaxydev.github.io/modsmith/>

## 1. Turn on GitHub Pages

1. In the repository, open **Settings › Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Merge the website changes into `master`, or run the **Website** workflow from the Actions tab.
4. Open <https://thegalaxydev.github.io/modsmith/> and check the home page, a guide and a missing address such as `/modsmith/nothing/`, which should show the site's 404 page.

The workflow runs again when files in `site/` change and after each successful **Release** workflow, so download links always point at the newest release's files.

## 2. Link the website and the repository

- In the repository's **About** settings (the gear next to About on the main page), set **Website** to `https://thegalaxydev.github.io/modsmith/`.
- The README already links to the website, and every page of the website links back to the repository.

## 3. Google Search Console

1. Go to <https://search.google.com/search-console> and add a **URL prefix** property for `https://thegalaxydev.github.io/modsmith/`. A Domain property is not possible for `github.io`.
2. Verify ownership with the **HTML tag** method: copy the `google-site-verification` meta tag Google shows you, add it to the `head` array in `site/build.mjs`, push, wait for the Website workflow to finish, then press **Verify**. Alternatively upload the HTML file Google offers to `site/static/`.
3. Under **Sitemaps**, submit `https://thegalaxydev.github.io/modsmith/sitemap.xml`.
4. With **URL inspection**, inspect the home page, `/modsmith/download/` and `/modsmith/docs/getting-started/`, and use **Request indexing** for each. Do this once after launch, not repeatedly.
5. Check **Pages** (indexing report) after a week or two for excluded URLs.

Search engines only read `robots.txt` at the root of a host. For a project site that is `https://thegalaxydev.github.io/robots.txt`, which this repository does not control, so `/modsmith/robots.txt` is informational until the site moves to its own domain. Submitting the sitemap directly, as above, is what matters.

## 4. Bing Webmaster Tools

1. Go to <https://www.bing.com/webmasters>. Either import the verified site from Google Search Console, or add `https://thegalaxydev.github.io/modsmith/` and verify with the meta tag method in the same way.
2. Submit the same sitemap URL.
3. Use **URL Inspection** on the home page and request indexing.

## 5. Announce real releases

- Write a short release announcement for each notable version: what changed, a screenshot or short video of a real workflow, and links to the release and the website.
- Share it where Minecraft mod developers already talk about tools, following each community's rules on self-promotion: for example the Fabric and NeoForge community Discord servers' showcase channels, r/feedthebeast or r/fabricmc where tool posts are allowed, and your own social accounts.
- Demonstrations that show a real task (creating a mod, testing against a modpack, debugging) are more useful than feature lists.
- Do not buy backlinks, post the same message to many places, or post where tool announcements are not welcome.

## 6. If you get a custom domain

1. Change `origin` (and `basePath` to `/` if the site is at the root) in `site/site.config.mjs`.
2. Add the domain in **Settings › Pages** and a `CNAME` file in `site/static/`.
3. Add the new address as a Search Console property and submit its sitemap. GitHub Pages redirects the old `github.io` address to the custom domain.

## After each change to the site

```bash
npm run site:serve
```

Open <http://127.0.0.1:4321/modsmith/> and check the pages you changed. The build fails loudly if a content file is missing; check links to GitHub docs by hand when files in `docs/` are renamed.
