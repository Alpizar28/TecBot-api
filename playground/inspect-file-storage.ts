import { chromium } from 'playwright';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("Logging in...");
    await page.goto('https://tecdigital.tec.ac.cr/dotlrn/');
    await page.fill('#mail-input', process.env.TEC_USER!);
    await page.fill('#password-input', process.env.TEC_PASS!);
    await page.press('#password-input', 'Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    console.log("Getting notifications...");
    await page.evaluate(() => {
        const bell = document.getElementById('platform_user_notifications');
        if (bell) bell.click();
    });

    await page.waitForSelector('a.notification');

    const docLink = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('a.notification'));
        const doc = items.find(el => el.textContent?.toLowerCase().includes('documento') || el.className.includes('documento'));
        return doc ? (doc as HTMLAnchorElement).href : null;
    });

    if (!docLink) {
        console.log("No document notifications found to inspect.");
        await browser.close();
        return;
    }

    console.log(`Found doc link: ${docLink}`);

    page.on('response', async res => {
        const url = res.url();
        const type = res.request().resourceType();
        if (type === 'xhr' || type === 'fetch') {
            console.log(`\n[AJAX Response] ${res.status()} ${url}`);
            if (url.includes('tda-file-storage') || url.includes('ajax') || url.includes('json')) {
                const text = await res.text();
                console.log(`[Payload start] => ${text.substring(0, 300)}...`);
            }
        }
    });

    console.log("Navigating to document link...");
    await page.goto(docLink, { waitUntil: 'networkidle' });

    // Let angular do its thing
    await page.waitForTimeout(3000);

    await browser.close();
})();
