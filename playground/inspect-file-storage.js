"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
var playwright_1 = require("playwright");
(function () { return __awaiter(void 0, void 0, void 0, function () {
    var browser, context, page, docLink;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, playwright_1.chromium.launch({ headless: true })];
            case 1:
                browser = _a.sent();
                return [4 /*yield*/, browser.newContext()];
            case 2:
                context = _a.sent();
                return [4 /*yield*/, context.newPage()];
            case 3:
                page = _a.sent();
                console.log("Logging in...");
                return [4 /*yield*/, page.goto('https://tecdigital.tec.ac.cr/dotlrn/')];
            case 4:
                _a.sent();
                return [4 /*yield*/, page.fill('#mail-input', process.env.TEC_USER)];
            case 5:
                _a.sent();
                return [4 /*yield*/, page.fill('#password-input', process.env.TEC_PASS)];
            case 6:
                _a.sent();
                return [4 /*yield*/, page.press('#password-input', 'Enter')];
            case 7:
                _a.sent();
                return [4 /*yield*/, page.waitForNavigation({ waitUntil: 'networkidle' })];
            case 8:
                _a.sent();
                console.log("Getting notifications...");
                return [4 /*yield*/, page.evaluate(function () {
                        var bell = document.getElementById('platform_user_notifications');
                        if (bell)
                            bell.click();
                    })];
            case 9:
                _a.sent();
                return [4 /*yield*/, page.waitForSelector('a.notification')];
            case 10:
                _a.sent();
                return [4 /*yield*/, page.evaluate(function () {
                        var items = Array.from(document.querySelectorAll('a.notification'));
                        var doc = items.find(function (el) { var _a; return ((_a = el.textContent) === null || _a === void 0 ? void 0 : _a.toLowerCase().includes('documento')) || el.className.includes('documento'); });
                        return doc ? doc.href : null;
                    })];
            case 11:
                docLink = _a.sent();
                if (!!docLink) return [3 /*break*/, 13];
                console.log("No document notifications found to inspect.");
                return [4 /*yield*/, browser.close()];
            case 12:
                _a.sent();
                return [2 /*return*/];
            case 13:
                console.log("Found doc link: ".concat(docLink));
                page.on('response', function (res) { return __awaiter(void 0, void 0, void 0, function () {
                    var url, type, text;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                url = res.url();
                                type = res.request().resourceType();
                                if (!(type === 'xhr' || type === 'fetch')) return [3 /*break*/, 2];
                                console.log("\n[AJAX Response] ".concat(res.status(), " ").concat(url));
                                if (!(url.includes('tda-file-storage') || url.includes('ajax') || url.includes('json'))) return [3 /*break*/, 2];
                                return [4 /*yield*/, res.text()];
                            case 1:
                                text = _a.sent();
                                console.log("[Payload start] => ".concat(text.substring(0, 300), "..."));
                                _a.label = 2;
                            case 2: return [2 /*return*/];
                        }
                    });
                }); });
                console.log("Navigating to document link...");
                return [4 /*yield*/, page.goto(docLink, { waitUntil: 'networkidle' })];
            case 14:
                _a.sent();
                // Let angular do its thing
                return [4 /*yield*/, page.waitForTimeout(3000)];
            case 15:
                // Let angular do its thing
                _a.sent();
                return [4 /*yield*/, browser.close()];
            case 16:
                _a.sent();
                return [2 /*return*/];
        }
    });
}); })();
