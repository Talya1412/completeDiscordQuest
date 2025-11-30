/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Free DOM-based captcha solver
 * Adapted from puppeteer-hcaptcha approach for Discord environment
 * WARNING: Using this may violate Discord's Terms of Service
 */

export interface CaptchaChallenge {
    captcha_key?: string[];
    captcha_sitekey?: string;
    captcha_service?: string;
    captcha_rqdata?: string;
    captcha_rqtoken?: string;
}

export interface CaptchaBypassResult {
    success: boolean;
    token?: string;
    error?: string;
}

/**
 * Token cache entry
 */
interface TokenCacheEntry {
    token: string;
    sitekey: string;
    timestamp: number;
    expiresAt: number;
}

/**
 * Token cache storage
 * Maps sitekey to cached token
 */
const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * Token cache settings
 */
const CACHE_LIFETIME_MS = 120000; // 2 minutes (hCaptcha tokens expire quickly)
const CACHE_CLEANUP_INTERVAL_MS = 60000; // Cleanup every 1 minute

/**
 * Get cached token for a sitekey
 */
function getCachedToken(sitekey: string): string | null {
    const entry = tokenCache.get(sitekey);

    if (!entry) {
        return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
        console.log("[TokenCache] Token expired for sitekey:", sitekey);
        tokenCache.delete(sitekey);
        return null;
    }

    console.log("[TokenCache] ✅ Using cached token for sitekey:", sitekey);
    return entry.token;
}

/**
 * Cache a token for a sitekey
 */
function cacheToken(sitekey: string, token: string): void {
    const now = Date.now();
    const entry: TokenCacheEntry = {
        token,
        sitekey,
        timestamp: now,
        expiresAt: now + CACHE_LIFETIME_MS
    };

    tokenCache.set(sitekey, entry);
    console.log("[TokenCache] 💾 Cached token for sitekey:", sitekey, "(expires in 2 min)");
}

/**
 * Cleanup expired tokens from cache
 */
function cleanupExpiredTokens(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sitekey, entry] of tokenCache.entries()) {
        if (now > entry.expiresAt) {
            tokenCache.delete(sitekey);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[TokenCache] 🧹 Cleaned up ${cleaned} expired token(s)`);
    }
}

/**
 * Start automatic cache cleanup
 */
let cleanupInterval: NodeJS.Timeout | null = null;

export function startTokenCacheCleanup(): void {
    if (cleanupInterval) return;

    cleanupInterval = setInterval(() => {
        cleanupExpiredTokens();
    }, CACHE_CLEANUP_INTERVAL_MS);

    console.log("[TokenCache] Started automatic cleanup (every 1 min)");
}

/**
 * Stop automatic cache cleanup
 */
export function stopTokenCacheCleanup(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        console.log("[TokenCache] Stopped automatic cleanup");
    }
}

/**
 * Clear all cached tokens
 */
export function clearTokenCache(): void {
    const count = tokenCache.size;
    tokenCache.clear();
    console.log(`[TokenCache] Cleared ${count} cached token(s)`);
}


/**
 * Detects if an API response contains a captcha challenge
 */
export function detectCaptchaChallenge(response: any): CaptchaChallenge | null {
    if (!response) return null;

    // Check for captcha in response body
    if (response.captcha_key || response.captcha_sitekey) {
        return {
            captcha_key: response.captcha_key,
            captcha_sitekey: response.captcha_sitekey,
            captcha_service: response.captcha_service || "hcaptcha",
            captcha_rqdata: response.captcha_rqdata,
            captcha_rqtoken: response.captcha_rqtoken,
        };
    }

    // Check for captcha in error response
    if (response.body?.captcha_key || response.body?.captcha_sitekey) {
        return {
            captcha_key: response.body.captcha_key,
            captcha_sitekey: response.body.captcha_sitekey,
            captcha_service: response.body.captcha_service || "hcaptcha",
            captcha_rqdata: response.body.captcha_rqdata,
            captcha_rqtoken: response.body.captcha_rqtoken,
        };
    }

    return null;
}

/**
 * Wait for element to appear in DOM
 */
async function waitForElement(selector: string, timeout: number = 10000): Promise<Element | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const element = document.querySelector(selector);
        if (element) return element;
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return null;
}

/**
 * Auto-solve hCaptcha checkbox (works for easy captchas)
 * Uses simulated clicks instead of DOM access due to CORS restrictions
 */
export async function autoSolveHCaptchaCheckbox(): Promise<CaptchaBypassResult> {
    try {
        console.log("[CaptchaSolver] Looking for hCaptcha iframe...");

        // Wait for hCaptcha iframe
        const iframe = await waitForElement("iframe[src*=\"hcaptcha.com/checkbox\"]");
        if (!iframe) {
            console.log("[CaptchaSolver] No checkbox iframe found");
            return {
                success: false,
                error: "hCaptcha checkbox iframe not found"
            };
        }

        console.log("[CaptchaSolver] Found hCaptcha iframe, simulating click...");

        // Cannot access iframe.contentDocument due to CORS
        // Instead, simulate a click on the iframe itself
        const iframeElement = iframe as HTMLIFrameElement;

        // Get iframe bounding rect to click in center
        const rect = iframeElement.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        // Create and dispatch mouse events
        const mouseDownEvent = new MouseEvent("mousedown", {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: centerX,
            clientY: centerY
        });

        const mouseUpEvent = new MouseEvent("mouseup", {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: centerX,
            clientY: centerY
        });

        const clickEvent = new MouseEvent("click", {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: centerX,
            clientY: centerY
        });

        // Dispatch events
        iframeElement.dispatchEvent(mouseDownEvent);
        await new Promise(resolve => setTimeout(resolve, 50));
        iframeElement.dispatchEvent(mouseUpEvent);
        await new Promise(resolve => setTimeout(resolve, 50));
        iframeElement.dispatchEvent(clickEvent);

        console.log("[CaptchaSolver] Click events dispatched, waiting for response...");

        // Wait for potential solving (maybe it's an easy captcha)
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Try to get token
        const tokenElement = document.querySelector("[name=\"h-captcha-response\"]") as HTMLTextAreaElement;
        if (tokenElement && tokenElement.value) {
            console.log("[CaptchaSolver] ✅ Captcha solved!");
            return {
                success: true,
                token: tokenElement.value
            };
        }

        // If no token, captcha probably requires image solving
        console.log("[CaptchaSolver] No token received - captcha likely requires manual solving");
        return {
            success: false,
            error: "Captcha requires manual solving (no token received)"
        };
    } catch (error) {
        console.error("[CaptchaSolver] Error:", error);
        return {
            success: false,
            error: String(error)
        };
    }
}

/**
 * Solve hCaptcha using NopeCHA API (100/day free)
 */
async function solveWithNopeCHA(
    siteKey: string,
    pageUrl: string,
    apiKey: string
): Promise<CaptchaBypassResult> {
    if (!apiKey || !apiKey.trim()) {
        return {
            success: false,
            error: "NopeCHA API key not configured"
        };
    }

    try {
        console.log("[NopeCHA] Solving hCaptcha...");
        console.log("[NopeCHA] Site key:", siteKey);

        // NopeCHA API endpoint
        const response = await fetch("https://api.nopecha.com/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                key: apiKey,
                type: "hcaptcha",
                sitekey: siteKey,
                url: pageUrl,
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("[NopeCHA] API error:", data);
            return {
                success: false,
                error: `NopeCHA: ${data.error || response.statusText}`
            };
        }

        if (data.data) {
            console.log("[NopeCHA] ✅ Solved!");
            return {
                success: true,
                token: data.data
            };
        }

        return {
            success: false,
            error: "NopeCHA: No solution returned"
        };
    } catch (error: any) {
        console.error("[NopeCHA] Failed:", error);
        return {
            success: false,
            error: `NopeCHA: ${error.message}`
        };
    }
}

/**
 * Solve hCaptcha using 2Captcha API
 */
async function solveWith2Captcha(
    siteKey: string,
    pageUrl: string,
    apiKey: string
): Promise<CaptchaBypassResult> {
    if (!apiKey || !apiKey.trim()) {
        return {
            success: false,
            error: "2Captcha API key not configured"
        };
    }

    try {
        console.log("[2Captcha] Solving hCaptcha...");

        // Step 1: Submit captcha task
        const submitResponse = await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=hcaptcha&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
        const submitData = await submitResponse.json();

        if (submitData.status !== 1) {
            return {
                success: false,
                error: `2Captcha submit failed: ${submitData.request}`
            };
        }

        const taskId = submitData.request;
        console.log("[2Captcha] Task submitted:", taskId);

        // Step 2: Poll for result
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3s between polls

            const resultResponse = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
            const resultData = await resultResponse.json();

            if (resultData.status === 1) {
                console.log("[2Captcha] ✅ Solved!");
                return {
                    success: true,
                    token: resultData.request
                };
            }

            if (resultData.request !== "CAPCHA_NOT_READY") {
                return {
                    success: false,
                    error: `2Captcha: ${resultData.request}`
                };
            }
        }

        return {
            success: false,
            error: "2Captcha: Timeout waiting for solution"
        };
    } catch (error: any) {
        console.error("[2Captcha] Failed:", error);
        return {
            success: false,
            error: `2Captcha: ${error.message}`
        };
    }
}

/**
 * Solve hCaptcha using CapSolver API
 */
async function solveWithCapSolver(
    siteKey: string,
    pageUrl: string,
    apiKey: string
): Promise<CaptchaBypassResult> {
    if (!apiKey || !apiKey.trim()) {
        return {
            success: false,
            error: "CapSolver API key not configured"
        };
    }

    try {
        console.log("[CapSolver] Solving hCaptcha...");

        // Step 1: Create task
        const createResponse = await fetch("https://api.capsolver.com/createTask", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                clientKey: apiKey,
                task: {
                    type: "HCaptchaTaskProxyless",
                    websiteURL: pageUrl,
                    websiteKey: siteKey,
                }
            })
        });

        const createData = await createResponse.json();

        if (createData.errorId !== 0) {
            return {
                success: false,
                error: `CapSolver: ${createData.errorDescription || "Task creation failed"}`
            };
        }

        const { taskId } = createData;
        console.log("[CapSolver] Task created:", taskId);

        // Step 2: Poll for result
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s

            const resultResponse = await fetch("https://api.capsolver.com/getTaskResult", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    clientKey: apiKey,
                    taskId: taskId,
                })
            });

            const resultData = await resultResponse.json();

            if (resultData.status === "ready") {
                console.log("[CapSolver] ✅ Solved!");
                return {
                    success: true,
                    token: resultData.solution.gRecaptchaResponse
                };
            }

            if (resultData.status === "failed") {
                return {
                    success: false,
                    error: `CapSolver: ${resultData.errorDescription || "Task failed"}`
                };
            }
        }

        return {
            success: false,
            error: "CapSolver: Timeout waiting for solution"
        };
    } catch (error: any) {
        console.error("[CapSolver] Failed:", error);
        return {
            success: false,
            error: `CapSolver: ${error.message}`
        };
    }
}

/**
 * Main bypass function - multi-service support with caching
 */
export async function bypassCaptcha(
    challenge: CaptchaChallenge,
    servicePreference?: string,
    apiKeys?: {
        nopecha?: string;
        twoCaptcha?: string;
        capsolver?: string;
    }
): Promise<CaptchaBypassResult> {
    console.log("[CaptchaSolver] Attempting to solve captcha...", challenge);

    // Priority 0: Check cache first
    if (challenge.captcha_sitekey) {
        const cachedToken = getCachedToken(challenge.captcha_sitekey);
        if (cachedToken) {
            return {
                success: true,
                token: cachedToken
            };
        }
    }

    if (!challenge.captcha_sitekey) {
        console.warn("[CaptchaSolver] No sitekey available");
        return {
            success: false,
            error: "No sitekey in challenge"
        };
    }

    const sitekey = challenge.captcha_sitekey;
    const url = "https://discord.com";

    // Determine service priority
    const services: Array<{ name: string, solver: () => Promise<CaptchaBypassResult>; }> = [];

    if (servicePreference === "auto" || !servicePreference) {
        // Auto mode: try all available services in priority order
        if (apiKeys?.nopecha) {
            services.push({
                name: "NopeCHA",
                solver: () => solveWithNopeCHA(sitekey, url, apiKeys.nopecha!)
            });
        }
        if (apiKeys?.capsolver) {
            services.push({
                name: "CapSolver",
                solver: () => solveWithCapSolver(sitekey, url, apiKeys.capsolver!)
            });
        }
        if (apiKeys?.twoCaptcha) {
            services.push({
                name: "2Captcha",
                solver: () => solveWith2Captcha(sitekey, url, apiKeys.twoCaptcha!)
            });
        }
    } else {
        // Specific service selected
        if (servicePreference === "nopecha" && apiKeys?.nopecha) {
            services.push({
                name: "NopeCHA",
                solver: () => solveWithNopeCHA(sitekey, url, apiKeys.nopecha!)
            });
        } else if (servicePreference === "2captcha" && apiKeys?.twoCaptcha) {
            services.push({
                name: "2Captcha",
                solver: () => solveWith2Captcha(sitekey, url, apiKeys.twoCaptcha!)
            });
        } else if (servicePreference === "capsolver" && apiKeys?.capsolver) {
            services.push({
                name: "CapSolver",
                solver: () => solveWithCapSolver(sitekey, url, apiKeys.capsolver!)
            });
        }
    }

    // Try API services
    for (const service of services) {
        console.log(`[CaptchaSolver] Trying ${service.name}...`);
        const result = await service.solver();

        if (result.success && result.token) {
            // Cache successful result
            cacheToken(sitekey, result.token);
            return result;
        }

        console.warn(`[CaptchaSolver] ${service.name} failed:`, result.error);
    }

    // Fallback: Try free auto-click method
    if (servicePreference !== "fallback") {
        console.log("[CaptchaSolver] Trying free fallback method...");
        const result = await autoSolveHCaptchaCheckbox();

        if (result.success && result.token) {
            cacheToken(sitekey, result.token);
            return result;
        }
    }

    // All methods failed
    console.warn("[CaptchaSolver] All solve methods failed");
    console.warn("[CaptchaSolver] Available options:");
    console.warn("  1. Get NopeCHA API key (100/day FREE) at nopecha.com");
    console.warn("  2. Get 2Captcha API key at 2captcha.com");
    console.warn("  3. Get CapSolver API key at capsolver.com");
    console.warn("  4. Solve manually");

    return {
        success: false,
        error: "All captcha solving methods failed"
    };
}

/**
 * Monitor for captcha popups and auto-solve
 */
export function setupCaptchaMonitor(
    servicePreference?: string,
    apiKeys?: {
        nopecha?: string;
        twoCaptcha?: string;
        capsolver?: string;
    }
) {
    console.log("[CaptchaSolver] Setting up captcha monitor...");

    // Watch for hCaptcha iframes appearing
    const observer = new MutationObserver(async mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof HTMLElement) {
                    // Log ALL iframes for debugging
                    if (node instanceof HTMLIFrameElement) {
                        console.log("[CaptchaSolver] 📋 Iframe detected:", node.src);
                    }

                    // Look for ANY hCaptcha iframe (not just checkbox)
                    const iframe = node.querySelector ?
                        node.querySelector("iframe[src*=\"hcaptcha.com\"]") :
                        null;

                    if (iframe || (node instanceof HTMLIFrameElement && node.src.includes("hcaptcha.com"))) {
                        console.log("[CaptchaSolver] 🔍 hCaptcha iframe detected!");
                        console.log("[CaptchaSolver] Iframe src:",
                            iframe ? (iframe as HTMLIFrameElement).src : (node as HTMLIFrameElement).src
                        );

                        // Extract sitekey from iframe src if possible
                        const iframeSrc = iframe ? (iframe as HTMLIFrameElement).src : (node as HTMLIFrameElement).src;
                        const sitekeyMatch = iframeSrc.match(/sitekey=([^&]+)/);
                        const sitekey = sitekeyMatch ? sitekeyMatch[1] : undefined;

                        // Create challenge object
                        const challenge: CaptchaChallenge = {
                            captcha_sitekey: sitekey,
                            captcha_service: "hcaptcha"
                        };

                        // Wait for iframe to load
                        await new Promise(resolve => setTimeout(resolve, 2000));

                        // Try to solve with configured services
                        const result = await bypassCaptcha(challenge, servicePreference, apiKeys);
                        if (result.success) {
                            console.log("[CaptchaSolver] ✅ Auto-solved captcha!");
                        } else {
                            console.log("[CaptchaSolver] ❌ Auto-solve failed");
                            console.log("[CaptchaSolver]", result.error);
                        }
                    }
                }
            }
        }
    });

    // Observe entire document for captcha iframes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log("[CaptchaSolver] Monitor active - watching for captcha popups...");

    return observer;
}

/**
 * Cleanup function
 */
export function cleanupCaptchaMonitor(observer: MutationObserver) {
    if (observer) {
        observer.disconnect();
        console.log("[CaptchaSolver] Captcha monitor stopped");
    }
}

// Legacy functions for compatibility
export function generateBypassToken(): string {
    // Not used anymore, keeping for compatibility
    return "";
}

export function patchRequestWithCaptchaBypass(requestBody: any, captchaToken?: string): any {
    // Remove captcha keys from request
    const cleanBody = { ...requestBody };
    delete cleanBody.captcha_key;
    delete cleanBody.captcha_rqtoken;
    delete cleanBody.captcha_rqdata;
    return cleanBody;
}
