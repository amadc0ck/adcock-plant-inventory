/* RSS 2.0 feed of the justamanda.net journal.

   Public, no auth: verify_jwt is off and the read goes through the publishable
   key, so RLS (posts_public_read) decides what appears. Only published posts
   with a published_at in the past ever come back, which is exactly the feed.
   No service-role key is used here, deliberately: a bug in this file can never
   leak a draft.

   Generated on request rather than written to the site as a file, because
   posts live in the database and the site has no build step. Publishing in
   admin is all it takes for a post to appear here.

   Image paths in posts may be relative ("images/..."), written for pages that
   live at the site root. Feed readers have no such base, so every src/href in
   the body and the cover is made absolute against SITE. */

const SITE = "https://justamanda.net";
// Public by design, the same key site.js ships to every reader.
const PUBLISHABLE_KEY = "sb_publishable_60U_SBa3qnwU2jhWzyylnA_-6A3LMDt";

type Post = {
  slug: string;
  title: string;
  excerpt: string | null;
  body_html: string | null;
  cover_url: string | null;
  cover_alt: string | null;
  tags: string[] | null;
  published_at: string;
  updated_at: string | null;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// CDATA cannot contain "]]>", so split any occurrence across two sections.
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

const absolute = (u: string) =>
  /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(u) ? u : `${SITE}/${u.replace(/^\.?\//, "")}`;

const absolutiseHtml = (html: string) =>
  html.replace(/\b(src|href)="([^"]*)"/g, (_m, attr, url) => `${attr}="${absolute(url)}"`);

const imageType = (u: string) =>
  /\.png($|\?)/i.test(u) ? "image/png" : /\.webp($|\?)/i.test(u) ? "image/webp" : "image/jpeg";

// Each post's static page, written by justamanda.net's tools/build-journal.mjs.
// A post newer than the last build still resolves there via 404.html.
const postUrl = (slug: string) => `${SITE}/journal/${encodeURIComponent(slug)}/`;

Deno.serve(async () => {
  const base = Deno.env.get("SUPABASE_URL")!;
  const res = await fetch(
    `${base}/rest/v1/posts?select=slug,title,excerpt,body_html,cover_url,cover_alt,tags,published_at,updated_at` +
      `&status=eq.published&order=published_at.desc&limit=30`,
    { headers: { apikey: PUBLISHABLE_KEY, Accept: "application/json" } },
  );
  if (!res.ok) {
    return new Response(`Feed unavailable: ${res.status}`, { status: 502 });
  }
  const posts: Post[] = await res.json();

  const items = posts.map((p) => {
    const link = postUrl(p.slug);
    const cover = p.cover_url ? absolute(p.cover_url) : "";
    const coverHtml = cover
      ? `<p><img src="${esc(cover)}" alt="${esc(p.cover_alt || "")}"></p>` : "";
    return `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
${(p.tags || []).map((t) => `      <category>${esc(t)}</category>`).join("\n")}
      <description>${esc(p.excerpt || "")}</description>
      <content:encoded>${cdata(coverHtml + absolutiseHtml(p.body_html || ""))}</content:encoded>${cover ? `
      <enclosure url="${esc(cover)}" type="${imageType(cover)}" length="0"/>
      <media:content url="${esc(cover)}" medium="image"/>` : ""}
    </item>`;
  }).join("\n");

  const newest = posts[0]?.published_at;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>just amanda · journal</title>
    <link>${SITE}/journal.html</link>
    <atom:link href="${base}/functions/v1/rss" rel="self" type="application/rss+xml"/>
    <description>Longer thoughts and project notes on plants, making, reading, and building things.</description>
    <language>en-us</language>
    <image>
      <url>${SITE}/images/apple-touch-icon.png</url>
      <title>just amanda · journal</title>
      <link>${SITE}/journal.html</link>
    </image>
${newest ? `    <lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // Readers poll; five minutes keeps a new post prompt without hammering the DB.
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
