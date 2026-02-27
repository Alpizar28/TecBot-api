import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

async function runInspector() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36'
    });

    let notificationEndpoint = '';
    let requestHeaders: Record<string, string> = {};

    const page = await context.newPage();

    page.on('request', (request) => {
        const url = request.url();
        const type = request.resourceType();

        // Log all XHR/Fetch requests to find the file storage API
        if (type === 'xhr' || type === 'fetch') {
            console.log(`\n[Network] Intercepted XHR/Fetch: ${request.method()} ${url}`);
            if (request.method() === 'POST' && url.includes('ajax')) {
                console.log(`[!] POST BODY:`, request.postData());
            }
        }

        if (url.includes('new-form') && request.method() === 'POST') {
            console.log('\n[!] LOGIN POST REQUEST DETECTED:');
        }

        if (url.includes('get_user_notifications') || url.includes('has_unread_notifications')) {
            notificationEndpoint = url;
            requestHeaders = request.headers();
        }
    });

    const username = process.env.TEC_USER;
    const password = process.env.TEC_PASS;

    if (!username || !password) {
        console.error('Please set TEC_USER and TEC_PASS environment variables.');
        process.exit(1);
    }

    try {
        console.log('[Inspector] Launching browser...');
        console.log('[Inspector] Navigating to login...');
        await page.goto('https://tecdigital.tec.ac.cr/dotlrn/', { waitUntil: 'networkidle', timeout: 30000 });

        await page.fill('#mail-input', username);
        await page.fill('#password-input', password);
        await page.press('#password-input', 'Enter');

        console.log('[Inspector] Waiting for login to complete...');
        await page.waitForTimeout(4000);

        const docUrl = 'https://tecdigital.tec.ac.cr/dotlrn/classes/E/EL2207/S-1-2026.CA.EL2207.2/file-storage/#/229915573#/';
        console.log(`[Inspector] Navigating to Document URL: ${docUrl}`);

        await page.goto(docUrl, { waitUntil: 'networkidle', timeout: 30000 });

        console.log('[Inspector] Waiting for Angular to fetch the files...');
        await page.waitForTimeout(5000);

    } catch (e) {
        console.error('Error during inspection:', (e as Error).message);
    } finally {
        console.log('\n==================================================');
        console.log('--- EXTRACTION COMPLETE ---');
        console.log(`Target Endpoint: ${notificationEndpoint}`);
        console.log(`Required Headers to replicate:`);
        console.log(requestHeaders);
        console.log('==================================================\n');

        await browser.close();
    }
}

runInspector().catch(console.error);
