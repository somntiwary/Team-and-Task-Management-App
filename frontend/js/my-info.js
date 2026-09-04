var myInfoState = {
    currentScope: "divisions",
    memberships: {
        divisions: [],
        groups: [],
        activities: [],
        teams: []
    },
    teamContextById: {},
    teamMembersByTeamId: {},
    expandedTeamIds: [],
    teamMembersLoaded: false,
    teamMembersLoading: false
};
var myInfoEffectiveRole = null;

var isSidebarCollapsed = loadSidebarCollapsed();

function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

function showToast(message, isError) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message || "";
    toast.className = "toast " + (isError ? "error" : "success");
    toast.hidden = false;
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(function () {
        toast.hidden = true;
    }, 2600);
}

function formatRole(role) {
    var value = String(role || "member").replace(/[_-]+/g, " ").trim();
    if (!value) return "Member";
    return value.replace(/\b\w/g, function (char) { return char.toUpperCase(); });
}

function formatUserIdDisplay(value) {
    var numeric = parseInt(value, 10);
    if (!numeric || numeric < 0) return String(value || "");
    if (numeric <= 999) return String(numeric).padStart(3, "0");
    return String(numeric);
}

function setUserNameBlock(element, username, designation) {
    if (!element) return;
    if (!designation) {
        element.textContent = username || "User";
        return;
    }
    element.innerHTML = "<span class=\"person-name-block\"><span class=\"person-name-primary\">" + escapeHtml(username || "User") + "</span><span class=\"person-name-secondary\">" + escapeHtml(designation) + "</span></span>";
}

function formatDesignation(designation) {
    return String(designation || "").trim();
}

function getDisplayDesignation(role, designation) {
    var normalizedRole = String(role || "").toLowerCase();
    if (normalizedRole === "admin") return "Administrator";
    if (normalizedRole === "division head") return "Division Head";
    if (normalizedRole === "group head") return "Group Head";
    if (normalizedRole === "project director") return "Project Director";
    if (normalizedRole === "team lead") return "Team Lead";
    return formatDesignation(designation);
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
    if (layout) layout.classList.toggle("dashboard-layout--sidebar-collapsed", !!isSidebarCollapsed);
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

function canAccessAnalyticsPages(roleValue) {
    var role = String(roleValue || myInfoEffectiveRole || localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head" || role === "group head" || role === "project director" || role === "team lead";
}

function updateSidebarPageAccess(roleValue) {
    var role = String(roleValue || myInfoEffectiveRole || localStorage.getItem("role") || "member").toLowerCase();
    var showWorkspace = role !== "member";
    var showAnalytics = canAccessAnalyticsPages(role);
    var workspaceItems = document.querySelectorAll(".sidebar-item--workspace");
    var statsItems = document.querySelectorAll(".sidebar-item--stats");
    var ganttItems = document.querySelectorAll(".sidebar-item--gantt");
    var i;

    for (i = 0; i < workspaceItems.length; i++) {
        workspaceItems[i].style.display = showWorkspace ? "" : "none";
    }
    for (i = 0; i < statsItems.length; i++) {
        statsItems[i].style.display = showAnalytics ? "" : "none";
    }
    for (i = 0; i < ganttItems.length; i++) {
        ganttItems[i].style.display = showAnalytics ? "" : "none";
    }
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

var DESIGNATION_SENIORITY_ORDER = {
    "Scientist H": 0,
    "Scientist G": 1,
    "Scientist F": 2,
    "Scientist E": 3,
    "Scientist D": 4,
    "Scientist C": 5,
    "Scientist B": 6,
    "Scientist A": 7,
    "Research Associate": 8,
    "Senior Research Fellow": 9,
    "Junior Research Fellow": 10
};

function getDesignationSeniority(designation) {
    var key = String(designation || "").trim();
    return Object.prototype.hasOwnProperty.call(DESIGNATION_SENIORITY_ORDER, key)
        ? DESIGNATION_SENIORITY_ORDER[key]
        : 999;
}

function sortUsersByDesignationSeniority(users) {
    return (Array.isArray(users) ? users.slice() : []).sort(function (a, b) {
        var byDesignation = getDesignationSeniority(a && a.designation) - getDesignationSeniority(b && b.designation);
        if (byDesignation !== 0) return byDesignation;
        var byName = String(a && a.username || "").localeCompare(String(b && b.username || ""), undefined, { sensitivity: "base" });
        if (byName !== 0) return byName;
        return (parseInt(a && a.id, 10) || 0) - (parseInt(b && b.id, 10) || 0);
    });
}

function formatUserInline(username, designation, fallback) {
    var parts = [username || fallback || "User"];
    if (designation) parts.push(designation);
    return parts.join(" | ");
}

function formatActivityProjectName(name, type) {
    var cleanName = String(name || "Unnamed activity").trim();
    var cleanType = String(type || "").trim();
    return cleanType ? cleanName + " (" + cleanType + ")" : cleanName;
}

function getTeamRoleLabel(team) {
    return team && team.user_role ? String(team.user_role) : "Member";
}

function deriveMemberships(navTree, teams) {
    var memberships = {
        divisions: [],
        groups: [],
        activities: [],
        teams: []
    };
    var teamMap = {};
    var divisionSeen = {};
    var groupSeen = {};
    var activitySeen = {};
    var currentUserId = parseInt(getUserId(), 10);
    var globalRole = (localStorage.getItem("role") || "member").toLowerCase();
    var isGlobalAdmin = globalRole === "admin" || globalRole === "division head";

    (Array.isArray(teams) ? teams : []).forEach(function (team) {
        if (!team || typeof team.id === "undefined") return;
        teamMap[String(team.id)] = true;
        memberships.teams.push({
            id: parseInt(team.id, 10),
            name: team.name || "Unnamed team",
            meta: getTeamRoleLabel(team)
        });
    });

    (Array.isArray(navTree) ? navTree : []).forEach(function (division) {
        if (!division) return;
        var includeDivision = isGlobalAdmin || parseInt(division.head_user_id, 10) === currentUserId;
        var groups = Array.isArray(division.groups) ? division.groups : [];

        groups.forEach(function (group) {
            if (!group) return;
            var includeGroup = isGlobalAdmin || parseInt(group.head_user_id, 10) === currentUserId;
            if (includeGroup) includeDivision = true;
            var activities = Array.isArray(group.activities) ? group.activities : [];

            activities.forEach(function (activity) {
                if (!activity) return;
                var includeActivity = false;
                var teamsForActivity = Array.isArray(activity.teams) ? activity.teams : [];

                teamsForActivity.forEach(function (teamNode) {
                    if (teamNode && teamMap[String(teamNode.id)]) {
                        includeActivity = true;
                        includeGroup = true;
                        includeDivision = true;
                    }
                });

                if (includeActivity && !activitySeen[String(activity.id)]) {
                    activitySeen[String(activity.id)] = true;
                    memberships.activities.push({
                        id: parseInt(activity.id, 10),
                        name: String(activity.name || "Unnamed activity").trim(),
                        meta: ""
                    });
                }
            });

            if (includeGroup && !groupSeen[String(group.id)]) {
                groupSeen[String(group.id)] = true;
                memberships.groups.push({
                    id: parseInt(group.id, 10),
                    name: group.name || "Unnamed group",
                    meta: division.name || ""
                });
            }
        });

        if (includeDivision && !divisionSeen[String(division.id)]) {
            divisionSeen[String(division.id)] = true;
            memberships.divisions.push({
                id: parseInt(division.id, 10),
                name: division.name || "Unnamed division",
                meta: division.head_name || ""
            });
        }
    });

    ["divisions", "groups", "activities", "teams"].forEach(function (key) {
        memberships[key].sort(function (a, b) {
            return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
        });
    });

    return memberships;
}

function buildTeamContextMap(navTree) {
    var map = {};
    (Array.isArray(navTree) ? navTree : []).forEach(function (division) {
        (Array.isArray(division && division.groups) ? division.groups : []).forEach(function (group) {
            (Array.isArray(group && group.activities) ? group.activities : []).forEach(function (activity) {
                (Array.isArray(activity && activity.teams) ? activity.teams : []).forEach(function (team) {
                    if (!team || typeof team.id === "undefined") return;
                    map[String(team.id)] = {
                        division_name: division.name || "Unnamed division",
                        group_name: group.name || "Unnamed group",
                        activity_name: activity.name || "Unnamed activity",
                        activity_type: activity.type || ""
                    };
                });
            });
        });
    });
    return map;
}

function getScopeTitle(scope) {
    if (scope === "groups") return "My Groups";
    if (scope === "activities") return "My Activities";
    if (scope === "teams") return "My Teams";
    return "My Divisions";
}

function getScopeDescription(scope) {
    if (scope === "groups") return "Groups you can directly review in your workspace structure.";
    if (scope === "activities") return "Activities and projects connected to your current memberships.";
    if (scope === "teams") return "Every team you belong to, with a cross-team member comparison matrix.";
    return "Divisions that currently include your membership footprint.";
}

function updateIdentityCopy() {
    var username = localStorage.getItem("username") || "User";
    var role = myInfoEffectiveRole || localStorage.getItem("role") || "member";
    var designation = getDisplayDesignation(role, localStorage.getItem("designation") || "");
    var heroUsername = document.getElementById("hero-username");
    var heroDesc = document.getElementById("my-info-hero-desc");
    if (heroUsername) setUserNameBlock(heroUsername, username, designation);
    if (heroDesc) {
        heroDesc.textContent = "A single place to review your divisions, groups, activities, and compare everyone across every team you belong to.";
    }
    updateSidebarPageAccess(role);
}

function updateCounts() {
    var memberships = myInfoState.memberships;
    var uniqueMembers = getUniqueMemberCount();
    var counts = {
        divisions: memberships.divisions.length,
        groups: memberships.groups.length,
        activities: memberships.activities.length,
        teams: memberships.teams.length,
        members: uniqueMembers
    };
    var ids = ["divisions", "groups", "activities", "teams"];
    ids.forEach(function (key) {
        var heroStat = document.getElementById("stat-" + key);
        var scopeStat = document.getElementById("info-count-" + key);
        if (heroStat) heroStat.textContent = String(counts[key]);
        if (scopeStat) scopeStat.textContent = String(counts[key]);
    });
    var membersEl = document.getElementById("stat-members");
    if (membersEl) membersEl.textContent = String(counts.members);
}

function getUniqueMemberCount() {
    var memberMap = {};
    Object.keys(myInfoState.teamMembersByTeamId).forEach(function (teamId) {
        (myInfoState.teamMembersByTeamId[teamId] || []).forEach(function (member) {
            if (member && typeof member.id !== "undefined") {
                memberMap[String(member.id)] = true;
            }
        });
    });
    return Object.keys(memberMap).length;
}

function bindScopeControls() {
    var buttons = document.querySelectorAll("[data-info-scope]");
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i]._bound) continue;
        buttons[i]._bound = true;
        buttons[i].addEventListener("click", function () {
            setInfoScope(this.getAttribute("data-info-scope"));
        });
    }
}

function setInfoScope(scope) {
    myInfoState.currentScope = scope || "divisions";
    if (myInfoState.currentScope !== "teams") {
        myInfoState.expandedTeamIds = [];
    }
    var buttons = document.querySelectorAll("[data-info-scope]");
    for (var i = 0; i < buttons.length; i++) {
        var isActive = buttons[i].getAttribute("data-info-scope") === myInfoState.currentScope;
        buttons[i].classList.toggle("is-active", isActive);
    }
    renderScopeSummary();
    renderMembershipList();
    if (myInfoState.currentScope === "teams") ensureTeamMembersLoaded();
}

function renderScopeSummary() {
    var titleEl = document.getElementById("info-membership-title");
    var descEl = document.getElementById("info-membership-desc");
    if (titleEl) titleEl.textContent = getScopeTitle(myInfoState.currentScope);
    if (descEl) descEl.textContent = getScopeDescription(myInfoState.currentScope);
}

function renderMembershipList() {
    var listEl = document.getElementById("info-membership-list");
    if (!listEl) return;

    if (myInfoState.currentScope === "teams") {
        renderTeamsComparison(listEl);
        return;
    }

    var items = myInfoState.memberships[myInfoState.currentScope] || [];
    if (!items.length) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">No memberships found for this section.</p>";
        return;
    }

    listEl.innerHTML = "<div class=\"my-info-membership-grid\">" + items.map(function (item) {
        return "<article class=\"my-info-membership-card\"><p class=\"my-info-membership-name\">" + escapeHtml(item.name || "Unnamed item") + "</p>" + (item.meta ? "<p class=\"my-info-membership-meta\">" + escapeHtml(item.meta) + "</p>" : "") + "</article>";
    }).join("") + "</div>";
}

function ensureTeamMembersLoaded() {
    if (myInfoState.teamMembersLoaded || myInfoState.teamMembersLoading) return;
    myInfoState.teamMembersLoading = true;
    renderMembershipList();

    var teams = myInfoState.memberships.teams || [];
    Promise.all(teams.map(function (team) {
        return apiRequest("/teams/" + team.id + "/members", "GET")
            .then(function (members) {
                myInfoState.teamMembersByTeamId[String(team.id)] = sortUsersByDesignationSeniority(members || []);
            })
            .catch(function () {
                myInfoState.teamMembersByTeamId[String(team.id)] = [];
            });
    }))
        .then(function () {
            myInfoState.teamMembersLoaded = true;
            updateCounts();
            renderScopeSummary();
            renderMembershipList();
        })
        .finally(function () {
            myInfoState.teamMembersLoading = false;
        });
}

function buildComparisonRows() {
    var rowMap = {};
    (myInfoState.memberships.teams || []).forEach(function (team) {
        var teamId = String(team.id);
        (myInfoState.teamMembersByTeamId[teamId] || []).forEach(function (member) {
            var key = String(member.id);
            if (!rowMap[key]) {
                rowMap[key] = {
                    id: member.id,
                    username: member.username || ("User " + member.id),
                    designation: member.designation || "",
                    memberships: {}
                };
            }
            rowMap[key].memberships[teamId] = member.role || "Member";
        });
    });

    return sortUsersByDesignationSeniority(Object.keys(rowMap).map(function (key) {
        var row = rowMap[key];
        row.team_count = Object.keys(row.memberships).length;
        return row;
    }));
}

function isTeamExpanded(teamId) {
    return myInfoState.expandedTeamIds.indexOf(parseInt(teamId, 10)) !== -1;
}

function toggleTeamExpansion(teamId) {
    var numericId = parseInt(teamId, 10);
    if (!numericId) return;
    var existingIndex = myInfoState.expandedTeamIds.indexOf(numericId);
    if (existingIndex === -1) {
        myInfoState.expandedTeamIds.push(numericId);
    } else {
        myInfoState.expandedTeamIds.splice(existingIndex, 1);
    }
    renderMembershipList();
}

function renderTeamMemberList(team) {
    var members = myInfoState.teamMembersByTeamId[String(team.id)] || [];
    if (!members.length) {
        return "<p class=\"empty-state empty-state--inline\">No members found in this team.</p>";
    }

    return "<div class=\"my-info-team-members-list\">" + members.map(function (member) {
        var designation = formatDesignation(member.designation || "");
        var role = member.role || "Member";
        return "<article class=\"my-info-team-member-card\">" +
            "<div class=\"my-info-team-member-main\">" +
            "<p class=\"my-info-team-member-name\">" + escapeHtml(member.username || ("User " + member.id)) + "</p>" +
            (designation ? "<p class=\"my-info-team-member-designation\">" + escapeHtml(designation) + "</p>" : "") +
            "</div>" +
            "<span class=\"my-info-role-pill\">" + escapeHtml(role) + "</span>" +
            "</article>";
    }).join("") + "</div>";
}

function renderTeamsComparison(listEl) {
    if (myInfoState.teamMembersLoading) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">Loading your teams...</p>";
        return;
    }

    var teams = myInfoState.memberships.teams || [];
    if (!teams.length) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">You are not part of any teams yet.</p>";
        return;
    }

    var expandedCount = myInfoState.expandedTeamIds.length;
    var teamCardsHtml = teams.map(function (team) {
        var context = myInfoState.teamContextById[String(team.id)] || {};
        var members = myInfoState.teamMembersByTeamId[String(team.id)] || [];
        var expanded = isTeamExpanded(team.id);
        return "<article class=\"my-info-team-card" + (expanded ? " my-info-team-card--expanded" : "") + "\">" +
            "<button type=\"button\" class=\"my-info-team-card-toggle\" aria-expanded=\"" + (expanded ? "true" : "false") + "\" onclick=\"toggleTeamExpansion(" + parseInt(team.id, 10) + ")\">" +
            "<div class=\"my-info-team-card-head\"><div><p class=\"my-info-team-card-title\">" + escapeHtml(team.name) + "</p><p class=\"my-info-team-card-role\">Your role: " + escapeHtml(team.meta || "Member") + "</p></div><div class=\"my-info-team-card-side\"><span class=\"my-info-team-card-count\">" + escapeHtml(members.length) + " members</span><span class=\"my-info-team-card-arrow\" aria-hidden=\"true\"></span></div></div>" +
            "<div class=\"my-info-team-card-context\"><p class=\"my-info-team-card-meta\">Division: " + escapeHtml(context.division_name || "-") + "</p><p class=\"my-info-team-card-meta\">Group: " + escapeHtml(context.group_name || "-") + "</p><p class=\"my-info-team-card-meta\">Activity: " + escapeHtml(formatActivityProjectName(context.activity_name || "-", context.activity_type || "")) + "</p></div>" +
            "</button>" +
            (expanded ? "<div class=\"my-info-team-card-body\"><div class=\"my-info-team-card-body-head\"><p class=\"my-info-team-card-body-title\">Members in " + escapeHtml(team.name) + "</p><p class=\"my-info-team-card-body-copy\">Open multiple teams together to compare who belongs where.</p></div>" + renderTeamMemberList(team) + "</div>" : "") +
            "</article>";
    }).join("");

    listEl.innerHTML = "<div class=\"my-info-teams-layout\">" +
        "<div class=\"my-info-compare-panel\">" +
        "<div class=\"my-info-compare-panel-head\"><div><p class=\"my-info-compare-eyebrow\">Team comparison</p><h3 class=\"my-info-compare-title\">Expand one or more teams to compare members</h3></div><p class=\"my-info-compare-copy\">" + escapeHtml(expandedCount > 0 ? (expandedCount + " team" + (expandedCount === 1 ? "" : "s") + " currently open for comparison.") : "Choose any team below. You can keep multiple teams expanded at the same time.") + "</p></div>" +
        "</div>" +
        "<div class=\"my-info-team-card-grid my-info-team-card-grid--compare\">" + teamCardsHtml + "</div>" +
        "</div>";
}

function loadMyInfoPage() {
    Promise.all([
        apiRequest("/users/" + getUserId() + "/teams", "GET"),
        apiRequest("/nav/tree", "GET").catch(function () { return []; })
    ])
        .then(function (results) {
            var teams = Array.isArray(results[0]) ? results[0] : [];
            var navTree = Array.isArray(results[1]) ? results[1] : [];
            myInfoEffectiveRole = deriveEffectiveRoleFromTeams(teams);

            myInfoState.memberships = deriveMemberships(navTree, teams);
            myInfoState.teamContextById = buildTeamContextMap(navTree);

            updateIdentityCopy();
            updateCounts();
            renderScopeSummary();
            renderMembershipList();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to load your info", true);
            var listEl = document.getElementById("info-membership-list");
            if (listEl) listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">Could not load your memberships right now.</p>";
        });
}

document.addEventListener("user-profile-updated", function () {
    updateIdentityCopy();
});

(function initMyInfoPage() {
    if (!isLoggedIn()) {
        window.location.href = "index.html";
        return;
    }
    bindScopeControls();
    applySidebarCollapsedState();
    updateIdentityCopy();
    if (typeof initializeTopbarControls === "function") initializeTopbarControls();
    if (typeof syncTopbarUserProfile === "function") syncTopbarUserProfile().finally(loadMyInfoPage);
    else loadMyInfoPage();
})();
