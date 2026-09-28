// Crawlers and automated browsers run the SDK like any visitor. Googlebot in
// particular renders pages with JavaScript, and each crawl arrives with empty
// storage, so without this every crawl counted as a new visit and a new
// unique visitor. Sessions are flagged, not dropped, so the backend can leave
// them out of the business metrics while errors they hit are still visible.

// Keep in sync with BOT_USER_AGENT_PATTERN in reliable-node's
// services/frontend/metrics/visits.ts. No lookbehind: older Safari cannot
// parse it, and a syntax error here would break the whole SDK.
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|ptst\/|gtmetrix|pingdom|uptime|phantomjs|bingpreview|google-inspectiontool|mediapartners-google|facebookexternalhit/i;

/** True for crawlers, headless browsers and pages driven by automation. */
export function isLikelyBot(): boolean {
    if (typeof navigator === 'undefined') return false;
    // WebDriver-controlled browsers (Selenium, Puppeteer, Playwright) set this
    // even when their user agent looks like a normal browser.
    if (navigator.webdriver === true) return true;
    const ua = navigator.userAgent || '';
    // "cubot" is a phone brand, not a crawler.
    return BOT_UA.test(ua) && !/cubot/i.test(ua);
}
