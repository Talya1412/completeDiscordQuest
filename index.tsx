/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { QuestButton, QuestsCount } from "./components/QuestButton";
import { questHandlers } from "./handlers";
import { bypassCaptcha, cleanupCaptchaMonitor, clearTokenCache, detectCaptchaChallenge, patchRequestWithCaptchaBypass, setupCaptchaMonitor, startTokenCacheCleanup, stopTokenCacheCleanup } from "./handlers/captcha";
import settings from "./settings";
import { ChannelStore, GuildChannelStore, QuestsStore, RunningGameStore } from "./stores";
import { SpoofingProfile, SpoofingSpeedMode } from "./types/spoofing";
import { callWithRetry } from "./utils/retry";

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestClaimAction = findByCodeLazy("type:\"QUESTS_CLAIM_REWARD_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;

let availableQuests: QuestValue[] = [];
let acceptableQuests: QuestValue[] = [];
let completableQuests: QuestValue[] = [];
let claimableQuests: QuestValue[] = [];

const completingQuest = new Map();
const fakeGames = new Map();
const fakeApplications = new Map();
const claimingQuest = new Set<string>();

let originalRestAPI: any = null;
let captchaBypassEnabled = false;
let captchaMonitor: MutationObserver | null = null;

function enableCaptchaBypass() {
    if (captchaBypassEnabled) return;

    console.log("[CompleteDiscordQuest] Enabling captcha bypass wrapper");

    if (!originalRestAPI) {
        originalRestAPI = {
            post: RestAPI.post.bind(RestAPI),
            get: RestAPI.get.bind(RestAPI),
            patch: RestAPI.patch ? RestAPI.patch.bind(RestAPI) : null,
        };
    }

    RestAPI.post = async function (options: any) {
        if (!settings.store.autoCaptchaSolving) {
            return await originalRestAPI.post(options);
        }

        const opts = { ...options };

        if (opts.body && typeof opts.body === "object") {
            delete opts.body.captcha_key;
            delete opts.body.captcha_rqtoken;
            delete opts.body.captcha_rqdata;

            console.log("[CaptchaBypass] Removed captcha keys from POST request:", opts.url);
        }

        try {
            return await originalRestAPI.post(opts);
        } catch (err: any) {
            const challenge = detectCaptchaChallenge(err);
            if (challenge) {
                console.warn("[CaptchaBypass] Captcha is REQUIRED for this request. Cannot bypass.");
                console.warn("[CaptchaBypass] Discord is enforcing captcha validation. Fake tokens won't work.");
            }
            throw err;
        }
    };

    RestAPI.get = async function (options: any) {
        if (!settings.store.autoCaptchaSolving) {
            return await originalRestAPI.get(options);
        }

        const opts = { ...options };

        try {
            return await originalRestAPI.get(opts);
        } catch (err: any) {
            const challenge = detectCaptchaChallenge(err);
            if (challenge) {
                console.log("[CaptchaBypass] Captcha in GET request, retrying...");
                const bypassResult = await bypassCaptcha(challenge);
                if (bypassResult.success && bypassResult.token) {
                    opts.query = opts.query || {};
                    opts.query.captcha_key = bypassResult.token;
                    return await originalRestAPI.get(opts);
                }
            }
            throw err;
        }
    };

    captchaBypassEnabled = true;
}

function disableCaptchaBypass() {
    if (!captchaBypassEnabled || !originalRestAPI) return;

    console.log("[CompleteDiscordQuest] Disabling captcha bypass wrapper");

    RestAPI.post = originalRestAPI.post;
    RestAPI.get = originalRestAPI.get;
    if (originalRestAPI.patch) {
        RestAPI.patch = originalRestAPI.patch;
    }

    captchaBypassEnabled = false;
}


const RewardPreference = {
    ANY: "any",
    NITRO: "nitro",
    AVATAR_DECORATION: "avatar_decoration",
    GAME_ITEM: "game_item",
    CURRENCY: "currency",
} as const;

type RewardPreference = (typeof RewardPreference)[keyof typeof RewardPreference];

const NitroSkuIds = new Set<string>([
    "521842865731829760",
    "521846918637420545",
]);

function getQuestRewardCategories(quest: QuestValue): RewardPreference[] {
    const rewards = quest.config?.rewardsConfig?.rewards ?? [];
    if (rewards.length === 0) {
        return [RewardPreference.GAME_ITEM];
    }

    const categories = new Set<RewardPreference>();

    for (const reward of rewards) {
        const rewardName = reward.messages?.name ?? "";
        const rewardLabel = `${rewardName} ${reward.messages?.nameWithArticle ?? ""}`.toLowerCase();
        if (NitroSkuIds.has(reward.skuId) || rewardLabel.includes("nitro")) {
            categories.add(RewardPreference.NITRO);
        }
        if (reward.orbQuantity > 0 || rewardLabel.includes("orb")) {
            categories.add(RewardPreference.CURRENCY);
        }
        if (rewardLabel.includes("avatar decoration") || rewardLabel.includes("profile decoration") || rewardLabel.includes("decoration")) {
            categories.add(RewardPreference.AVATAR_DECORATION);
        }
    }

    if (categories.size === 0) {
        categories.add(RewardPreference.GAME_ITEM);
    }

    return [...categories];
}

function questMatchesRewardPreference(quest: QuestValue) {
    const preference = (settings.store.preferredRewardType ?? RewardPreference.ANY) as RewardPreference;
    if (preference === RewardPreference.ANY) {
        return true;
    }

    const rewardCategories = getQuestRewardCategories(quest);
    return rewardCategories.includes(preference);
}

function getSpoofingProfile(): SpoofingProfile {
    const mode = (settings.store.spoofingSpeedMode ?? SpoofingSpeedMode.BALANCED) as SpoofingSpeedMode;

    switch (mode) {
        case SpoofingSpeedMode.SPEEDRUN:
            return {
                video: { maxFuture: 9999, speed: 60, interval: 0.15 },
                playActivity: { intervalMs: 2_000 },
            };
        case SpoofingSpeedMode.STEALTH:
            return {
                video: { maxFuture: 5, speed: 1, interval: 1 },
                playActivity: { intervalMs: 25_000 },
            };
        case SpoofingSpeedMode.BALANCED:
        default:
            return {
                video: { maxFuture: 10, speed: 7, interval: 1 },
                playActivity: { intervalMs: 20_000 },
            };
    }
}

function gatherRedeemCodes(body: any): string[] {
    const codes = new Set<string>();
    const codePattern = /^[A-Za-z0-9-]{8,}$/;
    const keysToCheck = ["code", "redemptionCode", "gift_code", "giftCode", "redeemableCode", "claimCode"];

    const walk = (value: any, depth: number) => {
        if (depth > 3 || value == null) return;
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (codePattern.test(trimmed)) {
                codes.add(trimmed);
            }
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item, depth + 1);
            }
            return;
        }
        if (typeof value === "object") {
            for (const key of keysToCheck) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    walk((value as any)[key], depth + 1);
                }
            }
            for (const nested of Object.values(value)) {
                if (typeof nested === "string") {
                    const trimmed = nested.trim();
                    if (codePattern.test(trimmed)) {
                        codes.add(trimmed);
                    }
                } else if (typeof nested === "object") {
                    walk(nested, depth + 1);
                }
            }
        }
    };

    walk(body, 0);
    return Array.from(codes);
}

function appendRedeemCodes(codes: string[], questName: string) {
    if (codes.length === 0) return;
    const timestamp = new Date().toISOString();
    const existing = (settings.store.redeemCodes ?? "").split("\n").map(x => x.trim()).filter(Boolean);
    const newEntries = codes.map(code => `${code} (${questName} @ ${timestamp})`);
    const merged = Array.from(new Set([...newEntries, ...existing]));
    settings.store.redeemCodes = merged.join("\n");
    console.log("[CompleteDiscordQuest] Saved redeem codes:", codes.join(", "));
}

async function claimQuestReward(quest: QuestValue) {
    if (!settings.store.autoClaimRewards) return;
    if (claimingQuest.has(quest.id)) return;
    if (quest.userStatus?.claimedAt) return;

    const questName = quest.config.messages.questName ?? quest.id;
    const endpoints = [`/quests/${quest.id}/claim-reward`];

    let claimPayload: any = {
        platform: 0,
        location: QuestLocationMap?.QUEST_HOME_DESKTOP ?? 11,
        is_targeted: false,
        metadata_raw: null,
    };

    if (settings.store.autoCaptchaSolving) {
        claimPayload = patchRequestWithCaptchaBypass(claimPayload);
    }

    claimingQuest.add(quest.id);
    try {
        let claimed = false;
        const collectedCodes: string[] = [];
        const tryClaim = async (fn: () => Promise<any>, label: string) => {
            try {
                const res = await callWithRetry(fn, { label: "claim-reward" });
                const codes = gatherRedeemCodes(res?.body ?? res);
                if (codes.length > 0) {
                    collectedCodes.push(...codes);
                }
                return true;
            } catch (err: any) {
                if (settings.store.autoCaptchaSolving) {
                    const challenge = detectCaptchaChallenge(err);
                    if (challenge) {
                        console.log("[CompleteDiscordQuest] Captcha detected during claim, bypassing...");
                        const bypassResult = await bypassCaptcha(challenge);
                        if (bypassResult.success && bypassResult.token) {
                            try {
                                const retryRes = await callWithRetry(fn, { label: "claim-reward-with-captcha" });
                                const codes = gatherRedeemCodes(retryRes?.body ?? retryRes);
                                if (codes.length > 0) {
                                    collectedCodes.push(...codes);
                                }
                                return true;
                            } catch (retryErr) {
                                console.warn(`[CompleteDiscordQuest] Claim retry with captcha failed for ${questName}`, retryErr);
                            }
                        }
                    }
                }
                console.warn(`[CompleteDiscordQuest] Claim attempt failed (${label}) for quest ${questName}`, err);
                return false;
            }
        };

        for (const url of endpoints) {
            if (claimed) break;
            claimed = await tryClaim(() => RestAPI.post({ url, body: claimPayload }), `${url} (with body)`);
        }

        if (!claimed) {
            claimed = await tryClaim(() => RestAPI.get({ url: `/quests/${quest.id}/reward-code` }), "reward-code");
        }
        if (claimed) {
            appendRedeemCodes(collectedCodes, questName);
            console.log("Claimed reward for quest:", questName);
        } else {
            console.error("Failed to claim reward for quest:", questName);
        }
    } finally {
        claimingQuest.delete(quest.id);
    }
}

function handleQuestCompletion(quest: QuestValue) {
    completingQuest.set(quest.id, false);
    void claimQuestReward(quest);
}

export default definePlugin({
    name: "CompleteDiscordQuest",
    description: "A plugin that completes multiple discord quests in background simultaneously.",
    authors: [{
        name: "Talya1412",
        id: 935942283214344302n
    }],
    settings,
    patches: [
        {
            find: ".winButtonsWithDivider]",
            replacement: {
                match: /(\((\i)\){)(let{leading)/,
                replace: "$1$2?.trailing?.props?.children?.unshift($self.renderQuestButtonTopBar());$3"
            }
        },
        {
            find: "#{intl::ACCOUNT_SPEAKING_WHILE_MUTED}",
            replacement: {
                match: /className:\i\.buttons,.+?children:\[/,
                replace: "$&$self.renderQuestButtonSettingsBar(),"
            }
        },
        {
            find: "\"innerRef\",\"navigate\",\"onClick\"",
            replacement: {
                match: /(\i).createElement\("a",(\i)\)/,
                replace: "$1.createElement(\"a\",$self.renderQuestButtonBadges($2))"
            }
        },
        {
            find: "location:\"GlobalDiscoverySidebar\"",
            replacement: {
                match: /(\(\i\){let{tab:(\i)}=.+?children:\i}\))(]}\))/,
                replace: "$1,$self.renderQuestButtonBadges($2)$3"
            }
        },
        {
            find: "\"RunningGameStore\"",
            group: true,
            replacement: [
                {
                    match: /}getRunningGames\(\){return/,
                    replace: "}getRunningGames(){const games=$self.getRunningGames();return games ? games : "
                },
                {
                    match: /}getGameForPID\((\i)\){/,
                    replace: "}getGameForPID($1){const pid=$self.getGameForPID($1);if(pid){return pid;}"
                }
            ]
        },
        {
            find: "ApplicationStreamingStore",
            replacement: {
                match: /}getStreamerActiveStreamMetadata\(\){/,
                replace: "}getStreamerActiveStreamMetadata(){const metadata=$self.getStreamerActiveStreamMetadata();if(metadata){return metadata;}"
            }
        }
    ],
    start: () => {
        QuestsStore.addChangeListener(updateQuests);
        updateQuests();

        enableCaptchaBypass();

        startTokenCacheCleanup();

        if (settings.store.autoCaptchaSolving) {
            const servicePreference = settings.store.captchaSolvingService;
            const apiKeys = {
                nopecha: settings.store.nopchaApiKey,
                twoCaptcha: settings.store.twoCaptchaApiKey,
                capsolver: settings.store.capsolverApiKey,
            };
            captchaMonitor = setupCaptchaMonitor(servicePreference, apiKeys);
        }
    },
    stop: () => {
        QuestsStore.removeChangeListener(updateQuests);
        stopCompletingAll();
        disableCaptchaBypass();

        stopTokenCacheCleanup();
        clearTokenCache();

        if (captchaMonitor) {
            cleanupCaptchaMonitor(captchaMonitor);
            captchaMonitor = null;
        }
    },

    renderQuestButtonTopBar() {
        if (settings.store.disableUiRendering) return;
        if (settings.store.showQuestsButtonTopBar) {
            return <QuestButton type="top-bar" />;
        }
    },

    renderQuestButtonSettingsBar() {
        if (settings.store.disableUiRendering) return;
        if (settings.store.showQuestsButtonSettingsBar) {
            return <QuestButton type="settings-bar" />;
        }
    },

    renderQuestButtonBadges(questButton) {
        if (settings.store.disableUiRendering) {
            return questButton;
        }
        if (settings.store.showQuestsButtonBadges && typeof questButton === "string" && questButton === "quests") {
            return (<QuestsCount />);
        }
        if (settings.store.showQuestsButtonBadges && questButton?.href?.startsWith("/quest-home")
            && Array.isArray(questButton?.children) && questButton.children.findIndex(child => child?.type === QuestsCount) === -1) {
            questButton.children.push(<QuestsCount />);
        }
        return questButton;
    },

    getRunningGames() {
        if (fakeGames.size > 0) {
            return Array.from(fakeGames.values());
        }
    },

    getGameForPID(pid) {
        if (fakeGames.size > 0) {
            return Array.from(fakeGames.values()).find(game => game.pid === pid);
        }
    },

    getStreamerActiveStreamMetadata() {
        if (fakeApplications.size > 0) {
            return Array.from(fakeApplications.values()).at(0);
        }
    }
});

function updateQuests() {
    availableQuests = [...QuestsStore.quests.values()];
    const preferredQuests = availableQuests.filter(questMatchesRewardPreference);
    acceptableQuests = preferredQuests.filter(x => x.userStatus?.enrolledAt == null && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
    completableQuests = preferredQuests.filter(x => x.userStatus?.enrolledAt && !x.userStatus?.completedAt && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
    claimableQuests = preferredQuests.filter(x => x.userStatus?.completedAt && !x.userStatus?.claimedAt && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
    for (const quest of acceptableQuests) {
        acceptQuest(quest);
    }
    for (const quest of completableQuests) {
        if (completingQuest.has(quest.id)) {
            if (completingQuest.get(quest.id) === false) {
                completingQuest.delete(quest.id);
            }
        } else {
            completeQuest(quest);
        }
    }
    for (const quest of claimableQuests) {
        claimQuestReward(quest);
    }
}

async function acceptQuest(quest: QuestValue) {
    if (!settings.store.acceptQuestsAutomatically) return;
    const action: QuestAction = {
        questContent: QuestLocationMap.QUEST_HOME_DESKTOP,
        questContentCTA: "ACCEPT_QUEST",
        sourceQuestContent: 0,
    };

    try {
        await QuestApplyAction(quest.id, action);
        console.log("Accepted quest:", quest.config.messages.questName);
    } catch (err: any) {
        if (settings.store.autoCaptchaSolving) {
            const challenge = detectCaptchaChallenge(err);
            if (challenge) {
                console.log("[CompleteDiscordQuest] Captcha detected during quest accept, bypassing...");
                const bypassResult = await bypassCaptcha(challenge);
                if (bypassResult.success) {
                    console.log("[CompleteDiscordQuest] Captcha bypassed, retrying quest accept...");
                    try {
                        await QuestApplyAction(quest.id, action);
                        console.log("Accepted quest after captcha bypass:", quest.config.messages.questName);
                        return;
                    } catch (retryErr) {
                        console.error("Failed to accept quest after captcha bypass:", quest.config.messages.questName, retryErr);
                    }
                }
            }
        }
        console.error("Failed to accept quest:", quest.config.messages.questName, err);
    }
}

function stopCompletingAll() {
    for (const quest of completableQuests) {
        if (completingQuest.has(quest.id)) {
            completingQuest.set(quest.id, false);
        }
    }
    console.log("Stopped completing all quests.");
}

function completeQuest(quest: QuestValue) {
    const isApp = typeof DiscordNative !== "undefined";
    if (!quest) {
        console.log("You don't have any uncompleted quests!");
        return;
    }

    const pid = Math.floor(Math.random() * 30000) + 1000;

    const applicationId = quest.config.application.id;
    const applicationName = quest.config.application.name;
    const { questName } = quest.config.messages;
    const taskConfig = (quest.config as any).taskConfig ?? quest.config.taskConfigV2;
    const taskName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(x => taskConfig.tasks[x] != null);
    if (!taskName) {
        console.log("Unknown task type for quest:", questName);
        return;
    }
    const secondsNeeded = taskConfig.tasks[taskName].target;
    const secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    if (!isApp && taskName !== "WATCH_VIDEO" && taskName !== "WATCH_VIDEO_ON_MOBILE") {
        console.log("This no longer works in browser for non-video quests. Use the discord desktop app to complete the", questName, "quest!");
        return;
    }

    const handler = questHandlers.find(h => h.supports(taskName));
    if (!handler) {
        console.error("No handler found for task type:", taskName);
        completingQuest.set(quest.id, false);
        return;
    }

    completingQuest.set(quest.id, true);

    console.log(`Completing quest ${questName} (${quest.id}) - ${taskName} for ${secondsNeeded} seconds.`);

    handler.handle({
        quest,
        questName,
        taskName,
        secondsNeeded,
        secondsDone,
        applicationId,
        applicationName,
        configVersion: quest.config.configVersion,
        pid,
        isApp,
        completingQuest,
        fakeGames,
        fakeApplications,
        RestAPI,
        FluxDispatcher,
        RunningGameStore,
        ChannelStore,
        GuildChannelStore,
        getSpoofingProfile,
        onQuestComplete: () => handleQuestCompletion(quest)
    });
}
