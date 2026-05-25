#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.NODE_ENV = "test";

const { buildSystemBlock, responsesToChatBody } = await import("../adaptive-server.mjs");

function usage() {
    console.error("Usage: node translator/tools/cache_stability_diff.mjs <responses-a.json> <responses-b.json>");
    process.exit(2);
}

function stableStringify(value) {
    return JSON.stringify(value, (key, val) => {
        if (!val || typeof val !== "object" || Array.isArray(val)) return val;
        return Object.keys(val).sort().reduce((out, k) => {
            out[k] = val[k];
            return out;
        }, {});
    }, 2);
}

function firstDiff(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return i;
    }
    return a.length === b.length ? -1 : len;
}

function contextAt(text, index) {
    if (index < 0) return "";
    const start = Math.max(0, index - 180);
    const end = Math.min(text.length, index + 260);
    return text.slice(start, end);
}

function readRequest(path) {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function toChatBody(request) {
    const compact = request?.tool_choice === "none" && !Array.isArray(request?.tools);
    const body = responsesToChatBody(request, {
        extraSystem: compact ? "" : buildSystemBlock(),
        allowTools: !compact,
        injectInternalTools: !compact,
    });
    delete body._routing;
    return body;
}

const [leftPath, rightPath] = process.argv.slice(2);
if (!leftPath || !rightPath) usage();

const left = stableStringify(toChatBody(readRequest(leftPath)));
const right = stableStringify(toChatBody(readRequest(rightPath)));
const diff = firstDiff(left, right);

const result = {
    equal: diff === -1,
    leftBytes: left.length,
    rightBytes: right.length,
    commonPrefixBytes: diff === -1 ? left.length : diff,
    firstDiff: diff,
    leftContext: contextAt(left, diff),
    rightContext: contextAt(right, diff),
};

console.log(JSON.stringify(result, null, 2));
