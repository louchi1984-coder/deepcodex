(() => {
  try {
    if (window.__DEEPCODEX_PLUGIN_UNLOCK_INSTALLED__) return;
    window.__DEEPCODEX_PLUGIN_UNLOCK_INSTALLED__ = true;

    const selectors = {
      navButtons: 'nav[role="navigation"] button, aside button, [role="navigation"] button',
      disabledButtons: 'button[disabled], button[aria-disabled="true"], [role="button"][aria-disabled="true"]',
      pluginIconPath: 'svg path[d^="M7.94562 14.0277"]',
    };

    function textOf(node) {
      return (node?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function reactFiberFrom(element) {
      const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber"));
      return fiberKey ? element[fiberKey] : null;
    }

    function authContextValueFrom(element) {
      for (let fiber = reactFiberFrom(element); fiber; fiber = fiber.return) {
        const values = [fiber.memoizedProps && fiber.memoizedProps.value, fiber.pendingProps && fiber.pendingProps.value];
        for (const value of values) {
          if (value && typeof value === "object" && typeof value.setAuthMethod === "function" && "authMethod" in value) {
            return value;
          }
        }
      }
      return null;
    }

    function spoofChatGPTAuthMethod(element) {
      try {
        const auth = authContextValueFrom(element);
        if (!auth || auth.authMethod === "chatgpt") return false;
        auth.setAuthMethod("chatgpt");
        return true;
      } catch {
        return false;
      }
    }

    function looksLikePluginEntry(button) {
      const text = textOf(button);
      return /^(\u63d2\u4ef6|Plugins)(\s+-\s+.*)?$/i.test(text) || !!button.querySelector(selectors.pluginIconPath);
    }

    function looksLikeInstallButton(button) {
      const text = textOf(button);
      return /^(\u5b89\u88c5|Install)(\s|$)/i.test(text) || /Force Install/i.test(text);
    }

    function unblockButton(button) {
      try {
        button.disabled = false;
        button.removeAttribute("disabled");
        button.removeAttribute("aria-disabled");
        button.classList.remove("disabled", "opacity-50", "cursor-not-allowed", "pointer-events-none");
        button.style.pointerEvents = "auto";
        button.style.display = "";
        button.tabIndex = 0;
        const reactPropsKey = Object.keys(button).find((key) => key.startsWith("__reactProps"));
        if (reactPropsKey) {
          button[reactPropsKey].disabled = false;
          button[reactPropsKey]["aria-disabled"] = false;
        }
      } catch {}
    }

    function labelPluginEntry(button) {
      try {
        if (button.dataset.deepcodexPluginLabelled === "true") return;
        button.dataset.deepcodexPluginLabelled = "true";
        button.title = "DeepCodex plugin UI unlock active";
      } catch {}
    }

    function scan() {
      try {
        for (const button of Array.from(document.querySelectorAll(selectors.navButtons))) {
          if (!looksLikePluginEntry(button)) continue;
          spoofChatGPTAuthMethod(button);
          unblockButton(button);
          labelPluginEntry(button);
          if (button.dataset.deepcodexPluginUnlocked !== "true") {
            button.dataset.deepcodexPluginUnlocked = "true";
            button.addEventListener("click", () => spoofChatGPTAuthMethod(button), true);
          }
        }

        for (const button of Array.from(document.querySelectorAll(selectors.disabledButtons))) {
          if (!looksLikeInstallButton(button)) continue;
          spoofChatGPTAuthMethod(button);
          unblockButton(button);
        }
      } catch {}
    }

    function start() {
      scan();
      const root = document.documentElement || document.body;
      if (root) {
        const observer = new MutationObserver(scan);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "class", "style"] });
      }
      window.setInterval(scan, 1500);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      window.setTimeout(start, 500);
    }
  } catch (err) {
    console.warn("[DeepCodex] plugin unlock injection failed", err);
  }
})();
