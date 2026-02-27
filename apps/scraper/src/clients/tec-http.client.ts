import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { logger as appLogger } from '../logger.js';

interface LoggerLike {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}

export class TecHttpClient {
    public readonly client: AxiosInstance;
    public readonly jar: CookieJar;
    private readonly logger: LoggerLike;

    constructor(logger: LoggerLike = appLogger.child({ component: 'tec_http_client' })) {
        this.logger = logger;
        this.jar = new CookieJar();

        this.client = wrapper(axios.create({
            jar: this.jar,
            withCredentials: true,
            timeout: 30000,
            headers: {
                'sec-ch-ua-platform': '"Windows"',
                'referer': 'https://tecdigital.tec.ac.cr/',
                'accept-language': 'en-US,en;q=0.9',
                'sec-ch-ua': '" Not;A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
                'sec-ch-ua-mobile': '?0',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36'
            }
        }));
    }

    async login(email: string, password: string): Promise<boolean> {
        const maxAttempts = 2;
        const loginUrl = 'https://tecdigital.tec.ac.cr/api/login/new-form/';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.logger.info({ email, attempt }, 'Attempting JSON login');

                const response = await this.client.post(loginUrl, {
                    email,
                    password,
                    returnUrl: '/dotlrn/',
                }, {
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        Accept: 'application/json, text/plain, */*',
                        Origin: 'https://tecdigital.tec.ac.cr',
                        Referer: 'https://tecdigital.tec.ac.cr/register/?return_url=/dotlrn/',
                    },
                    maxRedirects: 5,
                });

                this.logger.debug({ status: response.status, attempt }, 'Login endpoint response');
                await this.client.get('https://tecdigital.tec.ac.cr/dotlrn/', { maxRedirects: 5 });

                const authenticated = await this.verifySession();
                if (authenticated) {
                    this.logger.info({ email, attempt }, 'Session established after login');
                    return true;
                }

                this.logger.warn({ email, attempt }, 'Login completed but session verification failed');
            } catch (error) {
                if (axios.isAxiosError(error)) {
                    const status = error.response?.status;
                    const data = error.response?.data;
                    this.logger.error({
                        email,
                        attempt,
                        status,
                        data,
                        message: error.message,
                    }, 'Login request failed');
                } else {
                    this.logger.error({ email, attempt, error }, 'Unexpected login failure');
                }
            }

            if (attempt < maxAttempts) {
                await sleep(500);
            }
        }

        return false;
    }

    async verifySession(): Promise<boolean> {
        try {
            const cookies = await this.jar.getCookies('https://tecdigital.tec.ac.cr/');
            const now = Date.now();
            const hasSessionCookie = cookies.some((cookie) => {
                if (cookie.key !== 'JSESSIONID' && cookie.key !== 'ad_session_id') {
                    return false;
                }

                if (!cookie.expires || cookie.expires === 'Infinity') {
                    return true;
                }

                return cookie.expires.getTime() > now;
            });

            if (!hasSessionCookie) {
                return false;
            }

            const probe = await this.client.get('https://tecdigital.tec.ac.cr/tda-notifications/ajax/has_unread_notifications?');
            return probe.status === 200;
        } catch (error) {
            this.logger.debug({ error }, 'Session verification failed');
            return false;
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
