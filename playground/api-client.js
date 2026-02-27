"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var axios_1 = __importDefault(require("axios"));
var axios_cookiejar_support_1 = require("axios-cookiejar-support");
var tough_cookie_1 = require("tough-cookie");
var jar = new tough_cookie_1.CookieJar();
var client = (0, axios_cookiejar_support_1.wrapper)(axios_1.default.create({ jar: jar }));
// TEC Digital login actually uses a simple JSON API.
var LOGIN_URL = 'https://tecdigital.tec.ac.cr/api/login/new-form/';
var NOTIFICATIONS_URL = 'https://tecdigital.tec.ac.cr/tda-notifications/ajax/get_user_notifications?';
function testApiBypass() {
    return __awaiter(this, void 0, void 0, function () {
        var username, password, defaultHeaders, loginPayload, loginRes, cookies, notifRes, notifications, folderApiUrl, folderRes, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    username = process.env.TEC_USER || '';
                    password = process.env.TEC_PASS || '';
                    if (!username || !password) {
                        console.error('Please provide TEC_USER and TEC_PASS env variables.');
                        return [2 /*return*/];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    console.log('[API-Client] 1. Sending JSON POST to login endpoint...');
                    defaultHeaders = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Origin': 'https://tecdigital.tec.ac.cr',
                        'Referer': 'https://tecdigital.tec.ac.cr/register/?return_url=/dotlrn/',
                    };
                    loginPayload = {
                        email: username,
                        password: password,
                        returnUrl: "/dotlrn/"
                    };
                    return [4 /*yield*/, client.post(LOGIN_URL, loginPayload, {
                            headers: __assign(__assign({}, defaultHeaders), { 'Content-Type': 'application/json;charset=UTF-8' }),
                            maxRedirects: 5 // follow redirects automatically if any
                        })];
                case 2:
                    loginRes = _a.sent();
                    console.log("[API-Client] Login Response Status: ".concat(loginRes.status));
                    return [4 /*yield*/, jar.getCookies('https://tecdigital.tec.ac.cr')];
                case 3:
                    cookies = _a.sent();
                    console.log("[API-Client] Cookies captured: ".concat(cookies.length));
                    if (cookies.length === 0) {
                        console.error('[API-Client] Failure: No session cookies received. Authentication failed or was rejected.');
                        return [2 /*return*/];
                    }
                    console.log('[API-Client] 2. Querying Internal Notification API...');
                    return [4 /*yield*/, client.get(NOTIFICATIONS_URL, {
                            headers: __assign(__assign({}, defaultHeaders), { 'Referer': 'https://tecdigital.tec.ac.cr/dotlrn/' })
                        })];
                case 4:
                    notifRes = _a.sent();
                    console.log("[API-Client] Notifications Response Status: ".concat(notifRes.status));
                    console.log('\n==================================================');
                    console.log('--- EXTRACTED NOTIFICATIONS ---');
                    if (notifRes.data && Array.isArray(notifRes.data.notifications)) {
                        notifications = notifRes.data.notifications;
                        console.log("Found ".concat(notifications.length, " notifications.\n"));
                        notifications.forEach(function (n, i) {
                            console.log("[".concat(i + 1, "] Title: ").concat(n.title));
                            console.log("    Date: ".concat(n.creation_date));
                            console.log("    Text: ".concat(n.text));
                            console.log("    ID:   ".concat(n.notification_id, "\n"));
                        });
                    }
                    else {
                        console.log('No notifications found or unexpected payload format.');
                        console.log(JSON.stringify(notifRes.data).substring(0, 500));
                    }
                    console.log('==================================================\n');
                    // Test File Storage API directly
                    console.log('[API-Client] 3. Testing File Storage API for Document Notifications...');
                    folderApiUrl = 'https://tecdigital.tec.ac.cr/dotlrn/file-storage/view/folder-chunk?folder_id=229915573';
                    return [4 /*yield*/, client.get(folderApiUrl, {
                            headers: {
                                'Accept': 'application/json, text/plain, */*'
                            }
                        })];
                case 5:
                    folderRes = _a.sent();
                    console.log("[API-Client] Folder API Status: ".concat(folderRes.status));
                    console.log('\n==================================================');
                    console.log('--- EXTRACTED FOLDER CONTENTS ---');
                    console.log(JSON.stringify(folderRes.data, null, 2).substring(0, 2000));
                    console.log('==================================================\n');
                    return [3 /*break*/, 7];
                case 6:
                    error_1 = _a.sent();
                    console.error('[API-Client] Error occurred:', error_1 instanceof Error ? error_1.message : String(error_1));
                    if (axios_1.default.isAxiosError(error_1) && error_1.response) {
                        console.error('[API-Client] Responded with status:', error_1.response.status);
                        console.error('[API-Client] Response body:', error_1.response.data);
                    }
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    });
}
testApiBypass().catch(console.error);
