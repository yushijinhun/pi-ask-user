import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { pathToFileURL } from "node:url";

// Override the host to exercise an installed Pi without changing devDependencies.
const host = process.env.PI_TEST_HOST ?? import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(host);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getSystemMessageText, getCurrentTools } =
    await import(new URL("./dist/index.js", pathToFileURL(findPackageJSON("@earendil-works/pi-ai", host))));
const bridge = process.env.PI_TEST_BRIDGE
    ? (await import(pathToFileURL(process.env.PI_TEST_BRIDGE))).toBridgeContext : undefined;
const acm = process.env.PI_TEST_CONTEXT_EXTENSION;
const text = (message) => typeof message.content === "string" ? message.content :
    (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
const notices = (messages) => messages.filter((message) => /^Interactive questions are (ON|OFF)\./.test(text(message)));
const stateEntries = (sm) => sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "ask-user-availability");
const contentView = (messages) => messages.map((message) => ({ role: message.role, content: message.content }));
function extendsPrefix(previous, next) {
    assert.deepEqual(contentView(next.slice(0, previous.length)), contentView(previous), "existing request prefix must stay fixed");
}
function beforePrompt(messages, state, prompt) {
    const notice = messages.findLastIndex((message) => text(message).startsWith(`Interactive questions are ${state}.`));
    const user = messages.findLastIndex((message) => message.role === "user" && text(message) === prompt);
    assert.ok(notice >= 0 && notice < user, `availability ${state} must precede ${prompt}`);
}
function closedPairs(messages) {
    const pending = new Set();
    for (const message of messages) {
        if (message.role === "assistant") {
            for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
        } else if (message.role === "toolResult") {
            assert.ok(pending.delete(message.toolCallId), "tool result must have its call");
        } else if (message.role !== "system") {
            assert.equal(pending.size, 0, "availability/input must not split tool calls from results");
        }
    }
    assert.equal(pending.size, 0);
}

async function harness({ context = false, reverse = false, sessionFile, fork = false, settings = {}, window = 128000 } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "pi-ask-controls-"));
    const faux = fauxProvider({ models: [{ id: "controls", contextWindow: window, maxTokens: 512 }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const requests = [], errors = [], notifications = [];
    let session, askCalls = 0, action, afterTool;
    const controls = resolve("tools.ts");
    const paths = context ? (reverse ? [acm, controls] : [controls, acm]) : [controls];
    const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: paths,
        extensionFactories: [(pi) => {
            pi.registerTool({ name: "ask_user", label: "Ask", description: "Ask the user.", parameters: Type.Object({}),
                executionMode: "sequential", async execute() { askCalls++; return { content: [{ type: "text", text: "Yes" }], details: {} }; } });
            pi.registerTool({ name: "step", label: "Step", description: "Test operation.", parameters: Type.Object({}),
                executionMode: "sequential", async execute(_id, _args, _signal, _onUpdate, ctx) { return { content: [{ type: "text", text: await action?.(ctx) ?? "done" }], details: {} }; } });
            pi.on("tool_execution_end", async (event) => { await afterTool?.(event); });
        }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const sm = sessionFile ? (fork ? SessionManager.forkFrom(sessionFile, dir, dir) : SessionManager.open(sessionFile, dir)) : SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({
        cwd: dir, agentDir: dir, model: faux.getModel(), modelRuntime, resourceLoader: loader, sessionManager: sm,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 64 }, retry: { enabled: false }, ...settings }),
        tools: ["ask_user", "step", ...(context ? ["context_compact", "context_timeline", "context_checkpoint"] : [])],
    }));
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error),
        uiContext: { setStatus() {}, notify: (message) => notifications.push(message) } });
    const reply = (content = "done", effect) => async (request) => {
        requests.push(structuredClone(request));
        await effect?.();
        const blocks = Array.isArray(content) ? content : [content];
        return fauxAssistantMessage(content, { stopReason: blocks.some((block) => block?.type === "toolCall") ? "toolUse" : "stop" });
    };
    return {
        session, sm, faux, requests, errors, notifications, reply,
        get askCalls() { return askCalls; },
        set action(value) { action = value; }, set afterTool(value) { afterTool = value; },
        ask: (mode) => session.prompt(`/ask ${mode}`),
        call: (name) => fauxToolCall(name, {}),
        async run(prompt, responses = [reply()]) {
            faux.setResponses(responses);
            await session.prompt(prompt);
            assert.equal(faux.getPendingResponseCount(), 0, "every planned response was requested");
            assert.deepEqual(errors, []);
            assert.deepEqual(sm.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error").map((entry) => entry.message.errorMessage), []);
        },
        checkLoadout() {
            const first = requests[0];
            for (const request of requests) {
                assert.equal(getSystemMessageText(getCurrentSystemMessage(request.messages)), getSystemMessageText(getCurrentSystemMessage(first.messages)));
                assert.deepEqual(getCurrentTools(request.messages), getCurrentTools(first.messages));
                if (bridge) {
                    const a = bridge(first), b = bridge(request);
                    assert.equal(a.systemPrompt, b.systemPrompt);
                    assert.deepEqual(a.tools, b.tools);
                }
            }
        },
        async dispose() { session.dispose(); await rm(dir, { recursive: true, force: true }); },
    };
}

test("idle toggles coalesce, announcements precede input, and re-enabling clears a rejection", { timeout: 20000 }, async () => {
    const h = await harness();
    try {
        await h.ask("off"); await h.ask("on");
        assert.equal(stateEntries(h.sm).length, 0);
        await h.run("baseline");
        assert.equal(notices(h.requests[0].messages).length, 0);
        await h.ask("off"); await h.ask("on"); await h.ask("off"); await h.ask("off");
        assert.equal(h.requests.length, 1, "toggles never start a request");
        await h.run("disabled request", [h.reply(h.call("ask_user")), h.reply()]);
        assert.equal(h.askCalls, 0);
        beforePrompt(h.requests[1].messages, "OFF", "disabled request");
        assert.match(text(h.requests[2].messages.findLast((message) => message.role === "toolResult")), /Interactive questions disabled/);
        assert.equal(stateEntries(h.sm).length, 1);
        const branch = h.sm.getBranch();
        assert.ok(branch.indexOf(stateEntries(h.sm)[0]) < branch.findIndex((entry) => entry.type === "message" && text(entry.message) === "disabled request"));
        await h.ask("on");
        await h.run("enabled request", [h.reply(h.call("ask_user")), h.reply()]);
        assert.equal(h.askCalls, 1);
        beforePrompt(h.requests[3].messages, "ON", "enabled request");
        assert.equal(stateEntries(h.sm).length, 2);
        for (let i = 1; i < h.requests.length; i++) extendsPrefix(h.requests[i - 1].messages, h.requests[i].messages);
        h.checkLoadout();
    } finally { await h.dispose(); }
});

test("live toggles close tool pairs, precede steering, and recover from off/on around a rejected call", { timeout: 20000 }, async () => {
    const h = await harness();
    try {
        await h.ask("on");
        h.action = async () => { await h.ask("off"); await h.session.steer("queued input"); };
        await h.run("live", [h.reply(h.call("step")), h.reply()]);
        beforePrompt(h.requests[1].messages, "OFF", "queued input");
        closedPairs(h.requests[1].messages);
        await h.ask("on");
        h.afterTool = async (event) => { if (event.toolName === "ask_user") await h.ask("on"); };
        await h.run("race", [h.reply(h.call("ask_user"), () => h.ask("off")), h.reply()]);
        assert.equal(h.askCalls, 0);
        const next = h.requests.at(-1).messages;
        assert.match(text(next.at(-1)), /^Interactive questions are ON\./);
        assert.equal(next.at(-2).role, "toolResult");
        closedPairs(next);
        h.action = async (ctx) => {
            await h.ask("off");
            const result = await ctx.executeTool("ask_user", {});
            return text(result);
        };
        await h.run("nested call", [h.reply(h.call("step")), h.reply()]);
        assert.equal(h.askCalls, 0);
        assert.match(text(h.requests.at(-1).messages.at(-1)), /^Interactive questions are ON\./);
        assert.equal(h.requests.at(-1).messages.at(-2).toolName, "step");
        const count = stateEntries(h.sm).length;
        await h.run("last reply", [h.reply("finished", () => h.ask("off"))]);
        assert.equal(stateEntries(h.sm).length, count, "a final reply must not flush an unneeded hint");
        await h.ask("on");
        await h.run("next input");
        assert.equal(stateEntries(h.sm).length, count);
        h.checkLoadout();
    } finally { await h.dispose(); }
});

test("tree, reload, saved-session resume, and fork restore branch-local mode without extra hints", { timeout: 20000 }, async () => {
    const h = await harness();
    try {
        await h.ask("on");
        await h.run("root"); const root = h.sm.getLeafId();
        await h.ask("off"); await h.run("off branch"); const off = h.sm.getLeafId();
        await h.ask("on"); await h.run("on branch");
        await h.session.navigateTree(off);
        await h.session.reload();
        await h.ask("status"); assert.equal(h.notifications.at(-1), "Interactive questions off.");
        assert.equal(stateEntries(h.sm).length, 1);
        // Pi saves an active branch in the file when it next receives an entry.
        await h.run("save off branch");
        for (const fork of [false, true]) {
            const restored = await harness({ sessionFile: h.sm.getSessionFile(), fork });
            try {
                await restored.ask("status"); assert.equal(restored.notifications.at(-1), "Interactive questions off.");
                await restored.run("restored", [restored.reply(restored.call("ask_user")), restored.reply()]);
                assert.equal(restored.askCalls, 0);
                assert.equal(stateEntries(restored.sm).length, 1);
            } finally { await restored.dispose(); }
        }
        await h.session.navigateTree(root);
        await h.ask("status"); assert.equal(h.notifications.at(-1), "Interactive questions on.");
        assert.equal(stateEntries(h.sm).length, 0);
        await h.run("sibling", [h.reply(h.call("ask_user")), h.reply()]);
        assert.equal(h.askCalls, 1);
    } finally { await h.dispose(); }
});

test("native compaction carries folded mode at a fixed position across later toggles and reload", { timeout: 20000 }, async () => {
    const h = await harness();
    try {
        await h.run("older input", [h.reply("old detail ".repeat(200))]);
        await h.run("recent input", [h.reply("recent detail ".repeat(100))]);
        h.faux.setResponses([fauxAssistantMessage("NATIVE_SUMMARY"), fauxAssistantMessage("NATIVE_TURN_SUMMARY")]);
        await h.session.compact();
        assert.equal(notices(h.sm.buildSessionProjection().messages).length, 0, "fixture must fold away the announcement");
        await h.run("after native");
        const after = h.requests.at(-1).messages;
        beforePrompt(after, "OFF", "after native");
        assert.equal(notices(after).length, 1);
        await h.ask("on"); await h.run("changed after native");
        extendsPrefix(after, h.requests.at(-1).messages);
        const beforeReload = h.requests.at(-1).messages;
        await h.session.reload(); await h.run("after reload");
        extendsPrefix(beforeReload, h.requests.at(-1).messages);
        h.checkLoadout();
    } finally { await h.dispose(); }
});

test("automatic native compaction between tool turns retains availability", { timeout: 20000 }, async () => {
    const h = await harness({ window: 10000, settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 64 } } });
    try {
        await h.ask("off");
        h.action = async () => "large output ".repeat(5000);
        await h.run("automatic", [h.reply(h.call("step")), fauxAssistantMessage("AUTO_SUMMARY"), fauxAssistantMessage("AUTO_TURN_SUMMARY"), h.reply()]);
        assert.ok(h.sm.getBranch().some((entry) => entry.type === "compaction"));
        const after = h.requests.at(-1).messages;
        assert.equal(notices(after).length, 1);
        assert.match(text(notices(after)[0]), /^Interactive questions are OFF\./);
        assert.deepEqual(h.errors, []);
    } finally { await h.dispose(); }
});

for (const reverse of [false, true]) test(`ACM carries mode, preserves later prefixes, and composes with native compaction (reverse=${reverse})`,
    { timeout: 20000, skip: !acm }, async () => {
    const h = await harness({ context: true, reverse });
    try {
        await h.ask("on"); await h.run("root");
        await h.ask("off"); await h.run("off before ACM");
        const compact = () => fauxToolCall("context_compact", { target: "root", summary: "ACM_SUMMARY. Continue." });
        await h.run("compact", [h.reply(compact()), h.reply()]);
        const after = h.requests.at(-1).messages;
        assert.ok(after.some((message) => text(message).includes("ACM_SUMMARY")));
        assert.equal(notices(after).length, 1);
        assert.match(text(notices(after)[0]), /^Interactive questions are OFF\./);
        assert.equal(stateEntries(h.sm).length, 1, "ACM must not add another persistent hint");
        await h.ask("on"); await h.run("on after ACM");
        extendsPrefix(after, h.requests.at(-1).messages);
        const on = h.requests.at(-1).messages;
        await h.session.reload(); await h.run("reload after ACM");
        extendsPrefix(on, h.requests.at(-1).messages);
        await h.run("compact again", [h.reply(compact()), h.reply("enough new material ".repeat(100))]);
        assert.equal(notices(h.requests.at(-1).messages).length, 1);
        assert.match(text(notices(h.requests.at(-1).messages)[0]), /^Interactive questions are ON\./);
        await h.run("keep recent", [h.reply("recent answer ".repeat(100))]);
        h.faux.setResponses([fauxAssistantMessage("NATIVE_AFTER_ACM"), fauxAssistantMessage("NATIVE_TURN_SUMMARY")]);
        await h.session.compact();
        await h.run("after both");
        beforePrompt(h.requests.at(-1).messages, "ON", "after both");
        assert.equal(notices(h.requests.at(-1).messages).length, 1);
        h.checkLoadout();
    } finally { await h.dispose(); }
});
