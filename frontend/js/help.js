var isSidebarCollapsed = loadSidebarCollapsed();
var activeHelpTourStep = 1;
var helpTourTimer = null;
var helpEffectiveRole = null;

(function () {
    if (!isLoggedIn()) {
        window.location.href = "index.html";
        return;
    }

    hydrateUserShell();
    initializeTopbarControls();
    applySidebarCollapsedState();
    syncUserProfile();
    applyHelpRoleVisibility();
    bindHelpRevealAnimations();
    bindHelpTour();
    bindHelpFaq();
})();

function canAccessWorkspacePage() {
    var role = getHelpEffectiveRole();
    return role !== "member";
}

function canAccessAnalyticsPages() {
    var role = getHelpEffectiveRole();
    return role === "admin" || role === "division head" || role === "group head" || role === "project director" || role === "team lead";
}

function getHelpEffectiveRole() {
    return String(helpEffectiveRole || localStorage.getItem("role") || "member").toLowerCase();
}

function deriveEffectiveRoleFromTeams(teams) {
    var globalRole = (localStorage.getItem("role") || "member").toLowerCase();
    if (globalRole === "admin" || globalRole === "division head") return globalRole;
    var nextRole = globalRole;
    var privilegedRoles = ["project director", "group head", "team lead"];
    (Array.isArray(teams) ? teams : []).some(function (team) {
        var role = String(team && team.user_role || "").toLowerCase().trim();
        if (privilegedRoles.indexOf(role) === -1) return false;
        nextRole = role;
        return true;
    });
    return nextRole;
}

function formatUserIdDisplay(value) {
    var n = parseInt(value, 10);
    if (!n || n < 0) return String(value || "");
    if (n <= 999) return String(n).padStart(3, "0");
    return String(n);
}

function formatRole(role) {
    var value = String(role || "member").toLowerCase();
    if (value === "admin") return "Admin";
    if (value === "division head") return "Division Head";
    if (value === "group head") return "Group Head";
    if (value === "project director") return "Project Director";
    if (value === "team lead") return "Team Lead";
    return "Member";
}

function roleHasNoDesignation(role) {
    return String(role || "").trim().toLowerCase() === "admin";
}

function getDisplayDesignation(role, designation) {
    var value = String(designation || "").trim();
    var normalized = value.replace(/^\(+|\)+$/g, "").trim().toLowerCase();
    if (normalized === "designation not set") value = "";
    return roleHasNoDesignation(role) ? "" : value;
}

function setUserNameBlock(element, username, designation) {
    if (!element) return;
    var safeName = escapeHtml(username || "User");
    var safeDesignation = formatDesignation(designation);
    element.innerHTML = "<span class=\"person-name-block\"><span class=\"person-name-primary\">" + safeName + "</span>" +
        (safeDesignation ? "<span class=\"person-name-secondary\">" + escapeHtml(safeDesignation) + "</span>" : "") +
        "</span>";
}

function formatDesignation(designation) {
    var value = String(designation || "").trim();
    var normalized = value.replace(/^\(+|\)+$/g, "").trim().toLowerCase();
    if (!value || normalized === "designation not set") return "";
    return "(" + value + ")";
}

function hydrateUserShell() {
    var username = localStorage.getItem("username") || "User";
    var role = getHelpEffectiveRole();
    var designation = getDisplayDesignation(role, localStorage.getItem("designation") || "");
    var userId = getUserId() || "-";
    var badge = document.getElementById("user-badge");
    var avatar = document.getElementById("user-avatar");
    var topbarUserId = document.getElementById("topbar-user-id");
    var roleEl = document.getElementById("user-role");

    setUserNameBlock(badge, username, designation);
    if (avatar) avatar.textContent = (username.charAt(0) || "U").toUpperCase();
    if (topbarUserId) topbarUserId.textContent = formatUserIdDisplay(userId);
    if (roleEl) roleEl.textContent = formatRole(role);
    updateHelpWorkspaceLabel();
}

function syncUserProfile() {
    apiRequest("/users/me", "GET").then(function (me) {
        if (!me) return;
        if (me.username) localStorage.setItem("username", me.username);
        if (me.role) localStorage.setItem("role", me.role);
        localStorage.setItem("designation", getDisplayDesignation(me.role, me.designation || ""));
        refreshHelpAccessContext();
    }).catch(function () {
        // Keep cached values when sync fails.
        refreshHelpAccessContext();
    });
}

function updateHelpWorkspaceLabel() {
    var role = getHelpEffectiveRole();
    var label = role === "admin" ? "Admin Panel" : "Workspace";
    var labels = document.querySelectorAll(".sidebar-item--workspace .sidebar-label");
    for (var i = 0; i < labels.length; i++) {
        labels[i].textContent = label;
    }
}

function refreshHelpAccessContext() {
    apiRequest("/users/" + getUserId() + "/teams", "GET")
        .then(function (teams) {
            helpEffectiveRole = deriveEffectiveRoleFromTeams(teams);
        })
        .catch(function () {
            helpEffectiveRole = (localStorage.getItem("role") || "member").toLowerCase();
        })
        .finally(function () {
            hydrateUserShell();
            applyHelpRoleVisibility();
        });
}

function applyHelpRoleVisibility() {
    var showWorkspace = canAccessWorkspacePage();
    var showAnalytics = canAccessAnalyticsPages();
    var workspaceSelectors = [
        "[onclick='goToDashboard()']",
        ".sidebar-item--workspace"
    ];
    var analyticsSelectors = [
        "[onclick='goToStatisticsPage()']",
        "[onclick='goToGanttViewPage()']",
        ".sidebar-item--stats",
        ".sidebar-item--gantt"
    ];
    workspaceSelectors.forEach(function (selector) {
        var elements = document.querySelectorAll(selector);
        for (var i = 0; i < elements.length; i++) {
            elements[i].style.display = showWorkspace ? "" : "none";
        }
    });
    analyticsSelectors.forEach(function (selector) {
        var elements = document.querySelectorAll(selector);
        for (var i = 0; i < elements.length; i++) {
            elements[i].style.display = showAnalytics ? "" : "none";
        }
    });
    updateHelpWorkspaceLabel();
}

function loadSidebarCollapsed() {
    try {
        return localStorage.getItem("sidebar_collapsed") === "1";
    } catch (_err) {
        return false;
    }
}

function applySidebarCollapsedState() {
    var layout = document.querySelector(".dashboard-layout");
    var btn = document.getElementById("sidebar-collapse-btn");
    if (layout) {
        layout.classList.toggle("dashboard-layout--sidebar-collapsed", !!isSidebarCollapsed);
    }
    if (btn) {
        btn.setAttribute("aria-expanded", isSidebarCollapsed ? "false" : "true");
        btn.setAttribute("aria-label", isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar");
        btn.title = isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
    }
}

function toggleSidebarCollapse() {
    isSidebarCollapsed = !isSidebarCollapsed;
    try {
        localStorage.setItem("sidebar_collapsed", isSidebarCollapsed ? "1" : "0");
    } catch (_err) {
        // Ignore storage failures.
    }
    applySidebarCollapsedState();
}

function bindHelpRevealAnimations() {
    var items = document.querySelectorAll(".reveal-on-scroll");
    if (!items.length) return;
    if (typeof IntersectionObserver !== "function") {
        for (var i = 0; i < items.length; i++) items[i].classList.add("is-visible");
        return;
    }
    var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.18, rootMargin: "0px 0px -40px 0px" });

    for (var i = 0; i < items.length; i++) {
        observer.observe(items[i]);
    }
}

function bindHelpTour() {
    var steps = document.querySelectorAll("[data-tour-step]");
    if (!steps.length) return;
    for (var i = 0; i < steps.length; i++) {
        if (steps[i]._tourBound) continue;
        steps[i]._tourBound = true;
        steps[i].addEventListener("click", function () {
            var step = parseInt(this.getAttribute("data-tour-step"), 10) || 1;
            setHelpTourStep(step, true);
        });
    }
    setHelpTourStep(activeHelpTourStep, false);
    startHelpTourAutoPlay();
}

function setHelpTourStep(step, stopAutoPlay) {
    var steps = document.querySelectorAll("[data-tour-step]");
    var panels = document.querySelectorAll("[data-tour-panel]");
    activeHelpTourStep = step;
    for (var i = 0; i < steps.length; i++) {
        var isActive = parseInt(steps[i].getAttribute("data-tour-step"), 10) === step;
        steps[i].classList.toggle("is-active", isActive);
        steps[i].setAttribute("aria-selected", isActive ? "true" : "false");
    }
    for (var j = 0; j < panels.length; j++) {
        var panelActive = parseInt(panels[j].getAttribute("data-tour-panel"), 10) === step;
        panels[j].classList.toggle("is-active", panelActive);
        panels[j].hidden = !panelActive;
    }
    if (stopAutoPlay) stopHelpTourAutoPlay();
}

function startHelpTourAutoPlay() {
    stopHelpTourAutoPlay();
    helpTourTimer = window.setInterval(function () {
        var steps = document.querySelectorAll("[data-tour-step]");
        if (!steps.length) return;
        var nextStep = activeHelpTourStep + 1;
        if (nextStep > steps.length) nextStep = 1;
        setHelpTourStep(nextStep, false);
    }, 4800);
}

function stopHelpTourAutoPlay() {
    if (helpTourTimer) {
        window.clearInterval(helpTourTimer);
        helpTourTimer = null;
    }
}

function bindHelpFaq() {
    var triggers = document.querySelectorAll(".help-faq-trigger");
    for (var i = 0; i < triggers.length; i++) {
        if (triggers[i]._faqBound) continue;
        triggers[i]._faqBound = true;
        triggers[i].addEventListener("click", function () {
            var expanded = this.getAttribute("aria-expanded") === "true";
            var body = this.nextElementSibling;
            this.setAttribute("aria-expanded", expanded ? "false" : "true");
            if (body) body.hidden = expanded;
            var item = this.closest(".help-faq-item");
            if (item) item.classList.toggle("is-open", !expanded);
        });
        var item = triggers[i].closest(".help-faq-item");
        if (item) item.classList.toggle("is-open", triggers[i].getAttribute("aria-expanded") === "true");
    }
}

function goToHomePage() {
    window.location.href = "home.html";
}

function goToDashboard() {
    window.location.href = "dashboard.html";
}

function goToBoardPage() {
    window.location.href = "workspace-views.html";
}

function goToStatisticsPage() {
    window.location.href = "statistics.html";
}

function goToGanttViewPage() {
    window.location.href = "gantt-view.html";
}

function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
