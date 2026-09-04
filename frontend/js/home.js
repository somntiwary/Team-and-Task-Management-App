var isSidebarCollapsed = loadSidebarCollapsed();
var isSidebarInfoCollapsed = loadSidebarInfoCollapsed();
var currentInfoScope = "divisions";
var currentUserInfoMemberships = {
    divisions: [],
    groups: [],
    activities: [],
    teams: []
};
var selectedInfoTeamIds = [];
var infoTeamMembersCache = {};
var infoTeamMembersLoading = {};
var homeEffectiveRole = null;

(function () {
    if (!isLoggedIn()) {
        window.location.href = "index.html";
        return;
    }

    hydrateUserShell();
    initializeTopbarControls();
    applySidebarCollapsedState();
    bindSidebarInfoControls();
    applySidebarInfoCollapsedState();
    syncUserProfile();
    loadSidebarInfo();
    applyHomeRoleVisibility();
    loadHomeData();
})();

function canAccessWorkspacePage() {
    var role = getHomeEffectiveRole();
    return role !== "member";
}

function canAccessAnalyticsPages() {
    var role = getHomeEffectiveRole();
    return role === "admin" || role === "division head" || role === "group head" || role === "project director" || role === "team lead";
}

function getHomeEffectiveRole() {
    return String(homeEffectiveRole || localStorage.getItem("role") || "member").toLowerCase();
}

function deriveEffectiveRoleFromTeams(teams) {
    var globalRole = (localStorage.getItem("role") || "member").toLowerCase();
    if (globalRole === "admin" || globalRole === "division head") return globalRole;
    var privilegedRoles = ["project director", "group head", "team lead"];
    var nextRole = globalRole;
    (Array.isArray(teams) ? teams : []).some(function (team) {
        var role = String(team && team.user_role || "").toLowerCase().trim();
        if (privilegedRoles.indexOf(role) === -1) return false;
        nextRole = role;
        return true;
    });
    return nextRole;
}

function updateHomeWorkspaceLabel() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    var label = role === "admin" ? "Admin Panel" : "Workspace";
    var labels = document.querySelectorAll(".sidebar-item--workspace .sidebar-label");
    for (var i = 0; i < labels.length; i++) {
        labels[i].textContent = label;
    }
}

function applyHomeRoleVisibility() {
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
    updateHomeWorkspaceLabel();
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

function formatDesignation(designation) {
    var value = String(designation || "").trim();
    var normalized = value.replace(/^\(+|\)+$/g, "").trim().toLowerCase();
    if (!value || normalized === "designation not set") return "";
    return "(" + value + ")";
}

function setUserNameBlock(element, username, designation) {
    if (!element) return;
    var safeName = escapeHtml(username || "User");
    var safeDesignation = formatDesignation(designation);
    element.innerHTML = "<span class=\"person-name-block\"><span class=\"person-name-primary\">" + safeName + "</span>" +
        (safeDesignation ? "<span class=\"person-name-secondary\">" + escapeHtml(safeDesignation) + "</span>" : "") +
        "</span>";
}

function hydrateUserShell() {
    var username = localStorage.getItem("username") || "User";
    var role = getHomeEffectiveRole();
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
}

function syncUserProfile() {
    apiRequest("/users/me", "GET").then(function (me) {
        if (!me) return;
        if (me.username) localStorage.setItem("username", me.username);
        if (me.role) localStorage.setItem("role", me.role);
        localStorage.setItem("designation", getDisplayDesignation(me.role, me.designation || ""));
        hydrateUserShell();
        applyHomeRoleVisibility();
        loadSidebarInfo();
    }).catch(function () {
        // Keep cached profile when sync fails.
    });
}

function loadSidebarCollapsed() {
    try {
        return localStorage.getItem("sidebar_collapsed") === "1";
    } catch (_err) {
        return false;
    }
}

function loadSidebarInfoCollapsed() {
    try {
        var value = localStorage.getItem("sidebar_info_collapsed");
        return value === null ? true : value === "1";
    } catch (_err) {
        return true;
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

function applySidebarInfoCollapsedState() {
    var content = document.getElementById("sidebar-info-content");
    var toggle = document.getElementById("sidebar-info-toggle");
    if (content) content.hidden = !!isSidebarInfoCollapsed;
    if (toggle) {
        toggle.setAttribute("aria-expanded", isSidebarInfoCollapsed ? "false" : "true");
        toggle.title = isSidebarInfoCollapsed ? "Expand My Info" : "Collapse My Info";
    }
}

function toggleSidebarInfoCollapse() {
    isSidebarInfoCollapsed = !isSidebarInfoCollapsed;
    try {
        localStorage.setItem("sidebar_info_collapsed", isSidebarInfoCollapsed ? "1" : "0");
    } catch (_err) {
        // Ignore storage failures.
    }
    applySidebarInfoCollapsedState();
}

function bindSidebarInfoControls() {
    var buttons = document.querySelectorAll("[data-info-scope]");
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i]._infoBound) continue;
        buttons[i]._infoBound = true;
        buttons[i].addEventListener("click", function () {
            setInfoScope(this.getAttribute("data-info-scope"));
        });
    }
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

document.addEventListener("user-profile-updated", function () {
    hydrateUserShell();
    loadSidebarInfo();
});

function setInfoScope(scope) {
    currentInfoScope = scope || "divisions";
    var buttons = document.querySelectorAll("[data-info-scope]");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle("is-active", buttons[i].getAttribute("data-info-scope") === currentInfoScope);
    }
    renderInfoMembershipList();
}

function getInfoScopeTitle(scope) {
    if (scope === "groups") return "My Groups";
    if (scope === "activities") return "My Activities";
    if (scope === "teams") return "My Teams";
    return "My Divisions";
}

function getInfoScopeEmptyLabel(scope) {
    if (scope === "groups") return "groups";
    if (scope === "activities") return "activities";
    if (scope === "teams") return "teams";
    return "divisions";
}

function updateInfoCounts(memberships) {
    setText("info-count-divisions", (memberships.divisions || []).length);
    setText("info-count-groups", (memberships.groups || []).length);
    setText("info-count-activities", (memberships.activities || []).length);
    setText("info-count-teams", (memberships.teams || []).length);
}

function renderInfoMembershipList() {
    var titleEl = document.getElementById("info-membership-title");
    var listEl = document.getElementById("info-membership-list");
    if (titleEl) titleEl.textContent = getInfoScopeTitle(currentInfoScope);
    if (!listEl) return;
    var items = currentUserInfoMemberships[currentInfoScope] || [];
    if (!items.length) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">No " + escapeHtml(getInfoScopeEmptyLabel(currentInfoScope)) + " found.</p>";
        return;
    }
    if (currentInfoScope === "teams") {
        var availableTeamIds = items.map(function (team) { return parseInt(team.id, 10); });
        selectedInfoTeamIds = selectedInfoTeamIds.filter(function (teamId) {
            return availableTeamIds.indexOf(teamId) !== -1;
        });
        listEl.innerHTML = items.map(function (team) {
            var teamId = parseInt(team.id, 10);
            var isExpanded = selectedInfoTeamIds.indexOf(teamId) !== -1;
            var members = Array.isArray(infoTeamMembersCache[teamId]) ? infoTeamMembersCache[teamId] : null;
            var membersHtml = "";
            if (isExpanded) {
                if (infoTeamMembersLoading[teamId]) {
                    membersHtml = "<div class=\"info-team-members\"><p class=\"empty-state empty-state--inline\">Loading members...</p></div>";
                } else if (members && members.length) {
                    membersHtml = "<div class=\"info-team-members\">" + members.map(function (member) {
                        return "<div class=\"info-team-member-row\">" + renderInfoMemberLabel(member) + "</div>";
                    }).join("") + "</div>";
                } else {
                    membersHtml = "<div class=\"info-team-members\"><p class=\"empty-state empty-state--inline\">No team members found.</p></div>";
                }
            }
            return "<div class=\"info-team-box" + (isExpanded ? " info-team-box--expanded" : "") + "\">" +
                "<button type=\"button\" class=\"info-team-box-toggle\" aria-expanded=\"" + (isExpanded ? "true" : "false") + "\" onclick=\"toggleInfoTeamSelection(" + teamId + ")\">" +
                "<span class=\"info-team-box-title-wrap\"><span class=\"info-team-box-title\">" + escapeHtml(team.name || "Unnamed team") + "</span>" +
                (team.meta ? "<span class=\"info-team-box-meta\">" + escapeHtml(team.meta) + "</span>" : "") + "</span>" +
                "<span class=\"info-team-box-arrow\" aria-hidden=\"true\"></span>" +
                "</button>" +
                membersHtml +
                "</div>";
        }).join("");
        return;
    }
    listEl.innerHTML = items.map(function (item) {
        var subtitle = item.meta ? " <small class=\"team-tag-role\">(" + escapeHtml(item.meta) + ")</small>" : "";
        return "<span class=\"team-tag\">" + escapeHtml(item.name || "Unnamed item") + subtitle + "</span>";
    }).join("");
}

function toggleInfoTeamSelection(teamId) {
    var numericId = parseInt(teamId, 10);
    if (!numericId) return;
    var existingIndex = selectedInfoTeamIds.indexOf(numericId);
    if (existingIndex === -1) {
        selectedInfoTeamIds.push(numericId);
        loadInfoTeamMembers(numericId);
    } else {
        selectedInfoTeamIds.splice(existingIndex, 1);
    }
    renderInfoMembershipList();
}

function formatActivityProjectName(name, activityType) {
    return (String(activityType || "").trim().toLowerCase() === "project" ? "Project: " : "Activity: ") + (name || "Untitled");
}

function deriveInfoMemberships(navTree, teams) {
    var memberships = { divisions: [], groups: [], activities: [], teams: [] };
    var currentUserId = parseInt(getUserId(), 10);
    var isGlobalAdmin = ["admin", "division head"].indexOf((localStorage.getItem("role") || "").toLowerCase()) !== -1;
    var teamMap = {};
    var divisionSeen = {};
    var groupSeen = {};
    var activitySeen = {};

    (Array.isArray(teams) ? teams : []).forEach(function (team) {
        if (!team || typeof team.id === "undefined") return;
        teamMap[String(team.id)] = team;
        memberships.teams.push({ id: team.id, name: team.name || "Unnamed team", meta: team.user_role || "Member" });
    });

    (Array.isArray(navTree) ? navTree : []).forEach(function (division) {
        var includeDivision = isGlobalAdmin || division.head_user_id === currentUserId;
        (division.groups || []).forEach(function (group) {
            var includeGroup = isGlobalAdmin || group.head_user_id === currentUserId;
            (group.activities || []).forEach(function (activity) {
                var includeActivity = isGlobalAdmin;
                (activity.teams || []).forEach(function (teamNode) {
                    if (teamMap[String(teamNode.id)]) {
                        includeActivity = true;
                        includeGroup = true;
                        includeDivision = true;
                    }
                });
                if (includeActivity && !activitySeen[String(activity.id)]) {
                    activitySeen[String(activity.id)] = true;
                    memberships.activities.push({ id: activity.id, name: formatActivityProjectName(activity.name, activity.type), meta: group.name || "" });
                }
            });
            if (includeGroup && !groupSeen[String(group.id)]) {
                groupSeen[String(group.id)] = true;
                memberships.groups.push({ id: group.id, name: group.name || "Unnamed group", meta: division.name || "" });
            }
        });
        if (includeDivision && !divisionSeen[String(division.id)]) {
            divisionSeen[String(division.id)] = true;
            memberships.divisions.push({ id: division.id, name: division.name || "Unnamed division" });
        }
    });

    return memberships;
}

function loadSidebarInfo() {
    Promise.all([
        apiRequest("/users/" + getUserId() + "/teams", "GET").catch(function () { return []; }),
        apiRequest("/nav/tree", "GET").catch(function () { return []; })
    ]).then(function (results) {
        homeEffectiveRole = deriveEffectiveRoleFromTeams(results[0]);
        hydrateUserShell();
        applyHomeRoleVisibility();
        currentUserInfoMemberships = deriveInfoMemberships(results[1], results[0]);
        updateInfoCounts(currentUserInfoMemberships);
        renderInfoMembershipList();
    });
}

function loadInfoTeamMembers(teamId) {
    var numericId = parseInt(teamId, 10);
    if (!numericId || infoTeamMembersCache[numericId] || infoTeamMembersLoading[numericId]) return;
    infoTeamMembersLoading[numericId] = true;
    apiRequest("/teams/" + numericId + "/members", "GET")
        .then(function (members) {
            infoTeamMembersCache[numericId] = Array.isArray(members) ? members : [];
        })
        .catch(function () {
            infoTeamMembersCache[numericId] = [];
        })
        .finally(function () {
            delete infoTeamMembersLoading[numericId];
            renderInfoMembershipList();
        });
}

function renderInfoMemberLabel(member) {
    var username = member && member.username ? member.username : "User";
    var designation = getDisplayDesignation(member && member.role ? member.role : "", member && member.designation ? member.designation : "");
    var label = designation ? (username + " (" + designation + ")") : username;
    return "<span class=\"team-tag team-tag--member\">" + escapeHtml(label) + "</span>";
}

function loadHomeData() {
    Promise.all([
        apiRequest("/nav/tree", "GET").catch(function () { return []; }),
        getStatisticsData().catch(function () { return {}; }),
        apiRequest("/tasks", "GET").catch(function () { return []; })
    ]).then(function (results) {
        var tree = Array.isArray(results[0]) ? results[0] : [];
        var stats = results[1] || {};
        var tasks = Array.isArray(results[2]) ? results[2] : [];
        var summary = summarizeTree(tree);
        var metrics = buildTaskMetrics(tasks);
        renderSummary(summary, stats, metrics);
        renderInsights(summary, stats, metrics);
        renderUseCase(summary, stats, metrics);
    });
}

function getStatisticsData() {
    var urls = ["/api/dashboard/statistics", "/stats", "/dashboard/stats"];
    function tryNext(index) {
        if (index >= urls.length) return Promise.reject(new Error("Statistics endpoint not available"));
        return apiRequest(urls[index], "GET").catch(function () {
            return tryNext(index + 1);
        });
    }
    return tryNext(0);
}

function summarizeTree(tree) {
    var summary = {
        divisions: Array.isArray(tree) ? tree.length : 0,
        groups: 0,
        activities: 0,
        teams: 0
    };

    (tree || []).forEach(function (division) {
        var groups = Array.isArray(division.groups) ? division.groups : [];
        summary.groups += groups.length;
        groups.forEach(function (group) {
            var activities = Array.isArray(group.activities) ? group.activities : [];
            summary.activities += activities.length;
            activities.forEach(function (activity) {
                summary.teams += Array.isArray(activity.teams) ? activity.teams.length : 0;
            });
        });
    });

    return summary;
}

function flattenTasks(tasks) {
    var flat = [];
    (tasks || []).forEach(function (task) {
        if (!task) return;
        flat.push(task);
        if (Array.isArray(task.subtasks) && task.subtasks.length) {
            flat = flat.concat(flattenTasks(task.subtasks));
        }
    });
    return flat;
}

function buildTaskMetrics(tasks) {
    var flat = flattenTasks(tasks);
    var completed = 0;
    var pendingCompletion = 0;
    var inProgress = 0;
    var overdue = 0;
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    flat.forEach(function (task) {
        var status = String(task.status || "").toLowerCase();
        var due = parseDateOnly(task.due_date);
        if (status.indexOf("pending") !== -1) pendingCompletion += 1;
        else if (status.indexOf("in progress") !== -1) inProgress += 1;
        else if (status.indexOf("complete") !== -1) completed += 1;
        if (due && due < today && status.indexOf("complete") === -1) overdue += 1;
    });

    return {
        total: flat.length,
        completed: completed,
        pendingCompletion: pendingCompletion,
        inProgress: inProgress,
        overdue: overdue
    };
}

function parseDateOnly(value) {
    if (!value) return null;
    var parts = String(value).slice(0, 10).split("-");
    if (parts.length !== 3) return null;
    var date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    date.setHours(0, 0, 0, 0);
    return isNaN(date.getTime()) ? null : date;
}

function renderSummary(summary, stats, metrics) {
    setText("home-stat-divisions", summary.divisions);
    setText("home-stat-groups", summary.groups);
    setText("home-stat-activities", summary.activities);
    setText("home-stat-teams", summary.teams || stats.total_teams || 0);

    var foot = document.getElementById("home-hero-foot");
    if (foot) {
        foot.textContent = metrics.total + " work items tracked, " + metrics.completed + " completed, and " + (stats.total_members || 0) + " members participating across the visible workspace.";
    }
}

function renderInsights(summary, stats, metrics) {
    var container = document.getElementById("home-insights");
    if (!container) return;

    var items = [
        "The current structure covers " + summary.divisions + " divisions, " + summary.groups + " groups, and " + summary.activities + " activities, giving leadership a clear execution chain.",
        metrics.overdue > 0
            ? metrics.overdue + " open work items are overdue and should be reviewed first in the workspace."
            : "There are no overdue open work items in the current dataset, which indicates healthy schedule discipline.",
        metrics.pendingCompletion > 0
            ? metrics.pendingCompletion + " work items are awaiting completion review with supporting proof."
            : "No work items are currently waiting for proof-based completion approval.",
        (stats.tasks_extension_request || 0) > 0
            ? (stats.tasks_extension_request || 0) + " extension requests are active and may need timeline decisions."
            : "There are no active extension requests right now."
    ];

    container.innerHTML = items.map(function (item) {
        return "<div class=\"home-insight-item\">" + escapeHtml(item) + "</div>";
    }).join("");
}

function renderUseCase(summary, stats, metrics) {
    var el = document.getElementById("home-use-case-text");
    if (!el) return;

    el.textContent = "Based on the current implementation, this platform is best used for structured internal program oversight, hierarchy-based task allocation, monitored execution across " +
        summary.teams + " teams, and decision-supported closure using activity records, approvals, and operational statistics.";
}

function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(value);
}

function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
