import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

// TEC Digital login actually uses a simple JSON API.
const LOGIN_URL = 'https://tecdigital.tec.ac.cr/api/login/new-form/';
const NOTIFICATIONS_URL = 'https://tecdigital.tec.ac.cr/tda-notifications/ajax/get_user_notifications?';

async function testApiBypass() {
    const username = process.env.TEC_USER || '';
    const password = process.env.TEC_PASS || '';

    if (!username || !password) {
        console.error('Please provide TEC_USER and TEC_PASS env variables.');
        return;
    }

    try {
        console.log('[API-Client] 1. Sending JSON POST to login endpoint...');

        const defaultHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://tecdigital.tec.ac.cr',
            'Referer': 'https://tecdigital.tec.ac.cr/register/?return_url=/dotlrn/',
        };

        const loginPayload = {
            email: username,
            password: password,
            returnUrl: "/dotlrn/"
        };

        const loginRes = await client.post(LOGIN_URL, loginPayload, {
            headers: {
                ...defaultHeaders,
                'Content-Type': 'application/json;charset=UTF-8'
            },
            maxRedirects: 5 // follow redirects automatically if any
        });

        console.log(`[API-Client] Login Response Status: ${loginRes.status}`);

        // Check if cookies were successfully placed in the jar
        const cookies = await jar.getCookies('https://tecdigital.tec.ac.cr');
        console.log(`[API-Client] Cookies captured: ${cookies.length}`);
        if (cookies.length === 0) {
            console.error('[API-Client] Failure: No session cookies received. Authentication failed or was rejected.');
            return;
        }

        console.log('[API-Client] 2. Querying Internal Notification API...');

        const notifRes = await client.get(NOTIFICATIONS_URL, {
            headers: {
                ...defaultHeaders,
                'Referer': 'https://tecdigital.tec.ac.cr/dotlrn/'
            }
        });

        console.log(`[API-Client] Notifications Response Status: ${notifRes.status}`);

        console.log('\n==================================================');
        console.log('--- EXTRACTED NOTIFICATIONS ---');

        if (notifRes.data && Array.isArray(notifRes.data.notifications)) {
            const notifications = notifRes.data.notifications;
            console.log(`Found ${notifications.length} notifications.\n`);

            notifications.forEach((n: any, i: number) => {
                console.log(`[${i + 1}] Title: ${n.title}`);
                console.log(`    Date: ${n.creation_date}`);
                console.log(`    Text: ${n.text}`);
                console.log(`    ID:   ${n.notification_id}\n`);
            });
        } else {
            console.log('No notifications found or unexpected payload format.');
            console.log(JSON.stringify(notifRes.data).substring(0, 500));
        }
        console.log('==================================================\n');

        // Test File Storage API directly
        console.log('[API-Client] 3. Testing File Storage API for Document Notifications...');
        const folderApiUrl = 'https://tecdigital.tec.ac.cr/dotlrn/file-storage/view/folder-chunk?folder_id=229915573';
        const folderRes = await client.get(folderApiUrl, {
            headers: {
                'Accept': 'application/json, text/plain, */*'
            }
        });

        console.log(`[API-Client] Folder API Status: ${folderRes.status}`);
        console.log('\n==================================================');
        console.log('--- EXTRACTED FOLDER CONTENTS ---');
        console.log(JSON.stringify(folderRes.data, null, 2).substring(0, 2000));
        console.log('==================================================\n');

    } catch (error) {
        console.error('[API-Client] Error occurred:', error instanceof Error ? error.message : String(error));
        if (axios.isAxiosError(error) && error.response) {
            console.error('[API-Client] Responded with status:', error.response.status);
            console.error('[API-Client] Response body:', error.response.data);
        }
    }
}

testApiBypass().catch(console.error);
