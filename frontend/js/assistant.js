(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (typeof apiRequest !== "function") return;
    if (typeof isLoggedIn === "function" && !isLoggedIn()) return;

    var ASSISTANT_HISTORY_KEY = "saralta_assistant_history_v1";
    var ASSISTANT_OPEN_KEY = "saralta_assistant_open_v1";
    var assistantState = {
        history: loadAssistantHistory(),
        isOpen: loadAssistantOpenState(),
        isLoading: false,
        suppressLauncherClickUntil: 0
    };

    var shell = null;

    function loadAssistantHistory() {
        try {
            var raw = sessionStorage.getItem(ASSISTANT_HISTORY_KEY);
            var parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            var cleaned = parsed.filter(function (item) {
                return item && (item.role === "user" || item.role === "assistant") && item.content;
            }).slice(-14);
            if (
                cleaned.length === 1 &&
                cleaned[0].role === "assistant" &&
                String(cleaned[0].content || "").indexOf("I can answer questions from the live Saralta database") === 0
            ) {
                return [];
            }
            return cleaned;
        } catch (error) {
            return [];
        }
    }

    function saveAssistantHistory() {
        try {
            sessionStorage.setItem(ASSISTANT_HISTORY_KEY, JSON.stringify(assistantState.history.slice(-14)));
        } catch (error) {
            // Ignore storage errors in constrained environments.
        }
    }

    function loadAssistantOpenState() {
        try {
            localStorage.removeItem(ASSISTANT_OPEN_KEY);
            return false;
        } catch (error) {
            return false;
        }
    }

    function saveAssistantOpenState() {
        try {
            localStorage.removeItem(ASSISTANT_OPEN_KEY);
        } catch (error) {
            // Ignore storage errors in constrained environments.
        }
    }

    function buildAssistantShell() {
        var container = document.createElement("aside");
        container.className = "assistant-shell";
        container.innerHTML =
            '<button type="button" class="assistant-launcher" id="assistant-launcher" aria-label="Open Saralta Assist" aria-expanded="false">' +
                '<span class="assistant-launcher-icon" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
                        '<path d="M5 8.5A4.5 4.5 0 0 1 9.5 4h5A4.5 4.5 0 0 1 19 8.5v4A4.5 4.5 0 0 1 14.5 17H11l-3.8 3.2c-.7.6-1.7 0-1.6-.9l.4-2.3A4.47 4.47 0 0 1 5 12.5z"></path>' +
                        '<path d="M9 9.5h6"></path>' +
                        '<path d="M9 12.5h4"></path>' +
                    '</svg>' +
                '</span>' +
                '<span class="assistant-launcher-copy">' +
                    '<span class="assistant-launcher-title">Saralta Assist</span>' +
                    '<span class="assistant-launcher-meta">Live DB</span>' +
                '</span>' +
            '</button>' +
            '<section class="assistant-panel" id="assistant-panel" hidden style="display:none" aria-hidden="true">' +
                '<header class="assistant-panel-head">' +
                    '<div class="assistant-panel-brand">' +
                        '<div class="assistant-panel-badge">SA</div>' +
                        '<div>' +
                            '<h2 class="assistant-panel-title">Saralta Assist</h2>' +
                            '<p class="assistant-panel-meta">Live workspace answers, shaped for clarity</p>' +
                        '</div>' +
                    '</div>' +
                    '<div class="assistant-panel-actions">' +
                        '<button type="button" class="assistant-panel-btn" id="assistant-clear-btn" aria-label="Start a new conversation">New chat</button>' +
                        '<button type="button" class="assistant-panel-btn assistant-panel-btn--icon" id="assistant-collapse-btn" aria-label="Minimize assistant">' +
                            '<span aria-hidden="true">&#8722;</span>' +
                        '</button>' +
                    '</div>' +
                '</header>' +
                '<div class="assistant-panel-body">' +
                    '<div class="assistant-messages" id="assistant-messages" aria-live="polite"></div>' +
                    '<div class="assistant-empty-state" id="assistant-empty-state">' +
                        '<div class="assistant-empty-state-badge">Live DB</div>' +
                        '<h3 class="assistant-empty-state-title">Ask about your work without the clutter</h3>' +
                        '<p class="assistant-empty-state-copy">Get clean answers about tasks, milestones, dependencies, teams, and ownership from the workspace you already have access to.</p>' +
                    '</div>' +
                '</div>' +
                '<form class="assistant-composer" id="assistant-composer">' +
                    '<label class="sr-only" for="assistant-input">Ask Saralta Assist</label>' +
                    '<textarea id="assistant-input" class="assistant-input" rows="1" placeholder="Ask about a task, milestone, dependency, team, or assignment..."></textarea>' +
                    '<button type="submit" class="assistant-send-btn" id="assistant-send-btn">Send</button>' +
                '</form>' +
            '</section>';
        document.body.appendChild(container);
        return container;
    }

    function escapeHtml(value) {
        var div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    function formatInlineContent(value) {
        var safe = escapeHtml(value == null ? "" : String(value));
        safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
        return safe;
    }

    function flushListBuffer(buffer, htmlParts) {
        if (!buffer.length) return;
        htmlParts.push('<ul class="assistant-rich-list">' + buffer.map(function (item) {
            return '<li>' + item + '</li>';
        }).join("") + '</ul>');
        buffer.length = 0;
    }

    function formatMessageContent(value) {
        var text = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
        if (!text) return "";

        var lines = text.split("\n");
        var htmlParts = [];
        var listBuffer = [];

        lines.forEach(function (line) {
            var trimmed = line.trim();
            var bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
            var numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
            var keyValueMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9 /()#&_-]{1,40}):\s*(.+)$/);

            if (!trimmed) {
                flushListBuffer(listBuffer, htmlParts);
                return;
            }
            if (bulletMatch) {
                listBuffer.push(formatInlineContent(bulletMatch[1]));
                return;
            }
            if (numberedMatch) {
                listBuffer.push(formatInlineContent(numberedMatch[1]));
                return;
            }

            flushListBuffer(listBuffer, htmlParts);
            if (keyValueMatch) {
                htmlParts.push(
                    '<div class="assistant-kv-row">' +
                        '<span class="assistant-kv-label">' + formatInlineContent(keyValueMatch[1]) + ':</span>' +
                        '<span class="assistant-kv-value">' + formatInlineContent(keyValueMatch[2]) + '</span>' +
                    '</div>'
                );
                return;
            }

            htmlParts.push('<p class="assistant-rich-paragraph">' + formatInlineContent(trimmed) + '</p>');
        });

        flushListBuffer(listBuffer, htmlParts);
        if (!htmlParts.length) {
            htmlParts.push('<p class="assistant-rich-paragraph">' + formatInlineContent(text) + '</p>');
        }
        return '<div class="assistant-rich-text">' + htmlParts.join("") + '</div>';
    }

    function renderAssistant() {
        if (!shell) return;

        var launcher = document.getElementById("assistant-launcher");
        var panel = document.getElementById("assistant-panel");
        var messages = document.getElementById("assistant-messages");
        var emptyState = document.getElementById("assistant-empty-state");
        var sendBtn = document.getElementById("assistant-send-btn");
        var input = document.getElementById("assistant-input");

        if (!launcher || !panel || !messages || !sendBtn || !input) return;

        launcher.setAttribute("aria-expanded", assistantState.isOpen ? "true" : "false");
        panel.hidden = !assistantState.isOpen;
        panel.style.display = assistantState.isOpen ? "flex" : "none";
        panel.setAttribute("aria-hidden", assistantState.isOpen ? "false" : "true");
        shell.classList.toggle("is-open", assistantState.isOpen);
        sendBtn.disabled = assistantState.isLoading;
        input.disabled = assistantState.isLoading;
        input.setAttribute("placeholder", assistantState.isLoading ? "Checking the live database..." : "Ask about a task, milestone, dependency, team, or assignment...");

        messages.innerHTML = assistantState.history.map(function (item) {
            var citations = Array.isArray(item.citations) && item.citations.length
                ? '<div class="assistant-citations">' + item.citations.map(function (citation) {
                    var meta = citation.meta ? '<span class="assistant-citation-meta">' + escapeHtml(citation.meta) + '</span>' : '';
                    return '<span class="assistant-citation"><span class="assistant-citation-kind">' + escapeHtml(citation.kind || 'record') + '</span><span class="assistant-citation-title">' + escapeHtml(citation.title || '') + '</span>' + meta + '</span>';
                }).join('') + '</div>'
                : '';
            var footer = item.usedFallback
                ? '<div class="assistant-message-note">Answered with local fallback because the model was unavailable.</div>'
                : '';
            return (
                '<article class="assistant-message assistant-message--' + escapeHtml(item.role) + '">' +
                    '<div class="assistant-message-bubble">' +
                        '<div class="assistant-message-text">' + formatMessageContent(item.content || "") + '</div>' +
                        citations +
                        footer +
                    '</div>' +
                '</article>'
            );
        }).join("");
        if (emptyState) {
            emptyState.hidden = assistantState.history.length > 0 || assistantState.isLoading;
        }

        if (assistantState.isLoading) {
            messages.insertAdjacentHTML("beforeend",
                '<article class="assistant-message assistant-message--assistant">' +
                    '<div class="assistant-message-bubble assistant-message-bubble--loading">' +
                        '<span class="assistant-loading-dot"></span>' +
                        '<span class="assistant-loading-dot"></span>' +
                        '<span class="assistant-loading-dot"></span>' +
                    '</div>' +
                '</article>'
            );
        }

        messages.scrollTop = messages.scrollHeight;
    }

    function openAssistant() {
        assistantState.isOpen = true;
        var panel = document.getElementById("assistant-panel");
        if (panel) {
            panel.hidden = false;
            panel.style.display = "flex";
            panel.setAttribute("aria-hidden", "false");
        }
        saveAssistantOpenState();
        renderAssistant();
        var input = document.getElementById("assistant-input");
        if (input) window.setTimeout(function () { input.focus(); }, 40);
    }

    function closeAssistant() {
        assistantState.isOpen = false;
        var panel = document.getElementById("assistant-panel");
        if (panel) {
            panel.hidden = true;
            panel.style.display = "none";
            panel.setAttribute("aria-hidden", "true");
        }
        if (shell) shell.classList.remove("is-open");
        saveAssistantOpenState();
        renderAssistant();
    }

    function minimizeAssistant(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        assistantState.suppressLauncherClickUntil = Date.now() + 400;
        closeAssistant();
        return false;
    }

    function appendMessage(role, content, extra) {
        var nextMessage = {
            role: role,
            content: content
        };
        if (extra) {
            Object.keys(extra).forEach(function (key) {
                nextMessage[key] = extra[key];
            });
        }
        assistantState.history.push(nextMessage);
        assistantState.history = assistantState.history.slice(-14);
        saveAssistantHistory();
    }

    function collectHistoryForRequest() {
        return assistantState.history
            .filter(function (item) { return item && (item.role === "user" || item.role === "assistant"); })
            .slice(-12)
            .map(function (item) {
                return {
                    role: item.role,
                    content: item.content
                };
            });
    }

    function submitAssistantPrompt(promptText) {
        var prompt = String(promptText || "").trim();
        if (!prompt || assistantState.isLoading) return;
        appendMessage("user", prompt);
        assistantState.isLoading = true;
        openAssistant();
        renderAssistant();

        apiRequest("/assistant/chat", "POST", {
            message: prompt,
            history: collectHistoryForRequest()
        }).then(function (result) {
            appendMessage("assistant", result.answer || "I could not generate a response.", {
                citations: result.citations || [],
                usedFallback: !!result.used_fallback
            });
        }).catch(function (error) {
            appendMessage("assistant", error && error.message
                ? error.message
                : "I could not reach the assistant service right now.");
        }).finally(function () {
            assistantState.isLoading = false;
            renderAssistant();
        });
    }

    function bindAssistantEvents() {
        var launcher = document.getElementById("assistant-launcher");
        var collapseBtn = document.getElementById("assistant-collapse-btn");
        var clearBtn = document.getElementById("assistant-clear-btn");
        var composer = document.getElementById("assistant-composer");
        var input = document.getElementById("assistant-input");
        if (launcher && !launcher._assistantBound) {
            launcher._assistantBound = true;
            launcher.addEventListener("click", function (event) {
                if (Date.now() < assistantState.suppressLauncherClickUntil) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                if (assistantState.isOpen) closeAssistant();
                else openAssistant();
            });
        }

        if (collapseBtn && !collapseBtn._assistantBound) {
            collapseBtn._assistantBound = true;
            collapseBtn.onclick = minimizeAssistant;
            collapseBtn.addEventListener("click", minimizeAssistant);
            collapseBtn.addEventListener("mousedown", minimizeAssistant);
        }

        if (clearBtn && !clearBtn._assistantBound) {
            clearBtn._assistantBound = true;
            clearBtn.addEventListener("click", function (event) {
                event.preventDefault();
                event.stopPropagation();
                assistantState.history = [];
                saveAssistantHistory();
                renderAssistant();
            });
        }

        if (composer && !composer._assistantBound) {
            composer._assistantBound = true;
            composer.addEventListener("submit", function (event) {
                event.preventDefault();
                submitAssistantPrompt(input ? input.value : "");
                if (input) {
                    input.value = "";
                    autoResizeComposer(input);
                }
            });
        }

        if (input && !input._assistantBound) {
            input._assistantBound = true;
            input.addEventListener("input", function () {
                autoResizeComposer(input);
            });
            input.addEventListener("keydown", function (event) {
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitAssistantPrompt(input.value);
                    input.value = "";
                    autoResizeComposer(input);
                }
            });
        }

        if (!document._assistantProfileRefreshBound) {
            document._assistantProfileRefreshBound = true;
            document.addEventListener("user-profile-updated", function () {
                renderAssistant();
            });
        }

        if (!document._assistantCollapseDelegateBound) {
            document._assistantCollapseDelegateBound = true;
            document.addEventListener("click", function (event) {
                var target = event.target && event.target.closest ? event.target.closest("#assistant-collapse-btn") : null;
                if (!target) return;
                minimizeAssistant(event);
            }, true);
        }
    }

    function autoResizeComposer(input) {
        if (!input) return;
        input.style.height = "auto";
        input.style.height = Math.min(120, input.scrollHeight) + "px";
    }

    function initializeAssistant() {
        shell = buildAssistantShell();
        bindAssistantEvents();
        renderAssistant();
        if (assistantState.isOpen) openAssistant();
    }

    initializeAssistant();
})();
