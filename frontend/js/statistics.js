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
var statsStatusChart = null;
var statsTimelineChart = null;
var statsBreakdownChart = null;
var statsPriorityChart = null;
var statsGanttState = {
    rawTasks: [],
    milestones: [],
    navTree: [],
    accessibleTeams: [],
    visibleTeamIds: [],
    effectiveRole: null,
    hierarchy: null,
    levelFilter: "all",
    categoryFilter: "",
    scaleMode: "custom",
    scaleValue: 1,
    scaleUnit: "months",
    viewMode: "simple",
    filtersCollapsed: false,
    resizeBound: false,
    resizeFrame: null
};

function getStatisticsEffectiveRole() {
    return String(statsGanttState.effectiveRole || localStorage.getItem("role") || "member").toLowerCase();
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

function getScopedAnalyticsTeamIds(roleValue, teams) {
    var role = String(roleValue || getStatisticsEffectiveRole()).toLowerCase();
    if (role !== "project director" && role !== "team lead") return [];
    return (Array.isArray(teams) ? teams : []).filter(function (team) {
        var teamRole = String(team && team.user_role || "").toLowerCase().trim();
        return teamRole === "project director" || teamRole === "team lead";
    }).map(function (team) {
        return parseInt(team.id, 10);
    }).filter(function (teamId) {
        return !!teamId;
    });
}

function isTeamScopedAnalyticsRole(roleValue) {
    var role = String(roleValue || getStatisticsEffectiveRole()).toLowerCase();
    return role === "project director" || role === "team lead";
}

function canAccessAnalyticsPages(roleValue) {
    var role = String(roleValue || getStatisticsEffectiveRole()).toLowerCase();
    return role === "admin" || role === "division head" || role === "group head" || role === "project director" || role === "team lead";
}

function updateWorkspaceSidebarLabel() {
    var role = getStatisticsEffectiveRole();
    var label = role === "admin" ? "Admin Panel" : "Workspace";
    var labels = document.querySelectorAll(".sidebar-item--workspace .sidebar-label");
    for (var i = 0; i < labels.length; i++) {
        labels[i].textContent = label;
    }
}

function formatUserIdDisplay(value) {
    var n = parseInt(value, 10);
    if (!n || n < 0) return String(value || "");
    if (n <= 999) return String(n).padStart(3, "0");
    return String(n);
}

(function () {
    if (!isLoggedIn()) {
        window.location.href = "index.html";
        return;
    }

    initializeTopbarControls();
    applySidebarCollapsedState();
    bindSidebarInfoControls();
    applySidebarInfoCollapsedState();
    bindGanttControls();
    syncUserProfile()
        .finally(resolveStatisticsAccessContext)
        .then(function () {
            if (!canAccessAnalyticsPages()) {
                window.location.href = "workspace-views.html";
                return;
            }
            hydrateUserShell();
            loadSidebarInfo();
            loadStatisticsPage();
        });
})();

function hydrateUserShell() {
    var username = localStorage.getItem("username") || "User";
    var role = getStatisticsEffectiveRole();
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
    updateWorkspaceSidebarLabel();
}

function syncUserProfile() {
    return apiRequest("/users/me", "GET").then(function (me) {
        if (!me) return;
        if (me.username) localStorage.setItem("username", me.username);
        if (me.role) localStorage.setItem("role", me.role);
        localStorage.setItem("designation", getDisplayDesignation(me.role, me.designation || ""));
    }).catch(function () {
        // Keep local profile values when sync fails.
    });
}

function resolveStatisticsAccessContext() {
    return apiRequest("/users/" + getUserId() + "/teams", "GET").then(function (teams) {
        var list = Array.isArray(teams) ? teams : [];
        statsGanttState.accessibleTeams = list;
        statsGanttState.effectiveRole = deriveEffectiveRoleFromTeams(list);
        statsGanttState.visibleTeamIds = getScopedAnalyticsTeamIds(statsGanttState.effectiveRole, list);
    }).catch(function () {
        statsGanttState.accessibleTeams = [];
        statsGanttState.effectiveRole = (localStorage.getItem("role") || "member").toLowerCase();
        statsGanttState.visibleTeamIds = [];
    });
}

function formatRole(role) {
    var value = String(role || "member").toLowerCase();
    if (value === "admin") return "Admin";
    if (value === "division head") return "Division Head";
    if (value === "group head") return "Group Head";
    if (value === "project director") return "Project Director";
    if (value === "team lead") return "Team Lead";
    return value.charAt(0).toUpperCase() + value.slice(1);
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

function renderUserLabelHtml(username, designation) {
    var safeName = escapeHtml(username || "User");
    var safeDesignation = formatDesignation(designation);
    return "<span class=\"person-name-block\"><span class=\"person-name-primary\">" + safeName + "</span>" +
        (safeDesignation ? "<span class=\"person-name-secondary\">" + escapeHtml(safeDesignation) + "</span>" : "") +
        "</span>";
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

function goToHomePage() {
    window.location.href = "home.html";
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
    var division = document.getElementById("info-count-divisions");
    var group = document.getElementById("info-count-groups");
    var activity = document.getElementById("info-count-activities");
    var team = document.getElementById("info-count-teams");
    if (division) division.textContent = String((memberships.divisions || []).length);
    if (group) group.textContent = String((memberships.groups || []).length);
    if (activity) activity.textContent = String((memberships.activities || []).length);
    if (team) team.textContent = String((memberships.teams || []).length);
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

function isVisibleAnalyticsTeamId(teamId) {
    if (!isTeamScopedAnalyticsRole()) return true;
    var numericId = parseInt(teamId, 10);
    if (!numericId) return false;
    return statsGanttState.visibleTeamIds.indexOf(numericId) !== -1;
}

function filterNavTreeToVisibleTeams(tree) {
    if (!isTeamScopedAnalyticsRole()) return Array.isArray(tree) ? tree : [];
    return (Array.isArray(tree) ? tree : []).map(function (division) {
        var groups = (division.groups || []).map(function (group) {
            var activities = (group.activities || []).map(function (activity) {
                var teams = (activity.teams || []).filter(function (team) {
                    return isVisibleAnalyticsTeamId(team && team.id);
                });
                if (!teams.length) return null;
                return Object.assign({}, activity, { teams: teams });
            }).filter(Boolean);
            if (!activities.length) return null;
            return Object.assign({}, group, { activities: activities });
        }).filter(Boolean);
        if (!groups.length) return null;
        return Object.assign({}, division, { groups: groups });
    }).filter(Boolean);
}

function buildVisibleScopeLookup(tree) {
    var lookup = {
        divisions: {},
        groups: {},
        activities: {},
        teams: {}
    };
    (Array.isArray(tree) ? tree : []).forEach(function (division) {
        if (!division) return;
        lookup.divisions[String(division.id)] = true;
        (division.groups || []).forEach(function (group) {
            if (!group) return;
            lookup.groups[String(group.id)] = true;
            (group.activities || []).forEach(function (activity) {
                if (!activity) return;
                lookup.activities[String(activity.id)] = true;
                (activity.teams || []).forEach(function (team) {
                    if (!team) return;
                    lookup.teams[String(team.id)] = true;
                });
            });
        });
    });
    return lookup;
}

function isTaskVisibleInScopedAnalytics(task, visibleScope) {
    if (!task) return false;
    if (task.team_id != null && task.team_id !== "") {
        return !!visibleScope.teams[String(task.team_id)];
    }
    if (task.activity_id != null && task.activity_id !== "") {
        return !!visibleScope.activities[String(task.activity_id)];
    }
    if (task.group_id != null && task.group_id !== "") {
        return !!visibleScope.groups[String(task.group_id)];
    }
    if (task.division_id != null && task.division_id !== "") {
        return !!visibleScope.divisions[String(task.division_id)];
    }
    return false;
}

function filterTaskTreeToVisibleTeams(tasks, treeOrScope) {
    if (!isTeamScopedAnalyticsRole()) return Array.isArray(tasks) ? tasks : [];
    var visibleScope = treeOrScope && treeOrScope.teams && treeOrScope.activities
        ? treeOrScope
        : buildVisibleScopeLookup(treeOrScope);
    return (Array.isArray(tasks) ? tasks : []).map(function (task) {
        if (!task) return null;
        var children = filterTaskTreeToVisibleTeams(task.subtasks || [], visibleScope);
        var visibleSelf = isTaskVisibleInScopedAnalytics(task, visibleScope);
        if (!visibleSelf && !children.length) return null;
        return Object.assign({}, task, { subtasks: children });
    }).filter(Boolean);
}

function filterMilestonesForAnalytics(milestones) {
    if (!isTeamScopedAnalyticsRole()) return Array.isArray(milestones) ? milestones : [];
    return [];
}

function scopeMemberHierarchyMatrix(matrix) {
    var next = matrix || { rows: [], totals: { members: 0, teams: 0, activities: 0, groups: 0, divisions: 0 } };
    if (!isTeamScopedAnalyticsRole()) return next;
    var rows = (next.rows || []).filter(function (row) {
        return isVisibleAnalyticsTeamId(row && row.team_id);
    });
    var totals = buildScopedOrgStats(statsGanttState.navTree, rows, statsGanttState.rawTasks);
    return {
        rows: rows,
        totals: {
            members: totals.total_members,
            teams: totals.total_teams,
            activities: totals.total_activities,
            groups: totals.total_groups,
            divisions: totals.total_divisions
        }
    };
}

function flattenTasksForScopeCount(tasks, into) {
    (Array.isArray(tasks) ? tasks : []).forEach(function (task) {
        if (!task) return;
        into.push(task);
        flattenTasksForScopeCount(task.subtasks || [], into);
    });
    return into;
}

function buildScopedOrgStats(tree, rows, tasks) {
    var flatTasks = flattenTasksForScopeCount(tasks || [], []);
    return {
        total_divisions: (tree || []).length,
        total_groups: countUniqueFromTree(tree, "groups"),
        total_activities: countUniqueFromTree(tree, "activities"),
        total_teams: countUniqueFromTree(tree, "teams"),
        total_members: Object.keys((rows || []).reduce(function (map, row) {
            if (row && row.member_id != null) map[String(row.member_id)] = true;
            return map;
        }, {})).length,
        tasks_extension_request: flatTasks.filter(function (task) {
            return String(task && task.extension_request_status || "").toLowerCase() === "pending";
        }).length
    };
}

function loadStatisticsPage() {
    var loadingEl = document.getElementById("stats-loading");
    var errorEl = document.getElementById("stats-error");
    if (loadingEl) loadingEl.hidden = false;
    if (errorEl) errorEl.hidden = true;

    Promise.all([
        getStatisticsData(),
        apiRequest("/tasks", "GET"),
        apiRequest("/milestones", "GET").catch(function () { return []; }),
        apiRequest("/nav/tree", "GET").catch(function () { return []; }),
        getMemberHierarchyMatrix().catch(function () {
            return { rows: [], totals: { members: 0, teams: 0, activities: 0, groups: 0, divisions: 0 } };
        })
    ]).then(function (results) {
        var orgStats = results[0] || {};
        var navTree = filterNavTreeToVisibleTeams(Array.isArray(results[3]) ? results[3] : []);
        var nestedTasks = filterTaskTreeToVisibleTeams(Array.isArray(results[1]) ? results[1] : [], navTree);
        var milestoneItems = filterMilestonesForAnalytics(Array.isArray(results[2]) ? results[2] : []);
        var matrix = results[4] || { rows: [], totals: { members: 0, teams: 0, activities: 0, groups: 0, divisions: 0 } };
        statsGanttState.rawTasks = nestedTasks;
        statsGanttState.milestones = milestoneItems;
        statsGanttState.navTree = navTree;
        statsGanttState.hierarchy = buildGanttHierarchy(navTree);
        matrix = scopeMemberHierarchyMatrix(matrix);
        if (isTeamScopedAnalyticsRole()) {
            orgStats = buildScopedOrgStats(navTree, matrix.rows, nestedTasks);
        }
        var metrics = buildTaskMetrics(nestedTasks);
        renderHero(metrics);
        renderMetricSections(orgStats, metrics);
        renderInsights(orgStats, metrics);
        renderCharts(orgStats, metrics);
        initializeGanttScopeControls();
        renderGanttChart();
        renderMemberHierarchyMatrix(matrix.rows, matrix.totals);
        if (loadingEl) loadingEl.hidden = true;
    }).catch(function () {
        if (loadingEl) loadingEl.hidden = true;
        if (errorEl) errorEl.hidden = false;
    });
}

function getMemberHierarchyMatrix() {
    return Promise.all([
        apiRequest("/users", "GET"),
        apiRequest("/nav/tree", "GET")
    ]).then(function (results) {
        var users = Array.isArray(results[0]) ? results[0] : [];
        var tree = Array.isArray(results[1]) ? results[1] : [];

        var teams = [];
        (tree || []).forEach(function (division) {
            (division.groups || []).forEach(function (group) {
                (group.activities || []).forEach(function (activity) {
                    (activity.teams || []).forEach(function (team) {
                        teams.push({
                            id: team.id,
                            team_name: team.name || "-",
                            activity_name: activity.name || "-",
                            group_name: group.name || "-",
                            division_name: division.name || "-"
                        });
                    });
                });
            });
        });

        var teamRequests = teams.map(function (teamMeta) {
            return apiRequest("/teams/" + teamMeta.id + "/members", "GET")
                .then(function (members) {
                    return { meta: teamMeta, members: Array.isArray(members) ? members : [] };
                })
                .catch(function () {
                    return { meta: teamMeta, members: [] };
                });
        });

        return Promise.all(teamRequests).then(function (teamRows) {
            var rows = [];
            var membersWithTeams = {};

            teamRows.forEach(function (teamBlock) {
                var meta = teamBlock.meta;
                (teamBlock.members || []).forEach(function (member) {
                    var memberName = member && member.username ? member.username : ("User " + (member && member.id ? member.id : ""));
                    rows.push({
                        member_id: member.id,
                        member_name: memberName,
                        designation: member && member.designation ? member.designation : "",
                        team_id: meta.id,
                        team_name: meta.team_name,
                        activity_name: meta.activity_name,
                        group_name: meta.group_name,
                        division_name: meta.division_name
                    });
                    if (member && member.id != null) membersWithTeams[String(member.id)] = true;
                });
            });

            (users || []).forEach(function (user) {
                var uid = user && user.id != null ? String(user.id) : null;
                if (!uid || membersWithTeams[uid]) return;
                rows.push({
                    member_id: user.id,
                    member_name: user.username || ("User " + user.id),
                    designation: user.designation || "",
                    team_id: null,
                    team_name: "-",
                    activity_name: "-",
                    group_name: "-",
                    division_name: "-"
                });
            });

            rows.sort(function (a, b) {
                var byMember = String(a.member_name || "").localeCompare(String(b.member_name || ""));
                if (byMember !== 0) return byMember;
                var byDivision = String(a.division_name || "").localeCompare(String(b.division_name || ""));
                if (byDivision !== 0) return byDivision;
                var byGroup = String(a.group_name || "").localeCompare(String(b.group_name || ""));
                if (byGroup !== 0) return byGroup;
                var byActivity = String(a.activity_name || "").localeCompare(String(b.activity_name || ""));
                if (byActivity !== 0) return byActivity;
                return String(a.team_name || "").localeCompare(String(b.team_name || ""));
            });

            var uniqueMemberIds = {};
            rows.forEach(function (r) {
                if (r.member_id != null) uniqueMemberIds[String(r.member_id)] = true;
            });

            var totals = {
                members: Object.keys(uniqueMemberIds).length,
                teams: teams.length,
                activities: countUniqueFromTree(tree, "activities"),
                groups: countUniqueFromTree(tree, "groups"),
                divisions: (tree || []).length
            };

            return { rows: rows, totals: totals };
        });
    });
}

function countUniqueFromTree(tree, type) {
    var ids = {};
    (tree || []).forEach(function (division) {
        if (type === "groups") {
            (division.groups || []).forEach(function (group) {
                ids[String(group.id)] = true;
            });
        }
        (division.groups || []).forEach(function (group) {
            if (type === "activities") {
                (group.activities || []).forEach(function (activity) {
                    ids[String(activity.id)] = true;
                });
            } else if (type === "teams") {
                (group.activities || []).forEach(function (activity) {
                    (activity.teams || []).forEach(function (team) {
                        ids[String(team.id)] = true;
                    });
                });
            }
        });
    });
    return Object.keys(ids).length;
}

function bindGanttControls() {
    bindGanttFilterToggle();
    bindGanttPanControls();
    var ids = [
        "stats-gantt-division",
        "stats-gantt-group",
        "stats-gantt-activity",
        "stats-gantt-team",
        "stats-gantt-category"
    ];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || el._statsBound) return;
        el._statsBound = true;
        el.addEventListener("change", function () {
            if (id !== "stats-gantt-category") syncGanttScopeCascade(id);
            if (id === "stats-gantt-category") statsGanttState.categoryFilter = el.value || "";
            renderGanttChart();
        });
    });
    bindGanttLevelControls();
    bindGanttScaleControls();
    bindGanttResize();
}

function bindGanttFilterToggle() {
    var toggle = document.getElementById("stats-gantt-filter-toggle");
    var controls = document.getElementById("stats-gantt-controls");
    if (!toggle || !controls) return;
    if (!toggle._statsBound) {
        toggle._statsBound = true;
        toggle.addEventListener("click", function () {
            statsGanttState.filtersCollapsed = !statsGanttState.filtersCollapsed;
            applyGanttFilterCollapseState();
        });
    }
    applyGanttFilterCollapseState();
}

function applyGanttFilterCollapseState() {
    var toggle = document.getElementById("stats-gantt-filter-toggle");
    var controls = document.getElementById("stats-gantt-controls");
    var isCollapsed = !!statsGanttState.filtersCollapsed;
    if (controls) controls.classList.toggle("is-collapsed", isCollapsed);
    if (toggle) {
        toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        toggle.setAttribute("aria-label", isCollapsed ? "Expand gantt filters" : "Collapse gantt filters");
        toggle.title = isCollapsed ? "Expand filters" : "Collapse filters";
    }
}

function bindGanttLevelControls() {
    var buttons = document.querySelectorAll("[data-gantt-level]");
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i]._statsBound) continue;
        buttons[i]._statsBound = true;
        buttons[i].addEventListener("click", function () {
            statsGanttState.levelFilter = this.getAttribute("data-gantt-level") || "all";
            syncGanttLevelButtons();
            renderGanttChart();
        });
    }
    syncGanttLevelButtons();
}

function syncGanttLevelButtons() {
    var buttons = document.querySelectorAll("[data-gantt-level]");
    for (var i = 0; i < buttons.length; i++) {
        var isActive = buttons[i].getAttribute("data-gantt-level") === String(statsGanttState.levelFilter || "all");
        buttons[i].classList.toggle("is-active", isActive);
        buttons[i].setAttribute("aria-pressed", isActive ? "true" : "false");
    }
}

function bindGanttResize() {
    if (statsGanttState.resizeBound || typeof window === "undefined") return;
    statsGanttState.resizeBound = true;
    window.addEventListener("resize", function () {
        if (statsGanttState.resizeFrame) window.cancelAnimationFrame(statsGanttState.resizeFrame);
        statsGanttState.resizeFrame = window.requestAnimationFrame(function () {
            statsGanttState.resizeFrame = null;
            renderGanttChart();
        });
    });
}

function bindGanttPanControls() {
    var wrap = document.getElementById("stats-gantt-wrap");
    if (!wrap || wrap._statsPanBound) return;
    wrap._statsPanBound = true;

    var panState = {
        active: false,
        moved: false,
        suppressClick: false,
        inputType: null,
        pointerId: null,
        startX: 0,
        startY: 0,
        scrollLeft: 0,
        scrollTop: 0
    };

    function resolvePanTarget(target) {
        if (!target) return null;
        if (target.nodeType === 1) return target;
        return target.parentElement || null;
    }

    function canStartPan(target) {
        var node = resolvePanTarget(target);
        if (!node || !wrap.contains(node)) return false;
        if (!node.closest(".stats-gantt")) return false;
        if (node.closest("button, input, select, textarea, a, label")) return false;
        return true;
    }

    function startPan(clientX, clientY, inputType, pointerId) {
        panState.active = true;
        panState.moved = false;
        panState.suppressClick = false;
        panState.inputType = inputType || "mouse";
        panState.pointerId = pointerId != null ? pointerId : null;
        panState.startX = clientX;
        panState.startY = clientY;
        panState.scrollLeft = wrap.scrollLeft;
        panState.scrollTop = wrap.scrollTop;
        wrap.classList.add("is-panning");
    }

    function updatePan(clientX, clientY) {
        if (!panState.active) return;
        var deltaX = clientX - panState.startX;
        var deltaY = clientY - panState.startY;
        if (!panState.moved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
            panState.moved = true;
            panState.suppressClick = true;
        }
        wrap.scrollLeft = panState.scrollLeft - deltaX;
        wrap.scrollTop = panState.scrollTop - deltaY;
    }

    function stopPan(event) {
        if (!panState.active) return;
        if (event && event.pointerId != null && event.pointerId !== panState.pointerId) return;
        if (wrap.releasePointerCapture && panState.pointerId != null) {
            try {
                wrap.releasePointerCapture(panState.pointerId);
            } catch (error) {
                // Ignore capture release errors after abrupt pointer cancellation.
            }
        }
        panState.active = false;
        panState.inputType = null;
        panState.pointerId = null;
        wrap.classList.remove("is-panning");
    }

    wrap.addEventListener("pointerdown", function (event) {
        if (event.pointerType === "mouse") return;
        if (event.button !== 0) return;
        if (!canStartPan(event.target)) return;
        startPan(event.clientX, event.clientY, event.pointerType || "touch", event.pointerId);
        if (wrap.setPointerCapture) wrap.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    wrap.addEventListener("pointermove", function (event) {
        if (!panState.active || event.pointerId !== panState.pointerId) return;
        updatePan(event.clientX, event.clientY);
        event.preventDefault();
    });

    wrap.addEventListener("pointerup", stopPan);
    wrap.addEventListener("pointercancel", stopPan);
    wrap.addEventListener("lostpointercapture", stopPan);

    wrap.addEventListener("mousedown", function (event) {
        if (event.button !== 0) return;
        if (!canStartPan(event.target)) return;
        startPan(event.clientX, event.clientY, "mouse", null);
        event.preventDefault();
    });

    window.addEventListener("mousemove", function (event) {
        if (!panState.active || panState.inputType !== "mouse") return;
        updatePan(event.clientX, event.clientY);
        event.preventDefault();
    });

    window.addEventListener("mouseup", function () {
        if (!panState.active || panState.inputType !== "mouse") return;
        stopPan();
    });

    wrap.addEventListener("dragstart", function (event) {
        if (!panState.active) return;
        event.preventDefault();
    });

    wrap.addEventListener("click", function (event) {
        if (!panState.suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
        panState.suppressClick = false;
        panState.moved = false;
    }, true);
}

function bindGanttScaleControls() {
    var modeEl = document.getElementById("stats-gantt-scale-mode");
    var valueEl = document.getElementById("stats-gantt-scale-value");
    var unitEl = document.getElementById("stats-gantt-scale-unit");
    var viewModeEl = document.getElementById("stats-gantt-view-mode");
    if (!modeEl || !valueEl || !unitEl || !viewModeEl) return;

    if (!modeEl._statsBound) {
        modeEl._statsBound = true;
        modeEl.addEventListener("change", function () {
            statsGanttState.scaleMode = modeEl.value === "financial-quarter" ? "financial-quarter" : "custom";
            syncGanttScaleControlState();
            renderGanttChart();
        });
    }

    if (!valueEl._statsBound) {
        valueEl._statsBound = true;
        var handleValueChange = function () {
            var parsed = parseInt(valueEl.value, 10);
            statsGanttState.scaleValue = !isNaN(parsed) && parsed > 0 ? parsed : 1;
            if (!valueEl.value || parsed < 1) valueEl.value = String(statsGanttState.scaleValue);
            renderGanttChart();
        };
        valueEl.addEventListener("change", handleValueChange);
        valueEl.addEventListener("input", handleValueChange);
    }

    if (!unitEl._statsBound) {
        unitEl._statsBound = true;
        unitEl.addEventListener("change", function () {
            statsGanttState.scaleUnit = unitEl.value === "months" || unitEl.value === "years" ? unitEl.value : "days";
            renderGanttChart();
        });
    }

    if (!viewModeEl._statsBound) {
        viewModeEl._statsBound = true;
        viewModeEl.addEventListener("change", function () {
            statsGanttState.viewMode = viewModeEl.value === "simple" ? "simple" : "detailed";
            renderGanttChart();
        });
    }

    modeEl.value = statsGanttState.scaleMode;
    valueEl.value = String(statsGanttState.scaleValue);
    unitEl.value = statsGanttState.scaleUnit;
    viewModeEl.value = statsGanttState.viewMode;
    syncGanttScaleControlState();
}

function syncGanttScaleControlState() {
    var valueEl = document.getElementById("stats-gantt-scale-value");
    var unitEl = document.getElementById("stats-gantt-scale-unit");
    var isQuarterView = statsGanttState.scaleMode === "financial-quarter";
    if (valueEl) {
        valueEl.disabled = isQuarterView;
        valueEl.value = String(statsGanttState.scaleValue || 1);
    }
    if (unitEl) {
        unitEl.disabled = isQuarterView;
        unitEl.value = statsGanttState.scaleUnit || "days";
    }
}

function initializeGanttScopeControls() {
    var hierarchy = statsGanttState.hierarchy || { divisions: [], groupsByDivision: {}, activitiesByGroup: {}, teamsByActivity: {} };
    var divisionSel = document.getElementById("stats-gantt-division");
    var groupSel = document.getElementById("stats-gantt-group");
    var activitySel = document.getElementById("stats-gantt-activity");
    var teamSel = document.getElementById("stats-gantt-team");
    var categorySel = document.getElementById("stats-gantt-category");

    if (!divisionSel || !groupSel || !activitySel || !teamSel) return;

    var previousDivision = divisionSel.value || "";
    var previousGroup = groupSel.value || "";
    var previousActivity = activitySel.value || "";
    var previousTeam = teamSel.value || "";

    fillSelectWithOptions(divisionSel, hierarchy.divisions, "All divisions", previousDivision);
    fillSelectWithOptions(groupSel, previousDivision ? (hierarchy.groupsByDivision[String(previousDivision)] || []) : flattenMapValues(hierarchy.groupsByDivision), "All groups", previousGroup);
    fillSelectWithOptions(activitySel, previousGroup ? (hierarchy.activitiesByGroup[String(previousGroup)] || []) : flattenMapValues(hierarchy.activitiesByGroup), "All activities", previousActivity);
    fillSelectWithOptions(teamSel, previousActivity ? (hierarchy.teamsByActivity[String(previousActivity)] || []) : flattenMapValues(hierarchy.teamsByActivity), "All teams", previousTeam);
    initializeGanttCategoryControl(categorySel);
    syncGanttLevelButtons();
}

function initializeGanttCategoryControl(categorySel) {
    if (!categorySel) return;
    var previousCategory = statsGanttState.categoryFilter || categorySel.value || "";
    var taskItems = buildGanttItems(statsGanttState.rawTasks, statsGanttState.hierarchy, []);
    var categories = [];
    var seen = {};
    taskItems.forEach(function (item) {
        if (!item || item.item_kind !== "task") return;
        var key = String(item.task_type || "Others");
        if (seen[key]) return;
        seen[key] = true;
        categories.push({ id: key, name: key });
    });
    categories.sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
    fillSelectWithOptions(categorySel, categories, "All categories", previousCategory);
    statsGanttState.categoryFilter = categorySel.value || "";
}

function syncGanttScopeCascade(changedId) {
    var hierarchy = statsGanttState.hierarchy || { groupsByDivision: {}, activitiesByGroup: {}, teamsByActivity: {} };
    var divisionSel = document.getElementById("stats-gantt-division");
    var groupSel = document.getElementById("stats-gantt-group");
    var activitySel = document.getElementById("stats-gantt-activity");
    var teamSel = document.getElementById("stats-gantt-team");
    if (!divisionSel || !groupSel || !activitySel || !teamSel) return;

    if (changedId === "stats-gantt-division") {
        var groups = divisionSel.value ? (hierarchy.groupsByDivision[String(divisionSel.value)] || []) : flattenMapValues(hierarchy.groupsByDivision);
        fillSelectWithOptions(groupSel, groups, "All groups", "");
        fillSelectWithOptions(activitySel, [], "All activities", "");
        fillSelectWithOptions(teamSel, [], "All teams", "");
        return;
    }

    if (changedId === "stats-gantt-group") {
        var activities = groupSel.value ? (hierarchy.activitiesByGroup[String(groupSel.value)] || []) : flattenMapValues(hierarchy.activitiesByGroup);
        fillSelectWithOptions(activitySel, activities, "All activities", "");
        fillSelectWithOptions(teamSel, [], "All teams", "");
        return;
    }

    if (changedId === "stats-gantt-activity") {
        var teams = activitySel.value ? (hierarchy.teamsByActivity[String(activitySel.value)] || []) : flattenMapValues(hierarchy.teamsByActivity);
        fillSelectWithOptions(teamSel, teams, "All teams", "");
    }
}

function fillSelectWithOptions(selectEl, items, emptyLabel, selectedId) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    addSelectOption(selectEl, "", emptyLabel || "All", !selectedId);
    (Array.isArray(items) ? items : []).forEach(function (item) {
        if (!item || typeof item.id === "undefined") return;
        addSelectOption(selectEl, item.id, item.name || ("Item " + item.id), String(selectedId) === String(item.id));
    });
    if (selectedId && !Array.prototype.some.call(selectEl.options, function (opt) { return opt.value === String(selectedId); })) {
        selectEl.value = "";
    }
}

function addSelectOption(selectEl, value, label, selected) {
    var option = document.createElement("option");
    option.value = String(value == null ? "" : value);
    option.textContent = label || "";
    if (selected) option.selected = true;
    selectEl.appendChild(option);
}

function flattenMapValues(mapObj) {
    var merged = [];
    var seen = {};
    Object.keys(mapObj || {}).forEach(function (key) {
        (mapObj[key] || []).forEach(function (item) {
            var idKey = String(item && item.id);
            if (!item || seen[idKey]) return;
            seen[idKey] = true;
            merged.push(item);
        });
    });
    return merged.sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
}

function formatActivityLabel(activity) {
    var type = String(activity && activity.type || "").trim().toLowerCase();
    var prefix = type === "project" ? "Project" : "Activity";
    return prefix + ": " + String(activity && activity.name || "Untitled");
}

function buildGanttHierarchy(navTree) {
    var hierarchy = {
        divisions: [],
        groupsByDivision: {},
        activitiesByGroup: {},
        teamsByActivity: {},
        teamMetaById: {},
        activityMetaById: {}
    };

    (navTree || []).forEach(function (division) {
        if (!division || typeof division.id === "undefined") return;
        hierarchy.divisions.push({ id: division.id, name: division.name || ("Division " + division.id) });
        hierarchy.groupsByDivision[String(division.id)] = [];

        (division.groups || []).forEach(function (group) {
            if (!group || typeof group.id === "undefined") return;
            hierarchy.groupsByDivision[String(division.id)].push({ id: group.id, name: group.name || ("Group " + group.id) });
            hierarchy.activitiesByGroup[String(group.id)] = [];

            (group.activities || []).forEach(function (activity) {
                if (!activity || typeof activity.id === "undefined") return;
                hierarchy.activitiesByGroup[String(group.id)].push({ id: activity.id, name: formatActivityLabel(activity) });
                hierarchy.activityMetaById[String(activity.id)] = {
                    activity_id: activity.id,
                    activity_name: activity.name || ("Activity " + activity.id),
                    activity_type: activity.type || "",
                    division_id: division.id,
                    division_name: division.name || "-",
                    group_id: group.id,
                    group_name: group.name || "-"
                };
                hierarchy.teamsByActivity[String(activity.id)] = [];

                (activity.teams || []).forEach(function (team) {
                    if (!team || typeof team.id === "undefined") return;
                    hierarchy.teamsByActivity[String(activity.id)].push({ id: team.id, name: team.name || ("Team " + team.id) });
                    hierarchy.teamMetaById[String(team.id)] = {
                        team_id: team.id,
                        team_name: team.name || ("Team " + team.id),
                        activity_id: activity.id,
                        activity_name: activity.name || "-",
                        activity_type: activity.type || "",
                        group_id: group.id,
                        group_name: group.name || "-",
                        division_id: division.id,
                        division_name: division.name || "-"
                    };
                });
            });
        });
    });

    hierarchy.divisions.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    Object.keys(hierarchy.groupsByDivision).forEach(function (key) {
        hierarchy.groupsByDivision[key].sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    });
    Object.keys(hierarchy.activitiesByGroup).forEach(function (key) {
        hierarchy.activitiesByGroup[key].sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    });
    Object.keys(hierarchy.teamsByActivity).forEach(function (key) {
        hierarchy.teamsByActivity[key].sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    });

    return hierarchy;
}

function renderGanttChart() {
    var root = document.getElementById("stats-gantt");
    var emptyEl = document.getElementById("stats-gantt-empty");
    var overviewEl = document.getElementById("stats-gantt-overview");
    if (!root || !emptyEl) return;

    var flatItems = buildGanttItems(statsGanttState.rawTasks, statsGanttState.hierarchy, statsGanttState.milestones);
    var scopedItems = applyGanttScopeFilter(flatItems);

    if (!scopedItems.length) {
        root.innerHTML = "";
        emptyEl.hidden = false;
        if (overviewEl) overviewEl.innerHTML = "";
        return;
    }
    emptyEl.hidden = true;

    var range = getGanttRange(scopedItems);
    var scaleConfig = getGanttScaleConfig(statsGanttState.scaleValue, statsGanttState.scaleUnit, range.totalDays, statsGanttState.scaleMode);
    var layoutMetrics = getGanttLayoutMetrics(root, scaleConfig, range);
    if (overviewEl) overviewEl.innerHTML = buildGanttOverview(scopedItems, range);

    var header = "";
    var rows = "";
    if (scaleConfig.mode === "financial-quarter") {
        var quarterSegments = buildFinancialQuarterSegments(range.start, range.end);
        var quarterWidth = getGanttQuarterWidth(quarterSegments.length, scaleConfig, layoutMetrics);
        var timelineWidth = Math.max(layoutMetrics.timelineViewportWidth, quarterWidth * Math.max(1, quarterSegments.length));
        applyGanttLayoutMetrics(root, {
            availableWidth: layoutMetrics.availableWidth,
            taskColumnWidth: layoutMetrics.taskColumnWidth,
            timelineWidth: timelineWidth
        });
        header = buildFinancialQuarterHeader(quarterSegments, scaleConfig, timelineWidth);
        rows = scopedItems.map(function (item) {
            return buildFinancialQuarterRow(item, quarterSegments, scaleConfig, timelineWidth, quarterWidth);
        }).join("");
    } else {
        var dayWidth = getGanttDayWidth(range.totalDays, scaleConfig, layoutMetrics);
        var totalDays = range.totalDays;
        var timelineWidthDays = Math.max(layoutMetrics.timelineViewportWidth, totalDays * dayWidth);
        applyGanttLayoutMetrics(root, {
            availableWidth: layoutMetrics.availableWidth,
            taskColumnWidth: layoutMetrics.taskColumnWidth,
            timelineWidth: timelineWidthDays
        });
        header = buildGanttHeader(range.start, totalDays, dayWidth, scaleConfig, timelineWidthDays);
        rows = scopedItems.map(function (item) {
            return buildGanttRow(item, range.start, totalDays, dayWidth, scaleConfig, timelineWidthDays);
        }).join("");
    }

    root.innerHTML = header + "<div class=\"stats-gantt-body\">" +
        "<svg class=\"stats-gantt-dependency-layer\" aria-hidden=\"true\"></svg>" +
        rows +
        "</div>";
    renderGanttDependencyArrows(root, scopedItems);
}

function getGanttLayoutMetrics(root, scaleConfig, range) {
    var wrap = document.getElementById("stats-gantt-wrap");
    var wrapWidth = wrap && wrap.clientWidth ? wrap.clientWidth : (root.parentElement && root.parentElement.clientWidth ? root.parentElement.clientWidth : root.clientWidth || 1200);
    var availableWidth = Math.max(720, wrapWidth - 24);
    var isSimple = statsGanttState.viewMode === "simple";
    var taskColumnWidth = isSimple
        ? Math.max(160, Math.min(210, Math.round(availableWidth * 0.18)))
        : Math.max(200, Math.min(260, Math.round(availableWidth * 0.22)));
    if (range && range.totalDays > 365) taskColumnWidth = Math.max(isSimple ? 160 : 200, taskColumnWidth - 18);
    if (scaleConfig && scaleConfig.mode === "financial-quarter") taskColumnWidth = Math.max(isSimple ? 160 : 196, taskColumnWidth - 8);
    if (isSimple) taskColumnWidth = Math.min(taskColumnWidth, 200);
    var timelineViewportWidth = Math.max(460, availableWidth - taskColumnWidth - 8);

    return {
        availableWidth: availableWidth,
        taskColumnWidth: taskColumnWidth,
        timelineViewportWidth: timelineViewportWidth
    };
}

function applyGanttLayoutMetrics(root, metrics) {
    if (!root || !metrics) return;
    root.style.setProperty("--stats-gantt-task-col", metrics.taskColumnWidth + "px");
    root.style.setProperty("--stats-gantt-timeline-col", "minmax(0, " + metrics.timelineWidth + "px)");
    root.style.width = Math.max(metrics.availableWidth || 0, (metrics.taskColumnWidth || 0) + (metrics.timelineWidth || 0)) + "px";
    root.setAttribute("data-view-mode", statsGanttState.viewMode === "simple" ? "simple" : "detailed");
}

function snapGanttPixel(value) {
    var numeric = Number(value);
    if (!isFinite(numeric)) return 0;
    return Math.round(numeric * 2) / 2;
}

function getGanttDayWidth(totalDays, scaleConfig, metrics) {
    var baseDayWidth = scaleConfig && scaleConfig.dayWidth ? scaleConfig.dayWidth : 10;
    var minReadableDayWidth = getGanttMinReadableDayWidth(totalDays, scaleConfig);
    var viewportWidth = metrics && metrics.timelineViewportWidth ? metrics.timelineViewportWidth : 0;
    var targetVisibleDays = scaleConfig && scaleConfig.unit === "years"
        ? 720
        : (scaleConfig && scaleConfig.unit === "months" ? 365 : 180);
    var fittedDayWidth = viewportWidth > 0
        ? viewportWidth / Math.max(1, Math.min(totalDays, targetVisibleDays))
        : baseDayWidth;
    return Math.max(minReadableDayWidth, Math.min(baseDayWidth, fittedDayWidth));
}

function getGanttQuarterWidth(segmentCount, scaleConfig, metrics) {
    var baseQuarterWidth = scaleConfig && scaleConfig.quarterWidth ? scaleConfig.quarterWidth : 126;
    var viewportWidth = metrics && metrics.timelineViewportWidth ? metrics.timelineViewportWidth : 0;
    var fittedQuarterWidth = viewportWidth > 0
        ? viewportWidth / Math.max(1, Math.min(segmentCount || 1, 8))
        : baseQuarterWidth;
    return Math.max(84, Math.min(baseQuarterWidth, fittedQuarterWidth));
}

function getGanttMinReadableDayWidth(totalDays, scaleConfig) {
    if (scaleConfig && scaleConfig.unit === "years") {
        if (totalDays > 1095) return 1.85;
        if (totalDays > 540) return 2.2;
        return 2.8;
    }
    if (scaleConfig && scaleConfig.unit === "months") {
        if (totalDays > 720) return 2.1;
        if (totalDays > 240) return 2.6;
        return 3.4;
    }
    if (totalDays > 900) return 1.85;
    if (totalDays > 540) return 2.2;
    if (totalDays > 240) return 2.8;
    if (totalDays > 120) return 3.6;
    return 4.6;
}

function getGanttDensity(totalDays, dayWidth, scaleConfig) {
    var gridStep = 1;
    var minLabelGap = scaleConfig && scaleConfig.minLabelGap ? scaleConfig.minLabelGap : 72;

    if (scaleConfig && scaleConfig.unit === "days") {
        if (dayWidth < 0.9 || totalDays > 900) gridStep = 30;
        else if (dayWidth < 1.4 || totalDays > 540) gridStep = 14;
        else if (dayWidth < 2.2 || totalDays > 240) gridStep = 7;
        else if (dayWidth < 4 || totalDays > 120) gridStep = 3;
        else if (dayWidth < 7 || totalDays > 60) gridStep = 2;
    } else if (scaleConfig && scaleConfig.unit === "months") {
        if (dayWidth < 1.2 || totalDays > 720) gridStep = 14;
        else if (dayWidth < 2.6 || totalDays > 180) gridStep = 7;
        else if (dayWidth < 5 || totalDays > 90) gridStep = 2;
    } else if (scaleConfig && scaleConfig.unit === "years") {
        if (dayWidth < 2.5 || totalDays > 1095) gridStep = 30;
        else if (dayWidth < 4.5 || totalDays > 540) gridStep = 14;
        else if (dayWidth < 7 || totalDays > 180) gridStep = 7;
    }

    if (scaleConfig && scaleConfig.mode !== "financial-quarter") {
        if (scaleConfig.unit === "days") gridStep = Math.max(gridStep, scaleConfig.value || 1);
        else if (scaleConfig.unit === "months") gridStep = Math.max(gridStep, 7);
        else if (scaleConfig.unit === "years") gridStep = Math.max(gridStep, 30);
    }

    minLabelGap = Math.max(minLabelGap, gridStep * Math.max(10, dayWidth * 3));

    return {
        gridStep: gridStep,
        minLabelGap: minLabelGap
    };
}

function buildGanttItems(nestedTasks, hierarchy, milestones) {
    var flat = flattenTasksForGantt(nestedTasks || [], 1);
    var byId = {};
    var timelines = {};
    flat.forEach(function (task) {
        if (task && task.id != null) byId[String(task.id)] = task;
    });

    flat.forEach(function (task) {
        if (task && task.id != null) {
            timelines[String(task.id)] = resolveTaskTimeline(task, byId);
        }
    });

    var taskItems = flat.map(function (task) {
        var timeline = timelines[String(task.id)] || resolveTaskTimeline(task, byId);
        var scope = resolveTaskScopeForGantt(task, hierarchy);
        var percent = computeTimelineCompletionPercent(task, timeline);
        var taskType = getTaskTypeDisplayName(task && task.task_type);
        var taskLevel = Math.max(1, Math.min(3, parseInt(task._gantt_level, 10) || 1));
        return {
            id: task.id,
            item_kind: "task",
            title: task.title || ("Task " + task.id),
            task_type: taskType,
            task_level: taskLevel,
            created_at: task && task.created_at ? task.created_at : null,
            status: task.status || "To Do",
            team_name: scope.team_name || task.team_name || "-",
            activity_name: scope.activity_name || task.activity_name || "-",
            group_name: scope.group_name || "-",
            division_name: scope.division_name || "-",
            team_id: scope.team_id || task.team_id || null,
            activity_id: scope.activity_id || task.activity_id || null,
            group_id: scope.group_id || null,
            division_id: scope.division_id || null,
            start: timeline.start,
            end: timeline.end,
            baseline_start: timeline.baseline_start,
            baseline_end: timeline.baseline_end,
            start_delay_days: timeline.start_delay_days || 0,
            end_delay_days: timeline.end_delay_days || 0,
            delay_days: timeline.delay_days || 0,
            delay_reasons: timeline.delay_reasons || [],
            has_dependency: !!(task.has_dependency || task.start_dependency_task_id || task.finish_dependency_task_id),
            percent: percent,
            dependency_links: collectTaskDependencyLinks(task, timelines)
        };
    });

    var milestoneItems = (milestones || []).map(function (milestone) {
        var pointDate = parseDateOnly(milestone && milestone.milestone_date) || startOfDay(new Date());
        return {
            id: "milestone-" + milestone.id,
            source_id: milestone.id,
            item_kind: "milestone",
            title: milestone.name || ("Milestone " + milestone.id),
            task_type: "Milestone",
            created_at: milestone && milestone.created_at ? milestone.created_at : null,
            status: "Milestone",
            team_name: "All teams",
            activity_name: "All activities",
            group_name: "All groups",
            division_name: "All divisions",
            team_id: null,
            activity_id: null,
            group_id: null,
            division_id: null,
            start: pointDate,
            end: pointDate,
            has_dependency: !!(milestone.has_dependency || milestone.start_dependency_task_id || milestone.finish_dependency_task_id),
            percent: 100,
            dependency_links: collectTaskDependencyLinks(milestone, timelines)
        };
    });

    return taskItems.concat(milestoneItems).sort(function (a, b) {
        if ((a.item_kind || "task") !== (b.item_kind || "task") && a.start.getTime() === b.start.getTime()) {
            return a.item_kind === "milestone" ? -1 : 1;
        }
        var typeCompare = compareTaskTypeThenRecency(a, b);
        if (typeCompare !== 0) return typeCompare;
        if (a.start.getTime() !== b.start.getTime()) return a.start - b.start;
        return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" });
    });
}

function getTaskTypeDisplayName(taskType) {
    var value = String(taskType || "").trim();
    return value || "Others";
}

function getTaskCreatedTimestamp(task) {
    var createdAt = task && task.created_at ? Date.parse(task.created_at) : NaN;
    if (!isNaN(createdAt)) return createdAt;
    var numericId = task && task.id != null ? parseInt(task.id, 10) : NaN;
    return isNaN(numericId) ? 0 : numericId;
}

function compareTaskTypeThenRecency(a, b) {
    var typeCompare = getTaskTypeDisplayName(a && a.task_type).localeCompare(
        getTaskTypeDisplayName(b && b.task_type),
        undefined,
        { sensitivity: "base" }
    );
    if (typeCompare !== 0) return typeCompare;
    var createdDiff = getTaskCreatedTimestamp(b) - getTaskCreatedTimestamp(a);
    if (createdDiff !== 0) return createdDiff;
    return 0;
}

function resolveTaskScopeForGantt(task, hierarchy) {
    var info = {};
    var teamMeta = hierarchy && hierarchy.teamMetaById ? hierarchy.teamMetaById[String(task.team_id)] : null;
    var activityMeta = hierarchy && hierarchy.activityMetaById ? hierarchy.activityMetaById[String(task.activity_id)] : null;
    if (teamMeta) return teamMeta;
    if (activityMeta) return activityMeta;
    return info;
}

function isTaskCompletedForGanttTimeline(task) {
    var status = String(task && task.status || "").toLowerCase();
    return status.indexOf("complete") !== -1 && status.indexOf("pending") === -1;
}

function isTaskStartedForGanttTimeline(task) {
    var status = String(task && task.status || "").toLowerCase();
    return status.indexOf("progress") !== -1 || status.indexOf("pending") !== -1 || isTaskCompletedForGanttTimeline(task);
}

function isOngoingTaskForGantt(task) {
    return String(task && task.task_schedule_type || "").trim().toLowerCase() === "ongoing";
}

function getTaskTentativeCompletionDateForGantt(task) {
    var explicitCompletion = parseDateOnly(task && task.tentative_completion_date);
    if (explicitCompletion) return startOfDay(explicitCompletion);
    var tentativeStart = parseDateOnly(task && task.tentative_start_date);
    var tentativeDuration = task && task.tentative_duration_days != null ? parseInt(task.tentative_duration_days, 10) : null;
    if (!tentativeStart || tentativeDuration == null || isNaN(tentativeDuration) || tentativeDuration < 1) return null;
    return addDays(startOfDay(tentativeStart), Math.max(0, tentativeDuration - 1));
}

function formatGanttOriginalRange(item) {
    if (!item) return "";
    if (item.item_kind === "milestone") {
        return formatShortDate(item.baseline_start || item.start);
    }
    var plannedStart = item.baseline_start || item.start;
    var plannedEnd = item.baseline_end || item.end;
    return formatShortDate(plannedStart) + " - " + formatShortDate(plannedEnd);
}

function resolveTaskTimeline(task, byId, visited) {
    var seen = visited || {};
    var key = task && task.id != null ? String(task.id) : null;
    if (key && seen[key]) {
        var fallbackStart = parseDateOnly(task && task.tentative_start_date) || parseDateTimeValue(task && task.created_at) || startOfDay(new Date());
        var fallbackCompletion = getTaskTentativeCompletionDateForGantt(task);
        var fallbackEnd = fallbackCompletion
            ? startOfDay(fallbackCompletion)
            : (parseDateOnly(task && task.due_date) || addDays(startOfDay(fallbackStart), 1));
        if (fallbackEnd < fallbackStart) fallbackEnd = addDays(startOfDay(fallbackStart), 1);
        fallbackStart = startOfDay(fallbackStart);
        fallbackEnd = startOfDay(fallbackEnd);
        return {
            start: fallbackStart,
            end: fallbackEnd,
            baseline_start: fallbackStart,
            baseline_end: fallbackEnd,
            start_delay_days: 0,
            end_delay_days: 0,
            delay_days: 0,
            delay_reasons: []
        };
    }
    if (key) seen[key] = true;

    var now = startOfDay(new Date());
    var tentativeStart = parseDateOnly(task.tentative_start_date);
    var tentativeCompletion = getTaskTentativeCompletionDateForGantt(task);

    var created = parseDateTimeValue(task.created_at);
    var startedAt = parseDateTimeValue(task.started_at);
    var due = parseDateOnly(task.due_date);
    var baseStart = tentativeStart || (created ? startOfDay(created) : now);
    var baseEnd;
    if (tentativeCompletion) {
        baseEnd = startOfDay(tentativeCompletion);
    } else {
        baseEnd = due ? startOfDay(due) : addDays(baseStart, 7);
    }
    if (baseEnd < baseStart) baseEnd = addDays(baseStart, 1);

    baseStart = startOfDay(baseStart);
    baseEnd = startOfDay(baseEnd);
    var start = new Date(baseStart.getTime());
    var end = new Date(baseEnd.getTime());
    var intendedDuration = Math.max(1, daysBetweenInclusive(baseStart, baseEnd));
    var delayReasons = [];

    var startDepId = task.start_dependency_task_id;
    var finishDepId = task.finish_dependency_task_id;
    if (startDepId && byId[String(startDepId)]) {
        var startDepTask = byId[String(startDepId)];
        var depTimeline = resolveTaskTimeline(startDepTask, byId, Object.assign({}, seen));
        var depDate = String(task.start_dependency_event || "finish").toLowerCase() === "start" ? depTimeline.start : depTimeline.end;
        var startOffset = task.start_dependency_offset_days != null ? parseInt(task.start_dependency_offset_days, 10) : null;
        if (startOffset != null && !isNaN(startOffset) && startOffset > 0) {
            depDate = addDays(depDate, startOffset);
            delayReasons.push("start-offset");
        }
        if (depDate > start) {
            start = new Date(depDate.getTime());
            end = addDays(start, intendedDuration - 1);
            if (!startOffset || startOffset < 1) delayReasons.push("start-dependency");
        }
    }
    if (finishDepId && byId[String(finishDepId)]) {
        var finishDepTask = byId[String(finishDepId)];
        var depTimelineFinish = resolveTaskTimeline(finishDepTask, byId, Object.assign({}, seen));
        var finishDepDate = String(task.finish_dependency_event || "finish").toLowerCase() === "start" ? depTimelineFinish.start : depTimelineFinish.end;
        var finishOffset = task.finish_dependency_offset_days != null ? parseInt(task.finish_dependency_offset_days, 10) : null;
        if (finishOffset != null && !isNaN(finishOffset) && finishOffset > 0) {
            finishDepDate = addDays(finishDepDate, finishOffset);
            delayReasons.push("finish-offset");
        }
        if (finishDepDate > end) end = new Date(finishDepDate.getTime());
        if (finishDepDate > baseEnd && (!finishOffset || finishOffset < 1)) delayReasons.push("finish-dependency");
    }

    if (isTaskStartedForGanttTimeline(task) && startedAt) {
        var actualStart = startOfDay(startedAt);
        if (actualStart > start) {
            start = new Date(actualStart.getTime());
            end = new Date(Math.max(end.getTime(), addDays(start, intendedDuration - 1).getTime()));
            delayReasons.push("actual-start");
        }
    }

    // Keep overdue tasks visually extended through today until they are marked complete,
    // so the red dotted baseline reflects the live delay against the original plan.
    if (!isTaskCompletedForGanttTimeline(task) && baseEnd < now && end < now) {
        end = new Date(now.getTime());
        delayReasons.push("due-overrun");
    }

    if (end < start) end = addDays(start, 1);
    if (daysBetweenInclusive(start, end) < 1) end = addDays(start, 1);

    var startDelayDays = Math.max(0, daysBetween(baseStart, start));
    var endDelayDays = Math.max(0, daysBetween(baseEnd, end));
    if (endDelayDays > 0) delayReasons.push("due-overrun");

    return {
        start: start,
        end: end,
        baseline_start: baseStart,
        baseline_end: baseEnd,
        start_delay_days: startDelayDays,
        end_delay_days: endDelayDays,
        delay_days: Math.max(startDelayDays, endDelayDays),
        delay_reasons: uniqueArray(delayReasons)
    };
}

function applyGanttScopeFilter(items) {
    var divisionId = parseInt((document.getElementById("stats-gantt-division") || {}).value, 10);
    var groupId = parseInt((document.getElementById("stats-gantt-group") || {}).value, 10);
    var activityId = parseInt((document.getElementById("stats-gantt-activity") || {}).value, 10);
    var teamId = parseInt((document.getElementById("stats-gantt-team") || {}).value, 10);
    var categoryValue = String((document.getElementById("stats-gantt-category") || {}).value || statsGanttState.categoryFilter || "").trim();
    var levelValue = String(statsGanttState.levelFilter || "all");

    return (items || []).filter(function (item) {
        if (!item) return false;
        if (item.item_kind === "milestone") {
            return levelValue === "all" && !categoryValue;
        }
        if (divisionId && item.division_id !== divisionId) return false;
        if (groupId && item.group_id !== groupId) return false;
        if (activityId && item.activity_id !== activityId) return false;
        if (teamId && item.team_id !== teamId) return false;
        if (categoryValue && String(item.task_type || "") !== categoryValue) return false;
        if (levelValue !== "all" && parseInt(item.task_level, 10) !== parseInt(levelValue, 10)) return false;
        return true;
    });
}

function getGanttRange(items) {
    var start = null;
    var end = null;
    (items || []).forEach(function (item) {
        var itemStart = item.baseline_start && item.baseline_start < item.start ? item.baseline_start : item.start;
        var itemEnd = item.baseline_end && item.baseline_end > item.end ? item.baseline_end : item.end;
        if (!start || itemStart < start) start = itemStart;
        if (!end || itemEnd > end) end = itemEnd;
    });
    start = start || startOfDay(new Date());
    end = end || addDays(start, 7);
    if (statsGanttState.scaleMode === "financial-quarter") {
        start = getFinancialYearStart(start);
        end = getFinancialYearEnd(end);
    }
    if (end < start) end = addDays(start, 1);
    var totalDays = Math.max(1, daysBetweenInclusive(start, end));
    return { start: start, end: end, totalDays: totalDays };
}

function getGanttScaleConfig(scaleValue, scaleUnit, totalDays, scaleMode) {
    var mode = scaleMode === "financial-quarter" ? "financial-quarter" : "custom";
    var unit = scaleUnit === "months" || scaleUnit === "years" ? scaleUnit : "days";
    var value = Math.max(1, parseInt(scaleValue, 10) || 1);
    var dayWidth;
    var minLabelGap;

    if (mode === "financial-quarter") {
        dayWidth = 6;
        minLabelGap = 92;
    } else if (unit === "years") {
        dayWidth = totalDays > 1825 ? 2.8 : (totalDays > 730 ? 3.8 : (totalDays > 365 ? 5.2 : 7.2));
        minLabelGap = 88;
    } else if (unit === "months") {
        dayWidth = totalDays > 1095 ? 2.8 : (totalDays > 540 ? 4.2 : (totalDays > 180 ? 5.8 : (totalDays > 60 ? 8.5 : 11.5)));
        minLabelGap = 84;
    } else {
        dayWidth = totalDays > 365 ? 5.2 : (totalDays > 120 ? 7.5 : (totalDays > 45 ? 11 : (totalDays > 14 ? 17 : 24)));
        minLabelGap = Math.max(72, Math.min(128, value * Math.max(8, Math.floor(dayWidth * 0.95))));
    }

    return {
        mode: mode,
        unit: unit,
        value: value,
        dayWidth: dayWidth,
        minLabelGap: minLabelGap,
        quarterWidth: 126
    };
}

function buildFinancialQuarterSegments(start, end) {
    var segments = [];
    var current = getFinancialQuarterStart(start);
    var index = 0;
    while (current <= end) {
        var nextQuarter = addMonthsSafe(current, 3);
        var quarterEnd = addDays(nextQuarter, -1);
        segments.push({
            index: index,
            start: startOfDay(current),
            end: startOfDay(quarterEnd),
            fyLabel: getFinancialYearLabel(current),
            quarterNumber: getFinancialQuarterNumber(current),
            quarterLabel: "Q" + getFinancialQuarterNumber(current),
            shortLabel: "Q" + getFinancialQuarterNumber(current)
        });
        current = nextQuarter;
        index += 1;
    }
    return segments;
}

function buildFinancialQuarterHeader(segments, scaleConfig, timelineWidth) {
    var fyBands = "";
    var quarterTicks = "";
    var quarterWidth = timelineWidth / Math.max(1, segments.length);
    var todayX = getFinancialQuarterTodayOffset(segments, quarterWidth);
    var startIndex = 0;

    while (startIndex < segments.length) {
        var fyLabel = segments[startIndex].fyLabel;
        var endIndex = startIndex + 1;
        while (endIndex < segments.length && segments[endIndex].fyLabel === fyLabel) endIndex += 1;
        fyBands += "<span class=\"stats-gantt-axis-month stats-gantt-axis-fy\" style=\"left:" + snapGanttPixel(startIndex * quarterWidth) + "px; width:" + snapGanttPixel((endIndex - startIndex) * quarterWidth) + "px;\">" +
            escapeHtml(fyLabel) +
            "</span>";
        startIndex = endIndex;
    }

    segments.forEach(function (segment) {
        var quarterLabel = quarterWidth < 54 ? segment.shortLabel : segment.quarterLabel;
        var shouldRenderQuarterLabel = quarterWidth >= 42 || (segment.index % 2 === 0);
        quarterTicks += "<span class=\"stats-gantt-axis-quarter-block\" style=\"left:" + snapGanttPixel(segment.index * quarterWidth) + "px; width:" + snapGanttPixel(quarterWidth) + "px;\">" +
            (shouldRenderQuarterLabel ? "<span class=\"stats-gantt-axis-quarter-label\">" + escapeHtml(quarterLabel) + "</span>" : "") +
            "</span>";
    });

    return (
        "<div class=\"stats-gantt-header\">" +
        "<div class=\"stats-gantt-header-title\">Task / Milestone</div>" +
        "<div class=\"stats-gantt-timeline-axis stats-gantt-timeline-axis--quarter\" style=\"width:" + snapGanttPixel(timelineWidth) + "px;\">" +
        "<div class=\"stats-gantt-axis-months\">" + fyBands + "</div>" +
        "<div class=\"stats-gantt-axis-days stats-gantt-axis-days--quarter\">" + quarterTicks + "</div>" +
        (todayX !== null ? "<span class=\"stats-gantt-today-line stats-gantt-today-line--header\" style=\"left:" + snapGanttPixel(todayX) + "px;\"></span><span class=\"stats-gantt-today-chip\">Today</span>" : "") +
        "</div>" +
        "</div>"
    );
}

function buildFinancialQuarterRow(item, segments, scaleConfig, timelineWidth, quarterWidth) {
    var timelineGrid = "";
    var todayX = getFinancialQuarterTodayOffset(segments, quarterWidth);
    segments.forEach(function (segment) {
        timelineGrid += "<span class=\"stats-gantt-gridline stats-gantt-gridline--major\" style=\"left:" + snapGanttPixel(segment.index * quarterWidth) + "px;\"></span>";
    });

    var isMilestone = item.item_kind === "milestone";
    var isSimple = statsGanttState.viewMode === "simple";
    var barMetrics = getFinancialQuarterBarMetrics(item.start, item.end, segments, quarterWidth, isMilestone);
    var baselineMetrics = getFinancialQuarterBarMetrics(item.baseline_start || item.start, item.baseline_end || item.end, segments, quarterWidth, isMilestone);
    var barLeft = barMetrics.left;
    var barWidth = barMetrics.width;
    var fillWidth = Math.max(0, Math.min(100, item.percent));
    var delayMarkup = buildGanttDelayMarkup(item, baselineMetrics, barMetrics, {
        isSimple: isSimple,
        isQuarter: true,
        timelineWidth: timelineWidth
    });
    var barClass = "stats-gantt-bar" + (item.has_dependency ? " stats-gantt-bar--dependency" : "") + (isMilestone ? " stats-gantt-bar--milestone" : "");
    var scopeText = isMilestone
        ? "Global milestone"
        : (item.division_name || "-") + " / " + (item.group_name || "-") + " / " + (item.activity_name || "-") + " / " + (item.team_name || "-");
    var levelBadge = !isSimple && !isMilestone ? "<span class=\"stats-gantt-task-badge stats-gantt-task-badge--level\">L" + escapeHtml(String(item.task_level || 1)) + "</span>" : "";
    var typeBadge = !isSimple && item.task_type ? "<span class=\"stats-gantt-task-badge" + (isMilestone ? " stats-gantt-task-badge--milestone" : "") + "\">" + escapeHtml(item.task_type) + "</span>" : "";
    var depBadge = !isSimple && item.has_dependency ? "<span class=\"stats-gantt-task-badge\">Dependency</span>" : "";
    var statusBadge = !isSimple && !isMilestone ? "<span class=\"stats-gantt-task-badge stats-gantt-task-badge--status " + getGanttStatusBadgeClass(item.status) + "\">" + escapeHtml(item.status || "To Do") + "</span>" : "";
    var scheduleText = formatGanttOriginalRange(item);
    var actualRangeText = isMilestone ? formatShortDate(item.start) : (formatShortDate(item.start) + " - " + formatShortDate(item.end));
    var tooltipText = isMilestone
        ? (item.title + " | Planned: " + scheduleText)
        : (item.title + " | Planned: " + scheduleText + " | Current: " + actualRangeText + " | Progress: " + item.percent + "%");
    var innerContent = isMilestone
        ? "<span class=\"stats-gantt-milestone-star\" aria-hidden=\"true\"></span>"
        : "<span class=\"stats-gantt-bar-fill\" style=\"width:" + fillWidth + "%;\"></span>" +
        "<span class=\"stats-gantt-bar-progress-text\">" + escapeHtml(String(item.percent)) + "%</span>";

    var taskMetaHtml = isSimple
        ? ""
        : "<div class=\"stats-gantt-task-meta\">" + escapeHtml(scopeText) + "</div>" +
        "<div class=\"stats-gantt-task-dates\"><span>" + escapeHtml(scheduleText) + "</span>" + (isMilestone ? "" : "<span class=\"stats-gantt-progress-pill\">Progress " + escapeHtml(String(item.percent)) + "%</span>") + "</div>";

    return (
        "<div class=\"stats-gantt-row\" data-task-id=\"" + item.id + "\">" +
        "<div class=\"stats-gantt-task\">" +
        "<div class=\"stats-gantt-task-title\">" + escapeHtml(item.title) + levelBadge + typeBadge + statusBadge + depBadge + "</div>" +
        taskMetaHtml +
        "</div>" +
        "<div class=\"stats-gantt-timeline stats-gantt-timeline--quarter\" style=\"width:" + snapGanttPixel(timelineWidth) + "px;\">" +
        timelineGrid +
        (todayX !== null ? "<span class=\"stats-gantt-today-line stats-gantt-today-line--row\" style=\"left:" + snapGanttPixel(todayX) + "px;\"></span>" : "") +
        delayMarkup +
        "<span class=\"" + barClass + "\" style=\"left:" + snapGanttPixel(barLeft) + "px; width:" + snapGanttPixel(barWidth) + "px;\" title=\"" + escapeHtml(tooltipText) + "\">" +
        innerContent +
        "</span>" +
        "</div>" +
        "</div>"
    );
}

function buildGanttHeader(start, totalDays, dayWidth, scaleConfig, timelineWidth) {
    var monthBands = buildGanttAxisBands(start, totalDays, dayWidth, scaleConfig);
    var ticks = "";
    var todayX = getTodayMarkerOffset(start, totalDays, dayWidth);
    var lastLabelX = -9999;
    var density = getGanttDensity(totalDays, dayWidth, scaleConfig);
    var minLabelGap = density.minLabelGap;
    var shouldRenderTickLabels = shouldRenderGanttTickLabels(scaleConfig);

    for (var dayIndex = 0; dayIndex < totalDays; dayIndex++) {
        var x = dayIndex * dayWidth;
        var tickDate = addDays(start, dayIndex);
        var isMajor = isGanttMajorTick(tickDate, start, dayIndex, scaleConfig);
        var shouldRenderTick = isMajor || dayIndex % density.gridStep === 0;
        if (!shouldRenderTick) continue;
        var tickClass = "stats-gantt-axis-tick" + (isMajor ? " stats-gantt-axis-tick--major" : "");
        var labelText = "";

        if (shouldRenderTickLabels && isMajor && (x - lastLabelX >= minLabelGap)) {
            labelText = formatGanttScaleLabel(tickDate, scaleConfig);
            lastLabelX = x;
        }
        ticks += "<span class=\"" + tickClass + "\" style=\"left:" + snapGanttPixel(x) + "px;\">" +
            (labelText ? buildGanttTickLabelMarkup(labelText, x, timelineWidth) : "") +
            "</span>";
    }
    return (
        "<div class=\"stats-gantt-header\">" +
        "<div class=\"stats-gantt-header-title\">Task / Milestone</div>" +
        "<div class=\"stats-gantt-timeline-axis\" style=\"width:" + snapGanttPixel(timelineWidth) + "px;\">" +
        "<div class=\"stats-gantt-axis-months\">" + monthBands + "</div>" +
        "<div class=\"stats-gantt-axis-days\">" + ticks + "</div>" +
        (todayX !== null ? "<span class=\"stats-gantt-today-line stats-gantt-today-line--header\" style=\"left:" + snapGanttPixel(todayX) + "px;\"></span><span class=\"stats-gantt-today-chip\">Today</span>" : "") +
        "</div>" +
        "</div>"
    );
}

function shouldRenderGanttTickLabels(scaleConfig) {
    if (!scaleConfig) return true;
    if (scaleConfig.mode === "financial-quarter") return false;
    return scaleConfig.unit === "days";
}

function buildGanttTickLabelMarkup(labelText, x, timelineWidth) {
    var className = "stats-gantt-axis-tick-label";
    var style = "";
    var edgePadding = 8;
    var startThreshold = 48;
    var endThreshold = 80;

    if (x <= startThreshold) {
        className += " stats-gantt-axis-tick-label--start";
        style = " style=\"left:" + edgePadding + "px; transform:none;\"";
    } else if ((timelineWidth - x) <= endThreshold) {
        className += " stats-gantt-axis-tick-label--end";
        style = " style=\"left:-" + edgePadding + "px; transform:translateX(-100%);\"";
    }

    return "<span class=\"" + className + "\"" + style + ">" + escapeHtml(labelText) + "</span>";
}

function buildGanttRow(item, rangeStart, totalDays, dayWidth, scaleConfig, timelineWidth) {
    var timelineGrid = "";
    var todayX = getTodayMarkerOffset(rangeStart, totalDays, dayWidth);
    var density = getGanttDensity(totalDays, dayWidth, scaleConfig);
    for (var i = 0; i < totalDays; i++) {
        var gridDate = addDays(rangeStart, i);
        var isMajorGrid = isGanttGridMajor(gridDate, rangeStart, i, scaleConfig);
        var shouldRenderGrid = isMajorGrid || i % density.gridStep === 0;
        if (!shouldRenderGrid) continue;
        timelineGrid += "<span class=\"stats-gantt-gridline" + (isMajorGrid ? " stats-gantt-gridline--major" : "") + "\" style=\"left:" + snapGanttPixel(i * dayWidth) + "px;\"></span>";
    }
    var isMilestone = item.item_kind === "milestone";
    var isSimple = statsGanttState.viewMode === "simple";
    var barMetrics = getStandardGanttBarMetrics(item.start, item.end, rangeStart, dayWidth, isMilestone);
    var baselineMetrics = getStandardGanttBarMetrics(item.baseline_start || item.start, item.baseline_end || item.end, rangeStart, dayWidth, isMilestone);
    var barLeft = barMetrics.left;
    var barWidth = barMetrics.width;
    var fillWidth = Math.max(0, Math.min(100, item.percent));
    var delayMarkup = buildGanttDelayMarkup(item, baselineMetrics, barMetrics, {
        isSimple: isSimple,
        isQuarter: false,
        timelineWidth: timelineWidth
    });
    var barClass = "stats-gantt-bar" + (item.has_dependency ? " stats-gantt-bar--dependency" : "") + (isMilestone ? " stats-gantt-bar--milestone" : "");
    var scopeText = isMilestone
        ? "Global milestone"
        : (item.division_name || "-") + " / " + (item.group_name || "-") + " / " + (item.activity_name || "-") + " / " + (item.team_name || "-");
    var levelBadge = !isSimple && !isMilestone ? "<span class=\"stats-gantt-task-badge stats-gantt-task-badge--level\">L" + escapeHtml(String(item.task_level || 1)) + "</span>" : "";
    var typeBadge = !isSimple && item.task_type ? "<span class=\"stats-gantt-task-badge" + (isMilestone ? " stats-gantt-task-badge--milestone" : "") + "\">" + escapeHtml(item.task_type) + "</span>" : "";
    var depBadge = !isSimple && item.has_dependency ? "<span class=\"stats-gantt-task-badge\">Dependency</span>" : "";
    var statusBadge = !isSimple && !isMilestone ? "<span class=\"stats-gantt-task-badge stats-gantt-task-badge--status " + getGanttStatusBadgeClass(item.status) + "\">" + escapeHtml(item.status || "To Do") + "</span>" : "";
    var scheduleText = formatGanttOriginalRange(item);
    var actualRangeText = isMilestone ? formatShortDate(item.start) : (formatShortDate(item.start) + " - " + formatShortDate(item.end));
    var tooltipText = isMilestone
        ? (item.title + " | Planned: " + scheduleText)
        : (item.title + " | Planned: " + scheduleText + " | Current: " + actualRangeText + " | Progress: " + item.percent + "%");
    var innerContent = isMilestone
        ? "<span class=\"stats-gantt-milestone-star\" aria-hidden=\"true\"></span>"
        : "<span class=\"stats-gantt-bar-fill\" style=\"width:" + fillWidth + "%;\"></span>" +
        "<span class=\"stats-gantt-bar-progress-text\">" + escapeHtml(String(item.percent)) + "%</span>";

    var taskMetaHtml = isSimple
        ? ""
        : "<div class=\"stats-gantt-task-meta\">" + escapeHtml(scopeText) + "</div>" +
        "<div class=\"stats-gantt-task-dates\"><span>" + escapeHtml(scheduleText) + "</span>" + (isMilestone ? "" : "<span class=\"stats-gantt-progress-pill\">Progress " + escapeHtml(String(item.percent)) + "%</span>") + "</div>";

    return (
        "<div class=\"stats-gantt-row\" data-task-id=\"" + item.id + "\">" +
        "<div class=\"stats-gantt-task\">" +
        "<div class=\"stats-gantt-task-title\">" + escapeHtml(item.title) + levelBadge + typeBadge + statusBadge + depBadge + "</div>" +
        taskMetaHtml +
        "</div>" +
        "<div class=\"stats-gantt-timeline\" style=\"width:" + snapGanttPixel(timelineWidth) + "px;\">" +
        timelineGrid +
        (todayX !== null ? "<span class=\"stats-gantt-today-line stats-gantt-today-line--row\" style=\"left:" + snapGanttPixel(todayX) + "px;\"></span>" : "") +
        delayMarkup +
        "<span class=\"" + barClass + "\" style=\"left:" + snapGanttPixel(barLeft) + "px; width:" + snapGanttPixel(barWidth) + "px;\" title=\"" + escapeHtml(tooltipText) + "\">" +
        innerContent +
        "</span>" +
        "</div>" +
        "</div>"
    );
}

function buildGanttOverview(items, range) {
    var completed = 0;
    var inProgress = 0;
    var dependencies = 0;
    var milestones = 0;
    (items || []).forEach(function (item) {
        var status = String(item && item.status || "").toLowerCase();
        if (item && item.item_kind === "milestone") milestones += 1;
        if (status.indexOf("completed") !== -1 && status.indexOf("pending") === -1) completed += 1;
        else if (status.indexOf("progress") !== -1 || status.indexOf("pending") !== -1) inProgress += 1;
        if (item && item.has_dependency) dependencies += 1;
    });
    return [
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(String(items.length)) + " scheduled</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(String(milestones)) + " milestones</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(String(completed)) + " completed</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(String(inProgress)) + " active</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(String(dependencies)) + " dependencies</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(getGanttLevelSummaryLabel()) + "</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(getGanttCategorySummaryLabel()) + "</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(getGanttScaleSummaryLabel()) + "</span>",
        "<span class=\"stats-gantt-overview-chip\">" + escapeHtml(formatShortDate(range.start)) + " - " + escapeHtml(formatShortDate(range.end)) + "</span>"
    ].join("");
}

function getStandardGanttBarMetrics(startDate, endDate, rangeStart, dayWidth, isMilestone) {
    var startOffset = daysBetween(rangeStart, startDate);
    var durationDays = Math.max(1, daysBetweenInclusive(startDate, endDate));
    var left = startOffset * dayWidth;
    var width = isMilestone ? Math.max(24, dayWidth * 1.1) : Math.max(8, durationDays * dayWidth);
    if (isMilestone) left = Math.max(0, left - (width / 2));
    return { left: left, width: width };
}

function getFinancialQuarterBarMetrics(startDate, endDate, segments, quarterWidth, isMilestone) {
    var startPos = getFinancialQuarterPosition(startDate, segments, quarterWidth);
    var endPos = getFinancialQuarterPosition(endDate, segments, quarterWidth);
    var quarterInset = 10;
    var left = Math.max(0, startPos == null ? 0 : startPos);
    var rawWidth = Math.max(0, (endPos == null ? 0 : endPos) - left);
    var quarterIndexStart = Math.max(0, Math.floor(left / quarterWidth));
    var quarterIndexEnd = Math.min(segments.length - 1, Math.floor(Math.max(left, (endPos == null ? left : endPos) - 1) / quarterWidth));
    var spanQuarterCount = Math.max(1, (quarterIndexEnd - quarterIndexStart) + 1);
    var minWidth = spanQuarterCount === 1 ? Math.max(40, quarterWidth - (quarterInset * 2)) : Math.max(48, (spanQuarterCount * quarterWidth) - (quarterInset * 2));
    var width = Math.max(minWidth, rawWidth);
    var maxAllowedWidth = Math.max(36, (spanQuarterCount * quarterWidth) - (quarterInset * 2));
    width = Math.min(width, maxAllowedWidth);
    var snappedLeft = (quarterIndexStart * quarterWidth) + quarterInset;
    if (spanQuarterCount === 1) {
        left = snappedLeft;
    } else {
        left = Math.max(snappedLeft, Math.min(left, ((quarterIndexEnd + 1) * quarterWidth) - quarterInset - width));
    }
    if (isMilestone) {
        width = Math.max(24, Math.min(Math.max(24, quarterWidth * 0.32), quarterWidth - (quarterInset * 0.6)));
        left = Math.max(0, (quarterIndexStart * quarterWidth) + (quarterWidth / 2) - (width / 2));
    }
    return { left: left, width: width };
}

function buildGanttDelayMarkup(item, baselineMetrics, barMetrics, options) {
    if (!item || item.item_kind === "milestone" || !item.delay_days) {
        return "";
    }
    options = options || {};
    baselineMetrics = baselineMetrics || barMetrics;
    var baselineTitle = getGanttDelayTooltip(item);
    var badgeMetrics = getGanttDelayBadgeMetrics(item, baselineMetrics, barMetrics, options);
    var baselineClass = "stats-gantt-delay-baseline" +
        (options.isSimple ? " stats-gantt-delay-baseline--simple" : "") +
        (options.isQuarter ? " stats-gantt-delay-baseline--quarter" : "");
    var badgeClass = "stats-gantt-delay-badge" + (options.isSimple ? " stats-gantt-delay-badge--simple" : "");
    return (
        "<span class=\"" + baselineClass + "\" style=\"left:" + baselineMetrics.left + "px; width:" + baselineMetrics.width + "px;\" title=\"" + escapeHtml(baselineTitle) + "\"></span>" +
        "<span class=\"" + badgeClass + "\" style=\"left:" + badgeMetrics.left + "px;\" title=\"" + escapeHtml(baselineTitle) + "\">+" + escapeHtml(String(item.delay_days)) + "d</span>"
    );
}

function getGanttDelayBadgeMetrics(item, baselineMetrics, barMetrics, options) {
    var gap = options && options.isQuarter ? 10 : 8;
    var label = "+" + String(item && item.delay_days || 0) + "d";
    var estimatedWidth = Math.max(46, (label.length * 8) + 18);
    var occupiedStart = Math.min(
        baselineMetrics ? baselineMetrics.left : 0,
        barMetrics ? barMetrics.left : 0
    );
    var occupiedEnd = Math.max(
        baselineMetrics ? baselineMetrics.left + baselineMetrics.width : 0,
        barMetrics ? barMetrics.left + barMetrics.width : 0
    );
    var timelineWidth = options && options.timelineWidth ? options.timelineWidth : null;
    var preferredLeft = occupiedEnd + gap;

    if (timelineWidth && preferredLeft + estimatedWidth > timelineWidth - 6) {
        preferredLeft = Math.max(6, occupiedStart - estimatedWidth - gap);
    }

    if (timelineWidth) {
        preferredLeft = Math.max(6, Math.min(preferredLeft, timelineWidth - estimatedWidth - 6));
    }

    return {
        left: preferredLeft,
        width: estimatedWidth
    };
}

function isGanttTaskCompleted(item) {
    var status = String(item && item.status || "").toLowerCase();
    return status.indexOf("complete") !== -1 && status.indexOf("pending") === -1;
}

function getGanttDelayTooltip(item) {
    var parts = [];
    if (item.start_delay_days) parts.push("Start shifted by " + item.start_delay_days + " day" + (item.start_delay_days === 1 ? "" : "s"));
    if (item.end_delay_days) parts.push("End delayed by " + item.end_delay_days + " day" + (item.end_delay_days === 1 ? "" : "s"));
    if (!parts.length) parts.push("Delayed by " + (item.delay_days || 0) + " day" + ((item.delay_days || 0) === 1 ? "" : "s"));
    return parts.join(" | ");
}

function uniqueArray(values) {
    var result = [];
    (values || []).forEach(function (value) {
        if (value && result.indexOf(value) === -1) result.push(value);
    });
    return result;
}

function getGanttLevelSummaryLabel() {
    if (String(statsGanttState.levelFilter || "all") === "all") return "Levels: All";
    return "Levels: L" + String(statsGanttState.levelFilter);
}

function getGanttCategorySummaryLabel() {
    return statsGanttState.categoryFilter ? ("Category: " + statsGanttState.categoryFilter) : "Category: All";
}

function getGanttStatusBadgeClass(status) {
    var value = String(status || "").toLowerCase();
    if (value.indexOf("completed") !== -1 && value.indexOf("pending") === -1) return "stats-gantt-task-badge--done";
    if (value.indexOf("pending") !== -1) return "stats-gantt-task-badge--pending";
    if (value.indexOf("progress") !== -1) return "stats-gantt-task-badge--progress";
    return "stats-gantt-task-badge--todo";
}

function getTodayMarkerOffset(rangeStart, totalDays, dayWidth) {
    var today = startOfDay(new Date());
    var dayOffset = daysBetween(rangeStart, today);
    if (dayOffset < 0 || dayOffset >= totalDays) return null;
    return (dayOffset * dayWidth) + Math.floor(dayWidth / 2);
}

function computeTimelineCompletionPercent(task, timeline) {
    var explicitPercent = parseInt(task && task.completion_rate, 10);
    if (!isNaN(explicitPercent)) {
        return Math.max(0, Math.min(100, explicitPercent));
    }

    var status = String(task && task.status || "").toLowerCase();
    if (status.indexOf("complete") !== -1 && status.indexOf("pending") === -1) {
        return 100;
    }
    if (!isTaskStartedForGanttTimeline(task)) {
        return 0;
    }

    var created = parseDateTimeValue(task && task.created_at);
    var startedAt = parseDateTimeValue(task && task.started_at);
    var tentativeStart = parseDateOnly(task && task.tentative_start_date);
    var tentativeCompletion = getTaskTentativeCompletionDateForGantt(task);
    var due = parseDateOnly(task && task.due_date);
    var now = startOfDay(new Date());
    var resolvedStart = timeline && timeline.start ? startOfDay(timeline.start) : null;
    var baselineEnd = timeline && timeline.baseline_end ? startOfDay(timeline.baseline_end) : null;
    var resolvedEnd = timeline && timeline.end ? startOfDay(timeline.end) : null;
    var progressStart = startedAt || resolvedStart || (isOngoingTaskForGantt(task) ? tentativeStart : null) || created;

    if (!progressStart) {
        return 0;
    }

    progressStart = startOfDay(progressStart);
    if (isOngoingTaskForGantt(task) && tentativeStart && tentativeCompletion) {
        var ongoingStart = startOfDay(tentativeStart);
        var ongoingEnd = startOfDay(tentativeCompletion);
        if (ongoingEnd <= ongoingStart) {
            return now >= ongoingEnd ? 99 : 0;
        }
        if (now <= ongoingStart) {
            return 0;
        }
        if (now >= ongoingEnd) {
            return 99;
        }
        var ongoingElapsed = daysBetween(ongoingStart, now);
        var ongoingTotal = daysBetween(ongoingStart, ongoingEnd);
        var ongoingPercentage = ongoingTotal > 0 ? Math.round((ongoingElapsed / ongoingTotal) * 100) : 0;
        return Math.max(1, Math.min(99, ongoingPercentage));
    }

    var ongoingPlanStart = tentativeStart ? startOfDay(tentativeStart) : progressStart;
    var targetEnd = baselineEnd || (due
        ? startOfDay(due)
        : (tentativeCompletion ? startOfDay(tentativeCompletion) : resolvedEnd));
    if (!targetEnd) {
        return 0;
    }

    if (targetEnd <= progressStart) {
        return now >= targetEnd ? 99 : 0;
    }

    if (now >= targetEnd) {
        return 99;
    }

    var effectiveToday = now < progressStart ? progressStart : now;
    var elapsedDuration = daysBetween(progressStart, effectiveToday);
    var totalDuration = daysBetween(progressStart, targetEnd);
    var percentage = totalDuration > 0 ? Math.round((elapsedDuration / totalDuration) * 100) : 0;
    return Math.max(1, Math.min(99, percentage));
}

function collectTaskDependencyLinks(task, timelines) {
    var links = [];
    if (!task) return links;

    function pushDependency(sourceTaskId, sourceEvent, targetEvent, kind) {
        if (!sourceTaskId || !timelines[String(sourceTaskId)]) return;
        links.push({
            source_id: sourceTaskId,
            source_point: String(sourceEvent || "finish").toLowerCase() === "start" ? "start" : "end",
            target_point: String(targetEvent || "start").toLowerCase() === "finish" ? "end" : "start",
            kind: kind || "dependency"
        });
    }

    pushDependency(task.start_dependency_task_id, task.start_dependency_event, "start", "start");
    pushDependency(task.finish_dependency_task_id, task.finish_dependency_event, "finish", "finish");
    return links;
}

function renderGanttDependencyArrows(root, items) {
    if (!root) return;
    var layer = root.querySelector(".stats-gantt-dependency-layer");
    var body = root.querySelector(".stats-gantt-body");
    if (!layer || !body) return;
    var firstTimeline = body.querySelector(".stats-gantt-timeline");
    var timelineOriginX = firstTimeline ? getElementOffsetWithin(firstTimeline, body).left : 0;
    var dependencyInsetX = 10;

    var taskAnchors = {};
    var rows = body.querySelectorAll(".stats-gantt-row[data-task-id]");
    var rowAnchors = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var taskId = row.getAttribute("data-task-id");
        var bar = row.querySelector(".stats-gantt-bar");
        if (!taskId || !bar) continue;
        var delayBaseline = row.querySelector(".stats-gantt-delay-baseline");
        var delayBadge = row.querySelector(".stats-gantt-delay-badge");
        var rowOffset = getElementOffsetWithin(row, body);
        var barLeft = getElementOffsetWithin(bar, body).left;
        var barTop = getElementOffsetWithin(bar, body).top;
        var occupiedStart = barLeft;
        var occupiedEnd = barLeft + bar.offsetWidth;
        if (delayBaseline) {
            var baselineLeft = getElementOffsetWithin(delayBaseline, body).left;
            occupiedStart = Math.min(occupiedStart, baselineLeft);
            occupiedEnd = Math.max(occupiedEnd, baselineLeft + delayBaseline.offsetWidth);
        }
        if (delayBadge) {
            var badgeLeft = getElementOffsetWithin(delayBadge, body).left;
            occupiedStart = Math.min(occupiedStart, badgeLeft);
            occupiedEnd = Math.max(occupiedEnd, badgeLeft + delayBadge.offsetWidth);
        }
        var rowAnchor = {
            startX: barLeft,
            endX: barLeft + bar.offsetWidth,
            occupiedStartX: occupiedStart,
            occupiedEndX: occupiedEnd,
            y: barTop + (bar.offsetHeight / 2),
            barTop: barTop,
            barBottom: barTop + bar.offsetHeight,
            isMilestone: bar.classList.contains("stats-gantt-bar--milestone")
        };
        rowAnchor.rowIndex = rowAnchors.length;
        rowAnchor.rowTop = rowOffset.top;
        rowAnchor.rowBottom = rowOffset.top + row.offsetHeight;
        rowAnchor.rowHeight = row.offsetHeight;
        rowAnchor.taskId = String(taskId);
        taskAnchors[String(taskId)] = rowAnchor;
        rowAnchors.push(rowAnchor);
    }

    var paths = [];
    var layerMinX = 0;
    var layerMaxX = Math.max(1, (body.scrollWidth || body.clientWidth || root.scrollWidth || root.clientWidth) - timelineOriginX);
    (items || []).forEach(function (item) {
        var targetAnchor = taskAnchors[String(item.id)];
        if (!targetAnchor || !Array.isArray(item.dependency_links)) return;

        item.dependency_links.forEach(function (link) {
            var sourceAnchor = taskAnchors[String(link.source_id)];
            if (!sourceAnchor) return;

            var startX = link.source_point === "start" ? sourceAnchor.startX : sourceAnchor.endX;
            var endX = link.target_point === "end" ? targetAnchor.endX : targetAnchor.startX;
            var startY = getDependencyAnchorY(sourceAnchor, targetAnchor);
            var endY = getDependencyAnchorY(targetAnchor, sourceAnchor);
            var sourceLaneX = getDependencyExitLaneX(sourceAnchor, link.source_point);
            var targetLaneX = getDependencyTargetLaneX(rowAnchors, sourceAnchor, targetAnchor, link.target_point);
            var connectorY = getDependencyConnectorY(rowAnchors, sourceAnchor, targetAnchor);
            var title = escapeHtml((link.kind || "Dependency") + ": " + (item.title || "Task"));
            var localStartX = Math.max(dependencyInsetX, startX - timelineOriginX);
            var localEndX = Math.max(dependencyInsetX, endX - timelineOriginX);
            var localSourceLaneX = Math.max(dependencyInsetX, sourceLaneX - timelineOriginX);
            var localTargetLaneX = Math.max(dependencyInsetX, targetLaneX - timelineOriginX);
            layerMinX = Math.min(layerMinX, localSourceLaneX, localTargetLaneX, localStartX, localEndX);
            layerMaxX = Math.max(layerMaxX, localSourceLaneX, localTargetLaneX, localStartX, localEndX);
            paths.push(
                "<g class=\"stats-gantt-dependency-link\">" +
                "<title>" + title + "</title>" +
                "<path class=\"stats-gantt-dependency-path\" d=\"M " + localStartX + " " + startY +
                " L " + localSourceLaneX + " " + startY +
                " L " + localSourceLaneX + " " + connectorY +
                " L " + localTargetLaneX + " " + connectorY +
                " L " + localTargetLaneX + " " + endY +
                " L " + localEndX + " " + endY + "\" marker-end=\"url(#stats-gantt-arrowhead)\"></path>" +
                "</g>"
            );
        });
    });

    var viewBoxMinX = 0;
    var layerWidth = Math.max(1, layerMaxX + 20);
    var layerHeight = Math.max(1, body.scrollHeight || body.clientHeight);
    layer.style.left = timelineOriginX + "px";
    layer.style.width = Math.max(1, (body.scrollWidth || body.clientWidth || root.scrollWidth || root.clientWidth) - timelineOriginX) + "px";
    layer.setAttribute("viewBox", viewBoxMinX + " 0 " + layerWidth + " " + layerHeight);
    layer.setAttribute("width", String(layerWidth));
    layer.setAttribute("height", String(layerHeight));
    layer.innerHTML = paths.length
        ? "<defs><marker id=\"stats-gantt-arrowhead\" viewBox=\"0 0 10 10\" markerWidth=\"10\" markerHeight=\"10\" refX=\"9\" refY=\"5\" orient=\"auto-start-reverse\" markerUnits=\"userSpaceOnUse\"><path d=\"M 0 0 L 10 5 L 0 10 z\"></path></marker></defs>" + paths.join("")
        : "";
}

function getDependencyAnchorY(anchor, otherAnchor) {
    if (!anchor) return 0;
    if (!anchor.isMilestone) return anchor.y;
    var outerPadding = 8;
    if (otherAnchor && otherAnchor.rowIndex < anchor.rowIndex) {
        return Math.max(outerPadding, anchor.barTop - outerPadding);
    }
    return anchor.barBottom + outerPadding;
}

function getDependencyExitLaneX(anchor, sourcePoint) {
    var lanePadding = 26;
    if (String(sourcePoint || "end").toLowerCase() === "start") {
        return Math.max(8, (anchor.occupiedStartX != null ? anchor.occupiedStartX : anchor.startX) - lanePadding);
    }
    return (anchor.occupiedEndX != null ? anchor.occupiedEndX : anchor.endX) + lanePadding;
}

function getDependencyTargetLaneX(rowAnchors, sourceAnchor, targetAnchor, targetPoint) {
    var isTargetStart = String(targetPoint || "start").toLowerCase() !== "end";
    var crossedRows = getDependencyCrossedRows(rowAnchors, sourceAnchor, targetAnchor);
    var lanePadding = 26;
    var intervalPadding = 12;

    if (isTargetStart) {
        var desiredLeft = Math.max(8, (targetAnchor.occupiedStartX != null ? targetAnchor.occupiedStartX : targetAnchor.startX) - lanePadding);
        return findSafeDependencyLaneX(crossedRows, desiredLeft, "left", intervalPadding);
    }
    return findSafeDependencyLaneX(crossedRows, (targetAnchor.occupiedEndX != null ? targetAnchor.occupiedEndX : targetAnchor.endX) + lanePadding, "right", intervalPadding);
}

function getDependencyCrossedRows(rowAnchors, sourceAnchor, targetAnchor) {
    var startIndex = Math.min(sourceAnchor.rowIndex, targetAnchor.rowIndex);
    var endIndex = Math.max(sourceAnchor.rowIndex, targetAnchor.rowIndex);
    return (rowAnchors || []).slice(startIndex, endIndex + 1);
}

function findSafeDependencyLaneX(rows, desiredX, side, intervalPadding) {
    var laneX = desiredX;
    var padding = Math.max(8, intervalPadding || 10);
    var sortedRows = Array.isArray(rows) ? rows.slice() : [];
    var safety = 0;

    while (safety < 48) {
        var shifted = false;
        for (var i = 0; i < sortedRows.length; i++) {
            var row = sortedRows[i];
            var intervalStart = (row.occupiedStartX != null ? row.occupiedStartX : row.startX) - padding;
            var intervalEnd = (row.occupiedEndX != null ? row.occupiedEndX : row.endX) + padding;
            if (laneX >= intervalStart && laneX <= intervalEnd) {
                laneX = side === "left"
                    ? Math.max(8, intervalStart - padding)
                    : intervalEnd + padding;
                shifted = true;
            }
        }
        if (!shifted) break;
        safety += 1;
    }

    return Math.max(8, laneX);
}

function getDependencyConnectorY(rowAnchors, sourceAnchor, targetAnchor) {
    if (sourceAnchor.rowIndex === targetAnchor.rowIndex) {
        return Math.max(sourceAnchor.rowTop + 6, sourceAnchor.barTop - 6);
    }
    if (sourceAnchor.rowIndex < targetAnchor.rowIndex) {
        var nextRow = rowAnchors[sourceAnchor.rowIndex + 1];
        if (!nextRow) return sourceAnchor.rowBottom + 10;
        return sourceAnchor.rowBottom + Math.max(8, Math.round((nextRow.rowTop - sourceAnchor.rowBottom) / 2));
    }
    var prevRow = rowAnchors[sourceAnchor.rowIndex - 1];
    if (!prevRow) return sourceAnchor.rowTop + 6;
    return prevRow.rowBottom + Math.max(8, Math.round((sourceAnchor.rowTop - prevRow.rowBottom) / 2));
}

function getElementOffsetWithin(element, ancestor) {
    var left = 0;
    var top = 0;
    var current = element;
    while (current && current !== ancestor) {
        left += current.offsetLeft || 0;
        top += current.offsetTop || 0;
        current = current.offsetParent;
    }
    return { left: left, top: top };
}

function getGanttScaleSummaryLabel() {
    if (statsGanttState.scaleMode === "financial-quarter") return "View: Financial quarters";
    var unit = statsGanttState.scaleUnit || "days";
    var value = Math.max(1, parseInt(statsGanttState.scaleValue, 10) || 1);
    var labelUnit = unit.charAt(0).toUpperCase() + unit.slice(1);
    return "View: " + value + " " + labelUnit.replace(/s$/, "") + (value === 1 ? "" : "s");
}

function buildGanttAxisBands(start, totalDays, dayWidth, scaleConfig) {
    var html = "";
    var bandStartIndex = 0;
    var currentKey = getGanttBandKey(start, scaleConfig);
    var lastLabelEnd = -9999;

    for (var dayIndex = 1; dayIndex <= totalDays; dayIndex++) {
        var nextDate = dayIndex < totalDays ? addDays(start, dayIndex) : null;
        var nextKey = nextDate ? getGanttBandKey(nextDate, scaleConfig) : null;
        if (dayIndex === totalDays || nextKey !== currentKey) {
            var x = bandStartIndex * dayWidth;
            var width = (dayIndex - bandStartIndex) * dayWidth;
            var minBandWidth = dayWidth < 1.4 ? 44 : (dayWidth < 3 ? 56 : 72);
            var shouldRender = width >= minBandWidth && x >= lastLabelEnd - 8;
            if (shouldRender) {
                html += "<span class=\"stats-gantt-axis-month\" style=\"left:" + x + "px; width:" + Math.max(width, minBandWidth) + "px;\">" +
                    escapeHtml(getGanttBandLabel(addDays(start, bandStartIndex), scaleConfig)) +
                    "</span>";
                lastLabelEnd = x + Math.max(width, minBandWidth);
            }
            bandStartIndex = dayIndex;
            currentKey = nextKey;
        }
    }
    return html;
}

function getGanttBandKey(date, scaleConfig) {
    if (scaleConfig.mode === "financial-quarter") return getFinancialQuarterKey(date);
    if (scaleConfig.unit === "years") return String(date.getFullYear());
    return String(date.getFullYear()) + "-" + String(date.getMonth());
}

function getGanttBandLabel(date, scaleConfig) {
    if (scaleConfig.mode === "financial-quarter") return getFinancialQuarterLabel(date);
    if (scaleConfig.unit === "years") return "Year " + date.getFullYear();
    return formatGanttMonthLabel(date);
}

function isGanttMajorTick(date, rangeStart, dayIndex, scaleConfig) {
    if (dayIndex === 0) return true;
    if (scaleConfig.mode === "financial-quarter") return isFinancialQuarterStart(date);
    if (scaleConfig.unit === "years") {
        return date.getDate() === 1 && date.getMonth() === 0 && yearsBetween(startOfDay(rangeStart), date) % scaleConfig.value === 0;
    }
    if (scaleConfig.unit === "months") {
        return date.getDate() === 1 && monthsBetween(startOfDay(rangeStart), date) % scaleConfig.value === 0;
    }
    return daysBetween(startOfDay(rangeStart), date) % scaleConfig.value === 0;
}

function isGanttGridMajor(date, rangeStart, dayIndex, scaleConfig) {
    if (scaleConfig.mode === "financial-quarter") return isFinancialQuarterStart(date);
    if (scaleConfig.unit === "years") return (date.getDate() === 1 && date.getMonth() === 0) || isGanttMajorTick(date, rangeStart, dayIndex, scaleConfig);
    if (scaleConfig.unit === "months") return date.getDate() === 1 || isGanttMajorTick(date, rangeStart, dayIndex, scaleConfig);
    return date.getDate() === 1 || isGanttMajorTick(date, rangeStart, dayIndex, scaleConfig);
}

function formatGanttScaleLabel(date, scaleConfig) {
    if (scaleConfig.mode === "financial-quarter") return getFinancialQuarterTickLabel(date);
    if (scaleConfig.unit === "years") return String(date.getFullYear());
    if (scaleConfig.unit === "months") return formatGanttMonthLabel(date);
    return formatGanttMajorLabel(date);
}

function monthsBetween(start, end) {
    var startDate = startOfDay(start);
    var endDate = startOfDay(end);
    return ((endDate.getFullYear() - startDate.getFullYear()) * 12) + (endDate.getMonth() - startDate.getMonth());
}

function yearsBetween(start, end) {
    return startOfDay(end).getFullYear() - startOfDay(start).getFullYear();
}

function isFinancialQuarterStart(date) {
    return date.getDate() === 1 && [0, 3, 6, 9].indexOf(date.getMonth()) !== -1;
}

function getFinancialQuarterKey(date) {
    return getFinancialYearLabel(date) + "-Q" + getFinancialQuarterNumber(date);
}

function getFinancialQuarterNumber(date) {
    var month = date.getMonth();
    if (month >= 3 && month <= 5) return 1;
    if (month >= 6 && month <= 8) return 2;
    if (month >= 9 && month <= 11) return 3;
    return 4;
}

function getFinancialYearLabel(date) {
    var year = date.getFullYear();
    var fyStart = date.getMonth() >= 3 ? year : year - 1;
    var fyEndShort = String((fyStart + 1) % 100).padStart(2, "0");
    return "FY " + fyStart + "-" + fyEndShort;
}

function getFinancialQuarterLabel(date) {
    return "Q" + getFinancialQuarterNumber(date) + " " + getFinancialYearLabel(date);
}

function getFinancialQuarterShortLabel(date) {
    return "Q" + getFinancialQuarterNumber(date);
}

function getFinancialQuarterTickLabel(date) {
    var months = ["Apr", "Jul", "Oct", "Jan"];
    return months[(getFinancialQuarterNumber(date) - 1) % 4] + " " + getFinancialQuarterShortLabel(date);
}

function getFinancialYearStart(date) {
    var year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
    return new Date(year, 3, 1);
}

function getFinancialYearEnd(date) {
    var fyStart = getFinancialYearStart(date);
    return new Date(fyStart.getFullYear() + 1, 2, 31);
}

function getFinancialQuarterStart(date) {
    var quarterNumber = getFinancialQuarterNumber(date);
    var fyStart = getFinancialYearStart(date);
    return addMonthsSafe(fyStart, (quarterNumber - 1) * 3);
}

function addMonthsSafe(date, months) {
    return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function getFinancialQuarterTodayOffset(segments, quarterWidth) {
    if (!segments || !segments.length) return null;
    return getFinancialQuarterPosition(startOfDay(new Date()), segments, quarterWidth);
}

function getFinancialQuarterPosition(date, segments, quarterWidth) {
    if (!segments || !segments.length) return 0;
    var normalized = startOfDay(date);
    if (normalized < segments[0].start) return null;
    var lastSegment = segments[segments.length - 1];
    if (normalized > lastSegment.end) return null;

    for (var i = 0; i < segments.length; i++) {
        var segment = segments[i];
        if (normalized < segment.start || normalized > segment.end) continue;
        var totalDays = Math.max(1, daysBetweenInclusive(segment.start, segment.end));
        var elapsedDays = Math.max(0, daysBetween(segment.start, normalized));
        return (segment.index * quarterWidth) + ((elapsedDays / totalDays) * quarterWidth);
    }
    return null;
}

function parseDateTimeValue(value) {
    if (!value) return null;
    var date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date;
}

function startOfDay(date) {
    var d = new Date(date.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, days) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
}

function daysBetween(start, end) {
    var dayMs = 24 * 60 * 60 * 1000;
    return Math.floor((startOfDay(end).getTime() - startOfDay(start).getTime()) / dayMs);
}

function daysBetweenInclusive(start, end) {
    return daysBetween(start, end) + 1;
}

function formatShortDate(date) {
    var d = startOfDay(date);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return (m < 10 ? "0" + m : String(m)) + "/" + (day < 10 ? "0" + day : String(day));
}

function formatGanttMajorLabel(date) {
    var day = date.getDate();
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return day + " " + months[date.getMonth()];
}

function formatGanttMonthLabel(date) {
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[date.getMonth()] + " " + date.getFullYear();
}

function renderMemberHierarchyMatrix(rows, totals) {
    var body = document.getElementById("stats-member-hierarchy-body");
    var emptyEl = document.getElementById("stats-member-hierarchy-empty");
    if (!body) return;

    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
        body.innerHTML = "";
        if (emptyEl) emptyEl.hidden = false;
        return;
    }
    if (emptyEl) emptyEl.hidden = true;

    var rowHtml = list.map(function (r) {
        return (
            "<tr>" +
            "<td>" + renderUserLabelHtml(r.member_name || "-", r.designation || "") + "</td>" +
            "<td>" + escapeHtml(r.team_name || "-") + "</td>" +
            "<td>" + escapeHtml(r.activity_name || "-") + "</td>" +
            "<td>" + escapeHtml(r.group_name || "-") + "</td>" +
            "<td>" + escapeHtml(r.division_name || "-") + "</td>" +
            "</tr>"
        );
    }).join("");

    rowHtml += (
        "<tr>" +
        "<td><strong>Total: " + escapeHtml(String((totals && totals.members) || 0)) + "</strong></td>" +
        "<td><strong>Total: " + escapeHtml(String((totals && totals.teams) || 0)) + "</strong></td>" +
        "<td><strong>Total: " + escapeHtml(String((totals && totals.activities) || 0)) + "</strong></td>" +
        "<td><strong>Total: " + escapeHtml(String((totals && totals.groups) || 0)) + "</strong></td>" +
        "<td><strong>Total: " + escapeHtml(String((totals && totals.divisions) || 0)) + "</strong></td>" +
        "</tr>"
    );

    body.innerHTML = rowHtml;
}

function flattenTasks(tasks) {
    var flat = [];
    (tasks || []).forEach(function (task) {
        if (!task) return;
        flat.push(task);
        if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            flat = flat.concat(flattenTasks(task.subtasks));
        }
    });
    return flat;
}

function flattenTasksForGantt(tasks, level) {
    var flat = [];
    (tasks || []).forEach(function (task) {
        if (!task) return;
        task._gantt_level = Math.max(1, parseInt(level, 10) || 1);
        flat.push(task);
        if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            flat = flat.concat(flattenTasksForGantt(task.subtasks, task._gantt_level + 1));
        }
    });
    return flat;
}

function buildTaskMetrics(tasks) {
    var flat = flattenTasks(tasks);
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 6);

    var metrics = {
        workItems: flat.length,
        mainTasks: 0,
        subtasks: 0,
        completed: 0,
        inProgress: 0,
        pending: 0,
        toDo: 0,
        overdueOpen: 0,
        dueToday: 0,
        dueThisWeek: 0,
        upcomingLater: 0,
        noDueDate: 0,
        highPriority: 0,
        mediumPriority: 0,
        lowPriority: 0,
        statusBreakdown: {
            todo: 0,
            progress: 0,
            pending: 0,
            completed: 0
        },
        flatTasks: flat
    };

    flat.forEach(function (task) {
        var isSubtask = !!task.parent_task_id;
        var status = String(task.status || "").toLowerCase();
        var priority = String(task.priority || "medium").toLowerCase();
        var dueDate = parseDateOnly(task.due_date);
        var isCompleted = status.indexOf("complete") !== -1 && status.indexOf("pending") === -1;

        if (isSubtask) metrics.subtasks += 1;
        else metrics.mainTasks += 1;

        if (status === "in progress") {
            metrics.inProgress += 1;
            metrics.statusBreakdown.progress += 1;
        } else if (status === "pending completion") {
            metrics.pending += 1;
            metrics.statusBreakdown.pending += 1;
        } else if (isCompleted) {
            metrics.completed += 1;
            metrics.statusBreakdown.completed += 1;
        } else {
            metrics.toDo += 1;
            metrics.statusBreakdown.todo += 1;
        }

        if (priority === "high" || priority === "urgent") metrics.highPriority += 1;
        else if (priority === "low") metrics.lowPriority += 1;
        else metrics.mediumPriority += 1;

        if (!dueDate) {
            metrics.noDueDate += 1;
        } else {
            if (sameDate(dueDate, today)) metrics.dueToday += 1;
            if (dueDate >= today && dueDate <= weekEnd) metrics.dueThisWeek += 1;
            if (dueDate > weekEnd) metrics.upcomingLater += 1;
            if (dueDate < today && !isCompleted) metrics.overdueOpen += 1;
        }
    });

    metrics.completionRate = metrics.workItems ? Math.round((metrics.completed / metrics.workItems) * 100) : 0;
    return metrics;
}

function parseDateOnly(value) {
    if (!value) return null;
    var parts = String(value).slice(0, 10).split("-");
    if (parts.length !== 3) return null;
    var date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    date.setHours(0, 0, 0, 0);
    return isNaN(date.getTime()) ? null : date;
}

function sameDate(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function renderHero(metrics) {
    var completionEl = document.getElementById("stats-hero-completion");
    var metaEl = document.getElementById("stats-hero-meta");
    if (completionEl) completionEl.textContent = metrics.completionRate + "%";
    if (metaEl) metaEl.textContent = metrics.completed + " completed out of " + metrics.workItems + " work items";
}

function renderMetricSections(orgStats, metrics) {
    renderMetricCards("stats-primary-grid", [
        {
            eyebrow: "Work items",
            value: metrics.workItems,
            foot: metrics.mainTasks + " main tasks and " + metrics.subtasks + " subtasks"
        },
        {
            eyebrow: "Completed",
            value: metrics.completed,
            foot: metrics.completionRate + "% completion across all work items"
        },
        {
            eyebrow: "Overdue open",
            value: metrics.overdueOpen,
            foot: "Items past due date and still unfinished"
        },
        {
            eyebrow: "Due this week",
            value: metrics.dueThisWeek,
            foot: metrics.dueToday + " of these are due today"
        }
    ]);

    renderMetricCards("stats-secondary-grid", [
        {
            eyebrow: "In progress",
            value: metrics.inProgress,
            foot: metrics.pending + " waiting for completion review"
        },
        {
            eyebrow: "No due date",
            value: metrics.noDueDate,
            foot: "These need clearer scheduling"
        },
        {
            eyebrow: "High priority",
            value: metrics.highPriority,
            foot: metrics.mediumPriority + " medium and " + metrics.lowPriority + " low priority items"
        },
        {
            eyebrow: "Extension requests",
            value: orgStats.tasks_extension_request || 0,
            foot: "Pending timeline change requests"
        },
        {
            eyebrow: "Teams visible",
            value: orgStats.total_teams || 0,
            foot: (orgStats.total_activities || 0) + " activities across your workspace"
        },
        {
            eyebrow: "Members involved",
            value: orgStats.total_members || 0,
            foot: "People connected to your visible teams"
        }
    ]);
}

function renderMetricCards(containerId, cards) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = cards.map(function (card) {
        return (
            "<article class=\"stats-metric-card\">" +
            "<p class=\"stats-metric-eyebrow\">" + escapeHtml(card.eyebrow) + "</p>" +
            "<div class=\"stats-metric-value\">" + escapeHtml(String(card.value)) + "</div>" +
            "<p class=\"stats-metric-foot\">" + escapeHtml(card.foot) + "</p>" +
            "</article>"
        );
    }).join("");
}

function renderInsights(orgStats, metrics) {
    var container = document.getElementById("stats-insights-grid");
    if (!container) return;

    var insights = [
        {
            title: "Subtask depth",
            body: metrics.subtasks > metrics.mainTasks
                ? "Your workspace has more subtasks than parent tasks, which usually means members are actively breaking large work into manageable steps."
                : "Main tasks still outnumber subtasks, so there is room for teams to split larger assignments into smaller execution units."
        },
        {
            title: "Schedule health",
            body: metrics.overdueOpen > 0
                ? metrics.overdueOpen + " open work items are overdue. These should be reviewed first in standups or follow-up checks."
                : "No open overdue work items right now, which is a healthy signal for delivery discipline."
        },
        {
            title: "Workload pressure",
            body: (metrics.highPriority + metrics.dueToday) > 0
                ? (metrics.highPriority + metrics.dueToday) + " items are either high priority or due today, so this is the most immediate workload cluster."
                : "There is no urgent cluster right now. Most work is distributed into medium and longer-horizon items."
        },
        {
            title: "Workspace coverage",
            body: (orgStats.total_teams || 0) + " teams, " + (orgStats.total_activities || 0) + " activities, and " + (orgStats.total_members || 0) + " member assignments are reflected in these numbers."
        }
    ];

    container.innerHTML = insights.map(function (item) {
        return (
            "<article class=\"stats-insight-card\">" +
            "<h3 class=\"stats-insight-title\">" + escapeHtml(item.title) + "</h3>" +
            "<p class=\"stats-insight-body\">" + escapeHtml(item.body) + "</p>" +
            "</article>"
        );
    }).join("");
}

function renderCharts(orgStats, metrics) {
    if (typeof Chart === "undefined") return;
    var statusCanvas = document.getElementById("stats-chart-status");
    var timelineCanvas = document.getElementById("stats-chart-timeline");
    var breakdownCanvas = document.getElementById("stats-chart-breakdown");
    var priorityCanvas = document.getElementById("stats-chart-priority");
    if (!statusCanvas || !timelineCanvas || !breakdownCanvas || !priorityCanvas) return;

    var colors = {
        blue: "#2563eb",
        blueSoft: "#dbeafe",
        green: "#059669",
        greenSoft: "#d1fae5",
        amber: "#d97706",
        amberSoft: "#fef3c7",
        red: "#dc2626",
        redSoft: "#fee2e2",
        slate: "#64748b",
        slateSoft: "#e2e8f0",
        teal: "#0f766e",
        tealSoft: "#ccfbf1"
    };

    destroyChart(statsStatusChart);
    destroyChart(statsTimelineChart);
    destroyChart(statsBreakdownChart);
    destroyChart(statsPriorityChart);

    var fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    statsStatusChart = new Chart(statusCanvas, {
        type: "doughnut",
        data: {
            labels: ["To do", "In progress", "Pending completion", "Completed"],
            datasets: [{
                data: [
                    metrics.statusBreakdown.todo,
                    metrics.statusBreakdown.progress,
                    metrics.statusBreakdown.pending,
                    metrics.statusBreakdown.completed
                ],
                backgroundColor: [colors.slate, colors.blue, colors.amber, colors.green],
                borderWidth: 0
            }]
        },
        options: getChartOptions(fontFamily, true)
    });

    statsTimelineChart = new Chart(timelineCanvas, {
        type: "bar",
        data: {
            labels: ["Overdue", "Due today", "Due this week", "Later", "No due date", "Extensions"],
            datasets: [{
                data: [
                    metrics.overdueOpen,
                    metrics.dueToday,
                    metrics.dueThisWeek,
                    metrics.upcomingLater,
                    metrics.noDueDate,
                    orgStats.tasks_extension_request || 0
                ],
                backgroundColor: [colors.red, colors.amber, colors.blue, colors.teal, colors.slate, colors.green],
                borderRadius: 10,
                borderSkipped: false
            }]
        },
        options: getChartOptions(fontFamily, false)
    });

    statsBreakdownChart = new Chart(breakdownCanvas, {
        type: "doughnut",
        data: {
            labels: ["Main tasks", "Subtasks"],
            datasets: [{
                data: [metrics.mainTasks, metrics.subtasks],
                backgroundColor: [colors.blue, colors.teal],
                borderWidth: 0
            }]
        },
        options: getChartOptions(fontFamily, true)
    });

    statsPriorityChart = new Chart(priorityCanvas, {
        type: "bar",
        data: {
            labels: ["High", "Medium", "Low"],
            datasets: [{
                label: "Priority count",
                data: [metrics.highPriority, metrics.mediumPriority, metrics.lowPriority],
                backgroundColor: [colors.red, colors.blue, colors.green],
                borderRadius: 10,
                borderSkipped: false
            }]
        },
        options: getChartOptions(fontFamily, false)
    });
}

function getChartOptions(fontFamily, isPie) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                position: isPie ? "bottom" : "top",
                labels: {
                    font: { family: fontFamily, size: 11 },
                    boxWidth: 12,
                    padding: 14
                }
            },
            tooltip: {
                backgroundColor: "#0f172a",
                padding: 10,
                titleFont: { family: fontFamily, size: 12, weight: "600" },
                bodyFont: { family: fontFamily, size: 12 }
            }
        },
        scales: isPie ? {} : {
            y: {
                beginAtZero: true,
                grid: { color: "#e2e8f0" },
                ticks: { font: { family: fontFamily, size: 11 } }
            },
            x: {
                grid: { display: false },
                ticks: { font: { family: fontFamily, size: 11 } }
            }
        }
    };
}

function destroyChart(chart) {
    if (chart && typeof chart.destroy === "function") chart.destroy();
}

function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
