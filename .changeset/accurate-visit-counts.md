---
"@reliableapp/frontend-core": minor
"@reliableapp/react": minor
---

Count visits, page views and frustration clicks the way people actually use the site:

- **One session per visit, across tabs.** The session moves from sessionStorage (per tab) to localStorage, so opening a link in a new tab no longer starts a second visit. It still ends after 30 minutes without activity. A session left in sessionStorage by an older SDK is adopted on upgrade, so live visits are not split.
- **Only user activity starts or extends a visit.** Page views, custom events, `identify()`, clicks, and pointer, key, touch and scroll input count. Background network, WebSocket, error and vitals events attach to the current session without extending it, so a tab left open with polling neither stays "active" all day nor opens a new visit every 30 minutes.
- **Page views on pathname changes only.** Rewriting just the query string (search boxes, filters, pagination) is no longer a page view.
- **Nothing is sent from prerendered pages** until they are actually shown.
- **Bot flag.** Sessions carry `is_bot` for crawler user agents and WebDriver-controlled browsers, so the backend can leave them out of business metrics.
- **Honest session metadata.** `initial_referrer` is only sent for external referrers on the page load that starts the visit, and sessions report the real SDK version instead of `0.0.0`.
- **Dead and rage clicks.** Only buttons and links are judged, a response anywhere on the page (DOM change, URL change, scroll, focus change, request start) within 1s cancels it, and 3+ unanswered rapid clicks become one rage click. Clicking into text fields, checkboxes, selects and iframes is no longer a dead click.
