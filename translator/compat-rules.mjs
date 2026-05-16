/**
 * compat-rules.mjs — Tool classification & translation plan helpers
 *
 * Extracted from adaptive-server.mjs patterns so tests can verify
 * the desired compatibility rules without importing the server module.
 *
 * Rules tested here:
 *   - function tools → local callable
 *   - custom (apply_patch) → custom/freeform/grammar with metadata
 *   - namespace tools → nested tools recognized, not single callable
 *   - web_search / image_generation → hosted/account-bound, not local
 *   - tool_choice "none" → no tools forwarded/injected
 *   - compact mode → no tools/internal tools injected
 */

// ─────────────────────────────────────── hosted-only tool types (from adaptive-server.mjs) ──

export const HOSTED_ONLY = new Set(["web_search", "web_search_preview", "image_generation", "code_interpreter"]);

// ─────────────────────────────────────── tool classification ──

/**
 * Classify a single tool entry from a Responses API request.
 *
 * Returns an object with:
 *   type        – "function" | "custom" | "namespace" | "hosted" | "unknown"
 *   name        – string
 *   hostedType  – string (only for hosted tools)
 *   nested      – array (only for namespace tools)
 *   format      – object (only for custom tools if present)
 *   metadata    – preserved original keys the caller cares about
 */
export function classifyTool(tool) {
  if (!tool || typeof tool !== "object") {
    return { type: "unknown", name: "", metadata: {} };
  }

  const ttype = tool.type;

  // Hosted / account-bound tools
  if (HOSTED_ONLY.has(ttype)) {
    return {
      type: "hosted",
      name: tool.name || ttype,
      hostedType: ttype,
      metadata: { ...tool },
    };
  }

  // Function tools
  if (ttype === "function") {
    return {
      type: "function",
      name: tool.name || tool.function?.name || "",
      metadata: {
        description: tool.description || tool.function?.description || "",
        parameters: tool.parameters || tool.function?.parameters || null,
      },
    };
  }

  // Custom / freeform tools (e.g. apply_patch)
  if (ttype === "custom") {
    const fmt = tool.format || null;
    return {
      type: "custom",
      name: tool.name || "",
      format: fmt,
      metadata: {
        description: tool.description || "",
        formatType: fmt?.type || null,
        formatSyntax: fmt?.syntax || null,
      },
    };
  }

  // Namespace tools — nested tool entries
  if (ttype === "namespace") {
    const nested = Array.isArray(tool.tools) ? tool.tools.map(classifyTool) : [];
    return {
      type: "namespace",
      name: tool.name || "",
      nested,
      metadata: {
        description: tool.description || "",
        nestedCount: nested.length,
        nestedNames: nested.map((t) => t.name).filter(Boolean),
      },
    };
  }

  return { type: "unknown", name: tool.name || "", metadata: { ...tool } };
}

/**
 * Classify all tools in a Responses API request.
 */
export function classifyTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(classifyTool);
}

// ─────────────────────────────────────── classification summary ──

/**
 * Summarize a classified tool list into categorized buckets.
 */
export function summarizeClassification(classified) {
  const byType = {};
  for (const t of classified) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  // Namespace nested tools
  const namespaceSubtools = [];
  for (const ns of byType.namespace || []) {
    for (const sub of ns.nested || []) {
      namespaceSubtools.push({ namespace: ns.name, ...sub });
    }
  }

  return {
    total: classified.length,
    byType,
    functionCount: (byType.function || []).length,
    customCount: (byType.custom || []).length,
    namespaceCount: (byType.namespace || []).length,
    hostedCount: (byType.hosted || []).length,
    unknownCount: (byType.unknown || []).length,
    functionNames: (byType.function || []).map((t) => t.name).sort(),
    customNames: (byType.custom || []).map((t) => t.name).sort(),
    namespaceNames: (byType.namespace || []).map((t) => t.name).sort(),
    hostedNames: (byType.hosted || []).map((t) => t.name).sort(),
    namespaceSubtools,
  };
}

// ─────────────────────────────────────── translation plan ──

/**
 * Generate a plan describing how the request would be translated
 * for a non-OpenAI upstream (e.g. DeepSeek Chat API).
 *
 * Mirrors the logic in adaptive-server.mjs `responsesToChatBody`.
 *
 * @param {object} parsed - The parsed Responses API request body
 * @param {object} options
 * @param {boolean} options.compact - If true, no tools are forwarded/injected
 * @returns {object} plan
 */
export function generateTranslationPlan(parsed, options = {}) {
  const compact = options.compact === true;
  const allowTools = !compact && parsed.tool_choice !== "none";
  const injectInternal = allowTools; // mirrors adaptive-server.mjs

  const classified = classifyTools(parsed.tools);
  const summary = summarizeClassification(classified);

  // Tools that would be forwarded to chat API (non-hosted, non-namespace at top level)
  const forwardedTools = [];
  const droppedTools = [];

  if (allowTools && Array.isArray(parsed.tools)) {
    for (const raw of parsed.tools) {
      const cl = classifyTool(raw);
      if (cl.type === "hosted") {
        droppedTools.push({ name: cl.name, reason: "hosted/account-bound", hostedType: cl.hostedType });
      } else if (cl.type === "namespace") {
        // Namespace itself is not forwarded; its nested function tools are
        for (const sub of cl.nested) {
          if (sub.type === "function") {
            forwardedTools.push({
              name: sub.name,
              namespace: cl.name,
              type: "function",
              source: `namespace:${cl.name}`,
            });
          }
        }
      } else {
        // function, custom, unknown → forward
        forwardedTools.push({
          name: cl.name,
          type: cl.type,
          formatType: cl.metadata?.formatType || null,
        });
      }
    }
  }

  return {
    model: parsed.model || "unknown",
    toolChoice: parsed.tool_choice || "auto",
    compact,
    allowTools,
    injectInternalTools: injectInternal,
    classification: summary,
    forwardedTools,
    droppedTools,
    // Decision fields for assertions
    wouldForwardTools: allowTools && forwardedTools.length > 0,
    wouldDropHosted: droppedTools.length > 0,
    wouldInjectInternal: injectInternal,
    customToolPreserved: forwardedTools.some((t) => t.type === "custom"),
    namespaceToolsFlattened: forwardedTools.some((t) => t.namespace),
  };
}

// ─────────────────────────────────────── Chat tool builder with routing ──

/**
 * Build Chat Completions API tool definitions from a Responses API
 * request, with routing metadata so upstream tool call names can be
 * mapped back to original Codex callable names.
 *
 * @param {object} parsed - The parsed Responses API request body
 * @param {object} options
 * @param {boolean} options.compact - If true, no tools are produced
 * @param {boolean} options.injectInternalTools - If true, internal tools are appended
 * @param {Array} options.internalTools - Array of internal tool definitions to inject
 * @returns {{ tools: Array, routing: object }} Chat-format tools + routing metadata
 */
export function buildChatToolsWithRouting(parsed, options = {}) {
  const compact = options.compact === true;
  const allowTools = !compact && parsed.tool_choice !== "none";
  const injectInternal = options.injectInternalTools !== false && allowTools;
  const internalDefs = options.internalTools || [];

  const chatTools = [];
  const routing = {};

  if (!allowTools) {
    // tool_choice "none" or compact: forward/inject nothing
    return { tools: chatTools, routing };
  }

  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    // No request tools: still allow internal injection if enabled
    if (!injectInternal) return { tools: chatTools, routing };
    for (const it of internalDefs) {
      const name = it.function?.name || "";
      if (!name) continue;
      if (!chatTools.some(t => t.function.name === name)) chatTools.push(it);
    }
    return { tools: chatTools, routing };
  }

  for (const raw of parsed.tools) {
    const cl = classifyTool(raw);

    if (cl.type === "hosted") {
      // Drop hosted/account-bound tools when upstream lacks them
      continue;
    }

    if (cl.type === "namespace") {
      // Flatten: each nested function tool → standalone Chat function
      // with collision-safe name: namespace + "__" + subtool (strip trailing __ from namespace)
      const nsClean = String(cl.name).replace(/__+$/, "");
      for (const sub of cl.nested) {
        if (sub.type !== "function") continue;
        const chatName = `${nsClean}__${sub.name}`;
        const desc = sub.metadata.description || `Function ${sub.name} in namespace ${cl.name}`;
        chatTools.push({
          type: "function",
          function: {
            name: chatName,
            description: desc,
            parameters: sub.metadata.parameters || { type: "object", properties: {} },
          },
        });
        routing[chatName] = {
          codexName: sub.name,
          type: "function",
          namespace: cl.name,
        };
        if (!routing[sub.name]) {
          routing[sub.name] = {
            chatName,
            codexName: sub.name,
            type: "function",
            namespace: cl.name,
            aliasOnly: true,
          };
        }
      }
      continue;
    }

    if (cl.type === "custom") {
      // Forward as a callable function with routing metadata + argument handling notes.
      // The description advises the model this is a freeform tool; the format
      // description is embedded so the model can produce valid arguments.
      const fmtType = cl.metadata.formatType || "unknown";
      const fmtSyntax = cl.metadata.formatSyntax || "";
      const desc = cl.metadata.description || "";
      const argNote = fmtType === "grammar" && fmtSyntax === "lark"
        ? `\n\nARGUMENT FORMAT: This is a freeform tool adapted to Chat Completions. Put the complete raw patch body in the "content" argument using the grammar syntax (${fmtSyntax}). The body must start with "*** Begin Patch"; every file hunk must start with exactly "*** Add File: <path>", "*** Delete File: <path>", or "*** Update File: <path>"; update hunks use "@@" / "@@ <context>" plus space/-/+ lines; the final line must be exactly "*** End Patch". Never call this tool with {}, empty content, or explanatory text. Never use narrative hunk headers, ordinary unified-diff headers (---/+++), or line-number replacement prose; if you cannot construct a valid patch, stop and explain the blocker instead of using shell commands to rewrite files.`
        : fmtType
          ? `\n\nARGUMENT FORMAT: This is a freeform tool adapted to Chat Completions. Put the complete raw tool content in the "content" argument using format "${fmtType}"${fmtSyntax ? ` (${fmtSyntax})` : ""}. Never call this tool with {}, empty content, or explanatory text.`
          : "";

      chatTools.push({
        type: "function",
        function: {
          name: cl.name,
          description: desc + argNote,
          parameters: {
            type: "object",
            properties: {
              content: { type: "string", description: `The freeform content in ${fmtSyntax || fmtType || "the required"} format.` },
            },
            required: ["content"],
          },
        },
      });
      routing[cl.name] = {
        codexName: cl.name,
        type: "custom",
        namespace: null,
        formatType: fmtType,
        formatSyntax: fmtSyntax,
      };
      continue;
    }

    // Function / unknown tools → forward as normal Chat function
    const name = cl.name;
    if (!name) continue;
    chatTools.push({
      type: "function",
      function: {
        name,
        description: cl.metadata.description || "",
        parameters: cl.metadata.parameters || { type: "object", properties: {} },
      },
    });
    routing[name] = {
      codexName: name,
      type: cl.type,
      namespace: null,
    };
  }

  // Inject internal tools for missing capabilities
  if (injectInternal) {
    for (const it of internalDefs) {
      const name = it.function?.name || "";
      if (!name) continue;
      if (!chatTools.some(t => t.function.name === name)) chatTools.push(it);
    }
  }

  return { tools: chatTools, routing };
}
