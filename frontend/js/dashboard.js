/**
 * Dashboard — all backend features: teams, add member, tasks, comments, activity.
 */

var currentTeamIdForView = null; // null = all teams
var currentActivityIdForView = null; // null = all activities within selected team (or all teams)
var currentDivisionIdForView = null;
var currentGroupIdForView = null;
var isSidebarCollapsed = loadSidebarCollapsed();
var _sidebarTeamActivitiesCache = {}; // teamId -> activities array
var sidebarOpenTeamId = null; // which team's activity dropdown is open
// New sidebar hierarchy cache: Division -> Group -> Activity -> Team
var _sidebarNavTreeCache = null;
var sidebarOpenDivisionId = null;
var sidebarOpenGroupId = null;
var sidebarOpenActivityId = null;
var taskCreateHierarchy = {
    divisions: [],
    groupsByDivision: {},
    activitiesByGroup: {},
    teamsByActivity: {},
    teamMetaById: {}
};
var addMemberManageableTeamIds = {};
var removeMemberLoadedMembers = [];
var manageUsersDivisionOptions = [];
var manageUsersGroupOptions = [];
var hierarchyEditOptions = {
    divisions: [],
    groups: [],
    activities: [],
    teams: []
};
var chatPanelOpen = false;
var chatMessagesCache = {}; // activityId -> messages array
var userTeamOptionsForHistory = []; // { id, name }[] for History modal team dropdown
var ACTIVITY_TYPE_OPTIONS = ["Buildup", "Infrastructure Activity", "Project", "Feasibility Study", "Others"];
var TASK_TYPE_OPTIONS = ["Infrastructure Development", "Research and Development", "Fabrication", "Simulation", "Measurement", "Analysis", "Design", "Support Services", "Maintenance", "Visit & Exhibition", "Professional Upgradation", "Committees/Meetings/Lectures/Presentations", "Document/Report Preparation", "Procurement", "Others"];
// Effective role for header & multi-assign: global role (Admin/Division Head) OR team role (Project Director/Group Head/Team Lead)
var effectiveDisplayRole = null;
// Tasks view: 'table' | 'calendar'
var tasksViewMode = "table";
var currentTaskHierarchyLevel = "L1";
var daysLeftDisplayMode = loadDaysLeftDisplayMode();
var lastLoadedTasks = [];
var lastFetchedTaskRows = [];
var dependencyTaskOptions = [];
var openSubtaskParents = loadOpenSubtaskParents();
var historyTaskTree = [];
var groupedScopeResolveRetries = 0;
var taskSearchQuery = "";
var milestoneSearchQuery = "";
var duplicateNameDialogState = null;
var currentInfoScope = "divisions";
var currentUserInfoMemberships = {
    divisions: [],
    groups: [],
    activities: [],
    teams: []
};
// Calendar navigation (month 1–12, full year)
var calendarMonth = new Date().getMonth() + 1;
var calendarYear = new Date().getFullYear();
var holidaysByDate = {};
var holidaysList = [];
var milestonesByDate = {};
var milestonesList = [];
var selectedInfoTeamIds = [];
var infoTeamMembersCache = {};
var infoTeamMembersLoading = {};
var quickNavTargets = [];
var quickNavScrollListenerBound = false;
var quickNavDefaultApplied = false;
var isSidebarInfoCollapsed = loadSidebarInfoCollapsed();

function isWorkspaceViewsPage() {
    return !!(document.body && document.body.classList.contains("workspace-views-page"));
}

function isElementVisibleForQuickNav(element) {
    if (!element || element.hidden) return false;
    var current = element;
    while (current && current !== document.body) {
        if (current.hidden) return false;
        var style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        current = current.parentElement;
    }
    return true;
}

function getQuickNavDefinition() {
    if (isWorkspaceViewsPage()) {
        return {
            title: "Move across your dashboard in one tap",
            items: [
                { id: "tasks", label: "Tasks" },
                { id: "unassigned-tasks-card", label: "Unassigned Tasks" },
                { id: "milestones-card", label: "Milestones" }
            ]
        };
    }

    return {
        title: "Jump to your workspace sections",
        items: [
            { id: "admin-create-user-card", label: "Management Panel" },
            { id: "create-task", label: "Create Task" },
            { id: "milestone-admin-card", label: "Create Milestone" }
        ]
    };
}

function getVisibleQuickNavItems() {
    var role = getEffectiveRole();
    var definition = getQuickNavDefinition();
    return (definition.items || []).filter(function (item) {
        if (Array.isArray(item.roles) && item.roles.indexOf(role) === -1) return false;
        return isElementVisibleForQuickNav(document.getElementById(item.id));
    });
}

function activateQuickNavTab(targetId) {
    var buttons = document.querySelectorAll(".quick-nav-tab");
    for (var i = 0; i < buttons.length; i++) {
        var isActive = buttons[i].getAttribute("data-target") === String(targetId || "");
        buttons[i].classList.toggle("is-active", isActive);
        buttons[i].setAttribute("aria-selected", isActive ? "true" : "false");
    }
}

function scrollToQuickNavTarget(targetId) {
    var target = document.getElementById(targetId);
    if (!target) return;
    var top = Math.max(window.scrollY + target.getBoundingClientRect().top - 96, 0);
    activateQuickNavTab(targetId);
    window.scrollTo({ top: top, behavior: "smooth" });
}

function getDefaultQuickNavTarget(items) {
    if (!Array.isArray(items) || !items.length) return "";
    if (!isWorkspaceViewsPage()) {
        for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].id === "milestone-admin-card") return "milestone-admin-card";
        }
    }
    return items[0] && items[0].id ? items[0].id : "";
}

function updateQuickNavActiveOnScroll() {
    if (!quickNavTargets.length) return;
    var activeId = quickNavTargets[0];
    var bestTop = -Infinity;
    quickNavTargets.forEach(function (targetId) {
        var element = document.getElementById(targetId);
        if (!isElementVisibleForQuickNav(element)) return;
        var top = element.getBoundingClientRect().top;
        if (top <= 150 && top > bestTop) {
            bestTop = top;
            activeId = targetId;
        }
    });
    activateQuickNavTab(activeId);
}

function renderQuickNavTabs() {
    var section = document.getElementById("quick-nav-section");
    var titleEl = document.getElementById("quick-nav-title");
    var tabsEl = document.getElementById("quick-nav-tabs");
    if (!section || !tabsEl) return;

    var definition = getQuickNavDefinition();
    var items = getVisibleQuickNavItems();
    quickNavTargets = items.map(function (item) { return item.id; });

    if (titleEl) titleEl.textContent = definition.title;
    if (!items.length) {
        section.hidden = true;
        tabsEl.innerHTML = "";
        return;
    }

    section.hidden = false;
    var defaultTarget = getDefaultQuickNavTarget(items);
    tabsEl.innerHTML = items.map(function (item, index) {
        var isDefault = item && item.id === defaultTarget;
        return "<button type=\"button\" class=\"quick-nav-tab" + (isDefault ? " is-active" : "") + "\" role=\"tab\" aria-selected=\"" + (isDefault ? "true" : "false") + "\" data-target=\"" + escapeHtml(item.id) + "\">" + escapeHtml(item.label) + "</button>";
    }).join("");

    var buttons = tabsEl.querySelectorAll(".quick-nav-tab");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener("click", function () {
            scrollToQuickNavTarget(this.getAttribute("data-target"));
        });
    }

    if (defaultTarget) {
        activateQuickNavTab(defaultTarget);
        if (!quickNavDefaultApplied && !isWorkspaceViewsPage() && defaultTarget === "milestone-admin-card") {
            quickNavDefaultApplied = true;
            var target = document.getElementById(defaultTarget);
            if (target) {
                var top = Math.max(window.scrollY + target.getBoundingClientRect().top - 96, 0);
                window.scrollTo({ top: top, behavior: "auto" });
            }
        } else {
            updateQuickNavActiveOnScroll();
        }
    } else {
        updateQuickNavActiveOnScroll();
    }
    if (!quickNavScrollListenerBound) {
        quickNavScrollListenerBound = true;
        window.addEventListener("scroll", updateQuickNavActiveOnScroll, { passive: true });
    }
}

function normalizeDateKey(value) {
    if (!value) return "";
    return String(value).slice(0, 10);
}

function isHolidayDate(value) {
    var key = normalizeDateKey(value);
    return !!(key && holidaysByDate[key]);
}

function getHolidayNameByDate(value) {
    var key = normalizeDateKey(value);
    return key && holidaysByDate[key] ? holidaysByDate[key].name : "";
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

function setInfoScope(scope) {
    currentInfoScope = scope || "divisions";
    if (currentInfoScope !== "teams") selectedInfoTeamIds = [];
    var buttons = document.querySelectorAll("[data-info-scope]");
    for (var i = 0; i < buttons.length; i++) {
        var isActive = buttons[i].getAttribute("data-info-scope") === currentInfoScope;
        buttons[i].classList.toggle("is-active", isActive);
    }
    renderInfoMembershipList();
}

function bindInfoScopeControls() {
    var buttons = document.querySelectorAll("[data-info-scope]");
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i]._infoBound) continue;
        buttons[i]._infoBound = true;
        buttons[i].addEventListener("click", function () {
            setInfoScope(this.getAttribute("data-info-scope"));
        });
    }
}

function updateInfoCounts(memberships) {
    var counts = {
        divisions: Array.isArray(memberships && memberships.divisions) ? memberships.divisions.length : 0,
        groups: Array.isArray(memberships && memberships.groups) ? memberships.groups.length : 0,
        activities: Array.isArray(memberships && memberships.activities) ? memberships.activities.length : 0,
        teams: Array.isArray(memberships && memberships.teams) ? memberships.teams.length : 0
    };
    var divisionCount = document.getElementById("info-count-divisions");
    var groupCount = document.getElementById("info-count-groups");
    var activityCount = document.getElementById("info-count-activities");
    var teamCount = document.getElementById("info-count-teams");
    if (divisionCount) divisionCount.textContent = String(counts.divisions);
    if (groupCount) groupCount.textContent = String(counts.groups);
    if (activityCount) activityCount.textContent = String(counts.activities);
    if (teamCount) teamCount.textContent = String(counts.teams);
}

function renderInfoMembershipList() {
    var titleEl = document.getElementById("info-membership-title");
    var listEl = document.getElementById("info-membership-list");
    if (titleEl) titleEl.textContent = getInfoScopeTitle(currentInfoScope);
    if (!listEl) return;

    var items = currentUserInfoMemberships[currentInfoScope] || [];
    if (!items.length) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">No " + escapeHtml(getInfoScopeEmptyLabel(currentInfoScope)) + " found.</p>";
        syncInfoTeamActions();
        return;
    }

    if (currentInfoScope === "teams") {
        var availableTeamIds = items.map(function (team) { return parseInt(team.id, 10); });
        selectedInfoTeamIds = selectedInfoTeamIds.filter(function (teamId) {
            return availableTeamIds.indexOf(teamId) !== -1;
        });
        listEl.innerHTML = items.map(function (team) {
            var teamId = parseInt(team.id, 10);
            var isSelected = selectedInfoTeamIds.indexOf(teamId) !== -1;
            var members = Array.isArray(infoTeamMembersCache[teamId]) ? infoTeamMembersCache[teamId] : null;
            var membersHtml = "";
            if (isSelected) {
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
            return "<div class=\"info-team-box" + (isSelected ? " info-team-box--expanded" : "") + "\">" +
                "<button type=\"button\" class=\"info-team-box-toggle\" aria-expanded=\"" + (isSelected ? "true" : "false") + "\" onclick=\"toggleInfoTeamSelection(" + teamId + ")\">" +
                "<span class=\"info-team-box-title-wrap\"><span class=\"info-team-box-title\">" + escapeHtml(team.name || "Unnamed team") + "</span>" +
                (team.user_role ? "<span class=\"info-team-box-meta\">" + escapeHtml(team.user_role) + "</span>" : "") + "</span>" +
                "<span class=\"info-team-box-arrow\" aria-hidden=\"true\"></span>" +
                "</button>" +
                membersHtml +
                "</div>";
        }).join("");
        syncInfoTeamActions();
        return;
    }

    listEl.innerHTML = items.map(function (item) {
        var subtitle = item.meta ? " <small class=\"team-tag-role\">(" + escapeHtml(item.meta) + ")</small>" : "";
        return "<span class=\"team-tag\" title=\"" + escapeHtml(item.name || "") + "\">" + escapeHtml(item.name || "Unnamed item") + subtitle + "</span>";
    }).join("");
    syncInfoTeamActions();
}

function syncInfoTeamActions() {
    return;
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

function clearSelectedInfoTeams() {
    selectedInfoTeamIds = [];
    renderInfoMembershipList();
}

function openSelectedInfoTeamsModal() {
    return;
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
    var label = formatUserInline(username, designation, "User");
    return "<span class=\"team-tag team-tag--member\">" + escapeHtml(label) + "</span>";
}

function deriveInfoMemberships(navTree, teams) {
    var memberships = {
        divisions: [],
        groups: [],
        activities: [],
        teams: []
    };
    var currentUserId = parseInt(getUserId(), 10);
    var isGlobalAdmin = ["admin", "division head"].indexOf((localStorage.getItem("role") || "").toLowerCase()) !== -1;
    var teamMap = {};
    var divisionSeen = {};
    var groupSeen = {};
    var activitySeen = {};

    (Array.isArray(teams) ? teams : []).forEach(function (team) {
        if (!team || typeof team.id === "undefined") return;
        teamMap[String(team.id)] = team;
        memberships.teams.push({
            id: team.id,
            name: team.name || "Unnamed team",
            user_role: team.user_role || "Member"
        });
    });

    memberships.teams.sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });

    (Array.isArray(navTree) ? navTree : []).forEach(function (division) {
        if (!division) return;
        var includeDivision = isGlobalAdmin || division.head_user_id === currentUserId;
        var groups = Array.isArray(division.groups) ? division.groups : [];

        groups.forEach(function (group) {
            if (!group) return;
            var includeGroup = isGlobalAdmin || group.head_user_id === currentUserId;
            var activities = Array.isArray(group.activities) ? group.activities : [];

            activities.forEach(function (activity) {
                if (!activity) return;
                var includeActivity = isGlobalAdmin;
                var teamsForActivity = Array.isArray(activity.teams) ? activity.teams : [];

                teamsForActivity.forEach(function (teamNode) {
                    if (!teamNode) return;
                    if (teamMap[String(teamNode.id)]) {
                        includeActivity = true;
                        includeGroup = true;
                        includeDivision = true;
                    }
                });

                if (includeActivity && !activitySeen[String(activity.id)]) {
                    activitySeen[String(activity.id)] = true;
                    memberships.activities.push({
                        id: activity.id,
                        name: formatActivityProjectName(activity.name, activity.type),
                        meta: group.name || ""
                    });
                }
            });

            if (includeGroup && !groupSeen[String(group.id)]) {
                groupSeen[String(group.id)] = true;
                memberships.groups.push({
                    id: group.id,
                    name: group.name || "Unnamed group",
                    meta: division.name || ""
                });
            }
        });

        if (includeDivision && !divisionSeen[String(division.id)]) {
            divisionSeen[String(division.id)] = true;
            memberships.divisions.push({
                id: division.id,
                name: division.name || "Unnamed division"
            });
        }
    });

    memberships.divisions.sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
    memberships.groups.sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
    memberships.activities.sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });

    return memberships;
}

function formatUserIdDisplay(value) {
    var n = parseInt(value, 10);
    if (!n || n < 0) return String(value || "");
    if (n <= 999) return String(n).padStart(3, "0");
    return String(n);
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

function formatDesignation(designation) {
    var value = String(designation || "").trim();
    var normalized = value.replace(/^\(+|\)+$/g, "").trim().toLowerCase();
    if (!value) return "";
    if (normalized === "designation not set") return "";
    return value ? ("(" + value + ")") : "";
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

function renderUserLabelHtml(username, designation, fallback) {
    var safeName = escapeHtml(username || fallback || "User");
    var safeDesignation = formatDesignation(designation);
    return "<span class=\"person-name-block\"><span class=\"person-name-primary\">" + safeName + "</span>" +
        (safeDesignation ? "<span class=\"person-name-secondary\">" + escapeHtml(safeDesignation) + "</span>" : "") +
        "</span>";
}

function formatUserInline(username, designation, fallback) {
    var name = username || fallback || "User";
    var suffix = formatDesignation(designation);
    return suffix ? (name + " " + suffix) : name;
}

function formatUserOptionLabel(user, fallback) {
    if (!user) return fallback || "User";
    return formatUserInline(
        user.username,
        getDisplayDesignation(user.role, user.designation),
        fallback || ("User " + user.id)
    );
}

function getTaskAssignmentSummary(task, assignees) {
    var count = Array.isArray(assignees) ? assignees.length : 0;
    if (task && task.assignment_scope_type === "activity") {
        var teamCount = parseInt(task.assignment_team_count, 10) || 0;
        return teamCount > 0
            ? ("Whole " + getActivityProjectLabel(task.activity_type) + " (" + teamCount + " teams, " + count + " members)")
            : ("Whole " + getActivityProjectLabel(task.activity_type) + " (" + count + " members)");
    }
    if (task && task.assignment_scope_type === "team") {
        return "Whole team (" + count + " members)";
    }
    return count + " assignees";
}

function getRoleDisplayLabel(role) {
    function titleize(value) {
        return String(value || "")
            .trim()
            .split(/\s+/)
            .map(function (part) {
                return part ? (part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()) : "";
            })
            .join(" ");
    }
    var roleLower = (role || "member").toLowerCase();
    if (roleLower === "admin") return "Admin";
    if (roleLower === "division head") return "Division Head";
    if (roleLower === "group head") return "Group Head";
    if (roleLower === "project director") return "Project Director";
    if (roleLower === "team lead") return "Team Lead";
    if (roleLower === "member") return "Member";
    return titleize(role || "Member") || "Member";
}

function getActivityProjectLabel(activityType) {
    return String(activityType || "").trim().toLowerCase() === "project" ? "Project" : "Activity";
}

function formatActivityProjectName(name, activityType) {
    var baseName = name || "Untitled";
    return getActivityProjectLabel(activityType) + ": " + baseName;
}

function getSidebarActivityTypeClass(activityType) {
    return String(activityType || "").trim().toLowerCase() === "project"
        ? "sidebar-subitem--project"
        : "sidebar-subitem--activity";
}

var cachedUserOptions = {
    roles: ["Member", "Admin", "Division Head", "Group Head", "Project Director", "Team Lead"],
    designations: [
        "Scientist H",
        "Scientist G",
        "Scientist F",
        "Scientist E",
        "Scientist D",
        "Scientist C",
        "Scientist B",
        "Scientist A",
        "Research Associate",
        "Senior Research Fellow",
        "Junior Research Fellow"
    ]
};
var cachedUserOptionRecords = {
    roles: [],
    designations: []
};

function getAllowedRoleOptions() {
    return (cachedUserOptions.roles || []).slice();
}

function getAllowedDesignationOptions() {
    return (cachedUserOptions.designations || []).slice();
}

function normalizeRoleValueForApi(roleValue) {
    return String(roleValue || "Member").trim().toLowerCase();
}

function populateUserOptionSelect(selectId, items, placeholder, selectedValue, normalizeValue) {
    var select = document.getElementById(selectId);
    if (!select) return;
    var previous = typeof selectedValue !== "undefined" ? selectedValue : select.value;
    select.innerHTML = "";
    addOption(select, "", placeholder, !previous);
    (Array.isArray(items) ? items : []).forEach(function (item) {
        var value = normalizeValue ? normalizeValue(item) : item;
        addOption(select, value, item, String(previous) === String(value));
    });
    if (previous) select.value = String(previous);
}

function populateUserOptionSelects() {
    populateUserOptionSelect("admin-create-role", getAllowedRoleOptions(), "Select role", "Member", function (item) {
        return item;
    });
    populateUserOptionSelect("admin-create-designation", getAllowedDesignationOptions(), "Select designation");
    populateUserOptionSelect("edit-user-role", getAllowedRoleOptions(), "Select role", undefined, function (item) {
        return normalizeRoleValueForApi(item);
    });
    populateUserOptionSelect("edit-user-designation", getAllowedDesignationOptions(), "Select designation");
    populateUserOptionSelect("users-role-filter", getAllowedRoleOptions(), "All roles", undefined, function (item) {
        return normalizeRoleValueForApi(item);
    });
    populateManagedUserOptionSelect("role");
    populateManagedUserOptionSelect("designation");
    toggleCreateDesignationField();
    toggleEditDesignationField();
}

function getUserOptionRecords(optionType) {
    if (optionType === "role") return (cachedUserOptionRecords.roles || []).slice();
    return (cachedUserOptionRecords.designations || []).slice();
}

function populateManagedUserOptionSelect(optionType) {
    var isRole = optionType === "role";
    var select = document.getElementById(isRole ? "admin-manage-role-select" : "admin-manage-designation-select");
    if (!select) return;
    var records = getUserOptionRecords(optionType);
    var previous = select.value || "";
    select.innerHTML = "";
    addOption(select, "", isRole ? "Select role" : "Select designation", !previous);
    records.forEach(function (record) {
        if (!record || typeof record.id === "undefined") return;
        addOption(select, record.id, record.value || ("Option " + record.id), String(previous) === String(record.id));
    });
    if (previous) select.value = String(previous);
    syncManagedUserOptionInput(optionType);
}

function syncManagedUserOptionInput(optionType) {
    var isRole = optionType === "role";
    var select = document.getElementById(isRole ? "admin-manage-role-select" : "admin-manage-designation-select");
    var input = document.getElementById(isRole ? "admin-edit-role-name" : "admin-edit-designation-name");
    if (!select || !input) return;
    var selectedId = select.value ? parseInt(select.value, 10) : null;
    var match = getUserOptionRecords(optionType).find(function (record) {
        return record && parseInt(record.id, 10) === selectedId;
    });
    input.value = match && match.value ? match.value : "";
}

function toggleCreateDesignationField() {
    var roleEl = document.getElementById("admin-create-role");
    var designationEl = document.getElementById("admin-create-designation");
    var wrap = designationEl ? designationEl.closest(".form-group") : null;
    var hideDesignation = roleHasNoDesignation(roleEl ? roleEl.value : "");
    if (wrap) wrap.style.display = hideDesignation ? "none" : "";
    if (designationEl && hideDesignation) designationEl.value = "";
}

function toggleEditDesignationField() {
    var roleEl = document.getElementById("edit-user-role");
    var designationEl = document.getElementById("edit-user-designation");
    var wrap = designationEl ? designationEl.closest(".form-group") : null;
    var hideDesignation = roleHasNoDesignation(roleEl ? roleEl.value : "");
    if (wrap) wrap.style.display = hideDesignation ? "none" : "";
    if (designationEl && hideDesignation) designationEl.value = "";
    toggleEditUserScopeFields();
}

function initializeEditUserScopeBindings() {
    var divisionSelect = document.getElementById("edit-user-scope-division");
    var groupSelect = document.getElementById("edit-user-scope-group");
    var activitySelect = document.getElementById("edit-user-scope-activity");

    if (divisionSelect && !divisionSelect._bound) {
        divisionSelect._bound = true;
        divisionSelect.addEventListener("change", function () {
            populateEditUserScopeGroupOptions(divisionSelect.value, "");
            populateEditUserScopeActivityOptions("", "");
            populateEditUserScopeTeamOptions("", "");
        });
    }
    if (groupSelect && !groupSelect._bound) {
        groupSelect._bound = true;
        groupSelect.addEventListener("change", function () {
            populateEditUserScopeActivityOptions(groupSelect.value, "");
            populateEditUserScopeTeamOptions("", "");
        });
    }
    if (activitySelect && !activitySelect._bound) {
        activitySelect._bound = true;
        activitySelect.addEventListener("change", function () {
            populateEditUserScopeTeamOptions(activitySelect.value, "");
        });
    }
}

function populateEditUserScopeDivisionOptions(selectedDivisionId) {
    var select = document.getElementById("edit-user-scope-division");
    if (!select) return;
    select.innerHTML = "";
    addOption(select, "", "Select division", false);
    (taskCreateHierarchy.divisions || []).forEach(function (division) {
        addOption(select, division.id, division.name, String(selectedDivisionId) === String(division.id));
    });
    select.value = selectedDivisionId ? String(selectedDivisionId) : "";
}

function populateEditUserScopeGroupOptions(divisionId, selectedGroupId) {
    var select = document.getElementById("edit-user-scope-group");
    if (!select) return;
    var groups = divisionId ? (taskCreateHierarchy.groupsByDivision[String(divisionId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", divisionId ? "Select group" : "Select division first", false);
    groups.forEach(function (group) {
        addOption(select, group.id, group.name, String(selectedGroupId) === String(group.id));
    });
    select.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateEditUserScopeActivityOptions(groupId, selectedActivityId) {
    var select = document.getElementById("edit-user-scope-activity");
    if (!select) return;
    var activities = groupId ? (taskCreateHierarchy.activitiesByGroup[String(groupId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", groupId ? "Select activity / project" : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(select, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId) === String(activity.id));
    });
    select.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateEditUserScopeTeamOptions(activityId, selectedTeamId) {
    var select = document.getElementById("edit-user-scope-team");
    if (!select) return;
    var teams = activityId ? (taskCreateHierarchy.teamsByActivity[String(activityId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", activityId ? "Select team" : "Select activity / project first", false);
    teams.forEach(function (team) {
        addOption(select, team.id, team.name, String(selectedTeamId) === String(team.id));
    });
    select.value = selectedTeamId ? String(selectedTeamId) : "";
}

function toggleEditUserScopeFields() {
    var role = ((document.getElementById("edit-user-role") || {}).value || "member").toLowerCase();
    var divisionWrap = document.getElementById("edit-user-scope-division-wrap");
    var groupWrap = document.getElementById("edit-user-scope-group-wrap");
    var activityWrap = document.getElementById("edit-user-scope-activity-wrap");
    var teamWrap = document.getElementById("edit-user-scope-team-wrap");

    var showDivision = role === "division head" || role === "group head" || role === "team lead" || role === "project director";
    var showGroup = role === "group head" || role === "team lead" || role === "project director";
    var showActivity = role === "team lead" || role === "project director";
    var showTeam = role === "team lead" || role === "project director";

    if (divisionWrap) divisionWrap.hidden = !showDivision;
    if (groupWrap) groupWrap.hidden = !showGroup;
    if (activityWrap) activityWrap.hidden = !showActivity;
    if (teamWrap) teamWrap.hidden = !showTeam;
}

function loadUserOptionCatalog() {
    return apiRequest("/user-options", "GET")
        .then(function (items) {
            var roles = [];
            var designations = [];
            var roleRecords = [];
            var designationRecords = [];
            (Array.isArray(items) ? items : []).forEach(function (item) {
                if (!item || !item.value) return;
                if (item.option_type === "role") {
                    roles.push(item.value);
                    roleRecords.push(item);
                }
                if (item.option_type === "designation") {
                    designations.push(item.value);
                    designationRecords.push(item);
                }
            });
            if (roles.length) cachedUserOptions.roles = roles;
            if (designations.length) cachedUserOptions.designations = designations;
            cachedUserOptionRecords.roles = roleRecords;
            cachedUserOptionRecords.designations = designationRecords;
            populateUserOptionSelects();
        })
        .catch(function () {
            populateUserOptionSelects();
        });
}

(function () {
    if (!isLoggedIn()) {
        window.location.href = "index.html";
        return;
    }
    if (!isWorkspaceViewsPage() && !canAccessManagementPages()) {
        window.location.href = "workspace-views.html";
        return;
    }

    var username = localStorage.getItem("username") || "User";
    var designation = getDisplayDesignation(role, localStorage.getItem("designation") || "");
    var role = getEffectiveRole();

    var badge = document.getElementById("user-badge");
    setUserNameBlock(badge, username, designation);
    var avatar = document.getElementById("user-avatar");
    if (avatar) avatar.textContent = (username.charAt(0) || "U").toUpperCase();
    initializeTopbarControls();
    updateHeaderRole();
    applySidebarCollapsedState();
    applyDashboardUserProfile(username, designation);
    syncDaysLeftDisplayModeControl();
    var uid = getUserId();
    var heroUserId = document.getElementById("hero-user-id");
    if (heroUserId && uid) heroUserId.textContent = formatUserIdDisplay(uid);
    var topbarUserId = document.getElementById("topbar-user-id");
    if (topbarUserId && uid) topbarUserId.textContent = formatUserIdDisplay(uid);

    setupRoleBasedUI(role);
    renderQuickNavTabs();
    loadUserOptionCatalog();

    // Sync current user from server so role/name changes (e.g. promoted to Division Head / Group Head) apply without re-login
    apiRequest("/users/me", "GET")
        .then(function (me) {
            if (!me) return;
            var serverRole = (me.role || "member").toLowerCase();
            var serverName = me.username || "";
            var serverDesignation = getDisplayDesignation(serverRole, me.designation || "");
            if (serverName) localStorage.setItem("username", serverName);
            localStorage.setItem("designation", serverDesignation);
            var roleChanged = serverRole !== (localStorage.getItem("role") || "member").toLowerCase();
            if (roleChanged) {
                localStorage.setItem("role", serverRole);
                setupRoleBasedUI(serverRole);
                renderQuickNavTabs();
                loadUserTeams();
                loadTasks();
            }
            updateHeaderRole();
            if (serverName && badge) setUserNameBlock(badge, serverName, serverDesignation);
            if (serverName && avatar) avatar.textContent = (serverName.charAt(0) || "U").toUpperCase();
            applyDashboardUserProfile(serverName || username, serverDesignation);
        })
        .catch(function () { /* keep existing localStorage on error */ });
})();

document.addEventListener("user-profile-updated", function (event) {
    var detail = event && event.detail ? event.detail : {};
    var username = detail.username || localStorage.getItem("username") || "User";
    var designation = getDisplayDesignation(detail.role || localStorage.getItem("role") || "", detail.designation || localStorage.getItem("designation") || "");
    applyDashboardUserProfile(username, designation);
    updateHeaderRole();
    loadTasks();
    loadUserTeams();
    loadHolidays();
    loadMilestones();
    loadAllUsers();
    renderQuickNavTabs();
    if (chatPanelOpen) loadActivityChat(true);
});

function applyDashboardUserProfile(username, designation) {
    var heroName = document.getElementById("hero-username");
    setUserNameBlock(heroName, username, designation);
    var heroNameDesc = document.getElementById("hero-username-desc");
    if (heroNameDesc) heroNameDesc.textContent = formatUserInline(username, designation, "User");
    updateSidebarRoleLabel();
}

function canAccessManagementPages() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head" || role === "group head" || role === "team lead" || role === "project director";
}

function canAccessAnalyticsPages(roleValue) {
    var role = String(roleValue || getEffectiveRole() || "").toLowerCase();
    return role === "admin" || role === "division head" || role === "group head" || role === "project director" || role === "team lead";
}

function loadDaysLeftDisplayMode() {
    try {
        var value = localStorage.getItem("days_left_display_mode");
        return value === "days" ? "days" : "smart";
    } catch (_err) {
        return "smart";
    }
}

function syncDaysLeftDisplayModeControl() {
    var control = document.getElementById("days-left-display-mode");
    if (control) control.value = daysLeftDisplayMode;
}

function setDaysLeftDisplayMode(mode) {
    daysLeftDisplayMode = mode === "days" ? "days" : "smart";
    try {
        localStorage.setItem("days_left_display_mode", daysLeftDisplayMode);
    } catch (_err) {
        // Ignore storage failures.
    }
    syncDaysLeftDisplayModeControl();
    loadTasks();
}

function loadSidebarInfoCollapsed() {
    try {
        var value = localStorage.getItem("sidebar_info_collapsed");
        return value === null ? true : value === "1";
    } catch (_err) {
        return true;
    }
}

function getEffectiveRole() {
    if (effectiveDisplayRole !== null && effectiveDisplayRole !== undefined) {
        return effectiveDisplayRole.toLowerCase();
    }
    return (localStorage.getItem("role") || "member").toLowerCase();
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

function applySidebarInfoCollapsedState() {
    var card = document.querySelector(".sidebar-info-card");
    var content = document.getElementById("sidebar-info-content");
    var toggle = document.getElementById("sidebar-info-toggle");
    if (card) card.classList.toggle("is-collapsed", !!isSidebarInfoCollapsed);
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

function toggleSidebarCollapse() {
    isSidebarCollapsed = !isSidebarCollapsed;
    try {
        localStorage.setItem("sidebar_collapsed", isSidebarCollapsed ? "1" : "0");
    } catch (_err) {
        // Ignore storage failures.
    }
    applySidebarCollapsedState();
}

function loadOpenSubtaskParents() {
    try {
        var raw = localStorage.getItem("open_subtask_parents");
        var parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_err) {
        return {};
    }
}

function saveOpenSubtaskParents() {
    try {
        localStorage.setItem("open_subtask_parents", JSON.stringify(openSubtaskParents || {}));
    } catch (_err) {
        // Ignore storage failures; toggling still works for the current page session.
    }
}

function canCreateSubtaskForTask(task) {
    if (!task) return false;
    var role = getEffectiveRole();
    if (role === "admin" || role === "division head" || role === "group head" || role === "project director" || role === "team lead") {
        return true;
    }
    var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
    if (!currentUserId) return false;
    if (task.assigned_to === currentUserId) {
        return true;
    }
    if (Array.isArray(task.assignees)) {
        return task.assignees.some(function (assignee) {
            return assignee && assignee.user_id === currentUserId;
        });
    }
    return false;
}

function updateHeaderRole() {
    var role = getEffectiveRole();
    var roleEl = document.getElementById("user-role");
    if (roleEl) {
        roleEl.textContent = getRoleDisplayLabel(role);
    }
    updateSidebarRoleLabel();
}

function updateSidebarRoleLabel() {
    var roleEl = document.getElementById("sidebar-user-role");
    if (roleEl) {
        roleEl.textContent = getRoleDisplayLabel(getEffectiveRole());
    }
}

function updateWorkspaceSidebarLabel(role) {
    var label = String(role || getEffectiveRole() || "").toLowerCase() === "admin" ? "Admin Panel" : "Workspace";
    var labels = document.querySelectorAll(".sidebar-item--workspace .sidebar-label");
    for (var i = 0; i < labels.length; i++) {
        labels[i].textContent = label;
    }
}

function updateSidebarPageAccess(roleValue) {
    var role = String(roleValue || getEffectiveRole() || "").toLowerCase();
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

function setupRoleBasedUI(userRole) {
    // Normalize to lowercase so "Admin" and "admin" both work
    var role = (userRole || "member").toLowerCase();
    var isAdmin = role === "admin";
    var isDivisionHead = role === "division head";
    var isGroupHeadOnly = role === "group head";
    var canManageWorkspacePanel = isAdmin || isDivisionHead || isGroupHeadOnly;
    var canCreateTask = canManageWorkspacePanel || role === "project director" || role === "team lead";
    var canRemoveMember = canManageWorkspacePanel;
    var canViewWorkspaceActions = canManageWorkspacePanel || role === "project director" || role === "team lead";

    // Updated Hierarchy Creation visibility restrictions
    var isGlobalAdmin = isAdmin;
    var isDivHead = isGlobalAdmin || isDivisionHead;
    var isGroupHead = isDivHead || isGroupHeadOnly;

    var divSection = document.getElementById("division-section");
    var grpSection = document.getElementById("group-section");
    var actSection = document.getElementById("activity-section");
    var teamSection = document.getElementById("team-section");
    var hierarchyEditBtn = document.getElementById("hierarchy-edit-btn");
    var managementPanelSection = document.getElementById("teams");

    if (divSection) divSection.style.display = isGlobalAdmin ? "" : "none";
    if (grpSection) grpSection.style.display = isDivHead ? "" : "none";
    if (actSection) actSection.style.display = isGroupHead ? "" : "none";
    if (teamSection) teamSection.style.display = isGroupHead ? "" : "none";
    if (hierarchyEditBtn) hierarchyEditBtn.style.display = isGroupHead ? "" : "none";
    if (managementPanelSection) managementPanelSection.style.display = canViewWorkspaceActions ? "" : "none";
    
    // Auto-load dropdowns for these forms if any of them are visible
    if (isGroupHead) {
        if (typeof loadHierarchyFormDropdowns === "function") loadHierarchyFormDropdowns();
    }

    // Hide create task section (main tasks)
    var taskSection = document.getElementById("create-task");
    if (taskSection) {
        taskSection.style.display = canCreateTask ? "" : "none";
    }

    // Add member section: hidden by default; shown when user has admin teams (set in loadUserTeams)
    var memberSection = document.getElementById("member-section");
    if (memberSection) {
        memberSection.style.display = "none";
    }

    // Admin-only maintenance cards (delete team, remove member)
    var deleteTeamCard = document.getElementById("delete-team-card");
    if (deleteTeamCard) {
        deleteTeamCard.style.display = canManageWorkspacePanel ? "" : "none";
    }
    var removeMemberCard = document.getElementById("remove-member-card");
    if (removeMemberCard) {
        removeMemberCard.style.display = canRemoveMember ? "" : "none";
    }

    // Closure Control visibility in Task Creation
    // "Team lead can create team, but other people except member can remove member. 
    // If team lead creates task, it has option to give closure control to either group head / division head / project director"
    // We'll show the closure control input if the user is Team Lead (or higher, for flexibility).
    var closureGroup = document.getElementById("task-closure-group");
    if (closureGroup) {
        if (role === "team lead" || role === "group head" || role === "project director" || role === "division head" || role === "admin") {
            closureGroup.hidden = false;
        } else {
            closureGroup.hidden = true;
        }
    }

    // Show user management for admin only
    var userSection = document.getElementById("users-section");
    var adminCreateUserCard = document.getElementById("admin-create-user-card");
    var holidayCard = document.getElementById("holiday-admin-card");
    var milestoneCard = document.getElementById("milestone-admin-card");
    if (userSection) {
        if (role === "admin") {
            userSection.style.display = "block";
            if (adminCreateUserCard) {
                adminCreateUserCard.style.display = "";
            }
            loadAllUsers();
        } else {
            userSection.style.display = "none";
            if (adminCreateUserCard) {
                adminCreateUserCard.style.display = "none";
            }
        }
    }
    if (holidayCard) {
        holidayCard.style.display = isAdmin ? "" : "none";
    }
    if (milestoneCard) {
        milestoneCard.style.display = canManageMilestones() ? "" : "none";
    }
    renderQuickNavTabs();
    updateWorkspaceSidebarLabel(role);
    updateSidebarPageAccess(role);

    // Create task: Admin, Division Head, Group Head, Project Director, Team Lead can add assignees when creating. Members see no assign/lead/share UI.
    var multiWrap = document.getElementById("task-multi-assign-wrap");
    var singleWrap = document.getElementById("task-single-assign-wrap");
    var leadWrap = document.getElementById("task-lead-wrap");
    var shareWrap = document.getElementById("task-share-wrap");
    var scopeWrap = document.getElementById("task-assignment-scope-wrap");
    if (multiWrap && singleWrap) {
        multiWrap.style.display = "none";
        singleWrap.style.display = "none";
        if (leadWrap) leadWrap.style.display = "none";
        if (shareWrap) shareWrap.style.display = "none";
        if (scopeWrap) scopeWrap.style.display = canUseScopedTaskAssignment() ? "" : "none";
        syncTaskAssignmentScopeUI();
    }
    var typeHint = document.getElementById("task-type-hint");
    if (typeHint) typeHint.style.display = !canAssignTask() && !canUseMultiAssign() ? "block" : "none";
}

function isUserAdmin() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head";
}

function canManageMilestones() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    if (role === "admin" || role === "division head" || role === "group head") return true;
    role = String(getEffectiveRole() || role).toLowerCase();
    return role === "project director" || role === "team lead";
}

function canDeleteMilestones() {
    var role = String(getEffectiveRole() || localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head" || role === "group head";
}

function renderHolidayAdminList() {
    var listEl = document.getElementById("holiday-list");
    if (!listEl) return;
    if (!holidaysList.length) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">No holidays added yet.</p>";
        return;
    }
    listEl.innerHTML = holidaysList.map(function (holiday) {
        var id = parseInt(holiday.id, 10) || 0;
        var dateText = escapeHtml(normalizeDateKey(holiday.holiday_date));
        var nameText = escapeHtml(holiday.name || "Holiday");
        var canDelete = isUserAdmin();
        return (
            "<div class=\"member-bulk-item\">" +
            "<span>" + dateText + " - " + nameText + "</span>" +
            (canDelete ? "<button type=\"button\" class=\"btn btn-danger btn-sm\" onclick=\"deleteHolidayFromDashboard(" + id + ")\">Remove</button>" : "") +
            "</div>"
        );
    }).join("");
}

function loadHolidays() {
    return apiRequest("/holidays", "GET")
        .then(function (rows) {
            var nextList = Array.isArray(rows) ? rows.slice() : [];
            nextList.sort(function (a, b) {
                return normalizeDateKey(a && a.holiday_date).localeCompare(normalizeDateKey(b && b.holiday_date));
            });
            holidaysList = nextList;
            holidaysByDate = {};
            holidaysList.forEach(function (item) {
                var key = normalizeDateKey(item && item.holiday_date);
                if (!key) return;
                holidaysByDate[key] = { id: item.id, name: String(item.name || "Holiday") };
            });
            renderHolidayAdminList();
            if (tasksViewMode === "calendar") {
                renderCalendarView(lastLoadedTasks || []);
            }
        })
        .catch(function (_err) {
            holidaysList = [];
            holidaysByDate = {};
            renderHolidayAdminList();
        });
}

function createHolidayFromDashboard() {
    if (!isUserAdmin()) {
        showToast("Only admins can add holidays", true);
        return;
    }
    var dateEl = document.getElementById("holiday-date");
    var nameEl = document.getElementById("holiday-name");
    var holidayDate = dateEl ? (dateEl.value || "") : "";
    var holidayName = nameEl ? (nameEl.value || "").trim() : "";
    if (!holidayDate) {
        showToast("Select a holiday date", true);
        return;
    }
    if (!holidayName) {
        showToast("Enter a holiday name", true);
        return;
    }
    apiRequest("/holidays", "POST", {
        holiday_date: holidayDate,
        name: holidayName
    })
        .then(function () {
            if (dateEl) dateEl.value = "";
            if (nameEl) nameEl.value = "";
            showToast("Holiday added");
            return loadHolidays();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to add holiday", true);
        });
}

function deleteHolidayFromDashboard(holidayId) {
    if (!isUserAdmin()) {
        showToast("Only admins can remove holidays", true);
        return;
    }
    if (!holidayId) return;
    if (!confirm("Delete this holiday?")) return;
    apiRequest("/holidays/" + holidayId, "DELETE")
        .then(function () {
            showToast("Holiday removed");
            return loadHolidays();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to delete holiday", true);
        });
}

function renderMilestoneAdminList() {
    var listEl = document.getElementById("milestone-list");
    if (!listEl) return;
    if (!milestonesList.length) {
        listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">No milestones added yet.</p>";
        return;
    }
    listEl.innerHTML = milestonesList.map(function (milestone) {
        var id = parseInt(milestone.id, 10) || 0;
        var dateText = escapeHtml(normalizeDateKey(milestone.milestone_date));
        var nameText = escapeHtml(milestone.name || "Milestone");
        var canDelete = canDeleteMilestones();
        return (
            "<div class=\"member-bulk-item\">" +
            "<span>" + dateText + " - " + nameText + "</span>" +
            (canDelete ? "<button type=\"button\" class=\"btn btn-danger btn-sm\" onclick=\"deleteMilestoneFromDashboard(" + id + ")\">Remove</button>" : "") +
            "</div>"
        );
    }).join("");
}

function renderMilestonesTable() {
    var tbody = document.getElementById("milestones-table-body");
    var emptyEl = document.getElementById("milestones-empty");
    var card = document.getElementById("milestones-card");
    if (!tbody || !card) return;
    var searchValue = normalizeSearchText(milestoneSearchQuery);
    var visibleMilestones = filterMilestonesBySearch(milestonesList, searchValue);
    if (!visibleMilestones.length) {
        tbody.innerHTML = "";
        if (emptyEl) {
            if (milestonesList.length && searchValue) {
                setEmptyStateMessage(emptyEl, "No matching milestones", "Try another keyword or clear the search.");
            } else {
                setEmptyStateMessage(emptyEl, "No milestones yet", "Create milestones from the management panel to show them here and on the calendar.");
            }
        }
        card.hidden = false;
        return;
    }
    var canEdit = canManageMilestones();
    var canDelete = canDeleteMilestones();
    tbody.innerHTML = visibleMilestones.map(function (m) {
        var dateText = escapeHtml(normalizeDateKey(m.milestone_date));
        var nameText = escapeHtml(m.name || "Milestone");
        var actions = [];
        if (canEdit) actions.push("<button type=\"button\" class=\"btn btn-ghost btn-sm\" onclick=\"openEditMilestoneModal(" + parseInt(m.id, 10) + ")\">Edit</button>");
        if (canDelete) actions.push("<button type=\"button\" class=\"btn btn-danger btn-sm\" onclick=\"deleteMilestoneFromDashboard(" + parseInt(m.id, 10) + ")\">Delete</button>");
        if (!actions.length) actions.push("<span class=\"text-muted\">-</span>");
        return "<tr><td>" + nameText + "</td><td class=\"col-due\">" + dateText + "</td><td class=\"col-actions\">" + actions + "</td></tr>";
    }).join("");
    if (emptyEl) emptyEl.hidden = true;
    card.hidden = false;
}

function loadMilestones() {
    return apiRequest("/milestones", "GET")
        .then(function (rows) {
            var nextList = Array.isArray(rows) ? rows.slice() : [];
            nextList.sort(function (a, b) {
                var dateCompare = normalizeDateKey(a && a.milestone_date).localeCompare(normalizeDateKey(b && b.milestone_date));
                if (dateCompare !== 0) return dateCompare;
                return String((a && a.name) || "").localeCompare(String((b && b.name) || ""), undefined, { sensitivity: "base" });
            });
            milestonesList = nextList;
            milestonesByDate = {};
            milestonesList.forEach(function (item) {
                var key = normalizeDateKey(item && item.milestone_date);
                if (!key) return;
                if (!milestonesByDate[key]) milestonesByDate[key] = [];
                milestonesByDate[key].push({ id: item.id, name: String(item.name || "Milestone") });
            });
            renderMilestoneAdminList();
            renderMilestonesTable();
            if (tasksViewMode === "calendar") renderCalendarView(lastLoadedTasks || []);
            renderQuickNavTabs();
        })
        .catch(function () {
            milestonesList = [];
            milestonesByDate = {};
            renderMilestoneAdminList();
            renderMilestonesTable();
            renderQuickNavTabs();
        });
}

function createMilestoneFromDashboard() {
    if (!canManageMilestones()) {
        showToast("Only admin, division head, group head, project director, or team lead can add milestones", true);
        return;
    }
    var dateEl = document.getElementById("milestone-date");
    var nameEl = document.getElementById("milestone-name");
    var dependencyPayload = collectDependencyPayload("milestone");
    if (dependencyPayload === null) return;
    var milestoneDate = dateEl ? (dateEl.value || "") : "";
    var milestoneName = nameEl ? (nameEl.value || "").trim() : "";
    if (!milestoneDate) {
        showToast("Select a milestone date", true);
        return;
    }
    if (!milestoneName) {
        showToast("Enter a milestone name", true);
        return;
    }
    var linkedTaskPayload = collectMilestoneTaskCreationPayload(milestoneName, milestoneDate);
    if (document.getElementById("milestone-create-linked-task") && document.getElementById("milestone-create-linked-task").checked && linkedTaskPayload === null) {
        return;
    }

    guardDuplicateNameBeforeCreate({
        entityLabel: "milestone",
        name: milestoneName,
        sourceInputId: "milestone-name"
    }).then(function (finalName) {
        if (!finalName) return null;
        milestoneName = finalName;
        if (nameEl) nameEl.value = finalName;
        if (linkedTaskPayload) linkedTaskPayload.title = finalName;
        return apiRequest("/milestones", "POST", {
            milestone_date: milestoneDate,
            name: milestoneName,
            has_dependency: dependencyPayload.has_dependency,
            start_dependency_task_id: dependencyPayload.start_dependency_task_id,
            start_dependency_event: dependencyPayload.start_dependency_event,
            finish_dependency_task_id: dependencyPayload.finish_dependency_task_id,
            finish_dependency_event: dependencyPayload.finish_dependency_event
        })
            .then(function (createdMilestone) {
                if (linkedTaskPayload && createdMilestone && createdMilestone.id) {
                    return apiRequest("/milestones/" + createdMilestone.id + "/convert-to-task", "POST", linkedTaskPayload)
                        .then(function () {
                            return { createdLinkedTask: true };
                        })
                        .catch(function (err) {
                            showToast("Milestone added, but linked task creation failed: " + (err.message || "Unknown error"), true);
                            return { createdLinkedTask: false };
                        });
                }
                return { createdLinkedTask: false };
            })
            .then(function (result) {
                if (dateEl) dateEl.value = "";
                if (nameEl) nameEl.value = "";
                var depToggle = document.getElementById("milestone-has-dependency");
                var depStart = document.getElementById("milestone-start-dependency-task");
                var depStartEvent = document.getElementById("milestone-start-dependency-event");
                var depFinish = document.getElementById("milestone-finish-dependency-task");
                var depFinishEvent = document.getElementById("milestone-finish-dependency-event");
                if (depToggle) depToggle.checked = false;
                if (depStart) depStart.value = "";
                if (depStartEvent) depStartEvent.value = "finish";
                if (depFinish) depFinish.value = "";
                if (depFinishEvent) depFinishEvent.value = "finish";
                toggleMilestoneDependencyFields();
                resetMilestoneTaskCreationForm();
                showToast(result && result.createdLinkedTask ? "Milestone and linked task created" : "Milestone added");
                return Promise.all([loadMilestones(), loadTasks()]);
            });
    }).catch(function (err) {
        if (!err) return;
        showToast(err.message || "Failed to add milestone", true);
    });
}

function deleteMilestoneFromDashboard(milestoneId) {
    if (!canDeleteMilestones()) {
        showToast("Only admin, division head, or group head can remove milestones", true);
        return;
    }
    if (!milestoneId) return;
    if (!confirm("Delete this milestone?")) return;
    apiRequest("/milestones/" + milestoneId, "DELETE")
        .then(function () {
            showToast("Milestone removed");
            return loadMilestones();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to delete milestone", true);
        });
}

// Admin, Division Head, Group Head can assign/unassign tasks.
function canAssignTask() {
    var role = getEffectiveRole();
    return role === "admin" || role === "division head" || role === "group head";
}

// Admin, Division Head, Group Head, Project Director, Team Lead can create tasks with multiple assignees (create form only).
function canUseMultiAssign() {
    var role = getEffectiveRole();
    return ["admin", "division head", "group head", "team lead", "project director"].indexOf(role) !== -1;
}

function canUseScopedTaskAssignment() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head" || role === "group head";
}

function getTaskAssignmentScope() {
    var scopeEl = document.getElementById("task-assignment-scope");
    var scope = scopeEl ? String(scopeEl.value || "individual").toLowerCase() : "individual";
    if (!canUseScopedTaskAssignment()) return "individual";
    if (scope !== "team" && scope !== "activity") return "individual";
    return scope;
}

function canEnableTaskCreateDetails() {
    var divisionId = document.getElementById("task-division") ? document.getElementById("task-division").value : "";
    var groupId = document.getElementById("task-group") ? document.getElementById("task-group").value : "";
    var activityId = document.getElementById("task-activity") ? document.getElementById("task-activity").value : "";
    var teamId = document.getElementById("task-team") ? document.getElementById("task-team").value : "";
    var scope = getTaskAssignmentScope();
    if (!divisionId || !groupId || !activityId) return false;
    if (scope === "activity") return true;
    return !!teamId;
}

function syncTaskAssignmentScopeUI() {
    var scopeWrap = document.getElementById("task-assignment-scope-wrap");
    var scopeEl = document.getElementById("task-assignment-scope");
    var multiWrap = document.getElementById("task-multi-assign-wrap");
    var singleWrap = document.getElementById("task-single-assign-wrap");
    var leadWrap = document.getElementById("task-lead-wrap");
    var shareWrap = document.getElementById("task-share-wrap");
    var scope = getTaskAssignmentScope();
    var canScopeAssign = canUseScopedTaskAssignment();

    if (scopeWrap) scopeWrap.style.display = canScopeAssign ? "" : "none";
    if (scopeEl && !canScopeAssign) scopeEl.value = "individual";

    if (multiWrap) multiWrap.style.display = "none";
    if (singleWrap) singleWrap.style.display = "none";
    if (leadWrap) leadWrap.style.display = "none";
    if (shareWrap) shareWrap.style.display = "none";

    if (scope === "team" || scope === "activity") return;

    if (canUseMultiAssign()) {
        if (multiWrap) multiWrap.style.display = "block";
    } else if (canAssignTask()) {
        if (singleWrap) singleWrap.style.display = "";
        if (leadWrap) leadWrap.style.display = "";
        if (shareWrap) shareWrap.style.display = "";
    }
}

function getSelectedTeamId() {
    var v = document.getElementById("task-team");
    return v && v.value ? parseInt(v.value, 10) : null;
}

function setTaskCreateDetailsEnabled(enabled) {
    var section = document.getElementById("create-task");
    if (!section) return;
    var controls = section.querySelectorAll("input, select, textarea");
    var addAssigneeBtn = document.getElementById("task-add-assignee");
    controls.forEach(function (control) {
        if (!control || !control.id) return;
        if (control.id === "task-division" || control.id === "task-group" || control.id === "task-activity" || control.id === "task-team" || control.id === "task-assignment-scope") {
            control.disabled = false;
            return;
        }
        control.disabled = !enabled;
    });
    if (addAssigneeBtn) addAssigneeBtn.disabled = !enabled;
}

function initializeTaskCreateHierarchyBindings() {
    var divisionSelect = document.getElementById("task-division");
    var groupSelect = document.getElementById("task-group");
    var activitySelect = document.getElementById("task-activity");
    var teamSelect = document.getElementById("task-team");
    var scopeSelect = document.getElementById("task-assignment-scope");

    if (divisionSelect && !divisionSelect._bound) {
        divisionSelect._bound = true;
        divisionSelect.addEventListener("change", function () {
            populateTaskGroupOptions(divisionSelect.value, "");
            populateTaskActivityOptions("", "");
            populateTaskTeamOptions("", "");
            setTaskCreateDetailsEnabled(false);
            syncTaskAssignmentScopeUI();
        });
    }
    if (groupSelect && !groupSelect._bound) {
        groupSelect._bound = true;
        groupSelect.addEventListener("change", function () {
            populateTaskActivityOptions(groupSelect.value, "");
            populateTaskTeamOptions("", "");
            setTaskCreateDetailsEnabled(false);
            syncTaskAssignmentScopeUI();
        });
    }
    if (activitySelect && !activitySelect._bound) {
        activitySelect._bound = true;
        activitySelect.addEventListener("change", function () {
            populateTaskTeamOptions(activitySelect.value, "");
            setTaskCreateDetailsEnabled(canEnableTaskCreateDetails());
            syncTaskAssignmentScopeUI();
            if (getTaskAssignmentScope() === "activity") {
                loadTeamMembersForAssignee("");
                loadTeamMembersForLead("");
                loadClosureApprovers("");
            }
        });
    }
    if (teamSelect && !teamSelect._bound) {
        teamSelect._bound = true;
        teamSelect.addEventListener("change", function () {
            var teamId = teamSelect.value;
            setTaskCreateDetailsEnabled(canEnableTaskCreateDetails());
            loadTeamMembersForAssignee(teamId);
            loadTeamMembersForLead(teamId);
            loadClosureApprovers(teamId);
            syncTaskAssignmentScopeUI();
        });
    }
    if (scopeSelect && !scopeSelect._bound) {
        scopeSelect._bound = true;
        scopeSelect.addEventListener("change", function () {
            setTaskCreateDetailsEnabled(canEnableTaskCreateDetails());
            syncTaskAssignmentScopeUI();
            if (getTaskAssignmentScope() === "activity") {
                loadTeamMembersForAssignee("");
                loadTeamMembersForLead("");
                loadClosureApprovers("");
            } else {
                var selectedTeamId = teamSelect ? teamSelect.value : "";
                loadTeamMembersForAssignee(selectedTeamId);
                loadTeamMembersForLead(selectedTeamId);
                loadClosureApprovers(selectedTeamId);
            }
        });
    }
    setTaskCreateDetailsEnabled(canEnableTaskCreateDetails());
    syncTaskAssignmentScopeUI();
}

function buildTaskCreateHierarchyFromTree(tree) {
    var currentDivisionId = document.getElementById("task-division") ? document.getElementById("task-division").value : "";
    var currentGroupId = document.getElementById("task-group") ? document.getElementById("task-group").value : "";
    var currentActivityId = document.getElementById("task-activity") ? document.getElementById("task-activity").value : "";
    var currentTeamId = document.getElementById("task-team") ? document.getElementById("task-team").value : "";
    var hierarchy = {
        divisions: [],
        groupsByDivision: {},
        activitiesByGroup: {},
        teamsByActivity: {},
        teamMetaById: {}
    };

    (tree || []).forEach(function (division) {
        hierarchy.divisions.push({ id: division.id, name: division.name });
        hierarchy.groupsByDivision[String(division.id)] = Array.isArray(division.groups) ? division.groups.map(function (group) {
            return { id: group.id, name: group.name };
        }) : [];

        (division.groups || []).forEach(function (group) {
            hierarchy.activitiesByGroup[String(group.id)] = Array.isArray(group.activities) ? group.activities.map(function (activity) {
                return { id: activity.id, name: activity.name, type: activity.type || "" };
            }) : [];

            (group.activities || []).forEach(function (activity) {
                hierarchy.teamsByActivity[String(activity.id)] = Array.isArray(activity.teams) ? activity.teams.map(function (team) {
                    hierarchy.teamMetaById[String(team.id)] = {
                        division_id: division.id,
                        group_id: group.id,
                        activity_id: activity.id,
                        activity_type: activity.type || "",
                        team_id: team.id
                    };
                    return { id: team.id, name: team.name };
                }) : [];
            });
        });
    });

    taskCreateHierarchy = hierarchy;
    initializeTaskCreateHierarchyBindings();
    initializeMilestoneTaskHierarchyBindings();
    initializeEditUserScopeBindings();
    populateTaskDivisionOptions(currentDivisionId);
    populateTaskGroupOptions(currentDivisionId, currentGroupId);
    populateTaskActivityOptions(currentGroupId, currentActivityId);
    populateTaskTeamOptions(currentActivityId, currentTeamId);
    populateMilestoneTaskDivisionOptions(document.getElementById("milestone-task-division") ? document.getElementById("milestone-task-division").value : "");
    populateMilestoneTaskGroupOptions(document.getElementById("milestone-task-division") ? document.getElementById("milestone-task-division").value : "", document.getElementById("milestone-task-group") ? document.getElementById("milestone-task-group").value : "");
    populateMilestoneTaskActivityOptions(document.getElementById("milestone-task-group") ? document.getElementById("milestone-task-group").value : "", document.getElementById("milestone-task-activity") ? document.getElementById("milestone-task-activity").value : "");
    populateMilestoneTaskTeamOptions(document.getElementById("milestone-task-activity") ? document.getElementById("milestone-task-activity").value : "", document.getElementById("milestone-task-team") ? document.getElementById("milestone-task-team").value : "");
    populateEditUserScopeDivisionOptions("");
    populateEditUserScopeGroupOptions("", "");
    populateEditUserScopeActivityOptions("", "");
    populateEditUserScopeTeamOptions("", "");
    refreshAddMemberHierarchySelectors();
    refreshDeleteHierarchySelectors();
    if (currentTeamIdForView) {
        syncCreateTaskTeamToView();
    } else {
        setTaskCreateDetailsEnabled(!!currentTeamId);
    }
}

function populateTaskDivisionOptions(selectedDivisionId) {
    var divisionSelect = document.getElementById("task-division");
    if (!divisionSelect) return;
    var currentValue = selectedDivisionId || divisionSelect.value || "";
    divisionSelect.innerHTML = "";
    addOption(divisionSelect, "", "Select division", false);
    (taskCreateHierarchy.divisions || []).forEach(function (division) {
        addOption(divisionSelect, division.id, division.name, String(currentValue) === String(division.id));
    });
    divisionSelect.value = currentValue ? String(currentValue) : "";
    populateTaskGroupOptions(divisionSelect.value, "");
}

function populateTaskGroupOptions(divisionId, selectedGroupId) {
    var groupSelect = document.getElementById("task-group");
    if (!groupSelect) return;
    var groups = divisionId ? (taskCreateHierarchy.groupsByDivision[String(divisionId)] || []) : [];
    groupSelect.innerHTML = "";
    addOption(groupSelect, "", divisionId ? "Select group" : "Select division first", false);
    groups.forEach(function (group) {
        addOption(groupSelect, group.id, group.name, String(selectedGroupId) === String(group.id));
    });
    groupSelect.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateTaskActivityOptions(groupId, selectedActivityId) {
    var activitySelect = document.getElementById("task-activity");
    if (!activitySelect) return;
    var activities = groupId ? (taskCreateHierarchy.activitiesByGroup[String(groupId)] || []) : [];
    activitySelect.innerHTML = "";
    addOption(activitySelect, "", groupId ? "Select activity or project" : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(activitySelect, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId) === String(activity.id));
    });
    activitySelect.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateTaskTeamOptions(activityId, selectedTeamId) {
    var teamSelect = document.getElementById("task-team");
    if (!teamSelect) return;
    var teams = activityId ? (taskCreateHierarchy.teamsByActivity[String(activityId)] || []) : [];
    teamSelect.innerHTML = "";
    addOption(teamSelect, "", activityId ? "Select team" : "Select activity or project first", false);
    teams.forEach(function (team) {
        addOption(teamSelect, team.id, team.name, String(selectedTeamId) === String(team.id));
    });
    teamSelect.value = selectedTeamId ? String(selectedTeamId) : "";
}

function initializeAddMemberHierarchyBindings() {
    var divisionSelect = document.getElementById("add-member-division");
    var groupSelect = document.getElementById("add-member-group");
    var activitySelect = document.getElementById("add-member-activity");
    var teamSelect = document.getElementById("add-member-team");

    if (divisionSelect && !divisionSelect._bound) {
        divisionSelect._bound = true;
        divisionSelect.addEventListener("change", function () {
            populateAddMemberGroupOptions(divisionSelect.value, "");
            populateAddMemberActivityOptions("", "");
            populateAddMemberTeamOptions("", "");
        });
    }
    if (groupSelect && !groupSelect._bound) {
        groupSelect._bound = true;
        groupSelect.addEventListener("change", function () {
            populateAddMemberActivityOptions(groupSelect.value, "");
            populateAddMemberTeamOptions("", "");
        });
    }
    if (activitySelect && !activitySelect._bound) {
        activitySelect._bound = true;
        activitySelect.addEventListener("change", function () {
            populateAddMemberTeamOptions(activitySelect.value, "");
        });
    }
}

function getManageableTeamOptions(activityId) {
    var teams = activityId ? (taskCreateHierarchy.teamsByActivity[String(activityId)] || []) : [];
    return teams.filter(function (team) {
        return !!addMemberManageableTeamIds[String(team.id)];
    });
}

function getManageableActivityOptions(groupId) {
    var activities = groupId ? (taskCreateHierarchy.activitiesByGroup[String(groupId)] || []) : [];
    return activities.filter(function (activity) {
        return getManageableTeamOptions(activity.id).length > 0;
    });
}

function getManageableGroupOptions(divisionId) {
    var groups = divisionId ? (taskCreateHierarchy.groupsByDivision[String(divisionId)] || []) : [];
    return groups.filter(function (group) {
        return getManageableActivityOptions(group.id).length > 0;
    });
}

function getManageableDivisionOptions() {
    return (taskCreateHierarchy.divisions || []).filter(function (division) {
        return getManageableGroupOptions(division.id).length > 0;
    });
}

function populateAddMemberDivisionOptions(selectedDivisionId) {
    var divisionSelect = document.getElementById("add-member-division");
    if (!divisionSelect) return;
    var divisions = getManageableDivisionOptions();
    divisionSelect.innerHTML = "";
    addOption(divisionSelect, "", divisions.length ? "Select division" : "No teams to manage", false);
    divisions.forEach(function (division) {
        addOption(divisionSelect, division.id, division.name, String(selectedDivisionId) === String(division.id));
    });
    divisionSelect.disabled = divisions.length === 0;
    divisionSelect.value = selectedDivisionId ? String(selectedDivisionId) : "";
}

function populateAddMemberGroupOptions(divisionId, selectedGroupId) {
    var groupSelect = document.getElementById("add-member-group");
    if (!groupSelect) return;
    var groups = getManageableGroupOptions(divisionId);
    groupSelect.innerHTML = "";
    addOption(groupSelect, "", divisionId ? (groups.length ? "Select group" : "No groups available") : "Select division first", false);
    groups.forEach(function (group) {
        addOption(groupSelect, group.id, group.name, String(selectedGroupId) === String(group.id));
    });
    groupSelect.disabled = !divisionId || groups.length === 0;
    groupSelect.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateAddMemberActivityOptions(groupId, selectedActivityId) {
    var activitySelect = document.getElementById("add-member-activity");
    if (!activitySelect) return;
    var activities = getManageableActivityOptions(groupId);
    activitySelect.innerHTML = "";
    addOption(activitySelect, "", groupId ? (activities.length ? "Select activity or project" : "No activities/projects available") : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(activitySelect, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId) === String(activity.id));
    });
    activitySelect.disabled = !groupId || activities.length === 0;
    activitySelect.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateAddMemberTeamOptions(activityId, selectedTeamId) {
    var teamSelect = document.getElementById("add-member-team");
    if (!teamSelect) return;
    var teams = getManageableTeamOptions(activityId);
    teamSelect.innerHTML = "";
    addOption(teamSelect, "", activityId ? (teams.length ? "Select team" : "No teams available") : "Select activity or project first", false);
    teams.forEach(function (team) {
        addOption(teamSelect, team.id, team.name, String(selectedTeamId) === String(team.id));
    });
    teamSelect.disabled = !activityId || teams.length === 0;
    teamSelect.value = selectedTeamId ? String(selectedTeamId) : "";
}

function refreshAddMemberHierarchySelectors() {
    var divisionId = document.getElementById("add-member-division") ? document.getElementById("add-member-division").value : "";
    var groupId = document.getElementById("add-member-group") ? document.getElementById("add-member-group").value : "";
    var activityId = document.getElementById("add-member-activity") ? document.getElementById("add-member-activity").value : "";
    var teamId = document.getElementById("add-member-team") ? document.getElementById("add-member-team").value : "";

    initializeAddMemberHierarchyBindings();
    populateAddMemberDivisionOptions(divisionId);
    populateAddMemberGroupOptions(divisionId, groupId);
    populateAddMemberActivityOptions(groupId, activityId);
    populateAddMemberTeamOptions(activityId, teamId);
}

function initializeRemoveMemberActionBindings() {
    var actionSelect = document.getElementById("remove-member-action");
    var sourceDivisionSelect = document.getElementById("remove-member-division");
    var sourceGroupSelect = document.getElementById("remove-member-group");
    var sourceActivitySelect = document.getElementById("remove-member-activity");
    var sourceTeamSelect = document.getElementById("remove-member-team");
    var divisionSelect = document.getElementById("remove-member-target-division");
    var groupSelect = document.getElementById("remove-member-target-group");
    var activitySelect = document.getElementById("remove-member-target-activity");

    if (actionSelect && !actionSelect._bound) {
        actionSelect._bound = true;
        actionSelect.addEventListener("change", function () {
            toggleRemoveMemberShiftTargets();
        });
    }
    if (sourceDivisionSelect && !sourceDivisionSelect._bound) {
        sourceDivisionSelect._bound = true;
        sourceDivisionSelect.addEventListener("change", function () {
            refreshRemoveMemberSourceHierarchySelectors();
        });
    }
    if (sourceGroupSelect && !sourceGroupSelect._bound) {
        sourceGroupSelect._bound = true;
        sourceGroupSelect.addEventListener("change", function () {
            refreshRemoveMemberSourceHierarchySelectors();
        });
    }
    if (sourceActivitySelect && !sourceActivitySelect._bound) {
        sourceActivitySelect._bound = true;
        sourceActivitySelect.addEventListener("change", function () {
            refreshRemoveMemberSourceHierarchySelectors();
        });
    }
    if (sourceTeamSelect && !sourceTeamSelect._bound) {
        sourceTeamSelect._bound = true;
        sourceTeamSelect.addEventListener("change", function () {
            loadMembersForRemovalScope();
        });
    }
    if (divisionSelect && !divisionSelect._bound) {
        divisionSelect._bound = true;
        divisionSelect.addEventListener("change", function () {
            populateRemoveMemberTargetGroupOptions(divisionSelect.value, "");
            populateRemoveMemberTargetActivityOptions("", "");
            populateRemoveMemberTargetTeamOptions("", "");
        });
    }
    if (groupSelect && !groupSelect._bound) {
        groupSelect._bound = true;
        groupSelect.addEventListener("change", function () {
            populateRemoveMemberTargetActivityOptions(groupSelect.value, "");
            populateRemoveMemberTargetTeamOptions("", "");
        });
    }
    if (activitySelect && !activitySelect._bound) {
        activitySelect._bound = true;
        activitySelect.addEventListener("change", function () {
            populateRemoveMemberTargetTeamOptions(activitySelect.value, "");
        });
    }
}

function populateRemoveMemberDivisionOptions(selectedDivisionId) {
    var divisionSelect = document.getElementById("remove-member-division");
    if (!divisionSelect) return;
    var divisions = getManageableDivisionOptions();
    divisionSelect.innerHTML = "";
    addOption(divisionSelect, "", divisions.length ? "Select division" : "No divisions available", false);
    divisions.forEach(function (division) {
        addOption(divisionSelect, division.id, division.name, String(selectedDivisionId) === String(division.id));
    });
    divisionSelect.disabled = divisions.length === 0;
    divisionSelect.value = selectedDivisionId ? String(selectedDivisionId) : "";
}

function populateRemoveMemberGroupOptions(divisionId, selectedGroupId) {
    var groupSelect = document.getElementById("remove-member-group");
    if (!groupSelect) return;
    var groups = getManageableGroupOptions(divisionId);
    groupSelect.innerHTML = "";
    addOption(groupSelect, "", divisionId ? (groups.length ? "Select group" : "No groups available") : "Select division first", false);
    groups.forEach(function (group) {
        addOption(groupSelect, group.id, group.name, String(selectedGroupId) === String(group.id));
    });
    groupSelect.disabled = !divisionId || groups.length === 0;
    groupSelect.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateRemoveMemberActivityOptions(groupId, selectedActivityId) {
    var activitySelect = document.getElementById("remove-member-activity");
    if (!activitySelect) return;
    var activities = getManageableActivityOptions(groupId);
    activitySelect.innerHTML = "";
    addOption(activitySelect, "", groupId ? (activities.length ? "Select activity or project" : "No activities/projects available") : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(activitySelect, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId) === String(activity.id));
    });
    activitySelect.disabled = !groupId || activities.length === 0;
    activitySelect.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateRemoveMemberTeamOptions(activityId, selectedTeamId) {
    var teamSelect = document.getElementById("remove-member-team");
    if (!teamSelect) return;
    var teams = getManageableTeamOptions(activityId);
    teamSelect.innerHTML = "";
    addOption(teamSelect, "", activityId ? "All teams in selected activity / project" : "Optional: select team", !selectedTeamId);
    teams.forEach(function (team) {
        addOption(teamSelect, team.id, team.name, String(selectedTeamId) === String(team.id));
    });
    teamSelect.disabled = !activityId && teams.length === 0;
    teamSelect.value = selectedTeamId ? String(selectedTeamId) : "";
}

function refreshRemoveMemberSourceHierarchySelectors() {
    var divisionId = document.getElementById("remove-member-division") ? document.getElementById("remove-member-division").value : "";
    var groupId = document.getElementById("remove-member-group") ? document.getElementById("remove-member-group").value : "";
    var activityId = document.getElementById("remove-member-activity") ? document.getElementById("remove-member-activity").value : "";
    var teamId = document.getElementById("remove-member-team") ? document.getElementById("remove-member-team").value : "";

    initializeRemoveMemberActionBindings();
    populateRemoveMemberDivisionOptions(divisionId);
    populateRemoveMemberGroupOptions(divisionId, groupId);
    populateRemoveMemberActivityOptions(groupId, activityId);
    populateRemoveMemberTeamOptions(activityId, teamId);
    loadMembersForRemovalScope();
}

function getRemoveScopeTeamIds() {
    var divisionId = document.getElementById("remove-member-division") ? document.getElementById("remove-member-division").value : "";
    var groupId = document.getElementById("remove-member-group") ? document.getElementById("remove-member-group").value : "";
    var activityId = document.getElementById("remove-member-activity") ? document.getElementById("remove-member-activity").value : "";
    var teamId = document.getElementById("remove-member-team") ? document.getElementById("remove-member-team").value : "";

    if (teamId) return [parseInt(teamId, 10)];
    if (activityId) {
        return getManageableTeamOptions(activityId).map(function (team) { return parseInt(team.id, 10); }).filter(Boolean);
    }
    if (groupId) {
        return getManageableActivityOptions(groupId).reduce(function (acc, activity) {
            return acc.concat(getManageableTeamOptions(activity.id).map(function (team) { return parseInt(team.id, 10); }).filter(Boolean));
        }, []);
    }
    if (divisionId) {
        return getManageableGroupOptions(divisionId).reduce(function (acc, group) {
            return acc.concat(getManageableActivityOptions(group.id).reduce(function (activityAcc, activity) {
                return activityAcc.concat(getManageableTeamOptions(activity.id).map(function (team) { return parseInt(team.id, 10); }).filter(Boolean));
            }, []));
        }, []);
    }
    return [];
}

function toggleRemoveMemberShiftTargets() {
    var actionSelect = document.getElementById("remove-member-action");
    var wrap = document.getElementById("remove-member-shift-targets");
    var isShift = actionSelect && actionSelect.value === "shift";
    if (wrap) wrap.hidden = !isShift;
    if (isShift) {
        refreshRemoveMemberTargetHierarchySelectors();
    }
}

function populateRemoveMemberTargetDivisionOptions(selectedDivisionId) {
    var divisionSelect = document.getElementById("remove-member-target-division");
    if (!divisionSelect) return;
    var divisions = getManageableDivisionOptions();
    divisionSelect.innerHTML = "";
    addOption(divisionSelect, "", divisions.length ? "Select division" : "No destination teams available", false);
    divisions.forEach(function (division) {
        addOption(divisionSelect, division.id, division.name, String(selectedDivisionId) === String(division.id));
    });
    divisionSelect.disabled = divisions.length === 0;
    divisionSelect.value = selectedDivisionId ? String(selectedDivisionId) : "";
}

function populateRemoveMemberTargetGroupOptions(divisionId, selectedGroupId) {
    var groupSelect = document.getElementById("remove-member-target-group");
    if (!groupSelect) return;
    var groups = getManageableGroupOptions(divisionId);
    groupSelect.innerHTML = "";
    addOption(groupSelect, "", divisionId ? (groups.length ? "Select group" : "No groups available") : "Select division first", false);
    groups.forEach(function (group) {
        addOption(groupSelect, group.id, group.name, String(selectedGroupId) === String(group.id));
    });
    groupSelect.disabled = !divisionId || groups.length === 0;
    groupSelect.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateRemoveMemberTargetActivityOptions(groupId, selectedActivityId) {
    var activitySelect = document.getElementById("remove-member-target-activity");
    if (!activitySelect) return;
    var activities = getManageableActivityOptions(groupId);
    activitySelect.innerHTML = "";
    addOption(activitySelect, "", groupId ? (activities.length ? "Select activity or project" : "No activities/projects available") : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(activitySelect, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId) === String(activity.id));
    });
    activitySelect.disabled = !groupId || activities.length === 0;
    activitySelect.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateRemoveMemberTargetTeamOptions(activityId, selectedTeamId) {
    var teamSelect = document.getElementById("remove-member-target-team");
    if (!teamSelect) return;
    var teams = getManageableTeamOptions(activityId);
    teamSelect.innerHTML = "";
    addOption(teamSelect, "", activityId ? (teams.length ? "Select team" : "No teams available") : "Select activity or project first", false);
    teams.forEach(function (team) {
        addOption(teamSelect, team.id, team.name, String(selectedTeamId) === String(team.id));
    });
    teamSelect.disabled = !activityId || teams.length === 0;
    teamSelect.value = selectedTeamId ? String(selectedTeamId) : "";
}

function refreshRemoveMemberTargetHierarchySelectors() {
    var divisionId = document.getElementById("remove-member-target-division") ? document.getElementById("remove-member-target-division").value : "";
    var groupId = document.getElementById("remove-member-target-group") ? document.getElementById("remove-member-target-group").value : "";
    var activityId = document.getElementById("remove-member-target-activity") ? document.getElementById("remove-member-target-activity").value : "";
    var teamId = document.getElementById("remove-member-target-team") ? document.getElementById("remove-member-target-team").value : "";

    initializeRemoveMemberActionBindings();
    populateRemoveMemberTargetDivisionOptions(divisionId);
    populateRemoveMemberTargetGroupOptions(divisionId, groupId);
    populateRemoveMemberTargetActivityOptions(groupId, activityId);
    populateRemoveMemberTargetTeamOptions(activityId, teamId);
}

function renderRemoveMemberList(members) {
    var listEl = document.getElementById("remove-member-user-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!members || members.length === 0) {
        listEl.innerHTML = '<div class="member-bulk-empty">No members in selected scope</div>';
        return;
    }
    members.forEach(function (member) {
        var item = document.createElement("label");
        item.className = "member-bulk-item";
        item.innerHTML =
            '<input type="checkbox" class="remove-member-checkbox" value="' + member.id + '">' +
            '<span class="member-bulk-label">' +
            renderUserLabelHtml(member.username, member.designation, "User " + member.id) +
            '<span class="member-bulk-meta">ID: ' + escapeHtml(formatUserIdDisplay(member.id)) + ' | Role: ' + escapeHtml(member.role || "Member") + ' | Teams in scope: ' + escapeHtml(String((member.scopeTeamIds || []).length || 1)) + '</span>' +
            '</span>';
        listEl.appendChild(item);
    });
}

function getSelectedRemoveMembers() {
    var listEl = document.getElementById("remove-member-user-list");
    if (!listEl) return [];
    var selectedIds = Array.prototype.slice.call(listEl.querySelectorAll(".remove-member-checkbox:checked")).map(function (el) {
        return parseInt(el.value, 10);
    }).filter(Boolean);
    return removeMemberLoadedMembers.filter(function (member) {
        return selectedIds.indexOf(member.id) !== -1;
    });
}

function getFilterStatus() {
    var v = document.getElementById("filter-status");
    return v && v.value ? v.value : null;
}

function getFilterAssigned() {
    var v = document.getElementById("filter-assigned");
    return v && v.value ? parseInt(v.value, 10) : null;
}

function setTasksViewMode(mode) {
    tasksViewMode = mode === "calendar" ? "calendar" : "table";
    var tableCard = document.getElementById("tasks-table-card");
    var groupsEl = document.getElementById("tasks-table-groups");
    var unassignedCard = document.getElementById("unassigned-tasks-card");
    var calendarCard = document.getElementById("tasks-calendar-card");
    var milestonesCard = document.getElementById("milestones-card");
    var quickNavSection = document.getElementById("quick-nav-section");
    var tasksTitle = document.querySelector("#tasks .section-title");
    var hierarchyToggle = document.querySelector("#tasks .tasks-hierarchy-toggle");
    var filterStatus = document.getElementById("filter-status");
    var filterAssigned = document.getElementById("filter-assigned");
    var daysLeftMode = document.getElementById("days-left-display-mode");
    var btnTable = document.getElementById("tasks-view-table");
    var btnCalendar = document.getElementById("tasks-view-calendar");
    if (tableCard) {
        tableCard.hidden = tasksViewMode === "calendar";
        tableCard.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (groupsEl) {
        groupsEl.hidden = tasksViewMode === "calendar";
        groupsEl.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (unassignedCard) {
        unassignedCard.hidden = tasksViewMode === "calendar";
        unassignedCard.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (calendarCard) {
        calendarCard.hidden = tasksViewMode === "table";
        calendarCard.style.display = tasksViewMode === "table" ? "none" : "";
    }
    if (milestonesCard) {
        milestonesCard.hidden = tasksViewMode === "calendar";
        milestonesCard.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (quickNavSection) {
        quickNavSection.hidden = tasksViewMode === "calendar";
        quickNavSection.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (tasksTitle) {
        tasksTitle.textContent = tasksViewMode === "calendar" ? "Calendar View" : "Tasks";
    }
    if (hierarchyToggle) {
        hierarchyToggle.hidden = tasksViewMode === "calendar";
        hierarchyToggle.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (filterStatus) {
        filterStatus.hidden = tasksViewMode === "calendar";
        filterStatus.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (filterAssigned) {
        filterAssigned.hidden = tasksViewMode === "calendar";
        filterAssigned.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (daysLeftMode) {
        daysLeftMode.hidden = tasksViewMode === "calendar";
        daysLeftMode.style.display = tasksViewMode === "calendar" ? "none" : "";
    }
    if (btnTable) {
        btnTable.classList.toggle("tasks-view-btn--active", tasksViewMode === "table");
        btnTable.setAttribute("aria-selected", tasksViewMode === "table" ? "true" : "false");
    }
    if (btnCalendar) {
        btnCalendar.classList.toggle("tasks-view-btn--active", tasksViewMode === "calendar");
        btnCalendar.setAttribute("aria-selected", tasksViewMode === "calendar" ? "true" : "false");
    }
    if (tasksViewMode === "calendar") {
        renderCalendarView(lastLoadedTasks);
        return;
    }
    loadTasks();
}

function setTaskHierarchyLevel(level) {
    currentTaskHierarchyLevel = level === "L2" || level === "L3" ? level : "L1";
    ["L1", "L2", "L3"].forEach(function (item) {
        var btn = document.getElementById("tasks-hierarchy-" + item.toLowerCase());
        if (!btn) return;
        var isActive = item === currentTaskHierarchyLevel;
        btn.classList.toggle("tasks-hierarchy-btn--active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    loadTasks();
}

function flattenTasksForCalendar(tasks) {
    var flat = [];
    (tasks || []).forEach(function (task) {
        if (!task) return;
        flat.push(task);
        if (task.subtasks && task.subtasks.length > 0) {
            flat = flat.concat(flattenTasksForCalendar(task.subtasks));
        }
    });
    return flat;
}

function formatDependencyTaskOptionLabel(task) {
    if (!task) return "";
    var title = String(task.title || ("Task " + task.id));
    var due = task.due_date ? (" | Due: " + String(task.due_date).slice(0, 10)) : "";
    return "#" + task.id + " - " + title + due;
}

function buildDependencyTaskOptions(tasks) {
    return flattenTasksForCalendar(tasks || []).map(function (task) {
        return {
            id: task.id,
            title: task.title || ("Task " + task.id),
            due_date: task.due_date || null
        };
    }).sort(function (a, b) {
        return String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" });
    });
}

function fillDependencySelect(selectEl, selectedValue, excludeTaskId) {
    if (!selectEl) return;
    var exclude = excludeTaskId ? parseInt(excludeTaskId, 10) : null;
    var current = selectedValue != null && selectedValue !== "" ? String(selectedValue) : "";
    var html = '<option value="">None</option>';
    (dependencyTaskOptions || []).forEach(function (item) {
        if (!item || !item.id) return;
        if (exclude && parseInt(item.id, 10) === exclude) return;
        var value = String(item.id);
        var selected = current && current === value ? " selected" : "";
        html += '<option value="' + value + '"' + selected + '>' + escapeHtml(formatDependencyTaskOptionLabel(item)) + '</option>';
    });
    selectEl.innerHTML = html;
}

function refreshDependencyTaskSelectors(excludeTaskIdForSubtask) {
    dependencyTaskOptions = buildDependencyTaskOptions(lastLoadedTasks || []);

    var taskStartEl = document.getElementById("task-start-dependency-task");
    var taskFinishEl = document.getElementById("task-finish-dependency-task");
    fillDependencySelect(taskStartEl, taskStartEl ? taskStartEl.value : "", null);
    fillDependencySelect(taskFinishEl, taskFinishEl ? taskFinishEl.value : "", null);

    var subStartEl = document.getElementById("subtask-start-dependency-task");
    var subFinishEl = document.getElementById("subtask-finish-dependency-task");
    fillDependencySelect(subStartEl, subStartEl ? subStartEl.value : "", excludeTaskIdForSubtask || null);
    fillDependencySelect(subFinishEl, subFinishEl ? subFinishEl.value : "", excludeTaskIdForSubtask || null);

    var editStartEl = document.getElementById("edit-task-start-dependency-task");
    var editFinishEl = document.getElementById("edit-task-finish-dependency-task");
    var editExcludeId = currentEditTaskRecord ? currentEditTaskRecord.id : null;
    fillDependencySelect(editStartEl, editStartEl ? editStartEl.value : "", editExcludeId);
    fillDependencySelect(editFinishEl, editFinishEl ? editFinishEl.value : "", editExcludeId);

    var milestoneStartEl = document.getElementById("milestone-start-dependency-task");
    var milestoneFinishEl = document.getElementById("milestone-finish-dependency-task");
    fillDependencySelect(milestoneStartEl, milestoneStartEl ? milestoneStartEl.value : "", null);
    fillDependencySelect(milestoneFinishEl, milestoneFinishEl ? milestoneFinishEl.value : "", null);
}

function toggleTaskDependencyFields() {
    var enabled = !!(document.getElementById("task-has-dependency") && document.getElementById("task-has-dependency").checked);
    var startWrap = document.getElementById("task-start-dependency-wrap");
    var finishWrap = document.getElementById("task-finish-dependency-wrap");
    if (startWrap) startWrap.style.display = enabled ? "" : "none";
    if (finishWrap) finishWrap.style.display = enabled ? "" : "none";
    if (!enabled) {
        toggleDependencyOffsetInput("task", "start", false);
        toggleDependencyOffsetInput("task", "finish", false);
    } else {
        toggleDependencyOffsetInput("task", "start");
        toggleDependencyOffsetInput("task", "finish");
    }
    if (enabled) refreshDependencyTaskSelectors();
}

function toggleSubtaskDependencyFields(excludeTaskId) {
    var enabled = !!(document.getElementById("subtask-has-dependency") && document.getElementById("subtask-has-dependency").checked);
    var startWrap = document.getElementById("subtask-start-dependency-wrap");
    var finishWrap = document.getElementById("subtask-finish-dependency-wrap");
    if (startWrap) startWrap.style.display = enabled ? "" : "none";
    if (finishWrap) finishWrap.style.display = enabled ? "" : "none";
    if (enabled) refreshDependencyTaskSelectors(excludeTaskId || null);
}

function toggleMilestoneDependencyFields() {
    var enabled = !!(document.getElementById("milestone-has-dependency") && document.getElementById("milestone-has-dependency").checked);
    var startWrap = document.getElementById("milestone-start-dependency-wrap");
    var finishWrap = document.getElementById("milestone-finish-dependency-wrap");
    if (startWrap) startWrap.style.display = enabled ? "" : "none";
    if (finishWrap) finishWrap.style.display = enabled ? "" : "none";
    if (enabled) refreshDependencyTaskSelectors();
}

function populateMilestoneTaskDivisionOptions(selectedDivisionId) {
    var select = document.getElementById("milestone-task-division");
    if (!select) return;
    var currentValue = selectedDivisionId || select.value || "";
    select.innerHTML = "";
    addOption(select, "", "Select division", false);
    (taskCreateHierarchy.divisions || []).forEach(function (division) {
        addOption(select, division.id, division.name, String(currentValue) === String(division.id));
    });
    select.value = currentValue ? String(currentValue) : "";
}

function populateMilestoneTaskGroupOptions(divisionId, selectedGroupId) {
    var select = document.getElementById("milestone-task-group");
    if (!select) return;
    var groups = divisionId ? (taskCreateHierarchy.groupsByDivision[String(divisionId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", divisionId ? "Select group" : "Select division first", false);
    groups.forEach(function (group) {
        addOption(select, group.id, group.name, String(selectedGroupId || "") === String(group.id));
    });
    select.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateMilestoneTaskActivityOptions(groupId, selectedActivityId) {
    var select = document.getElementById("milestone-task-activity");
    if (!select) return;
    var activities = groupId ? (taskCreateHierarchy.activitiesByGroup[String(groupId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", groupId ? "Select activity / project" : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(select, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId || "") === String(activity.id));
    });
    select.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateMilestoneTaskTeamOptions(activityId, selectedTeamId) {
    var select = document.getElementById("milestone-task-team");
    if (!select) return;
    var teams = activityId ? (taskCreateHierarchy.teamsByActivity[String(activityId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", activityId ? "Select team" : "Select activity or project first", false);
    teams.forEach(function (team) {
        addOption(select, team.id, team.name, String(selectedTeamId || "") === String(team.id));
    });
    select.value = selectedTeamId ? String(selectedTeamId) : "";
}

function populateMilestoneTaskParentLevel1Options(selectedTaskId) {
    var select = document.getElementById("milestone-task-parent-level-1");
    if (!select) return;
    var topLevelTasks = (lastLoadedTasks || []).filter(function (task) {
        return task && task.id && !task.parent_task_id;
    });
    select.innerHTML = "";
    addOption(select, "", "Select parent task", false);
    topLevelTasks.forEach(function (task) {
        addOption(select, task.id, task.title || ("Task " + task.id), String(selectedTaskId || "") === String(task.id));
    });
    select.value = selectedTaskId ? String(selectedTaskId) : "";
}

function populateMilestoneTaskParentLevel2Options(parentTaskId, selectedSubtaskId) {
    var select = document.getElementById("milestone-task-parent-level-2");
    if (!select) return;
    var parentTask = parentTaskId ? findTaskByIdInTree(lastLoadedTasks || [], parseInt(parentTaskId, 10)) : null;
    var subtasks = parentTask && Array.isArray(parentTask.subtasks) ? parentTask.subtasks : [];
    select.innerHTML = "";
    addOption(select, "", parentTaskId ? "Select subtask" : "Select parent task first", false);
    subtasks.forEach(function (task) {
        addOption(select, task.id, task.title || ("Task " + task.id), String(selectedSubtaskId || "") === String(task.id));
    });
    select.value = selectedSubtaskId ? String(selectedSubtaskId) : "";
}

function initializeMilestoneTaskHierarchyBindings() {
    var divisionSelect = document.getElementById("milestone-task-division");
    var groupSelect = document.getElementById("milestone-task-group");
    var activitySelect = document.getElementById("milestone-task-activity");
    if (divisionSelect && !divisionSelect._milestoneBound) {
        divisionSelect._milestoneBound = true;
        divisionSelect.addEventListener("change", function () {
            populateMilestoneTaskGroupOptions(divisionSelect.value, "");
            populateMilestoneTaskActivityOptions("", "");
            populateMilestoneTaskTeamOptions("", "");
        });
    }
    if (groupSelect && !groupSelect._milestoneBound) {
        groupSelect._milestoneBound = true;
        groupSelect.addEventListener("change", function () {
            populateMilestoneTaskActivityOptions(groupSelect.value, "");
            populateMilestoneTaskTeamOptions("", "");
        });
    }
    if (activitySelect && !activitySelect._milestoneBound) {
        activitySelect._milestoneBound = true;
        activitySelect.addEventListener("change", function () {
            populateMilestoneTaskTeamOptions(activitySelect.value, "");
        });
    }
}

function onMilestoneTaskParentLevel1Change() {
    populateMilestoneTaskParentLevel2Options(document.getElementById("milestone-task-parent-level-1").value, "");
    toggleMilestoneTaskCreationFields();
}

function onMilestoneTaskParentLevel2Change() {
    toggleMilestoneTaskCreationFields();
}

function toggleMilestoneTaskCreationFields() {
    var enabled = !!(document.getElementById("milestone-create-linked-task") && document.getElementById("milestone-create-linked-task").checked);
    var levelEl = document.getElementById("milestone-task-level");
    var level = levelEl ? String(levelEl.value || "task") : "task";
    var wrap = document.getElementById("milestone-task-create-wrap");
    var mainWrap = document.getElementById("milestone-task-main-scope-wrap");
    var parentWrap = document.getElementById("milestone-task-parent-scope-wrap");
    var parentLevel2Wrap = document.getElementById("milestone-task-parent-level-2-wrap");
    if (wrap) wrap.style.display = enabled ? "" : "none";
    if (mainWrap) mainWrap.style.display = enabled && level === "task" ? "" : "none";
    if (parentWrap) parentWrap.style.display = enabled && level !== "task" ? "" : "none";
    if (parentLevel2Wrap) parentLevel2Wrap.style.display = enabled && level === "subsubtask" ? "" : "none";
    if (!enabled) return;
    initializeMilestoneTaskHierarchyBindings();
    populateMilestoneTaskDivisionOptions(document.getElementById("milestone-task-division") ? document.getElementById("milestone-task-division").value : "");
    populateMilestoneTaskGroupOptions(document.getElementById("milestone-task-division") ? document.getElementById("milestone-task-division").value : "", document.getElementById("milestone-task-group") ? document.getElementById("milestone-task-group").value : "");
    populateMilestoneTaskActivityOptions(document.getElementById("milestone-task-group") ? document.getElementById("milestone-task-group").value : "", document.getElementById("milestone-task-activity") ? document.getElementById("milestone-task-activity").value : "");
    populateMilestoneTaskTeamOptions(document.getElementById("milestone-task-activity") ? document.getElementById("milestone-task-activity").value : "", document.getElementById("milestone-task-team") ? document.getElementById("milestone-task-team").value : "");
    populateMilestoneTaskParentLevel1Options(document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "");
    populateMilestoneTaskParentLevel2Options(document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "", document.getElementById("milestone-task-parent-level-2") ? document.getElementById("milestone-task-parent-level-2").value : "");
}

function collectMilestoneTaskCreationPayload(milestoneName, milestoneDate) {
    var enabled = !!(document.getElementById("milestone-create-linked-task") && document.getElementById("milestone-create-linked-task").checked);
    if (!enabled) return null;
    var levelEl = document.getElementById("milestone-task-level");
    var level = levelEl ? String(levelEl.value || "task") : "task";
    var payload = {
        title: milestoneName,
        due_date: milestoneDate,
        priority: "Medium",
        status: "To Do",
        task_type: "Infrastructure Development",
        task_schedule_type: "Time Bound"
    };

    if (level === "task") {
        var activityId = document.getElementById("milestone-task-activity") ? document.getElementById("milestone-task-activity").value : "";
        var teamId = document.getElementById("milestone-task-team") ? document.getElementById("milestone-task-team").value : "";
        if (!activityId) {
            showToast("Select an activity or project for the linked task", true);
            return null;
        }
        if (!teamId) {
            showToast("Select a team for the linked task", true);
            return null;
        }
        payload.activity_id = parseInt(activityId, 10);
        payload.team_id = parseInt(teamId, 10);
        payload.parent_task_id = null;
        return payload;
    }

    var parentTaskId = document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "";
    if (!parentTaskId) {
        showToast("Select the parent task", true);
        return null;
    }
    if (level === "subtask") {
        payload.parent_task_id = parseInt(parentTaskId, 10);
        return payload;
    }

    var parentSubtaskId = document.getElementById("milestone-task-parent-level-2") ? document.getElementById("milestone-task-parent-level-2").value : "";
    if (!parentSubtaskId) {
        showToast("Select the parent subtask", true);
        return null;
    }
    payload.parent_task_id = parseInt(parentSubtaskId, 10);
    return payload;
}

function resetMilestoneTaskCreationForm() {
    var createAsTask = document.getElementById("milestone-create-linked-task");
    var level = document.getElementById("milestone-task-level");
    var division = document.getElementById("milestone-task-division");
    var group = document.getElementById("milestone-task-group");
    var activity = document.getElementById("milestone-task-activity");
    var team = document.getElementById("milestone-task-team");
    var parentTask = document.getElementById("milestone-task-parent-level-1");
    var parentSubtask = document.getElementById("milestone-task-parent-level-2");
    if (createAsTask) createAsTask.checked = false;
    if (level) level.value = "task";
    if (division) division.value = "";
    populateMilestoneTaskGroupOptions("", "");
    populateMilestoneTaskActivityOptions("", "");
    populateMilestoneTaskTeamOptions("", "");
    populateMilestoneTaskParentLevel1Options("");
    populateMilestoneTaskParentLevel2Options("", "");
    if (group) group.value = "";
    if (activity) activity.value = "";
    if (team) team.value = "";
    if (parentTask) parentTask.value = "";
    if (parentSubtask) parentSubtask.value = "";
    toggleMilestoneTaskCreationFields();
}

function collectDependencyPayload(prefix) {
    var hasDependencyEl = document.getElementById(prefix + "-has-dependency");
    var startTaskEl = document.getElementById(prefix + "-start-dependency-task");
    var startEventEl = document.getElementById(prefix + "-start-dependency-event");
    var startOffsetEnabledEl = document.getElementById(prefix + "-start-dependency-offset-enabled");
    var startOffsetDaysEl = document.getElementById(prefix + "-start-dependency-offset-days");
    var finishTaskEl = document.getElementById(prefix + "-finish-dependency-task");
    var finishEventEl = document.getElementById(prefix + "-finish-dependency-event");
    var finishOffsetEnabledEl = document.getElementById(prefix + "-finish-dependency-offset-enabled");
    var finishOffsetDaysEl = document.getElementById(prefix + "-finish-dependency-offset-days");
    var hasDependency = !!(hasDependencyEl && hasDependencyEl.checked);
    var startTaskId = startTaskEl && startTaskEl.value ? parseInt(startTaskEl.value, 10) : null;
    var finishTaskId = finishTaskEl && finishTaskEl.value ? parseInt(finishTaskEl.value, 10) : null;
    var startOffsetDays = startOffsetEnabledEl && startOffsetEnabledEl.checked && startOffsetDaysEl && startOffsetDaysEl.value !== ""
        ? parseInt(startOffsetDaysEl.value, 10)
        : null;
    var finishOffsetDays = finishOffsetEnabledEl && finishOffsetEnabledEl.checked && finishOffsetDaysEl && finishOffsetDaysEl.value !== ""
        ? parseInt(finishOffsetDaysEl.value, 10)
        : null;

    if (!hasDependency) {
        return {
            has_dependency: false,
            start_dependency_task_id: null,
            start_dependency_event: null,
            start_dependency_offset_days: null,
            finish_dependency_task_id: null,
            finish_dependency_event: null,
            finish_dependency_offset_days: null
        };
    }

    if (!startTaskId && !finishTaskId) {
        showToast("Select at least one dependency task or untick Dependency", true);
        return null;
    }
    if (startOffsetDays != null && (isNaN(startOffsetDays) || startOffsetDays < 0)) {
        showToast("Start dependency offset must be 0 or greater", true);
        return null;
    }
    if (finishOffsetDays != null && (isNaN(finishOffsetDays) || finishOffsetDays < 0)) {
        showToast("Finish dependency offset must be 0 or greater", true);
        return null;
    }

    return {
        has_dependency: hasDependency,
        start_dependency_task_id: startTaskId,
        start_dependency_event: startTaskId ? ((startEventEl && startEventEl.value) || "finish") : null,
        start_dependency_offset_days: startTaskId ? startOffsetDays : null,
        finish_dependency_task_id: finishTaskId,
        finish_dependency_event: finishTaskId ? ((finishEventEl && finishEventEl.value) || "finish") : null,
        finish_dependency_offset_days: finishTaskId ? finishOffsetDays : null
    };
}

function toggleDependencyOffsetInput(prefix, dependencyType, forceHide) {
    var enabledEl = document.getElementById(prefix + "-" + dependencyType + "-dependency-offset-enabled");
    var wrapEl = document.getElementById(prefix + "-" + dependencyType + "-dependency-offset-wrap");
    var inputEl = document.getElementById(prefix + "-" + dependencyType + "-dependency-offset-days");
    var shouldShow = !forceHide && !!(enabledEl && enabledEl.checked);
    if (wrapEl) wrapEl.hidden = !shouldShow;
    if (!shouldShow && inputEl) inputEl.value = "";
}

function cloneTaskForHierarchyView(task, lineage) {
    var cloned = {};
    Object.keys(task || {}).forEach(function (key) {
        cloned[key] = task[key];
    });
    cloned.subtasks = [];
    cloned._hierarchy_parent_title = lineage && lineage.parentTitle ? lineage.parentTitle : null;
    cloned._hierarchy_root_title = lineage && lineage.rootTitle ? lineage.rootTitle : null;
    return cloned;
}

function getTasksForHierarchyLevel(tasks, level) {
    var targetDepth = level === "L2" ? 1 : (level === "L3" ? 2 : 0);
    if (targetDepth === 0) {
        return tasks || [];
    }
    var result = [];
    function visit(taskList, depth, rootTitle, parentTitle) {
        (taskList || []).forEach(function (task) {
            if (!task) return;
            var nextRootTitle = depth === 0 ? (task.title || null) : rootTitle;
            if (depth === targetDepth) {
                result.push(cloneTaskForHierarchyView(task, {
                    rootTitle: nextRootTitle,
                    parentTitle: parentTitle || null
                }));
            }
            if (task.subtasks && task.subtasks.length > 0) {
                visit(task.subtasks, depth + 1, nextRootTitle, task.title || null);
            }
        });
    }
    visit(tasks || [], 0, null, null);
    return result;
}

function isTaskUnassigned(task) {
    if (!task) return true;
    var assignees = Array.isArray(task.assignees) ? task.assignees.filter(function (item) { return !!item; }) : [];
    if (assignees.length > 0) return false;
    return !(task.assigned_to || task.assigned_username);
}

function splitTasksByAssignment(tasks) {
    var assigned = [];
    var unassigned = [];

    function cloneTask(task, childTasks) {
        var cloned = {};
        Object.keys(task || {}).forEach(function (key) {
            cloned[key] = task[key];
        });
        cloned.subtasks = childTasks || [];
        return cloned;
    }

    function visit(taskList) {
        (taskList || []).forEach(function (task) {
            if (!task) return;
            var childSplit = splitTasksByAssignment(task.subtasks || []);
            if (isTaskUnassigned(task)) {
                unassigned.push(cloneTask(task, childSplit.assigned.concat(childSplit.unassigned)));
                return;
            }
            assigned.push(cloneTask(task, childSplit.assigned));
            Array.prototype.push.apply(unassigned, childSplit.unassigned);
        });
    }

    visit(tasks || []);
    return { assigned: assigned, unassigned: unassigned };
}

function normalizeSearchText(value) {
    return String(value || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function matchesKeywordSearch(text, normalizedQuery) {
    if (!normalizedQuery) return true;
    var normalizedText = normalizeSearchText(text);
    return normalizedQuery.split(" ").every(function (token) {
        return normalizedText.indexOf(token) !== -1;
    });
}

function cloneTaskWithChildren(task, childTasks) {
    var cloned = {};
    Object.keys(task || {}).forEach(function (key) {
        cloned[key] = task[key];
    });
    cloned.subtasks = childTasks || [];
    return cloned;
}

function filterTasksByTitleSearch(tasks, normalizedQuery) {
    if (!normalizedQuery) return Array.isArray(tasks) ? tasks.slice() : [];
    return (tasks || []).reduce(function (result, task) {
        if (!task) return result;
        var matchingChildren = filterTasksByTitleSearch(task.subtasks || [], normalizedQuery);
        var matchesSelf = matchesKeywordSearch(task.title || "", normalizedQuery);
        if (!matchesSelf && !matchingChildren.length) return result;
        result.push(cloneTaskWithChildren(task, matchingChildren));
        return result;
    }, []);
}

function filterMilestonesBySearch(items, normalizedQuery) {
    if (!normalizedQuery) return Array.isArray(items) ? items.slice() : [];
    return (items || []).filter(function (item) {
        return matchesKeywordSearch(item && item.name ? item.name : "", normalizedQuery);
    });
}

function setEmptyStateMessage(emptyEl, titleText, descText) {
    if (!emptyEl) return;
    var titleEl = emptyEl.querySelector && emptyEl.querySelector(".empty-state-title");
    var descEl = emptyEl.querySelector && emptyEl.querySelector(".empty-state-desc");
    if (titleEl) titleEl.textContent = titleText;
    if (descEl) descEl.textContent = descText;
    emptyEl.hidden = false;
}

function handleTaskSearchInput(value) {
    taskSearchQuery = String(value || "");
    renderTasksFromRows(lastFetchedTaskRows || []);
}

function handleMilestoneSearchInput(value) {
    milestoneSearchQuery = String(value || "");
    renderMilestonesTable();
}

function tokenizeNameForComparison(value) {
    return normalizeSearchText(value).split(" ").filter(function (token) {
        return token.length > 1;
    });
}

function getTaskLevelLabelForDepth(depth) {
    if (depth <= 0) return "Task";
    if (depth === 1) return "Subtask";
    return "Sub-subtask";
}

function flattenTaskCatalogForDuplicateCheck(tasks, depth, lineage) {
    depth = depth || 0;
    lineage = lineage || [];
    var items = [];
    (tasks || []).forEach(function (task) {
        if (!task) return;
        var title = String(task.title || ("Task " + task.id));
        items.push({
            id: task.id,
            title: title,
            itemType: getTaskLevelLabelForDepth(depth),
            parentTitle: lineage.length ? lineage[lineage.length - 1] : "",
            rootTitle: lineage.length ? lineage[0] : "",
            activityName: task.activity_name || "",
            teamName: task.team_name || ""
        });
        if (task.subtasks && task.subtasks.length) {
            Array.prototype.push.apply(items, flattenTaskCatalogForDuplicateCheck(task.subtasks, depth + 1, lineage.concat([title])));
        }
    });
    return items;
}

function buildDuplicateNameCatalog(tasks, milestones) {
    var items = flattenTaskCatalogForDuplicateCheck(tasks || [], 0, []);
    (milestones || []).forEach(function (milestone) {
        if (!milestone) return;
        items.push({
            id: milestone.id,
            title: String(milestone.name || ("Milestone " + milestone.id)),
            itemType: "Milestone",
            milestoneDate: normalizeDateKey(milestone.milestone_date)
        });
    });
    return items;
}

function computeDuplicateNameMatch(candidateName, catalogItem) {
    var candidateNorm = normalizeSearchText(candidateName);
    var itemNorm = normalizeSearchText(catalogItem && catalogItem.title);
    if (!candidateNorm || !itemNorm) return null;
    if (candidateNorm === itemNorm) {
        return { score: 100, label: "Exact name" };
    }
    var minPhraseLength = Math.min(candidateNorm.length, itemNorm.length);
    if (minPhraseLength >= 6 && (itemNorm.indexOf(candidateNorm) !== -1 || candidateNorm.indexOf(itemNorm) !== -1)) {
        return { score: 92, label: "Similar phrase" };
    }

    var candidateTokens = tokenizeNameForComparison(candidateNorm);
    var itemTokens = tokenizeNameForComparison(itemNorm);
    if (!candidateTokens.length || !itemTokens.length) return null;

    var commonCount = candidateTokens.filter(function (token, index) {
        return candidateTokens.indexOf(token) === index && itemTokens.indexOf(token) !== -1;
    }).length;
    var coverage = commonCount / candidateTokens.length;
    if (commonCount >= Math.min(2, candidateTokens.length) && coverage >= 0.6) {
        return { score: 78 + commonCount, label: "Keyword overlap" };
    }

    if (candidateTokens.length === 1 && candidateTokens[0].length >= 6) {
        var queryToken = candidateTokens[0];
        var partialMatch = itemTokens.some(function (token) {
            return token.indexOf(queryToken) === 0 || queryToken.indexOf(token) === 0;
        });
        if (partialMatch) {
            return { score: 72, label: "Close wording" };
        }
    }
    return null;
}

function getDuplicateNameMatches(candidateName, catalog) {
    return (catalog || []).map(function (item) {
        var match = computeDuplicateNameMatch(candidateName, item);
        if (!match) return null;
        return {
            id: item.id,
            title: item.title,
            itemType: item.itemType,
            parentTitle: item.parentTitle || "",
            rootTitle: item.rootTitle || "",
            activityName: item.activityName || "",
            teamName: item.teamName || "",
            milestoneDate: item.milestoneDate || "",
            score: match.score,
            matchLabel: match.label
        };
    }).filter(function (item) {
        return !!item;
    }).sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" });
    }).slice(0, 8);
}

function buildDuplicateNameMetaText(item) {
    var parts = [item.itemType];
    if (item.milestoneDate) parts.push("Date: " + item.milestoneDate);
    if (item.parentTitle) parts.push("Parent: " + item.parentTitle);
    if (item.rootTitle && item.rootTitle !== item.parentTitle && item.itemType === "Sub-subtask") parts.push("L1: " + item.rootTitle);
    if (item.activityName) parts.push("Activity: " + item.activityName);
    if (item.teamName) parts.push("Team: " + item.teamName);
    return parts.join(" | ");
}

function loadDuplicateNameCatalog() {
    return Promise.allSettled([
        apiRequest("/tasks", "GET"),
        apiRequest("/milestones", "GET")
    ]).then(function (results) {
        var taskRows = results[0] && results[0].status === "fulfilled" && Array.isArray(results[0].value)
            ? results[0].value
            : (Array.isArray(lastFetchedTaskRows) && lastFetchedTaskRows.length ? lastFetchedTaskRows : (lastLoadedTasks || []));
        var milestoneRows = results[1] && results[1].status === "fulfilled" && Array.isArray(results[1].value)
            ? results[1].value
            : (milestonesList || []);
        return buildDuplicateNameCatalog(taskRows, milestoneRows);
    });
}

function renderDuplicateNameDialog() {
    if (!duplicateNameDialogState) return;
    var inputEl = document.getElementById("duplicate-name-input");
    var summaryEl = document.getElementById("duplicate-name-summary");
    var listEl = document.getElementById("duplicate-name-match-list");
    var btnEl = document.getElementById("duplicate-name-confirm-btn");
    var subtitleEl = document.getElementById("duplicate-name-modal-subtitle");
    var errorEl = document.getElementById("duplicate-name-error");
    var currentName = inputEl ? String(inputEl.value || "").trim() : "";
    var matches = getDuplicateNameMatches(currentName, duplicateNameDialogState.catalog);
    duplicateNameDialogState.matches = matches;

    if (errorEl) errorEl.hidden = true;
    if (summaryEl) {
        summaryEl.textContent = matches.length
            ? ("A similar " + duplicateNameDialogState.entityLabel + " already exists. Review the closest matches below, update the name if needed, or continue with this one.")
            : ("No close matches were found for this updated name. You can proceed with confidence.");
    }
    if (subtitleEl) {
        subtitleEl.textContent = "You can update the name below or continue anyway.";
    }
    if (btnEl) {
        btnEl.textContent = matches.length ? "Create anyway" : "Create " + duplicateNameDialogState.entityLabel;
    }
    if (listEl) {
        if (!matches.length) {
            listEl.innerHTML = "<div class=\"duplicate-name-list-empty\">No close matches for the current name.</div>";
        } else {
            listEl.innerHTML = matches.map(function (item) {
                var badgeClass = item.matchLabel === "Exact name" ? " duplicate-name-item__badge--exact" : "";
                return (
                    "<div class=\"duplicate-name-item\">" +
                    "<div class=\"duplicate-name-item__main\">" +
                    "<p class=\"duplicate-name-item__title\">" + escapeHtml(item.title || "") + "</p>" +
                    "<p class=\"duplicate-name-item__meta\">" + escapeHtml(buildDuplicateNameMetaText(item)) + "</p>" +
                    "</div>" +
                    "<span class=\"duplicate-name-item__badge" + badgeClass + "\">" + escapeHtml(item.matchLabel) + "</span>" +
                    "</div>"
                );
            }).join("");
        }
    }
}

function openDuplicateNameDialog(options) {
    var modal = document.getElementById("duplicate-name-modal");
    var inputEl = document.getElementById("duplicate-name-input");
    var titleEl = document.getElementById("duplicate-name-modal-title");
    if (!modal || !inputEl) return Promise.resolve(String(options.initialName || "").trim());
    return new Promise(function (resolve) {
        duplicateNameDialogState = {
            resolve: resolve,
            catalog: options.catalog || [],
            entityLabel: options.entityLabel || "item",
            sourceInputId: options.sourceInputId || ""
        };
        if (titleEl) titleEl.textContent = "Similar " + duplicateNameDialogState.entityLabel + " found";
        inputEl.value = String(options.initialName || "").trim();
        modal.hidden = false;
        renderDuplicateNameDialog();
        setTimeout(function () {
            inputEl.focus();
            inputEl.select();
        }, 20);
    });
}

function handleDuplicateNameInput() {
    renderDuplicateNameDialog();
}

function closeDuplicateNameDialog(resultName) {
    var modal = document.getElementById("duplicate-name-modal");
    var resolver = duplicateNameDialogState && duplicateNameDialogState.resolve;
    duplicateNameDialogState = null;
    if (modal) modal.hidden = true;
    if (typeof resolver === "function") resolver(resultName || null);
}

function cancelDuplicateNameDialog() {
    closeDuplicateNameDialog(null);
}

function confirmDuplicateNameDialog() {
    var inputEl = document.getElementById("duplicate-name-input");
    var errorEl = document.getElementById("duplicate-name-error");
    var nextName = inputEl ? String(inputEl.value || "").trim() : "";
    if (!nextName) {
        if (errorEl) {
            errorEl.textContent = "Enter a name before continuing.";
            errorEl.hidden = false;
        }
        if (inputEl) inputEl.focus();
        return;
    }
    if (duplicateNameDialogState && duplicateNameDialogState.sourceInputId) {
        var sourceEl = document.getElementById(duplicateNameDialogState.sourceInputId);
        if (sourceEl) sourceEl.value = nextName;
    }
    closeDuplicateNameDialog(nextName);
}

function guardDuplicateNameBeforeCreate(options) {
    var initialName = String(options && options.name || "").trim();
    if (!initialName) return Promise.resolve(initialName);
    return loadDuplicateNameCatalog()
        .then(function (catalog) {
            var matches = getDuplicateNameMatches(initialName, catalog);
            if (!matches.length) return initialName;
            return openDuplicateNameDialog({
                initialName: initialName,
                catalog: catalog,
                entityLabel: options && options.entityLabel ? options.entityLabel : "item",
                sourceInputId: options && options.sourceInputId ? options.sourceInputId : ""
            });
        })
        .catch(function () {
            return initialName;
        });
}

function getCalendarTaskStatusClass(task) {
    var rawStatus = ((task && task.status) || "").toLowerCase();
    if (rawStatus === "completed" || (rawStatus.indexOf("complete") !== -1 && rawStatus.indexOf("pending") === -1)) return "calendar-task--done";
    if (rawStatus === "in progress") return "calendar-task--progress";
    if (rawStatus === "pending completion") return "calendar-task--pending";
    return "calendar-task--todo";
}

function getCalendarTaskLabel(task) {
    if (!task) return "";
    return task.parent_task_id ? "Subtask: " + (task.title || "Untitled task") : (task.title || "Untitled task");
}

function renderCalendarView(tasks) {
    var grid = document.getElementById("calendar-grid");
    var monthTitle = document.getElementById("calendar-month-title");
    var noDateSection = document.getElementById("calendar-no-date-section");
    var noDateList = document.getElementById("calendar-no-date-list");
    var calendarEmpty = document.getElementById("calendar-empty");
    if (!grid) return;

    var monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (monthTitle) monthTitle.textContent = monthNames[calendarMonth - 1] + " " + calendarYear;

    var year = calendarYear;
    var month = calendarMonth;
    var firstDay = new Date(year, month - 1, 1);
    var lastDay = new Date(year, month, 0);
    var startWeekday = firstDay.getDay();
    var todayStr = getTodayDateStr();
    var flatTasks = flattenTasksForCalendar(tasks);

    var tasksByDate = {};
    var noDateTasks = [];
    flatTasks.forEach(function (t) {
        var d = t.due_date ? String(t.due_date).slice(0, 10) : "";
        if (d) {
            if (isHolidayDate(d)) return;
            if (!tasksByDate[d]) tasksByDate[d] = [];
            tasksByDate[d].push(t);
        } else {
            noDateTasks.push(t);
        }
    });

    var html = "";
    var totalCells = 42;
    var dayNum = 1 - startWeekday;
    for (var i = 0; i < totalCells; i++) {
        var cellDate = new Date(year, month - 1, dayNum + i);
        var cellYear = cellDate.getFullYear();
        var cellMonth = cellDate.getMonth() + 1;
        var cellDay = cellDate.getDate();
        var isCurrentMonth = cellMonth === month && cellYear === year;
        var dateStr = cellYear + "-" + (cellMonth < 10 ? "0" : "") + cellMonth + "-" + (cellDay < 10 ? "0" : "") + cellDay;
        var isToday = dateStr === todayStr;

        var dayClass = "calendar-day";
        if (!isCurrentMonth) dayClass += " calendar-day--other-month";
        if (isToday) dayClass += " calendar-day--today";

        html += "<div class=\"" + dayClass + "\" data-date=\"" + dateStr + "\">";
        html += "<div class=\"calendar-day-head\"><span class=\"calendar-day-num\">" + cellDay + "</span>";
        if (isCurrentMonth && tasksByDate[dateStr] && tasksByDate[dateStr].length > 0) {
            html += "<span class=\"calendar-day-count\">" + tasksByDate[dateStr].length + "</span>";
        }
        html += "</div>";
        html += "<div class=\"calendar-day-tasks\">";

        if (isCurrentMonth && tasksByDate[dateStr]) {
            tasksByDate[dateStr].forEach(function (t) {
                var statusClass = "";
                var rawStatus = (t.status || "").toLowerCase();
                if (rawStatus === "completed" || (rawStatus.indexOf("complete") !== -1 && rawStatus.indexOf("pending") === -1)) statusClass = " calendar-task--done";
                else if (rawStatus === "in progress") statusClass = " calendar-task--progress";
                else if (rawStatus === "pending completion") statusClass = " calendar-task--pending";
                var priorityClass = " calendar-task--" + (t.priority || "medium").toLowerCase();
                var titleEsc = escapeHtml((t.title || "").slice(0, 36));
                if ((t.title || "").length > 36) titleEsc += "…";
                html += "<button type=\"button\" class=\"calendar-task-pill" + statusClass + priorityClass + "\" onclick=\"openTaskQuickView(" + t.id + ")\" title=\"" + escapeHtml(t.title || "") + "\">" + titleEsc + "</button>";
            });
        }
        if (dayMilestones.length > 0) {
            html += "<div class=\"calendar-day-milestones\">";
            dayMilestones.forEach(function (m) {
                html += "<span class=\"calendar-milestone-pill\" title=\"" + escapeHtml(m.name || "Milestone") + "\">Milestone: " + escapeHtml(m.name || "Milestone") + "</span>";
            });
            html += "</div>";
        }
        html += "</div></div>";
    }
    grid.innerHTML = html;

    if (noDateTasks.length > 0) {
        noDateSection.hidden = false;
        noDateList.innerHTML = noDateTasks.map(function (t) {
            var titleEsc = escapeHtml(t.title || "");
            return "<li><button type=\"button\" class=\"calendar-no-date-task\" onclick=\"openTaskQuickView(" + t.id + ")\">" + titleEsc + "</button></li>";
        }).join("");
    } else {
        noDateSection.hidden = true;
    }

    if (calendarEmpty) {
        var hasAnyTasks = (tasks || []).length > 0;
        calendarEmpty.hidden = hasAnyTasks;
    }
}

function calendarPrevMonth() {
    calendarMonth--;
    if (calendarMonth < 1) {
        calendarMonth = 12;
        calendarYear--;
    }
    renderCalendarView(lastLoadedTasks);
}

function calendarNextMonth() {
    calendarMonth++;
    if (calendarMonth > 12) {
        calendarMonth = 1;
        calendarYear++;
    }
    renderCalendarView(lastLoadedTasks);
}

function calendarGoToToday() {
    var d = new Date();
    calendarMonth = d.getMonth() + 1;
    calendarYear = d.getFullYear();
    renderCalendarView(lastLoadedTasks);
}

function openTaskQuickView(taskId) {
    var t = (lastLoadedTasks || []).find(function (x) { return x.id === taskId; });
    var modal = document.getElementById("task-quick-view-modal");
    var body = document.getElementById("task-quick-view-body");
    var titleEl = document.getElementById("task-quick-view-title");
    if (!modal || !body) return;
    if (!t) {
        body.innerHTML = "<p class=\"text-muted\">Task not found.</p>";
        if (titleEl) titleEl.textContent = "Task details";
        modal.hidden = false;
        return;
    }
    if (titleEl) titleEl.textContent = t.title || "Task details";
    var assignee = formatUserInline(t.assigned_username, t.assigned_designation, "—");
    if (!t.assigned_username && t.assignees && t.assignees.length) {
        assignee = t.assignees.map(function (a) { return formatUserOptionLabel(a, "User " + a.user_id); }).join(", ");
    }
    var desc = buildTaskDescriptionContentHtml(t);
    var s = (t.status || "").toLowerCase();
    var statusClass = "status ";
    if (s === "to do") statusClass += "status-todo";
    else if (s === "in progress") statusClass += "status-progress";
    else if (s.indexOf("pending") !== -1) statusClass += "status-pending-completion";
    else if (s.indexOf("complete") !== -1 && s.indexOf("pending") === -1) statusClass += "status-done";
    else statusClass += "status-todo";
    body.innerHTML = (
        "<div class=\"task-quick-view\">" +
        "<p><strong>Due:</strong> " + escapeHtml(t.due_date || "—") + "</p>" +
        "<p><strong>Status:</strong> <span class=\"" + statusClass + "\">" + escapeHtml(t.status || "—") + "</span></p>" +
        "<p><strong>Priority:</strong> " + escapeHtml(t.priority || "—") + "</p>" +
        "<p><strong>Assigned:</strong> " + escapeHtml(assignee) + "</p>" +
        "<p><strong>Description:</strong></p><div class=\"task-quick-view-desc\">" + desc + "</div>" +
        "<p class=\"task-quick-view-actions\"><button type=\"button\" class=\"btn btn-primary btn-sm\" onclick=\"closeTaskQuickView(); setTasksViewMode('table');\">Open in table</button></p>" +
        "</div>"
    );
    modal.hidden = false;
}

function renderCalendarView(tasks) {
    var grid = document.getElementById("calendar-grid");
    var monthTitle = document.getElementById("calendar-month-title");
    var noDateSection = document.getElementById("calendar-no-date-section");
    var noDateList = document.getElementById("calendar-no-date-list");
    var calendarEmpty = document.getElementById("calendar-empty");
    if (!grid) return;

    var monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (monthTitle) monthTitle.textContent = monthNames[calendarMonth - 1] + " " + calendarYear;

    var year = calendarYear;
    var month = calendarMonth;
    var firstDay = new Date(year, month - 1, 1);
    var startWeekday = firstDay.getDay();
    var todayStr = getTodayDateStr();
    var flatTasks = flattenTasksForCalendar(tasks);

    var tasksByDate = {};
    var noDateTasks = [];
    flatTasks.forEach(function (t) {
        var d = t.due_date ? String(t.due_date).slice(0, 10) : "";
        if (d) {
            if (isHolidayDate(d)) return;
            if (!tasksByDate[d]) tasksByDate[d] = [];
            tasksByDate[d].push(t);
        } else {
            noDateTasks.push(t);
        }
    });

    var html = "";
    var totalCells = 42;
    var dayNum = 1 - startWeekday;
    for (var i = 0; i < totalCells; i++) {
        var cellDate = new Date(year, month - 1, dayNum + i);
        var cellYear = cellDate.getFullYear();
        var cellMonth = cellDate.getMonth() + 1;
        var cellDay = cellDate.getDate();
        var isCurrentMonth = cellMonth === month && cellYear === year;
        var dateStr = cellYear + "-" + (cellMonth < 10 ? "0" : "") + cellMonth + "-" + (cellDay < 10 ? "0" : "") + cellDay;
        var isToday = dateStr === todayStr;
        var holidayName = isCurrentMonth ? getHolidayNameByDate(dateStr) : "";
        var isHoliday = !!holidayName;
        var dayMilestones = isCurrentMonth && milestonesByDate[dateStr] ? milestonesByDate[dateStr] : [];

        var dayClass = "calendar-day";
        if (!isCurrentMonth) dayClass += " calendar-day--other-month";
        if (isToday) dayClass += " calendar-day--today";
        if (isHoliday) dayClass += " calendar-day--holiday";

        html += "<div class=\"" + dayClass + "\" data-date=\"" + dateStr + "\">";
        html += "<div class=\"calendar-day-head\"><span class=\"calendar-day-num\">" + cellDay + "</span>";
        if (isHoliday) {
            html += "<span class=\"calendar-day-holiday-tag\" title=\"" + escapeHtml(holidayName) + "\">Holiday</span>";
        } else if (isCurrentMonth && tasksByDate[dateStr] && tasksByDate[dateStr].length > 0) {
            html += "<span class=\"calendar-day-count\">" + tasksByDate[dateStr].length + "</span>";
        } else if (dayMilestones.length > 0) {
            html += "<span class=\"calendar-day-count\">" + dayMilestones.length + "</span>";
        }
        html += "</div>";
        html += "<div class=\"calendar-day-tasks\">";

        if (isHoliday) {
            html += "<p class=\"calendar-day-holiday-note\">" + escapeHtml(holidayName) + "<br>Tasks are hidden on holidays.</p>";
        } else if (isCurrentMonth && tasksByDate[dateStr]) {
            tasksByDate[dateStr].forEach(function (t) {
                var taskLabel = getCalendarTaskLabel(t);
                var titleEsc = escapeHtml(taskLabel.slice(0, 42));
                if (taskLabel.length > 42) titleEsc += "...";
                var assignee = formatUserInline(t.assigned_username, t.assigned_designation, "Unassigned");
                if (!t.assigned_username && t.assignees && t.assignees.length) {
                    assignee = t.assignees.map(function (a) { return formatUserOptionLabel(a, "User " + a.user_id); }).join(", ");
                }
                html += "<button type=\"button\" class=\"calendar-task-pill " + getCalendarTaskStatusClass(t) + " calendar-task--" + (t.priority || "medium").toLowerCase() + (t.parent_task_id ? " calendar-task-pill--subtask" : "") + "\" onclick=\"openTaskQuickView(" + t.id + ")\" title=\"" + escapeHtml(taskLabel) + "\">";
                html += "<span class=\"calendar-task-pill-title\">" + titleEsc + "</span>";
                html += "<span class=\"calendar-task-pill-meta\">" + escapeHtml(t.priority || "Medium") + " | " + escapeHtml(assignee) + "</span>";
                html += "</button>";
            });
        }
        if (dayMilestones.length > 0) {
            html += "<div class=\"calendar-day-milestones\">";
            dayMilestones.forEach(function (m) {
                html += "<span class=\"calendar-milestone-pill\" title=\"" + escapeHtml(m.name || "Milestone") + "\">Milestone: " + escapeHtml(m.name || "Milestone") + "</span>";
            });
            html += "</div>";
        }
        html += "</div></div>";
    }
    grid.innerHTML = html;

    if (noDateTasks.length > 0) {
        noDateSection.hidden = false;
        noDateList.innerHTML = noDateTasks.map(function (t) {
            var titleEsc = escapeHtml(getCalendarTaskLabel(t));
            return "<li><button type=\"button\" class=\"calendar-no-date-task" + (t.parent_task_id ? " calendar-no-date-task--subtask" : "") + "\" onclick=\"openTaskQuickView(" + t.id + ")\">" + titleEsc + "</button></li>";
        }).join("");
    } else {
        noDateSection.hidden = true;
    }

    if (calendarEmpty) {
        calendarEmpty.hidden = flatTasks.length > 0 || milestonesList.length > 0;
    }
}

function openTaskQuickView(taskId) {
    var t = flattenTasksForCalendar(lastLoadedTasks || []).find(function (x) { return x.id === taskId; });
    var modal = document.getElementById("task-quick-view-modal");
    var body = document.getElementById("task-quick-view-body");
    var titleEl = document.getElementById("task-quick-view-title");
    if (!modal || !body) return;
    if (!t) {
        body.innerHTML = "<p class=\"text-muted\">Task not found.</p>";
        if (titleEl) titleEl.textContent = "Task details";
        modal.hidden = false;
        return;
    }
    if (titleEl) titleEl.textContent = getCalendarTaskLabel(t);
    var assignee = formatUserInline(t.assigned_username, t.assigned_designation, "-");
    if (!t.assigned_username && t.assignees && t.assignees.length) {
        assignee = t.assignees.map(function (a) { return formatUserOptionLabel(a, "User " + a.user_id); }).join(", ");
    }
    var desc = buildTaskDescriptionContentHtml(t);
    var s = (t.status || "").toLowerCase();
    var statusClass = "status ";
    if (s === "to do") statusClass += "status-todo";
    else if (s === "in progress") statusClass += "status-progress";
    else if (s.indexOf("pending") !== -1) statusClass += "status-pending-completion";
    else if (s.indexOf("complete") !== -1 && s.indexOf("pending") === -1) statusClass += "status-done";
    else statusClass += "status-todo";
    body.innerHTML = (
        "<div class=\"task-quick-view\">" +
        "<p><strong>Due:</strong> " + escapeHtml(t.due_date || "-") + "</p>" +
        "<p><strong>Status:</strong> <span class=\"" + statusClass + "\">" + escapeHtml(t.status || "-") + "</span></p>" +
        "<p><strong>Priority:</strong> " + escapeHtml(t.priority || "-") + "</p>" +
        "<p><strong>Assigned:</strong> " + escapeHtml(assignee) + "</p>" +
        "<p><strong>Type:</strong> " + escapeHtml(t.task_type || "Others") + "</p>" +
        (t.parent_task_id ? "<p><strong>Task Kind:</strong> Subtask</p>" : "") +
        "<p><strong>Description:</strong></p><div class=\"task-quick-view-desc\">" + desc + "</div>" +
        "<p class=\"task-quick-view-actions\"><button type=\"button\" class=\"btn btn-primary btn-sm\" onclick=\"closeTaskQuickView(); setTasksViewMode('table');\">Open in table</button></p>" +
        "</div>"
    );
    modal.hidden = false;
}

function closeTaskQuickView() {
    var modal = document.getElementById("task-quick-view-modal");
    if (modal) modal.hidden = true;
}

function formatTaskMetaDate(value) {
    if (!value) return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) {
        var parts = String(value).slice(0, 10).split("-");
        if (parts.length === 3) {
            date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        }
    }
    if (isNaN(date.getTime())) return "";
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return String(date.getDate()).padStart(2, "0") + " " + months[date.getMonth()] + " " + date.getFullYear();
}

function normalizeTaskDateValue(value) {
    return value ? String(value).slice(0, 10) : "";
}

function parseTaskDateValue(value) {
    var normalized = normalizeTaskDateValue(value);
    if (!normalized) return null;
    var parts = normalized.split("-");
    if (parts.length !== 3) return null;
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
    return new Date(Date.UTC(year, month, day));
}

function formatTaskDateUtc(dateObj) {
    if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return "";
    return dateObj.getUTCFullYear() + "-" +
        String(dateObj.getUTCMonth() + 1).padStart(2, "0") + "-" +
        String(dateObj.getUTCDate()).padStart(2, "0");
}

function deriveTentativeCompletionDateValue(startValue, durationValue) {
    var startDate = parseTaskDateValue(startValue);
    var duration = durationValue != null ? parseInt(durationValue, 10) : null;
    if (!startDate || duration == null || isNaN(duration) || duration < 1) return "";
    startDate.setUTCDate(startDate.getUTCDate() + Math.max(0, duration - 1));
    return formatTaskDateUtc(startDate);
}

function getTaskTentativeCompletionDateValue(task) {
    if (!task) return "";
    return normalizeTaskDateValue(task.tentative_completion_date) ||
        deriveTentativeCompletionDateValue(task.tentative_start_date, task.tentative_duration_days);
}

function getTaskScheduleDeadlineValue(task) {
    if (!task) return "";
    return normalizeTaskDateValue(task.due_date) || getTaskTentativeCompletionDateValue(task);
}

function buildTaskDescriptionMetaHtml(task) {
    var bits = [];
    var createdLabel = formatTaskMetaDate(task && task.created_at);
    var startLabel = formatTaskMetaDate(task && task.tentative_start_date);
    var completionLabel = formatTaskMetaDate(getTaskTentativeCompletionDateValue(task));

    if (createdLabel) bits.push("Created: " + createdLabel);
    if (startLabel) bits.push("Start: " + startLabel);
    if (completionLabel) bits.push("Tentative completion: " + completionLabel);

    if (!bits.length) return "";
    return "<div class=\"task-description-meta\">[" + escapeHtml(bits.join(" | ")) + "]</div>";
}

function buildTaskDescriptionContentHtml(task) {
    var descriptionHtml = (task && task.description && task.description.trim())
        ? escapeHtml(task.description).replace(/\n/g, "<br>")
        : "<em class=\"text-muted\">No description</em>";
    return buildTaskDescriptionMetaHtml(task) +
        "<div class=\"task-description-body\">" + descriptionHtml + "</div>";
}

function renderCalendarView(tasks) {
    var grid = document.getElementById("calendar-grid");
    var monthTitle = document.getElementById("calendar-month-title");
    var noDateSection = document.getElementById("calendar-no-date-section");
    var noDateList = document.getElementById("calendar-no-date-list");
    var calendarEmpty = document.getElementById("calendar-empty");
    if (!grid) return;

    var monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (monthTitle) monthTitle.textContent = monthNames[calendarMonth - 1] + " " + calendarYear;

    var year = calendarYear;
    var month = calendarMonth;
    var firstDay = new Date(year, month - 1, 1);
    var startWeekday = firstDay.getDay();
    var todayStr = getTodayDateStr();
    var flatTasks = flattenTasksForCalendar(tasks);

    var tasksByDate = {};
    var noDateTasks = [];
    flatTasks.forEach(function (t) {
        var d = t.due_date ? String(t.due_date).slice(0, 10) : "";
        if (d) {
            if (isHolidayDate(d)) return;
            if (!tasksByDate[d]) tasksByDate[d] = [];
            tasksByDate[d].push(t);
        } else {
            noDateTasks.push(t);
        }
    });

    var html = "";
    var totalCells = 42;
    var dayNum = 1 - startWeekday;
    for (var i = 0; i < totalCells; i++) {
        var cellDate = new Date(year, month - 1, dayNum + i);
        var cellYear = cellDate.getFullYear();
        var cellMonth = cellDate.getMonth() + 1;
        var cellDay = cellDate.getDate();
        var isCurrentMonth = cellMonth === month && cellYear === year;
        var dateStr = cellYear + "-" + (cellMonth < 10 ? "0" : "") + cellMonth + "-" + (cellDay < 10 ? "0" : "") + cellDay;
        var isToday = dateStr === todayStr;
        var holidayName = isCurrentMonth ? getHolidayNameByDate(dateStr) : "";
        var isHoliday = !!holidayName;
        var dayMilestones = isCurrentMonth && milestonesByDate[dateStr] ? milestonesByDate[dateStr] : [];

        var dayClass = "calendar-day";
        if (!isCurrentMonth) dayClass += " calendar-day--other-month";
        if (isToday) dayClass += " calendar-day--today";
        if (isHoliday) dayClass += " calendar-day--holiday";

        html += "<div class=\"" + dayClass + "\" data-date=\"" + dateStr + "\">";
        html += "<div class=\"calendar-day-head\"><span class=\"calendar-day-num\">" + cellDay + "</span>";
        if (isHoliday) {
            html += "<span class=\"calendar-day-holiday-tag\" title=\"" + escapeHtml(holidayName) + "\">Holiday</span>";
        } else if (isCurrentMonth && tasksByDate[dateStr] && tasksByDate[dateStr].length > 0) {
            html += "<span class=\"calendar-day-count\">" + tasksByDate[dateStr].length + "</span>";
        } else if (dayMilestones.length > 0) {
            html += "<span class=\"calendar-day-count\">" + dayMilestones.length + "</span>";
        }
        html += "</div>";
        html += "<div class=\"calendar-day-tasks\">";

        if (isHoliday) {
            html += "<p class=\"calendar-day-holiday-note\">" + escapeHtml(holidayName) + "<br>Tasks are hidden on holidays.</p>";
        } else if (isCurrentMonth && tasksByDate[dateStr]) {
            tasksByDate[dateStr].forEach(function (t) {
                var taskLabel = getCalendarTaskLabel(t);
                var titleEsc = escapeHtml(taskLabel.slice(0, 42));
                if (taskLabel.length > 42) titleEsc += "...";
                var assignee = formatUserInline(t.assigned_username, t.assigned_designation, "Unassigned");
                if (!t.assigned_username && t.assignees && t.assignees.length) {
                    assignee = t.assignees.map(function (a) { return formatUserOptionLabel(a, "User " + a.user_id); }).join(", ");
                }
                html += "<button type=\"button\" class=\"calendar-task-pill " + getCalendarTaskStatusClass(t) + " calendar-task--" + (t.priority || "medium").toLowerCase() + (t.parent_task_id ? " calendar-task-pill--subtask" : "") + "\" onclick=\"openTaskQuickView(" + t.id + ")\" title=\"" + escapeHtml(taskLabel) + "\">";
                html += "<span class=\"calendar-task-pill-title\">" + titleEsc + "</span>";
                html += "<span class=\"calendar-task-pill-meta\">" + escapeHtml(t.priority || "Medium") + " • " + escapeHtml(assignee) + "</span>";
                html += "</button>";
            });
        }
        if (dayMilestones.length > 0) {
            html += "<div class=\"calendar-day-milestones\">";
            dayMilestones.forEach(function (m) {
                html += "<span class=\"calendar-milestone-pill\" title=\"" + escapeHtml(m.name || "Milestone") + "\">Milestone: " + escapeHtml(m.name || "Milestone") + "</span>";
            });
            html += "</div>";
        }
        html += "</div></div>";
    }
    grid.innerHTML = html;

    if (noDateTasks.length > 0) {
        noDateSection.hidden = false;
        noDateList.innerHTML = noDateTasks.map(function (t) {
            var titleEsc = escapeHtml(getCalendarTaskLabel(t));
            return "<li><button type=\"button\" class=\"calendar-no-date-task" + (t.parent_task_id ? " calendar-no-date-task--subtask" : "") + "\" onclick=\"openTaskQuickView(" + t.id + ")\">" + titleEsc + "</button></li>";
        }).join("");
    } else {
        noDateSection.hidden = true;
    }

    if (calendarEmpty) {
        calendarEmpty.hidden = flatTasks.length > 0 || milestonesList.length > 0;
    }
}

function openTaskQuickView(taskId) {
    var t = flattenTasksForCalendar(lastLoadedTasks || []).find(function (x) { return x.id === taskId; });
    var modal = document.getElementById("task-quick-view-modal");
    var body = document.getElementById("task-quick-view-body");
    var titleEl = document.getElementById("task-quick-view-title");
    if (!modal || !body) return;
    if (!t) {
        body.innerHTML = "<p class=\"text-muted\">Task not found.</p>";
        if (titleEl) titleEl.textContent = "Task details";
        modal.hidden = false;
        return;
    }
    if (titleEl) titleEl.textContent = getCalendarTaskLabel(t);
    var assignee = formatUserInline(t.assigned_username, t.assigned_designation, "—");
    if (!t.assigned_username && t.assignees && t.assignees.length) {
        assignee = t.assignees.map(function (a) { return formatUserOptionLabel(a, "User " + a.user_id); }).join(", ");
    }
    var desc = buildTaskDescriptionContentHtml(t);
    var s = (t.status || "").toLowerCase();
    var statusClass = "status ";
    if (s === "to do") statusClass += "status-todo";
    else if (s === "in progress") statusClass += "status-progress";
    else if (s.indexOf("pending") !== -1) statusClass += "status-pending-completion";
    else if (s.indexOf("complete") !== -1 && s.indexOf("pending") === -1) statusClass += "status-done";
    else statusClass += "status-todo";
    body.innerHTML = (
        "<div class=\"task-quick-view\">" +
        "<p><strong>Due:</strong> " + escapeHtml(t.due_date || "—") + "</p>" +
        "<p><strong>Status:</strong> <span class=\"" + statusClass + "\">" + escapeHtml(t.status || "—") + "</span></p>" +
        "<p><strong>Priority:</strong> " + escapeHtml(t.priority || "—") + "</p>" +
        "<p><strong>Assigned:</strong> " + escapeHtml(assignee) + "</p>" +
        "<p><strong>Type:</strong> " + escapeHtml(t.task_type || "Others") + "</p>" +
        (t.parent_task_id ? "<p><strong>Task Kind:</strong> Subtask</p>" : "") +
        "<p><strong>Description:</strong></p><div class=\"task-quick-view-desc\">" + desc + "</div>" +
        "<p class=\"task-quick-view-actions\"><button type=\"button\" class=\"btn btn-primary btn-sm\" onclick=\"closeTaskQuickView(); setTasksViewMode('table');\">Open in table</button></p>" +
        "</div>"
    );
    modal.hidden = false;
}

// Statistics charts (destroy before redraw)
var statsChartOverview = null;
var statsChartTasks = null;
var statsChartPieStatus = null;

function showStatisticsView() {
    window.location.href = "statistics.html";
}

function goToHomePage() {
    window.location.href = "home.html";
}

function goToStatisticsPage() {
    showStatisticsView();
}

function goToGanttViewPage() {
    window.location.href = "gantt-view.html";
}

function loadDashboardStats() {
    var loadingEl = document.getElementById("stats-loading");
    var errorEl = document.getElementById("stats-error");
    var wrap = document.querySelector(".stats-charts-wrap");
    if (loadingEl) loadingEl.hidden = false;
    if (errorEl) errorEl.hidden = true;
    if (wrap) wrap.style.visibility = "hidden";

    var urls = ["/api/dashboard/statistics", "/stats", "/dashboard/stats"];
    function tryNext(i) {
        if (i >= urls.length) {
            if (loadingEl) loadingEl.hidden = true;
            if (errorEl) errorEl.hidden = false;
            if (wrap) wrap.style.visibility = "visible";
            showToast("Statistics endpoint not available. Restart the backend.", true);
            return;
        }
        apiRequest(urls[i], "GET")
            .then(function (data) {
                if (loadingEl) loadingEl.hidden = true;
                if (errorEl) errorEl.hidden = true;
                if (wrap) wrap.style.visibility = "visible";
                renderStatsCharts(data);
            })
            .catch(function (err) {
                tryNext(i + 1);
            });
    }
    tryNext(0);
}

function renderStatsCharts(data) {
    if (typeof Chart === "undefined") return;
    var colors = {
        primary: "#0052cc",
        primaryLight: "#deebff",
        success: "#00875a",
        successBg: "#e3fcef",
        warning: "#ff8b00",
        warningBg: "#fff4e6",
        danger: "#de350b",
        dangerBg: "#ffebe6",
        muted: "#97a0af",
        teal: "#00b8d9",
        purple: "#6554c0",
    };
    var fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    if (statsChartOverview) {
        statsChartOverview.destroy();
        statsChartOverview = null;
    }
    var ctxOverview = document.getElementById("stats-bar-overview");
    if (ctxOverview) {
        statsChartOverview = new Chart(ctxOverview, {
            type: "bar",
            data: {
                labels: ["Teams", "Tasks", "Activities", "Members"],
                datasets: [{
                    label: "Count",
                    data: [
                        data.total_teams || 0,
                        data.total_tasks || 0,
                        data.total_activities || 0,
                        data.total_members || 0,
                    ],
                    backgroundColor: [colors.primary, colors.success, colors.teal, colors.purple],
                    borderColor: [colors.primary, colors.success, colors.teal, colors.purple],
                    borderWidth: 1,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { backgroundColor: "#172b4d" },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { font: { family: fontFamily, size: 11 } },
                        grid: { color: "#ebecf0" },
                    },
                    x: {
                        ticks: { font: { family: fontFamily, size: 11 } },
                        grid: { display: false },
                    },
                },
            },
        });
    }

    if (statsChartTasks) {
        statsChartTasks.destroy();
        statsChartTasks = null;
    }
    var ctxTasks = document.getElementById("stats-bar-tasks");
    if (ctxTasks) {
        statsChartTasks = new Chart(ctxTasks, {
            type: "bar",
            data: {
                labels: ["Due today", "Due this week", "In progress", "To do", "Pending", "Completed", "Ext. request"],
                datasets: [{
                    label: "Tasks",
                    data: [
                        data.tasks_due_today || 0,
                        data.tasks_due_this_week || 0,
                        data.tasks_in_progress || 0,
                        data.tasks_to_do || 0,
                        data.tasks_pending || 0,
                        data.tasks_completed || 0,
                        data.tasks_extension_request || 0,
                    ],
                    backgroundColor: [
                        colors.danger,
                        colors.warning,
                        colors.primary,
                        colors.muted,
                        colors.warning,
                        colors.success,
                        colors.purple,
                    ],
                    borderColor: [
                        colors.danger,
                        colors.warning,
                        colors.primary,
                        colors.muted,
                        colors.warning,
                        colors.success,
                        colors.purple,
                    ],
                    borderWidth: 1,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { backgroundColor: "#172b4d" },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { font: { family: fontFamily, size: 11 } },
                        grid: { color: "#ebecf0" },
                    },
                    x: {
                        ticks: { font: { family: fontFamily, size: 10 }, maxRotation: 35 },
                        grid: { display: false },
                    },
                },
            },
        });
    }

    if (statsChartPieStatus) {
        statsChartPieStatus.destroy();
        statsChartPieStatus = null;
    }
    var ctxPie = document.getElementById("stats-pie-status");
    if (ctxPie) {
        var toDo = data.tasks_to_do || 0;
        var inProgress = data.tasks_in_progress || 0;
        var pending = data.tasks_pending || 0;
        var completed = data.tasks_completed || 0;
        statsChartPieStatus = new Chart(ctxPie, {
            type: "doughnut",
            data: {
                labels: ["To do", "In progress", "Pending completion", "Completed"],
                datasets: [{
                    data: [toDo, inProgress, pending, completed],
                    backgroundColor: [colors.muted, colors.primary, colors.warning, colors.success],
                    borderColor: "#fff",
                    borderWidth: 2,
                    hoverOffset: 6,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: "bottom",
                        labels: { font: { family: fontFamily, size: 11 }, padding: 12 },
                    },
                    tooltip: {
                        backgroundColor: "#172b4d",
                        callbacks: {
                            label: function (context) {
                                var total = context.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                                var pct = total ? Math.round((context.raw / total) * 100) : 0;
                                return context.label + ": " + context.raw + " (" + pct + "%)";
                            },
                        },
                    },
                },
            },
        });
    }
}

function showToast(message, isError) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.className = "toast " + (isError ? "error" : "success");
    el.hidden = false;
    setTimeout(function () { el.hidden = true; }, 3500);
}

function escapeHtml(s) {
    if (!s) return "";
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
}

/**
 * Format backend timestamps in the user's local time.
 *
 * The backend generally stores timestamps in UTC but often returns them
 * without an explicit timezone (e.g. "2026-02-02T11:20:54"). In the browser,
 * such strings are treated as local time, which means the time shown can
 * actually reflect the server clock instead of the user's local time.
 *
 * This helper:
 * - Detects naive ISO strings (without "Z" or timezone offset)
 * - Treats those as UTC by appending "Z"
 * - Leaves values that already have timezone info unchanged
 */
function formatBackendDateTimeToLocal(value) {
    if (!value) return "";

    // If it's already a Date, just format it.
    if (value instanceof Date) {
        return value.toLocaleString();
    }

    // Ensure we are working with a string.
    var str = String(value);

    // Basic check for ISO-like datetime "YYYY-MM-DDTHH:mm:ss"
    var isIsoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
    // Check if it already has timezone info (Z or +hh:mm / -hh:mm)
    var hasTimezone =
        /[zZ]$/.test(str) || /[+\-]\d{2}:?\d{2}$/.test(str);

    var date = parseBackendDateTime(str);

    if (isNaN(date.getTime())) {
        return "";
    }
    return date.toLocaleString();
}

function parseNaiveBackendDateTimeAsIndia(value) {
    var str = String(value || "").trim();
    var match = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?$/);
    if (!match) return null;
    var year = parseInt(match[1], 10);
    var month = parseInt(match[2], 10) - 1;
    var day = parseInt(match[3], 10);
    var hour = parseInt(match[4], 10);
    var minute = parseInt(match[5], 10);
    var second = parseInt(match[6] || "0", 10);
    var fraction = (match[7] || "0").slice(0, 3);
    while (fraction.length < 3) fraction += "0";
    var millisecond = parseInt(fraction, 10);
    var indiaOffsetMs = (5 * 60 + 30) * 60 * 1000;
    return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - indiaOffsetMs);
}

/** Return today as YYYY-MM-DD (local date). */
function getTodayDateStr() {
    var d = new Date();
    var y = d.getFullYear();
    var m = (d.getMonth() + 1);
    var day = d.getDate();
    return y + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

/** Return date N days from today as YYYY-MM-DD. */
function getDateStrOffset(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    var y = d.getFullYear();
    var m = (d.getMonth() + 1);
    var day = d.getDate();
    return y + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

function isDateInCurrentMonth(dateStr) {
    if (!dateStr) return false;
    var date = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
    if (isNaN(date.getTime())) return false;
    var now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

/**
 * Calculate number of working days (Mon–Fri) between today and a given due date.
 * Positive = days remaining; 0 = due today; negative = overdue.
 */
function computeWorkingDaysLeft(dueDateStr) {
    if (!dueDateStr) return null;

    // Expecting "YYYY-MM-DD" from the backend.
    var parts = String(dueDateStr).split("-");
    if (parts.length !== 3) return null;

    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;

    var today = new Date();
    var todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    var dueUtc = new Date(Date.UTC(year, month, day));

    if (isNaN(todayUtc.getTime()) || isNaN(dueUtc.getTime())) return null;

    // Same calendar day => 0 working days left.
    if (todayUtc.getTime() === dueUtc.getTime()) return 0;

    var forward = dueUtc > todayUtc;
    var start = forward ? todayUtc : dueUtc;
    var end = forward ? dueUtc : todayUtc;

    var days = 0;
    var cursor = new Date(start.getTime());
    while (cursor < end) {
        var dayOfWeek = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            days++;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return forward ? days : -days;
}

function isTentativeCompletionBeforeStart(startValue, completionValue) {
    var start = normalizeTaskDateValue(startValue);
    var completion = normalizeTaskDateValue(completionValue);
    return !!(start && completion && completion < start);
}

function isExtensionRequestLocked(task, dueDateValue) {
    var dueRaw = dueDateValue || (task && task.due_date) || "";
    var scheduleType = task && task.task_schedule_type ? String(task.task_schedule_type).toLowerCase() : "";
    var isOngoing = scheduleType === "ongoing" || (!scheduleType && !dueRaw);
    return !dueRaw && isOngoing;
}

function buildExtensionButtonHtml(task, dueDateValue) {
    var dueRaw = dueDateValue || (task && task.due_date) || "";
    var extStatus = task && task.extension_status ? task.extension_status : null;
    var isLocked = isExtensionRequestLocked(task, dueRaw);
    var extBtnClass = "btn btn-sm btn-ext btn-ext--primary";
    var extBtnLabel = "Request";
    var extBtnAttrs = "type=\"button\"";
    var extDataAttrs = "";

    if (isLocked) {
        extBtnClass = "btn btn-sm btn-ext btn-ext--pending";
        extBtnLabel = "&#128274; Request";
        extBtnAttrs += " disabled title=\"Request extension is available only for time-bound tasks with a due date.\"";
        return "<button " + extBtnAttrs + " class=\"" + extBtnClass + "\">" + extBtnLabel + "</button>";
    }

    if (!extStatus || extStatus === "rejected" || extStatus === "approved") {
        extBtnAttrs += " onclick=\"openExtensionRequest(" + task.id + ", '" + (dueRaw || "") + "')\"";
    } else if (extStatus === "pending") {
        extBtnLabel = "Pending";
        if (task.extension_reason) {
            extDataAttrs += " data-ext-reason=\"" + escapeHtml(String(task.extension_reason)) + "\"";
        }
        if (task.extension_requested_due_date) {
            extDataAttrs += " data-ext-date=\"" + escapeHtml(String(task.extension_requested_due_date)) + "\"";
        }
        extBtnClass = "btn btn-sm btn-ext btn-ext--pending";
        if (isUserAdmin()) {
            extBtnAttrs += " onclick=\"reviewExtensionRequest(" + (task.extension_request_id || 0) + ", " + task.id + ", this)\"";
        } else {
            extBtnAttrs += " disabled";
        }
    }

    return "<button " + extBtnAttrs + extDataAttrs + " class=\"" + extBtnClass + "\">" + extBtnLabel + "</button>";
}

function formatWorkingDaysLeftValue(daysLeft) {
    if (typeof daysLeft !== "number") return "—";
    if (daysLeftDisplayMode === "days") return String(daysLeft);

    var sign = daysLeft < 0 ? "-" : "";
    var absDays = Math.abs(daysLeft);

    if (absDays <= 6) return sign + String(absDays);
    if (absDays >= 365) return sign + String(Math.max(1, Math.floor(absDays / 365))) + "Y";
    if (absDays >= 30) {
        var wholeMonths = Math.floor(absDays / 30);
        var extraDaysInMonth = absDays % 30;
        return sign + String(wholeMonths) + (extraDaysInMonth ? "." + String(extraDaysInMonth) : "") + "M";
    }

    var wholeWeeks = Math.floor(absDays / 7);
    var extraDaysInWeek = absDays % 7;
    return sign + String(wholeWeeks) + (extraDaysInWeek ? "." + String(extraDaysInWeek) : "") + "W";
}

function buildDaysLeftContent(daysLeft) {
    if (typeof daysLeft !== "number") return "—";

    var daysLeftClass = "days-left";
    if (daysLeft < 0) daysLeftClass += " days-left--overdue";
    else if (daysLeft <= 3) daysLeftClass += " days-left--warning";

    var displayValue = formatWorkingDaysLeftValue(daysLeft);
    var absoluteDays = Math.abs(daysLeft);
    var dayLabel = absoluteDays === 1 ? "working day" : "working days";
    var title = daysLeft === 0 ? "Due today" : (daysLeft < 0
        ? absoluteDays + " " + dayLabel + " overdue"
        : daysLeft + " " + dayLabel + " left");

    return "<span class=\"" + daysLeftClass + "\" title=\"" + escapeHtml(title) + "\">" + escapeHtml(displayValue) + "</span>";
}

function addOption(sel, value, text, selected) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (selected) opt.selected = true;
    sel.appendChild(opt);
}

function isKnownTaskType(value) {
    return TASK_TYPE_OPTIONS.indexOf(String(value || "").trim()) !== -1;
}

function getTaskTypeBadgeClass(taskType) {
    var value = String(taskType || "").trim().toLowerCase();
    if (!value) return "task-type-badge--neutral";
    if (value === "infrastructure development" || value === "infrastructure activity" || value === "maintenance") {
        return "task-type-badge--field";
    }
    if (value === "research and development" || value === "simulation" || value === "analysis" || value === "measurement") {
        return "task-type-badge--research";
    }
    if (value === "fabrication" || value === "design") {
        return "task-type-badge--engineering";
    }
    if (value === "support services" || value === "document/report preparation") {
        return "task-type-badge--support";
    }
    if (value === "professional upgradation" || value === "committees/meetings/lectures/presentations" || value === "visit & exhibition") {
        return "task-type-badge--coordination";
    }
    if (value === "procurement") {
        return "task-type-badge--procurement";
    }
    return "task-type-badge--neutral";
}

function toggleActivityCreationMode() {
    var createKindSelect = document.getElementById("activity-create-kind");
    var typeGroup = document.getElementById("activity-type-group");
    var typeSelect = document.getElementById("activity-type");
    var nameLabel = document.getElementById("activity-name-label");
    var nameInput = document.getElementById("activity-name");
    var submitBtn = document.getElementById("create-activity-btn");
    var kind = createKindSelect ? String(createKindSelect.value || "activity").toLowerCase() : "activity";
    var isProject = kind === "project";

    if (typeGroup) typeGroup.style.display = isProject ? "none" : "";
    if (typeSelect && isProject) typeSelect.value = ACTIVITY_TYPE_OPTIONS[0];
    if (nameLabel) nameLabel.textContent = isProject ? "Project name" : "Activity name";
    if (nameInput) nameInput.placeholder = isProject ? "e.g. Project Astra" : "e.g. Instrumentation buildup";
    if (submitBtn) submitBtn.textContent = isProject ? "Create project" : "Create activity";

    toggleActivityCustomTypeInput();
}

function toggleActivityCustomTypeInput() {
    var createKindSelect = document.getElementById("activity-create-kind");
    var select = document.getElementById("activity-type");
    var wrap = document.getElementById("activity-custom-type-wrap");
    var input = document.getElementById("activity-custom-type");
    var createKind = createKindSelect ? String(createKindSelect.value || "activity").toLowerCase() : "activity";
    var show = createKind !== "project" && !!(select && select.value === "Others");
    if (wrap) wrap.style.display = show ? "" : "none";
    if (!show && input) input.value = "";
}

function toggleTaskCustomTypeInput() {
    var select = document.getElementById("task-type");
    var wrap = document.getElementById("task-custom-type-wrap");
    var input = document.getElementById("task-custom-type");
    var show = !!(select && select.value === "Others");
    if (wrap) wrap.style.display = show ? "" : "none";
    if (!show && input) input.value = "";
}

function toggleEditTaskCustomTypeInput() {
    var select = document.getElementById("edit-task-type");
    var wrap = document.getElementById("edit-task-custom-type-wrap");
    var input = document.getElementById("edit-task-custom-type");
    var show = !!(select && select.value === "Others");
    if (wrap) wrap.style.display = show ? "" : "none";
    if (!show && input) input.value = "";
}

function toggleTaskScheduleType() {
    var modeSelect = document.getElementById("task-schedule-type");
    var dueWrap = document.getElementById("task-due-wrap");
    var dueInput = document.getElementById("task-due");
    var tentativeStartInput = document.getElementById("task-tentative-start");
    var tentativeCompletionInput = document.getElementById("task-tentative-completion");
    var isTimeBound = !modeSelect || modeSelect.value === "Time Bound";
    if (dueWrap) dueWrap.style.display = isTimeBound ? "" : "none";
    if (dueInput) {
        if (isTimeBound) dueInput.disabled = false;
        else {
            dueInput.value = "";
            dueInput.disabled = true;
        }
    }
    if (tentativeStartInput) tentativeStartInput.required = !isTimeBound;
    if (tentativeCompletionInput) tentativeCompletionInput.required = !isTimeBound;
}

function toggleEditTaskScheduleType() {
    var modeSelect = document.getElementById("edit-task-schedule-type");
    var dueWrap = document.getElementById("edit-task-due-wrap");
    var dueInput = document.getElementById("edit-task-due");
    var tentativeStartInput = document.getElementById("edit-task-tentative-start");
    var tentativeCompletionInput = document.getElementById("edit-task-tentative-completion");
    var isTimeBound = !modeSelect || modeSelect.value === "Time Bound";
    if (dueWrap) dueWrap.style.display = isTimeBound ? "" : "none";
    if (dueInput) {
        if (isTimeBound) dueInput.disabled = false;
        else {
            dueInput.value = "";
            dueInput.disabled = true;
        }
    }
    if (tentativeStartInput) tentativeStartInput.required = !isTimeBound;
    if (tentativeCompletionInput) tentativeCompletionInput.required = !isTimeBound;
}

function loadUserTeams() {
    Promise.all([
        apiRequest("/users/" + getUserId() + "/teams", "GET"),
        apiRequest("/users", "GET"),
        apiRequest("/nav/tree", "GET").catch(function () { return []; })
    ]).then(function (results) {
        var teams = Array.isArray(results[0]) ? results[0] : [];
        // User list must be an array of { id, username } from API only - never use credentials
        var rawUsers = results[1];
        var navTree = Array.isArray(results[2]) ? results[2] : [];
        var users = Array.isArray(rawUsers)
            ? rawUsers.filter(function (u) { return u && typeof u.id !== "undefined" && u.username != null; })
            : [];
        users = sortUsersByDesignationSeniority(users);
        _sidebarNavTreeCache = navTree;
        // Effective role: global (Admin/Division Head) OR best team role (Project Director, Group Head, Team Lead) for header & multi-assign
        var globalRole = (localStorage.getItem("role") || "member").toLowerCase();
        if (globalRole === "admin" || globalRole === "division head") {
            effectiveDisplayRole = globalRole;
        } else {
            var teamPrivilegedRoles = ["project director", "group head", "team lead"];
            effectiveDisplayRole = globalRole;
            for (var i = 0; i < teams.length; i++) {
                var r = (teams[i].user_role || "").toLowerCase().trim();
                if (teamPrivilegedRoles.indexOf(r) !== -1) {
                    effectiveDisplayRole = r;
                    break;
                }
            }
        }
        if (effectiveDisplayRole === "member") {
            window.location.href = "workspace-views.html";
            return;
        }
        updateHeaderRole();
        setupRoleBasedUI(effectiveDisplayRole);
        var teamOptions = teams.map(function (t) { return { id: t.id, name: t.name }; });
        userTeamOptionsForHistory = teamOptions;
        var adminTeamOptions = teams.filter(function (t) {
            return t.user_role === "Admin" || getEffectiveRole() === "division head" || getEffectiveRole() === "admin";
        }).map(function (t) { return { id: t.id, name: t.name }; });
        var removeMemberTeamOptions = teams.filter(function (t) {
            var r = (t.user_role || "").toLowerCase();
            return adminTeamOptions.some(function (a) { return a.id === t.id; }) ||
                r === "project director" || r === "group head" || r === "team lead";
        }).map(function (t) { return { id: t.id, name: t.name }; });

        var taskDivisionSelect = document.getElementById("task-division");
        var taskGroupSelect = document.getElementById("task-group");
        var select = document.getElementById("task-team");
        var activitySelect = document.getElementById("task-activity");
        var createActivityTeamSelect = document.getElementById("activity-team");
        var addMemberDivisionSelect = document.getElementById("add-member-division");
        var addMemberGroupSelect = document.getElementById("add-member-group");
        var addMemberActivitySelect = document.getElementById("add-member-activity");
        var addMemberSelect = document.getElementById("add-member-team");
        var addMemberUserSelect = document.getElementById("add-member-user");
        var filterAssignedSelect = document.getElementById("filter-assigned");
        var sidebarListEl = document.getElementById("team-nav-list");

        initializeTaskCreateHierarchyBindings();
        if (taskDivisionSelect) {
            taskDivisionSelect.innerHTML = "";
            addOption(taskDivisionSelect, "", "Loading divisions...", false);
        }
        if (taskGroupSelect) {
            taskGroupSelect.innerHTML = "";
            addOption(taskGroupSelect, "", "Select division first", false);
        }
        if (activitySelect) {
            activitySelect.innerHTML = "";
            addOption(activitySelect, "", "Select group first", false);
        }
        if (select) {
            select.innerHTML = "";
            addOption(select, "", "Select activity or project first", false);
        }
        if (sidebarListEl) {
            renderSidebarNavTree(false);
        }
        addMemberManageableTeamIds = {};
        adminTeamOptions.forEach(function (t) {
            addMemberManageableTeamIds[String(t.id)] = true;
        });
        if (addMemberDivisionSelect) {
            addMemberDivisionSelect.innerHTML = "";
            addOption(addMemberDivisionSelect, "", adminTeamOptions.length > 0 ? "Select division" : "No teams to manage", false);
            addMemberDivisionSelect.disabled = adminTeamOptions.length === 0;
        }
        if (addMemberGroupSelect) {
            addMemberGroupSelect.innerHTML = "";
            addOption(addMemberGroupSelect, "", "Select division first", false);
            addMemberGroupSelect.disabled = true;
        }
        if (addMemberActivitySelect) {
            addMemberActivitySelect.innerHTML = "";
            addOption(addMemberActivitySelect, "", "Select group first", false);
            addMemberActivitySelect.disabled = true;
        }
        if (addMemberSelect) {
            addMemberSelect.innerHTML = "";
            addOption(addMemberSelect, "", adminTeamOptions.length > 0 ? "Select activity or project first" : "No teams to manage", false);
            addMemberSelect.disabled = adminTeamOptions.length === 0;
        }
        if (adminTeamOptions.length > 0) {
            var memberSection = document.getElementById("member-section");
            if (memberSection) memberSection.style.display = "block";
        }
        refreshAddMemberHierarchySelectors();
        if (createActivityTeamSelect) {
            createActivityTeamSelect.innerHTML = "";
            addOption(createActivityTeamSelect, "", "Select team", false);
            teamOptions.forEach(function (t) { addOption(createActivityTeamSelect, t.id, t.name, false); });
        }
        refreshDeleteHierarchySelectors();
        refreshRemoveMemberSourceHierarchySelectors();
        refreshRemoveMemberTargetHierarchySelectors();
        toggleRemoveMemberShiftTargets();
        if (addMemberUserSelect) {
            addMemberUserSelect.innerHTML = "";
            addOption(addMemberUserSelect, "", "Select user", false);
            users.forEach(function (u) {
                var label = formatUserOptionLabel(u, "User " + u.id);
                addOption(addMemberUserSelect, u.id, label + " (ID: " + formatUserIdDisplay(u.id) + ")", false);
            });
        }
        if (filterAssignedSelect) {
            filterAssignedSelect.innerHTML = "";
            addOption(filterAssignedSelect, "", "Assigned to", true);
            users.forEach(function (u) {
                var label = formatUserOptionLabel(u, "User " + u.id);
                addOption(filterAssignedSelect, u.id, label, false);
            });
        }

        var statTeams = document.getElementById("stat-teams");
        if (statTeams) statTeams.textContent = teams && teams.length !== undefined ? teams.length : 0;
        currentUserInfoMemberships = deriveInfoMemberships(navTree, teams);
        updateInfoCounts(currentUserInfoMemberships);
        renderInfoMembershipList();

        // Keep default as "All teams" on initial load; do not auto-switch to first team.
        updateTeamNavActiveState();
    }).catch(function (err) {
        var statTeams = document.getElementById("stat-teams");
        if (statTeams) statTeams.textContent = "0";
        showToast(err.message || "Failed to load teams", true);
    });
}

// ---------------- Sidebar: Division -> Group -> Activity -> Team ----------------

function renderSidebarNavTree(forceRefresh) {
    var sidebarListEl = document.getElementById("team-nav-list");
    if (!sidebarListEl) return;

    function renderTree(tree) {
        buildTaskCreateHierarchyFromTree(tree || []);
        refreshHierarchyEditOptionsFromTree(tree || []);
        if (!tree || tree.length === 0) {
            sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">No divisions yet</div>";
            return;
        }
        var html = "";
        for (var i = 0; i < tree.length; i++) {
            var d = tree[i];
            var dOpen = sidebarOpenDivisionId === d.id;
            html += (
                "<div class=\"sidebar-team\" role=\"listitem\">" +
                "<button type=\"button\" class=\"sidebar-item sidebar-team-btn\" onclick=\"toggleDivisionNav(" + d.id + ")\">" +
                "<span class=\"sidebar-dot\" aria-hidden=\"true\"></span>" +
                "<span class=\"sidebar-label\">" + escapeHtml(d.name) + "</span>" +
                "<span class=\"sidebar-caret\" aria-hidden=\"true\"></span>" +
                "</button>" +
                "<div class=\"sidebar-sublist\" id=\"division-groups-" + d.id + "\" " + (dOpen ? "" : "hidden") + "></div>" +
                "</div>"
            );
        }
        sidebarListEl.innerHTML = html;
        if (sidebarOpenDivisionId !== null) {
            var dNode = null;
            for (var k = 0; k < tree.length; k++) if (tree[k].id === sidebarOpenDivisionId) dNode = tree[k];
            if (dNode) renderDivisionGroups(dNode);
        }
    }

    if (!forceRefresh && _sidebarNavTreeCache) {
        renderTree(_sidebarNavTreeCache);
        return;
    }
    sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">Loading…</div>";
    apiRequest("/nav/tree", "GET").then(function (tree) {
        _sidebarNavTreeCache = Array.isArray(tree) ? tree : [];
        renderTree(_sidebarNavTreeCache);
    }).catch(function () {
        sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">Failed to load divisions</div>";
    });
}

function toggleDivisionNav(divisionId) {
    divisionId = divisionId ? parseInt(divisionId, 10) : null;
    if (!divisionId) return;
    if (sidebarOpenDivisionId === divisionId) {
        sidebarOpenDivisionId = null;
        sidebarOpenGroupId = null;
        sidebarOpenActivityId = null;
    } else {
        sidebarOpenDivisionId = divisionId;
        sidebarOpenGroupId = null;
        sidebarOpenActivityId = null;
    }
    renderSidebarNavTree(false);
}

function toggleGroupNav(groupId) {
    groupId = groupId ? parseInt(groupId, 10) : null;
    if (!groupId) return;
    if (sidebarOpenGroupId === groupId) {
        sidebarOpenGroupId = null;
        sidebarOpenActivityId = null;
    } else {
        sidebarOpenGroupId = groupId;
        sidebarOpenActivityId = null;
    }
    renderSidebarNavTree(false);
}

function toggleActivityNav(activityId) {
    activityId = activityId ? parseInt(activityId, 10) : null;
    if (!activityId) return;
    if (sidebarOpenActivityId === activityId) sidebarOpenActivityId = null;
    else sidebarOpenActivityId = activityId;
    // Selecting an activity here is mainly for the Activity Chat panel.
    currentActivityIdForView = activityId;
    renderSidebarNavTree(false);
    if (chatPanelOpen) loadActivityChat(true);
    else updateChatSubtitle();
}

function renderDivisionGroups(divisionNode) {
    var groupsEl = document.getElementById("division-groups-" + divisionNode.id);
    if (!groupsEl) return;
    var groups = Array.isArray(divisionNode.groups) ? divisionNode.groups : [];
    if (groups.length === 0) {
        groupsEl.innerHTML = "<div class=\"sidebar-subempty\">No groups</div>";
        return;
    }
    var html = "";
    for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var gOpen = sidebarOpenGroupId === g.id;
        html += (
            "<div>" +
            "<button type=\"button\" class=\"sidebar-subitem\" onclick=\"toggleGroupNav(" + g.id + ")\">" +
            escapeHtml(g.name) +
            "</button>" +
            "<div class=\"sidebar-sublist\" id=\"group-activities-" + g.id + "\" " + (gOpen ? "" : "hidden") + "></div>" +
            "</div>"
        );
    }
    groupsEl.innerHTML = html;
    if (sidebarOpenGroupId !== null) {
        var gNode = null;
        for (var k = 0; k < groups.length; k++) if (groups[k].id === sidebarOpenGroupId) gNode = groups[k];
        if (gNode) renderGroupActivities(gNode);
    }
}

function renderGroupActivities(groupNode) {
    var actsEl = document.getElementById("group-activities-" + groupNode.id);
    if (!actsEl) return;
    var acts = Array.isArray(groupNode.activities) ? groupNode.activities : [];
    if (acts.length === 0) {
        actsEl.innerHTML = "<div class=\"sidebar-subempty\">No activities or projects</div>";
        return;
    }
    var html = "";
    for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        var aOpen = sidebarOpenActivityId === a.id;
        var activityTypeClass = getSidebarActivityTypeClass(a.type);
        html += (
            "<div>" +
            "<button type=\"button\" class=\"sidebar-subitem " + activityTypeClass + "\" onclick=\"toggleActivityNav(" + a.id + ")\">" +
            escapeHtml(formatActivityProjectName(a.name, a.type)) +
            "</button>" +
            "<div class=\"sidebar-sublist\" id=\"activity-teams-" + a.id + "\" " + (aOpen ? "" : "hidden") + "></div>" +
            "</div>"
        );
    }
    actsEl.innerHTML = html;
    if (sidebarOpenActivityId !== null) {
        var aNode = null;
        for (var k = 0; k < acts.length; k++) if (acts[k].id === sidebarOpenActivityId) aNode = acts[k];
        if (aNode) renderActivityTeams(aNode);
    }
}

function renderActivityTeams(activityNode) {
    var teamsEl = document.getElementById("activity-teams-" + activityNode.id);
    if (!teamsEl) return;
    var teams = Array.isArray(activityNode.teams) ? activityNode.teams : [];
    if (teams.length === 0) {
        teamsEl.innerHTML = "<div class=\"sidebar-subempty\">No teams</div>";
        return;
    }
    teamsEl.innerHTML = teams.map(function (t) {
        var isActive = currentTeamIdForView !== null && t.id === currentTeamIdForView;
        return (
            "<button type=\"button\" class=\"sidebar-subitem" + (isActive ? " sidebar-subitem--active" : "") + "\" onclick=\"selectTeamForView(" + t.id + ")\">" +
            escapeHtml(t.name) +
            "</button>"
        );
    }).join("");
}

function selectTeamForView(teamId) {
    currentTeamIdForView = teamId ? parseInt(teamId, 10) : null;
    // Keep currentActivityIdForView as-is (activity chat selection is independent of team filtering)
    sidebarOpenTeamId = currentTeamIdForView;
    var statsSection = document.getElementById("statistics-section");
    if (statsSection) statsSection.hidden = true;
    var navStats = document.getElementById("team-nav-statistics");
    if (navStats) navStats.classList.remove("sidebar-item--active");
    var allBtn = document.getElementById("team-nav-all");
    if (allBtn) {
        allBtn.setAttribute("data-explicit", currentTeamIdForView === null ? "1" : "0");
    }
    updateTeamNavActiveState();
    syncCreateTaskTeamToView();
    loadTasks();
    if (chatPanelOpen) {
        loadActivityChat(true);
    } else {
        updateChatSubtitle();
    }
}

function updateTeamNavActiveState() {
    var allBtn = document.getElementById("team-nav-all");
    if (allBtn) {
        allBtn.classList.toggle("sidebar-item--active", currentTeamIdForView === null);
    }
    var navStats = document.getElementById("team-nav-statistics");
    if (navStats) navStats.classList.remove("sidebar-item--active");
    // Active team highlight is handled when rendering the nav tree (teams get sidebar-subitem--active).
}

function syncCreateTaskTeamToView() {
    var teamSelect = document.getElementById("task-team");
    if (!teamSelect || currentTeamIdForView === null) return;

    var teamMeta = taskCreateHierarchy.teamMetaById[String(currentTeamIdForView)];
    if (!teamMeta) return;

    populateTaskDivisionOptions(teamMeta.division_id);
    populateTaskGroupOptions(teamMeta.division_id, teamMeta.group_id);
    populateTaskActivityOptions(teamMeta.group_id, teamMeta.activity_id);
    populateTaskTeamOptions(teamMeta.activity_id, teamMeta.team_id);
    teamSelect.value = String(teamMeta.team_id);
    setTaskCreateDetailsEnabled(canEnableTaskCreateDetails());
    loadTeamMembersForAssignee(teamMeta.team_id);
    loadTeamMembersForLead(teamMeta.team_id);
    loadClosureApprovers(teamMeta.team_id);
    syncTaskAssignmentScopeUI();
}

function selectActivityForView(teamId, activityId) {
    currentTeamIdForView = teamId ? parseInt(teamId, 10) : null;
    currentActivityIdForView = activityId ? parseInt(activityId, 10) : null;
    sidebarOpenTeamId = currentTeamIdForView;
    updateTeamNavActiveState();
    syncCreateTaskTeamToView();
    ensureTeamActivitiesLoadedAndShown(sidebarOpenTeamId);
    loadTasks();
    if (chatPanelOpen) {
        loadActivityChat(true);
    } else {
        updateChatSubtitle();
    }
}

function ensureTeamActivitiesLoadedAndShown(teamId) {
    if (!teamId) {
        // All teams: collapse all activity lists
        var listEl = document.getElementById("team-nav-list");
        if (!listEl || !listEl.querySelectorAll) return;
        var subs = listEl.querySelectorAll(".sidebar-sublist");
        for (var i = 0; i < subs.length; i++) subs[i].hidden = true;
        return;
    }

    var subListEl = document.getElementById("team-activities-" + teamId);
    if (!subListEl) return;

    // Toggle open for selected team; close others.
    var listWrap = document.getElementById("team-nav-list");
    if (listWrap && listWrap.querySelectorAll) {
        var allSubs = listWrap.querySelectorAll(".sidebar-sublist");
        for (var j = 0; j < allSubs.length; j++) allSubs[j].hidden = true;
    }
    subListEl.hidden = false;

    // If cached, just render.
    if (_sidebarTeamActivitiesCache[String(teamId)]) {
        renderTeamActivities(teamId, _sidebarTeamActivitiesCache[String(teamId)]);
        return;
    }

    subListEl.innerHTML = "<div class=\"sidebar-subempty\">Loading activities…</div>";
    apiRequest("/teams/" + teamId + "/activities", "GET")
        .then(function (activities) {
            var list = Array.isArray(activities) ? activities : [];
            _sidebarTeamActivitiesCache[String(teamId)] = list;
            renderTeamActivities(teamId, list);
        })
        .catch(function () {
            subListEl.innerHTML = "<div class=\"sidebar-subempty\">No activities or projects</div>";
        });
}

function renderTeamActivities(teamId, activities) {
    var subListEl = document.getElementById("team-activities-" + teamId);
    if (!subListEl) return;

    if (!activities || activities.length === 0) {
        subListEl.innerHTML = "<div class=\"sidebar-subempty\">No activities or projects</div>";
        return;
    }

    // Include an "All activities/projects" item for the selected team.
    var html = "";
    html += (
        "<button type=\"button\" class=\"sidebar-subitem" + (currentActivityIdForView === null ? " sidebar-subitem--active" : "") + "\" " +
        "onclick=\"selectActivityForView(" + teamId + ", null)\">All activities / projects</button>"
    );

    html += activities.map(function (a) {
        var label = escapeHtml(formatActivityProjectName(a.name, a.type));
        var isActive = currentActivityIdForView !== null && a.id === currentActivityIdForView;
        return (
            "<button type=\"button\" class=\"sidebar-subitem" + (isActive ? " sidebar-subitem--active" : "") + "\" " +
            "data-activity-id=\"" + a.id + "\" onclick=\"selectActivityForView(" + teamId + ", " + a.id + ")\">" + label + "</button>"
        );
    }).join("");

    subListEl.innerHTML = html;
    updateTeamNavActiveState();
}

function getSidebarScopeMaps() {
    var tree = Array.isArray(_sidebarNavTreeCache) ? _sidebarNavTreeCache : [];
    var map = {
        divisions: {},
        groups: {},
        activities: {},
        teams: {}
    };
    tree.forEach(function (division) {
        map.divisions[division.id] = { id: division.id, name: division.name, head_user_id: division.head_user_id || null };
        (division.groups || []).forEach(function (group) {
            map.groups[group.id] = {
                id: group.id,
                name: group.name,
                head_user_id: group.head_user_id || null,
                division_id: division.id,
                division_name: division.name
            };
            (group.activities || []).forEach(function (activity) {
                map.activities[activity.id] = {
                    id: activity.id,
                    name: activity.name,
                    type: activity.type || "",
                    group_id: group.id,
                    group_name: group.name,
                    division_id: division.id,
                    division_name: division.name
                };
                (activity.teams || []).forEach(function (team) {
                    map.teams[team.id] = {
                        id: team.id,
                        name: team.name,
                        activity_id: activity.id,
                        activity_name: activity.name,
                        activity_type: activity.type || "",
                        group_id: group.id,
                        group_name: group.name,
                        division_id: division.id,
                        division_name: division.name
                    };
                });
            });
        });
    });
    return map;
}

function getTaskScopeInfo(task, scopeMaps) {
    scopeMaps = scopeMaps || getSidebarScopeMaps();
    var activityInfo = task && task.activity_id ? scopeMaps.activities[task.activity_id] : null;
    var teamInfo = task && task.team_id ? scopeMaps.teams[task.team_id] : null;
    return {
        division_id: activityInfo ? activityInfo.division_id : (teamInfo ? teamInfo.division_id : null),
        division_name: activityInfo ? activityInfo.division_name : (teamInfo ? teamInfo.division_name : null),
        group_id: activityInfo ? activityInfo.group_id : (teamInfo ? teamInfo.group_id : null),
        group_name: activityInfo ? activityInfo.group_name : (teamInfo ? teamInfo.group_name : null),
        activity_id: task ? task.activity_id : null,
        activity_name: task && task.activity_name ? task.activity_name : (activityInfo ? activityInfo.name : (teamInfo ? teamInfo.activity_name : null)),
        activity_type: task && task.activity_type ? task.activity_type : (activityInfo ? activityInfo.type : (teamInfo ? teamInfo.activity_type : null)),
        team_id: task ? task.team_id : null,
        team_name: task && task.team_name ? task.team_name : (teamInfo ? teamInfo.name : null)
    };
}

function matchesCurrentTaskScope(task, scopeMaps) {
    var info = getTaskScopeInfo(task, scopeMaps);
    if (currentTeamIdForView && info.team_id !== currentTeamIdForView) return false;
    if (currentActivityIdForView && info.activity_id !== currentActivityIdForView) return false;
    if (currentGroupIdForView && info.group_id !== currentGroupIdForView) return false;
    if (currentDivisionIdForView && info.division_id !== currentDivisionIdForView) return false;
    return true;
}

function getCurrentTaskScopeLabel(scopeMaps) {
    scopeMaps = scopeMaps || getSidebarScopeMaps();
    if (currentActivityIdForView && scopeMaps.activities[currentActivityIdForView]) {
        var currentActivity = scopeMaps.activities[currentActivityIdForView];
        return "Showing " + getActivityProjectLabel(currentActivity.type) + ": " + currentActivity.name;
    }
    if (currentGroupIdForView && scopeMaps.groups[currentGroupIdForView]) {
        return "Showing group: " + scopeMaps.groups[currentGroupIdForView].name;
    }
    if (currentDivisionIdForView && scopeMaps.divisions[currentDivisionIdForView]) {
        return "Showing division: " + scopeMaps.divisions[currentDivisionIdForView].name;
    }
    if (currentTeamIdForView && scopeMaps.teams[currentTeamIdForView]) {
        return "Showing team: " + scopeMaps.teams[currentTeamIdForView].name;
    }
    return "Showing all tasks";
}

function selectAllTasksView() {
    var statsSection = document.getElementById("statistics-section");
    if (statsSection) statsSection.hidden = true;
    var navStats = document.getElementById("team-nav-statistics");
    if (navStats) navStats.classList.remove("sidebar-item--active");
    currentDivisionIdForView = null;
    currentGroupIdForView = null;
    currentActivityIdForView = null;
    currentTeamIdForView = null;
    updateTeamNavActiveState();
    loadTasks();
    updateChatSubtitle();
}

function selectDivisionForView(divisionId) {
    var statsSection = document.getElementById("statistics-section");
    if (statsSection) statsSection.hidden = true;
    currentDivisionIdForView = divisionId ? parseInt(divisionId, 10) : null;
    currentGroupIdForView = null;
    currentActivityIdForView = null;
    currentTeamIdForView = null;
    sidebarOpenDivisionId = currentDivisionIdForView;
    updateTeamNavActiveState();
    loadTasks();
}

function selectGroupForView(divisionId, groupId) {
    var statsSection = document.getElementById("statistics-section");
    if (statsSection) statsSection.hidden = true;
    currentDivisionIdForView = divisionId ? parseInt(divisionId, 10) : null;
    currentGroupIdForView = groupId ? parseInt(groupId, 10) : null;
    currentActivityIdForView = null;
    currentTeamIdForView = null;
    sidebarOpenDivisionId = currentDivisionIdForView;
    sidebarOpenGroupId = currentGroupIdForView;
    updateTeamNavActiveState();
    loadTasks();
}

function selectActivityForView(activityId, teamId) {
    var statsSection = document.getElementById("statistics-section");
    if (statsSection) statsSection.hidden = true;
    currentActivityIdForView = activityId ? parseInt(activityId, 10) : null;
    currentTeamIdForView = teamId ? parseInt(teamId, 10) : null;
    var maps = getSidebarScopeMaps();
    var activityInfo = currentActivityIdForView ? maps.activities[currentActivityIdForView] : null;
    currentGroupIdForView = activityInfo ? activityInfo.group_id : null;
    currentDivisionIdForView = activityInfo ? activityInfo.division_id : null;
    sidebarOpenDivisionId = currentDivisionIdForView;
    sidebarOpenGroupId = currentGroupIdForView;
    sidebarOpenActivityId = currentActivityIdForView;
    updateTeamNavActiveState();
    loadTasks();
    if (chatPanelOpen) loadActivityChat(true);
    else updateChatSubtitle();
}

function selectTeamForView(teamId) {
    var statsSection = document.getElementById("statistics-section");
    if (statsSection) statsSection.hidden = true;
    currentTeamIdForView = teamId ? parseInt(teamId, 10) : null;
    var maps = getSidebarScopeMaps();
    var teamInfo = currentTeamIdForView ? maps.teams[currentTeamIdForView] : null;
    currentActivityIdForView = teamInfo ? teamInfo.activity_id : null;
    currentGroupIdForView = teamInfo ? teamInfo.group_id : null;
    currentDivisionIdForView = teamInfo ? teamInfo.division_id : null;
    updateTeamNavActiveState();
    syncCreateTaskTeamToView();
    loadTasks();
}

function handleDivisionScopeClick(divisionId) {
    var shouldCollapse = sidebarOpenDivisionId === divisionId && currentDivisionIdForView === divisionId && !currentGroupIdForView && !currentActivityIdForView;
    selectDivisionForView(divisionId);
    sidebarOpenDivisionId = shouldCollapse ? null : divisionId;
    if (shouldCollapse) {
        currentDivisionIdForView = null;
        loadTasks();
    }
    renderSidebarNavTree(false);
}

function handleGroupScopeClick(divisionId, groupId) {
    var shouldCollapse = sidebarOpenGroupId === groupId && currentGroupIdForView === groupId && !currentActivityIdForView;
    selectGroupForView(divisionId, groupId);
    sidebarOpenDivisionId = divisionId;
    sidebarOpenGroupId = shouldCollapse ? null : groupId;
    if (shouldCollapse) {
        currentGroupIdForView = null;
        currentDivisionIdForView = divisionId;
        loadTasks();
    }
    renderSidebarNavTree(false);
}

function handleActivityScopeClick(activityId) {
    selectActivityForView(activityId, null);
    sidebarOpenActivityId = activityId;
    renderSidebarNavTree(false);
}

function toggleDivisionBranch(evt, divisionId) {
    if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
    divisionId = divisionId ? parseInt(divisionId, 10) : null;
    if (!divisionId) return;
    sidebarOpenDivisionId = sidebarOpenDivisionId === divisionId ? null : divisionId;
    if (sidebarOpenDivisionId !== divisionId) {
        sidebarOpenGroupId = null;
        sidebarOpenActivityId = null;
    }
    renderSidebarNavTree(false);
}

function toggleGroupBranch(evt, groupId) {
    if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
    groupId = groupId ? parseInt(groupId, 10) : null;
    if (!groupId) return;
    sidebarOpenGroupId = sidebarOpenGroupId === groupId ? null : groupId;
    if (sidebarOpenGroupId !== groupId) {
        sidebarOpenActivityId = null;
    }
    renderSidebarNavTree(false);
}

function toggleActivityBranch(evt, activityId) {
    if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
    activityId = activityId ? parseInt(activityId, 10) : null;
    if (!activityId) return;
    sidebarOpenActivityId = sidebarOpenActivityId === activityId ? null : activityId;
    renderSidebarNavTree(false);
}

function updateTeamNavActiveState() {
    var allBtn = document.getElementById("team-nav-all");
    if (allBtn) {
        allBtn.classList.toggle("sidebar-item--active", !currentDivisionIdForView && !currentGroupIdForView && !currentActivityIdForView && !currentTeamIdForView);
    }
    var navStats = document.getElementById("team-nav-statistics");
    if (navStats) navStats.classList.remove("sidebar-item--active");
}

function renderSidebarNavTree(forceRefresh) {
    var sidebarListEl = document.getElementById("team-nav-list");
    if (!sidebarListEl) return;

    function renderTree(tree) {
        buildTaskCreateHierarchyFromTree(tree || []);
        refreshHierarchyEditOptionsFromTree(tree || []);
        if (!tree || tree.length === 0) {
            sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">No divisions yet</div>";
            return;
        }
        var html = "";
        tree.forEach(function (division) {
            var isDivisionActive = currentDivisionIdForView === division.id && !currentGroupIdForView && !currentActivityIdForView;
            var groupsHtml = "";
            if (Array.isArray(division.groups) && division.groups.length > 0) {
                groupsHtml += "<div class=\"sidebar-section-label\">Groups</div>";
                division.groups.forEach(function (group) {
                    var isGroupActive = currentGroupIdForView === group.id && !currentActivityIdForView;
                    var activitiesHtml = "";
                    if (Array.isArray(group.activities) && group.activities.length > 0) {
                        activitiesHtml += "<div class=\"sidebar-section-label\">Activities / Projects</div>";
                        group.activities.forEach(function (activity) {
                            var isActivityActive = currentActivityIdForView === activity.id;
                            var activityTypeClass = getSidebarActivityTypeClass(activity.type);
                            var teamsHtml = "";
                            if (Array.isArray(activity.teams) && activity.teams.length > 0) {
                                teamsHtml += "<div class=\"sidebar-section-label\">Teams</div>";
                                teamsHtml += activity.teams.map(function (team) {
                                    var isTeamActive = currentTeamIdForView === team.id;
                                    return "<button type=\"button\" class=\"sidebar-subitem" + (isTeamActive ? " sidebar-subitem--active" : "") + "\" onclick=\"selectActivityForView(" + activity.id + ", " + team.id + ")\">" + escapeHtml(team.name) + "</button>";
                                }).join("");
                            } else {
                                teamsHtml = "<div class=\"sidebar-subempty\">No teams</div>";
                            }
                            activitiesHtml += (
                                "<div>" +
                                "<div class=\"sidebar-subitem-row\">" +
                                "<button type=\"button\" class=\"sidebar-subitem " + activityTypeClass + (isActivityActive ? " sidebar-subitem--active" : "") + "\" onclick=\"handleActivityScopeClick(" + activity.id + ")\">" + escapeHtml(formatActivityProjectName(activity.name, activity.type)) + "</button>" +
                                "<button type=\"button\" class=\"sidebar-branch-toggle\" aria-label=\"Toggle activity teams\" aria-expanded=\"" + (sidebarOpenActivityId === activity.id ? "true" : "false") + "\" onclick=\"toggleActivityBranch(event, " + activity.id + "); return false;\"></button>" +
                                "</div>" +
                                "<div class=\"sidebar-sublist\" " + (sidebarOpenActivityId === activity.id ? "" : "hidden") + ">" + teamsHtml + "</div>" +
                                "</div>"
                            );
                        });
                    } else {
                        activitiesHtml = "<div class=\"sidebar-subempty\">No activities or projects</div>";
                    }
                    groupsHtml += (
                        "<div>" +
                        "<div class=\"sidebar-subitem-row\">" +
                        "<button type=\"button\" class=\"sidebar-subitem" + (isGroupActive ? " sidebar-subitem--active" : "") + "\" onclick=\"handleGroupScopeClick(" + division.id + ", " + group.id + ")\">Group: " + escapeHtml(group.name) + "</button>" +
                        "<button type=\"button\" class=\"sidebar-branch-toggle\" aria-label=\"Toggle group activities\" aria-expanded=\"" + (sidebarOpenGroupId === group.id ? "true" : "false") + "\" onclick=\"toggleGroupBranch(event, " + group.id + "); return false;\"></button>" +
                        "</div>" +
                        "<div class=\"sidebar-sublist\" " + (sidebarOpenGroupId === group.id ? "" : "hidden") + ">" + activitiesHtml + "</div>" +
                        "</div>"
                    );
                });
            } else {
                groupsHtml = "<div class=\"sidebar-subempty\">No groups</div>";
            }

            html += (
                "<div class=\"sidebar-team\" role=\"listitem\">" +
                "<div class=\"sidebar-item-row\">" +
                "<button type=\"button\" class=\"sidebar-item sidebar-team-btn" + (isDivisionActive ? " sidebar-item--active" : "") + "\" onclick=\"handleDivisionScopeClick(" + division.id + ")\">" +
                "<span class=\"sidebar-dot\" aria-hidden=\"true\"></span>" +
                "<span class=\"sidebar-label\">Division: " + escapeHtml(division.name) + "</span>" +
                "</button>" +
                "<button type=\"button\" class=\"sidebar-branch-toggle\" aria-label=\"Toggle division groups\" aria-expanded=\"" + (sidebarOpenDivisionId === division.id ? "true" : "false") + "\" onclick=\"toggleDivisionBranch(event, " + division.id + "); return false;\"></button>" +
                "</div>" +
                "<div class=\"sidebar-sublist\" " + (sidebarOpenDivisionId === division.id ? "" : "hidden") + ">" + groupsHtml + "</div>" +
                "</div>"
            );
        });
        sidebarListEl.innerHTML = html;
        updateTeamNavActiveState();
    }

    if (!forceRefresh && _sidebarNavTreeCache) {
        renderTree(_sidebarNavTreeCache);
        return;
    }
    sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">Loading...</div>";
    apiRequest("/nav/tree", "GET").then(function (tree) {
        _sidebarNavTreeCache = Array.isArray(tree) ? tree : [];
        renderTree(_sidebarNavTreeCache);
    }).catch(function () {
        sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">Failed to load divisions</div>";
    });
}

function toggleChatPanel(forceOpen) {
    var panel = document.getElementById("chat-panel");
    if (!panel) return;
    if (typeof forceOpen === "boolean") chatPanelOpen = forceOpen;
    else chatPanelOpen = !chatPanelOpen;
    panel.hidden = !chatPanelOpen;
    if (chatPanelOpen) {
        loadActivityChat(true);
    }
}

function updateChatSubtitle() {
    var el = document.getElementById("chat-subtitle");
    if (!el) return;
    if (!currentActivityIdForView) {
        el.textContent = "Select an activity";
        return;
    }
    var label = "Activity #" + currentActivityIdForView;
    if (currentTeamIdForView && _sidebarTeamActivitiesCache[String(currentTeamIdForView)]) {
        var acts = _sidebarTeamActivitiesCache[String(currentTeamIdForView)] || [];
        for (var i = 0; i < acts.length; i++) {
            if (acts[i] && acts[i].id === currentActivityIdForView) {
                label = acts[i].name + (acts[i].type ? " (" + acts[i].type + ")" : "");
                break;
            }
        }
    }
    el.textContent = label;
}

var activityChatActiveTab = "chat";

function switchActivityChatTab(tab) {
    activityChatActiveTab = tab;
    var chatPanel = document.getElementById("chat-messages-panel");
    var systemPanel = document.getElementById("chat-system-panel");
    var chatTabBtn = document.getElementById("chat-tab-chat");
    var systemTabBtn = document.getElementById("chat-tab-system");
    var compose = document.getElementById("chat-compose");
    if (chatPanel) chatPanel.hidden = tab !== "chat";
    if (systemPanel) systemPanel.hidden = tab !== "system";
    if (chatTabBtn) {
        chatTabBtn.classList.toggle("chat-tab--active", tab === "chat");
        chatTabBtn.setAttribute("aria-selected", tab === "chat" ? "true" : "false");
    }
    if (systemTabBtn) {
        systemTabBtn.classList.toggle("chat-tab--active", tab === "system");
        systemTabBtn.setAttribute("aria-selected", tab === "system" ? "true" : "false");
    }
    if (compose) compose.hidden = tab !== "chat";
}

function initActivityChatTabs() {
    var chatTab = document.getElementById("chat-tab-chat");
    var systemTab = document.getElementById("chat-tab-system");
    if (chatTab && !chatTab._bound) {
        chatTab._bound = true;
        chatTab.addEventListener("click", function () { switchActivityChatTab("chat"); });
    }
    if (systemTab && !systemTab._bound) {
        systemTab._bound = true;
        systemTab.addEventListener("click", function () { switchActivityChatTab("system"); });
    }
}

function loadActivityChat(forceRefresh) {
    updateChatSubtitle();
    initActivityChatTabs();
    var chatBox = document.getElementById("chat-messages");
    var systemBox = document.getElementById("chat-system-messages");
    var input = document.getElementById("chat-input");
    if (!chatBox) return;

    if (!currentActivityIdForView) {
        chatBox.innerHTML = "<div class=\"chat-empty\">Select a specific activity to view its discussion.</div>";
        if (systemBox) systemBox.innerHTML = "<div class=\"chat-empty\">No system messages.</div>";
        if (input) input.disabled = true;
        return;
    }

    if (input) input.disabled = false;

    var cacheKey = String(currentActivityIdForView);
    if (!forceRefresh && chatMessagesCache[cacheKey]) {
        renderChatMessages(chatMessagesCache[cacheKey]);
        return;
    }

    chatBox.innerHTML = "<div class=\"chat-empty\">Loading…</div>";
    if (systemBox) systemBox.innerHTML = "<div class=\"chat-empty\">Loading…</div>";
    apiRequest("/activities/" + currentActivityIdForView + "/messages?limit=200", "GET")
        .then(function (msgs) {
            var list = Array.isArray(msgs) ? msgs : [];
            chatMessagesCache[cacheKey] = list;
            renderChatMessages(list);
        })
        .catch(function (err) {
            var errMsg = "Failed to load chat. " + escapeHtml(err.message || "");
            chatBox.innerHTML = "<div class=\"chat-empty\">" + errMsg + "</div>";
            if (systemBox) systemBox.innerHTML = "<div class=\"chat-empty\">" + errMsg + "</div>";
        });
}

function renderChatMessages(messages) {
    var chatBox = document.getElementById("chat-messages");
    var systemBox = document.getElementById("chat-system-messages");
    if (!chatBox) return;

    var list = Array.isArray(messages) ? messages : [];
    var userMessages = list.filter(function (m) { return m && m.message_type !== "system"; });
    var systemMessages = list.filter(function (m) { return m && m.message_type === "system"; });

    if (userMessages.length === 0) {
        chatBox.innerHTML = "<div class=\"chat-empty\">No messages yet.</div>";
    } else {
        chatBox.innerHTML = userMessages.map(function (m) {
            var who = m.username || "User";
            var when = m.created_at ? formatBackendDateTimeToLocal(m.created_at) : "";
            return (
                "<div class=\"chat-msg\">" +
                "<div class=\"chat-meta\"><span class=\"chat-who\">" + renderUserLabelHtml(who, m.designation, "User") + "</span><span class=\"chat-when\">" + escapeHtml(when) + "</span></div>" +
                "<div class=\"chat-text\">" + escapeHtml(m.content || "") + "</div>" +
                "</div>"
            );
        }).join("");
    }
    if (systemBox) {
        if (systemMessages.length === 0) {
            systemBox.innerHTML = "<div class=\"chat-empty\">No system messages.</div>";
        } else {
            systemBox.innerHTML = systemMessages.map(function (m) {
                var when = m.created_at ? formatBackendDateTimeToLocal(m.created_at) : "";
                return (
                    "<div class=\"chat-msg chat-msg--system\">" +
                    "<div class=\"chat-meta\"><span class=\"chat-who\">System</span><span class=\"chat-when\">" + escapeHtml(when) + "</span></div>" +
                    "<div class=\"chat-text\">" + escapeHtml(m.content || "") + "</div>" +
                    "</div>"
                );
            }).join("");
        }
    }
    try {
        var chatPanel = document.getElementById("chat-messages-panel");
        var systemPanel = document.getElementById("chat-system-panel");
        if (chatPanel && chatPanel.scrollTop !== undefined) chatPanel.scrollTop = chatPanel.scrollHeight;
        if (systemPanel && systemPanel.scrollTop !== undefined) systemPanel.scrollTop = systemPanel.scrollHeight;
    } catch (e) { }
}

function onChatKeyDown(e) {
    if (!e) return;
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

function sendChatMessage() {
    if (!currentActivityIdForView) {
        showToast("Select an activity first", true);
        return;
    }
    var input = document.getElementById("chat-input");
    if (!input) return;
    var content = (input.value || "").trim();
    if (!content) return;
    input.disabled = true;
    apiRequest("/activities/" + currentActivityIdForView + "/messages", "POST", { content: content })
        .then(function () {
            input.value = "";
            input.disabled = false;
            loadActivityChat(true);
        })
        .catch(function (err) {
            input.disabled = false;
            showToast(err.message || "Failed to send message", true);
        });
}

function loadAssignDropdown(selectEl) {
    if (!selectEl || selectEl.options.length > 1) return;
    var teamId = selectEl.getAttribute("data-team-id");
    if (!teamId) return;
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            selectEl.innerHTML = "";
            var placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = "Assign to...";
            selectEl.appendChild(placeholder);
            (members || []).forEach(function (m) {
                var opt = document.createElement("option");
                opt.value = m.id;
                opt.textContent = formatUserOptionLabel(m, "User " + m.id);
                selectEl.appendChild(opt);
            });
        })
        .catch(function () {
            showToast("Could not load team members", true);
        });
}

function approveTaskType(taskId, approved) {
    var action = approved ? "approve" : "reject";
    if (!approved && !confirm("Reject type approval for this task? The task will be marked as rejected.")) return;
    apiRequest("/tasks/" + taskId + "/approve-type", "PUT", { approved: approved })
        .then(function () {
            showToast(approved ? "Task type approved" : "Task type rejected");
            loadTasks();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to " + action + " task type", true);
        });
}

function doAssignTask(selectEl) {
    if (!selectEl || !selectEl.value) return;
    var taskId = selectEl.getAttribute("data-task-id");
    var userId = parseInt(selectEl.value, 10);
    if (!taskId || !userId) return;
    apiRequest("/tasks/" + taskId + "/assign", "PUT", { assigned_to: userId })
        .then(function () {
            showToast("Task assigned");
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to assign task", true);
        });
}

var _taskAssigneesMembers = [];
var _taskAssigneesRowId = 0;
var _editTaskAssigneesMembers = [];
var _editTaskAssigneesRowId = 0;
var currentEditTaskRecord = null;
var currentEditMilestoneRecord = null;

function loadTeamMembersForAssignee(teamId) {
    var assigneeSelect = document.getElementById("task-assignee");
    if (!assigneeSelect || !teamId) {
        if (assigneeSelect) {
            assigneeSelect.innerHTML = "";
            addOption(assigneeSelect, "", "Optional — select team first", false);
        }
        return;
    }
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            assigneeSelect.innerHTML = "";
            addOption(assigneeSelect, "", "Optional (unassigned)", false);
            (members || []).forEach(function (m) { addOption(assigneeSelect, m.id, formatUserOptionLabel(m, "User " + m.id), false); });
            if (canUseMultiAssign()) {
                _taskAssigneesMembers = members || [];
                refreshTaskAssigneeRowsOptions();
            }
        })
        .catch(function () {
            assigneeSelect.innerHTML = "";
            addOption(assigneeSelect, "", "Optional — select team first", false);
        });
}

function refreshTaskAssigneeRowsOptions() {
    var list = document.getElementById("task-assignees-list");
    if (!list) return;
    var selects = list.querySelectorAll("select.task-assignee-user");
    selects.forEach(function (sel) {
        var cur = sel.value;
        sel.innerHTML = "";
        addOption(sel, "", "Select member", false);
        _taskAssigneesMembers.forEach(function (m) {
            addOption(sel, m.id, formatUserOptionLabel(m, "User " + m.id), false);
        });
        if (cur) sel.value = cur;
    });
}

function addTaskAssigneeRow() {
    var list = document.getElementById("task-assignees-list");
    if (!list) return;
    var rowId = "assignee-row-" + (++_taskAssigneesRowId);
    var row = document.createElement("div");
    row.className = "task-assignee-row";
    row.setAttribute("data-row-id", rowId);
    row.innerHTML =
        "<select class=\"input input-sm task-assignee-user\"><option value=\"\">Select member</option></select>" +
        "<input type=\"number\" class=\"input input-sm task-assignee-share\" placeholder=\"%\" min=\"0\" max=\"100\" style=\"width:60px\">" +
        "<label class=\"task-assignee-lead-wrap\"><input type=\"checkbox\" class=\"task-assignee-lead\"> Lead</label>" +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm task-assignee-remove\">Remove</button>";
    list.appendChild(row);
    refreshTaskAssigneeRowsOptions();
    row.querySelector(".task-assignee-remove").onclick = function () {
        row.remove();
    };
    row.querySelector(".task-assignee-lead").onchange = function () {
        if (this.checked) {
            list.querySelectorAll(".task-assignee-lead").forEach(function (cb) {
                if (cb !== row.querySelector(".task-assignee-lead")) cb.checked = false;
            });
        }
    };
}

function getTaskAssigneesFromRows() {
    var list = document.getElementById("task-assignees-list");
    if (!list) return [];
    var rows = list.querySelectorAll(".task-assignee-row");
    var out = [];
    rows.forEach(function (row) {
        var sel = row.querySelector(".task-assignee-user");
        var shareEl = row.querySelector(".task-assignee-share");
        var leadEl = row.querySelector(".task-assignee-lead");
        var uid = sel && sel.value ? parseInt(sel.value, 10) : null;
        if (!uid) return;
        var share = shareEl && shareEl.value.trim() !== "" ? parseInt(shareEl.value, 10) : null;
        if (share !== null && (isNaN(share) || share < 0 || share > 100)) share = null;
        out.push({ user_id: uid, percent_share: share, is_lead: leadEl ? leadEl.checked : false });
    });
    return out;
}

function refreshEditTaskAssigneeRowsOptions() {
    var list = document.getElementById("edit-task-assignees-list");
    if (!list) return;
    var selects = list.querySelectorAll("select.task-assignee-user");
    selects.forEach(function (sel) {
        var current = sel.value;
        sel.innerHTML = "";
        addOption(sel, "", "Select member", false);
        _editTaskAssigneesMembers.forEach(function (member) {
            addOption(sel, member.id, formatUserOptionLabel(member, "User " + member.id), false);
        });
        if (current) sel.value = current;
    });
}

function addEditTaskAssigneeRow(initial) {
    var list = document.getElementById("edit-task-assignees-list");
    if (!list) return;
    var rowId = "edit-assignee-row-" + (++_editTaskAssigneesRowId);
    var row = document.createElement("div");
    row.className = "task-assignee-row";
    row.setAttribute("data-row-id", rowId);
    row.innerHTML =
        "<select class=\"input input-sm task-assignee-user\"><option value=\"\">Select member</option></select>" +
        "<input type=\"number\" class=\"input input-sm task-assignee-share\" placeholder=\"%\" min=\"0\" max=\"100\" style=\"width:60px\">" +
        "<label class=\"task-assignee-lead-wrap\"><input type=\"checkbox\" class=\"task-assignee-lead\"> Lead</label>" +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm task-assignee-remove\">Remove</button>";
    list.appendChild(row);
    refreshEditTaskAssigneeRowsOptions();
    if (initial && initial.user_id) row.querySelector(".task-assignee-user").value = String(initial.user_id);
    if (initial && initial.percent_share != null) row.querySelector(".task-assignee-share").value = String(initial.percent_share);
    if (initial && initial.is_lead) row.querySelector(".task-assignee-lead").checked = true;
    row.querySelector(".task-assignee-remove").onclick = function () {
        row.remove();
    };
    row.querySelector(".task-assignee-lead").onchange = function () {
        if (this.checked) {
            list.querySelectorAll(".task-assignee-lead").forEach(function (cb) {
                if (cb !== row.querySelector(".task-assignee-lead")) cb.checked = false;
            });
        }
    };
}

function getEditTaskAssigneesFromRows() {
    var list = document.getElementById("edit-task-assignees-list");
    if (!list) return [];
    var rows = list.querySelectorAll(".task-assignee-row");
    var out = [];
    rows.forEach(function (row) {
        var sel = row.querySelector(".task-assignee-user");
        var shareEl = row.querySelector(".task-assignee-share");
        var leadEl = row.querySelector(".task-assignee-lead");
        var uid = sel && sel.value ? parseInt(sel.value, 10) : null;
        if (!uid) return;
        var share = shareEl && shareEl.value.trim() !== "" ? parseInt(shareEl.value, 10) : null;
        if (share !== null && (isNaN(share) || share < 0 || share > 100)) share = null;
        out.push({ user_id: uid, percent_share: share, is_lead: !!(leadEl && leadEl.checked) });
    });
    return out;
}

function loadTeamMembersForLead(teamId) {
    var sel = document.getElementById("task-lead");
    if (!sel || !teamId) {
        if (sel) { sel.innerHTML = ""; addOption(sel, "", "Select team first", false); }
        return;
    }
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            sel.innerHTML = "";
            addOption(sel, "", "Optional (no lead)", false);
            (members || []).forEach(function (m) { addOption(sel, m.id, formatUserOptionLabel(m, "User " + m.id), false); });
        })
        .catch(function () { });
}

function loadClosureApprovers(teamId) {
    var sel = document.getElementById("task-closure");
    if (!sel || !teamId) {
        if (sel) { sel.innerHTML = ""; addOption(sel, "", "Default (Admin/Div Head)", false); }
        return;
    }
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            sel.innerHTML = "";
            addOption(sel, "", "Default (Admin/Div Head)", false);
            // "option to give closure control to either group head / division head / project director"
            // We filter members who have these roles. 
            // Note: The backend returns 'role' in member list if we implemented it in 'get_team_members'.
            // Let's check crud.py get_team_members. It returns {id, username, role}.
            var allowedRoles = ["group head", "division head", "project director", "admin"];
            var eligible = (members || []).filter(function (m) {
                var r1 = m.role ? m.role.toLowerCase() : "";
                var r2 = m.global_role ? m.global_role.toLowerCase() : "";
                return allowedRoles.indexOf(r1) !== -1 || allowedRoles.indexOf(r2) !== -1;
            });
            eligible.forEach(function (m) {
                addOption(sel, m.id, formatUserOptionLabel(m, "User " + m.id) + " (" + m.role + ")", false);
            });
        })
        .catch(function () { });
}

function loadTeamMembersForRemoval(teamId) {
    var listEl = document.getElementById("remove-member-user-list");
    removeMemberLoadedMembers = [];
    if (!listEl || !teamId) {
        if (listEl) {
            listEl.innerHTML = '<div class="member-bulk-empty">Select team first</div>';
        }
        return;
    }
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            removeMemberLoadedMembers = Array.isArray(members) ? members : [];
            renderRemoveMemberList(removeMemberLoadedMembers);
        })
        .catch(function () {
            removeMemberLoadedMembers = [];
            if (listEl) listEl.innerHTML = '<div class="member-bulk-empty">Failed to load members</div>';
        });
}

function loadMembersForRemovalScope() {
    var listEl = document.getElementById("remove-member-user-list");
    var teamIds = getRemoveScopeTeamIds();
    removeMemberLoadedMembers = [];
    if (!listEl) return;
    if (!teamIds.length) {
        listEl.innerHTML = '<div class="member-bulk-empty">Select division, group, activity/project, or team</div>';
        return;
    }

    listEl.innerHTML = '<div class="member-bulk-empty">Loading members…</div>';
    Promise.all(teamIds.map(function (teamId) {
        return apiRequest("/teams/" + teamId + "/members", "GET")
            .then(function (members) {
                return { teamId: teamId, members: Array.isArray(members) ? members : [] };
            })
            .catch(function () {
                return { teamId: teamId, members: [] };
            });
    })).then(function (results) {
        var merged = {};
        results.forEach(function (result) {
            (result.members || []).forEach(function (member) {
                var key = String(member.id);
                if (!merged[key]) {
                    merged[key] = {
                        id: member.id,
                        username: member.username,
                        designation: member.designation,
                        role: member.role || "Member",
                        scopeTeamIds: []
                    };
                }
                if (merged[key].scopeTeamIds.indexOf(result.teamId) === -1) {
                    merged[key].scopeTeamIds.push(result.teamId);
                }
            });
        });
        removeMemberLoadedMembers = Object.keys(merged).map(function (key) { return merged[key]; }).sort(function (a, b) {
            return String(a.username || "").localeCompare(String(b.username || ""));
        });
        renderRemoveMemberList(removeMemberLoadedMembers);
    }).catch(function () {
        removeMemberLoadedMembers = [];
        listEl.innerHTML = '<div class="member-bulk-empty">Failed to load members</div>';
    });
}

function loadActivitiesForTeam(teamId) {
    var activitySelect = document.getElementById("task-activity");
    if (!activitySelect) return;

    if (!teamId) {
        activitySelect.innerHTML = "";
        addOption(activitySelect, "", "Select team first", false);
        return;
    }

    apiRequest("/teams/" + teamId + "/activities", "GET")
        .then(function (activities) {
            activitySelect.innerHTML = "";
            if (!activities || activities.length === 0) {
                addOption(activitySelect, "", "No activities or projects yet", false);
                return;
            }
            addOption(activitySelect, "", "Select activity or project", false);
            activities.forEach(function (a) {
                var label = formatActivityProjectName(a.name, a.type);
                addOption(activitySelect, a.id, label, false);
            });
        })
        .catch(function () {
            activitySelect.innerHTML = "";
            addOption(activitySelect, "", "Failed to load activities", false);
        });
}

function createDivision() {
    var name = document.getElementById("division-name").value.trim();
    var rawHead = document.getElementById("division-head").value;
    var headId = rawHead ? parseInt(rawHead, 10) : null;
    if (!name) { showToast("Enter division name", true); return; }
    var payload = { name: name };
    if (headId) payload.head_user_id = headId;
    apiRequest("/divisions", "POST", payload)
        .then(function () {
            document.getElementById("division-name").value = "";
            var headEl = document.getElementById("division-head");
            if (headEl) headEl.value = "";
            showToast("Division created");
            loadHierarchyFormDropdowns();
            renderSidebarNavTree(); // Refresh sidebar explicitly
            loadAllUsers();
        }).catch(function (err) { showToast(err.message, true); });
}

function createGroup() {
    var divisionId = parseInt(document.getElementById("group-division").value, 10);
    var name = document.getElementById("group-name").value.trim();
    var headValue = document.getElementById("group-head").value;
    var headId = headValue ? parseInt(headValue, 10) : null;
    if (!divisionId) { showToast("Select division", true); return; }
    if (!name) { showToast("Enter group name", true); return; }
    apiRequest("/groups", "POST", { division_id: divisionId, name: name, head_user_id: headId || null })
        .then(function () {
            document.getElementById("group-name").value = "";
            var headEl = document.getElementById("group-head");
            if (headEl) headEl.value = "";
            showToast("Group created");
            loadHierarchyFormDropdowns();
            loadAllUsers();
            renderSidebarNavTree();
        }).catch(function (err) { showToast(err.message, true); });
}

function createActivity() {
    var groupId = parseInt(document.getElementById("activity-group").value, 10);
    var name = document.getElementById("activity-name").value.trim();
    var createKind = document.getElementById("activity-create-kind") ? document.getElementById("activity-create-kind").value : "activity";
    var type = createKind === "project" ? "Project" : document.getElementById("activity-type").value;
    var customType = document.getElementById("activity-custom-type") ? document.getElementById("activity-custom-type").value.trim() : "";
    if (!groupId) { showToast("Select group", true); return; }
    if (!name) { showToast("Enter " + (createKind === "project" ? "project" : "activity") + " name", true); return; }
    apiRequest("/activities/group", "POST", { group_id: groupId, name: name, type: type, custom_type: customType || null })
        .then(function () {
            document.getElementById("activity-name").value = "";
            if (document.getElementById("activity-custom-type")) document.getElementById("activity-custom-type").value = "";
            if (document.getElementById("activity-type")) document.getElementById("activity-type").value = ACTIVITY_TYPE_OPTIONS[0];
            if (document.getElementById("activity-create-kind")) document.getElementById("activity-create-kind").value = "activity";
            toggleActivityCreationMode();
            showToast(getActivityProjectLabel(type) + " created");
            loadHierarchyFormDropdowns();
            renderSidebarNavTree();
        }).catch(function (err) { showToast(err.message, true); });
}

function createTeam() {
    var activityId = parseInt(document.getElementById("team-activity").value, 10);
    var name = document.getElementById("team-name").value.trim();
    if (!activityId) { showToast("Select activity or project", true); return; }
    if (!name) { showToast("Enter team name", true); return; }
    apiRequest("/teams/activity/" + activityId, "POST", { name: name })
        .then(function () {
            document.getElementById("team-name").value = "";
            showToast("Team created");
            loadHierarchyFormDropdowns();
            loadUserTeams();
            renderSidebarNavTree();
        }).catch(function (err) { showToast(err.message, true); });
}

function loadHierarchyFormDropdowns() {
    apiRequest("/users", "GET").then(function(users) {
        users = sortUsersByDesignationSeniority(users);
        var dh = document.getElementById("division-head");
        var gh = document.getElementById("group-head");
        if(dh) { dh.innerHTML = '<option value="">Optional (set later from Manage Users)</option>'; users.forEach(function(u) { addOption(dh, u.id, formatUserOptionLabel(u, "User " + u.id), false); }); }
        if(gh) { gh.innerHTML = '<option value="">Optional (set later from Manage Users)</option>'; users.forEach(function(u) { addOption(gh, u.id, formatUserOptionLabel(u, "User " + u.id), false); }); }
    }).catch(function(){});

    apiRequest("/nav/tree", "GET").then(function(tree) {
        var groupDiv = document.getElementById("group-division");
        var actGroup = document.getElementById("activity-group");
        var teamAct = document.getElementById("team-activity");
        var usersDivisionSelect = document.getElementById("users-division-head-target");
        var usersGroupSelect = document.getElementById("users-group-head-target");

        manageUsersDivisionOptions = Array.isArray(tree) ? tree.map(function (d) {
            return { id: d.id, name: d.name };
        }) : [];
        manageUsersGroupOptions = [];
        (tree || []).forEach(function (division) {
            (division.groups || []).forEach(function (group) {
                manageUsersGroupOptions.push({
                    id: group.id,
                    name: group.name,
                    label: division.name + " | " + group.name
                });
            });
        });

        if(groupDiv) {
            groupDiv.innerHTML = '<option value="">Select division</option>';
            tree.forEach(function(d) { addOption(groupDiv, d.id, d.name, false); });
        }
        if(usersDivisionSelect) {
            var prev = usersDivisionSelect.value;
            usersDivisionSelect.innerHTML = '<option value="">Select division</option>';
            manageUsersDivisionOptions.forEach(function (d) { addOption(usersDivisionSelect, d.id, d.name, String(prev) === String(d.id)); });
            if (prev) usersDivisionSelect.value = prev;
        }
        if(usersGroupSelect) {
            var prevGroup = usersGroupSelect.value;
            usersGroupSelect.innerHTML = '<option value="">Select group</option>';
            manageUsersGroupOptions.forEach(function (g) { addOption(usersGroupSelect, g.id, g.label || g.name, String(prevGroup) === String(g.id)); });
            if (prevGroup) usersGroupSelect.value = prevGroup;
        }
        if(actGroup) {
            actGroup.innerHTML = '<option value="">Select group</option>';
            tree.forEach(function(d) {
                (d.groups || []).forEach(function(g) { addOption(actGroup, g.id, d.name + " > " + g.name, false); });
            });
        }
        if(teamAct) {
            teamAct.innerHTML = '<option value="">Select activity or project</option>';
            tree.forEach(function(d) {
                (d.groups || []).forEach(function(g) {
                    (g.activities || []).forEach(function(a) { addOption(teamAct, a.id, g.name + " > " + formatActivityProjectName(a.name, a.type), false); });
                });
            });
        }
        refreshHierarchyEditOptionsFromTree(tree || []);
    }).catch(function(){});
}

function refreshHierarchyEditOptionsFromTree(tree) {
    var divisions = [];
    var groups = [];
    var activities = [];
    var teams = [];
    (tree || []).forEach(function (d) {
        divisions.push({ id: d.id, name: d.name });
        (d.groups || []).forEach(function (g) {
            groups.push({ id: g.id, name: g.name, division_name: d.name });
            (g.activities || []).forEach(function (a) {
                activities.push({ id: a.id, name: a.name, type: a.type || "", group_name: g.name, division_name: d.name });
                (a.teams || []).forEach(function (t) {
                    teams.push({ id: t.id, name: t.name, activity_name: a.name, activity_type: a.type || "", group_name: g.name, division_name: d.name });
                });
            });
        });
    });
    hierarchyEditOptions = {
        divisions: divisions,
        groups: groups,
        activities: activities,
        teams: teams
    };
    populateHierarchyEditDropdowns();
}

function openHierarchyEditModal() {
    var modal = document.getElementById("hierarchy-edit-modal");
    if (!modal) return;
    populateHierarchyEditDropdowns();
    modal.hidden = false;
}

function closeHierarchyEditModal() {
    var modal = document.getElementById("hierarchy-edit-modal");
    if (modal) modal.hidden = true;
}

function sendRenameRequest(paths, payload) {
    var queue = Array.isArray(paths) ? paths.slice() : [];
    if (!queue.length) return Promise.reject(new Error("No endpoint configured"));
    function runNext(lastErr) {
        if (!queue.length) return Promise.reject(lastErr || new Error("Rename failed"));
        var path = queue.shift();
        return apiRequest(path, "PUT", payload).catch(function (err) {
            var msg = ((err && err.message) ? String(err.message) : "").toLowerCase();
            var isNotFound = msg.indexOf("404") !== -1 || msg.indexOf("not found") !== -1;
            if (isNotFound && queue.length) return runNext(err);
            return Promise.reject(err);
        });
    }
    return runNext(null);
}

function populateHierarchyEditDropdowns() {
    var divisionSel = document.getElementById("edit-division-select");
    var groupSel = document.getElementById("edit-group-select");
    var activitySel = document.getElementById("edit-activity-select");
    var teamSel = document.getElementById("edit-team-select");

    if (divisionSel) {
        var prevDivision = divisionSel.value;
        divisionSel.innerHTML = "";
        addOption(divisionSel, "", "Select division", false);
        (hierarchyEditOptions.divisions || []).forEach(function (d) {
            addOption(divisionSel, d.id, d.name, String(prevDivision) === String(d.id));
        });
        if (prevDivision) divisionSel.value = prevDivision;
    }
    if (groupSel) {
        var prevGroup = groupSel.value;
        groupSel.innerHTML = "";
        addOption(groupSel, "", "Select group", false);
        (hierarchyEditOptions.groups || []).forEach(function (g) {
            addOption(groupSel, g.id, g.division_name + " > " + g.name, String(prevGroup) === String(g.id));
        });
        if (prevGroup) groupSel.value = prevGroup;
    }
    if (activitySel) {
        var prevActivity = activitySel.value;
        activitySel.innerHTML = "";
        addOption(activitySel, "", "Select activity or project", false);
        (hierarchyEditOptions.activities || []).forEach(function (a) {
            addOption(activitySel, a.id, a.division_name + " > " + a.group_name + " > " + formatActivityProjectName(a.name, a.type), String(prevActivity) === String(a.id));
        });
        if (prevActivity) activitySel.value = prevActivity;
    }
    if (teamSel) {
        var prevTeam = teamSel.value;
        teamSel.innerHTML = "";
        addOption(teamSel, "", "Select team", false);
        (hierarchyEditOptions.teams || []).forEach(function (t) {
            addOption(teamSel, t.id, t.division_name + " > " + t.group_name + " > " + formatActivityProjectName(t.activity_name, t.activity_type) + " > " + t.name, String(prevTeam) === String(t.id));
        });
        if (prevTeam) teamSel.value = prevTeam;
    }
}

function renameDivision() {
    var sel = document.getElementById("edit-division-select");
    var nameEl = document.getElementById("edit-division-name");
    var id = sel && sel.value ? parseInt(sel.value, 10) : null;
    var name = nameEl ? nameEl.value.trim() : "";
    if (!id) { showToast("Select division", true); return; }
    if (!name) { showToast("Enter new division name", true); return; }
    sendRenameRequest(
        ["/divisions/" + id, "/divisions/" + id + "/rename"],
        { name: name }
    )
        .then(function () {
            if (nameEl) nameEl.value = "";
            showToast("Division updated");
            loadHierarchyFormDropdowns();
            renderSidebarNavTree(true);
            loadTasks();
        })
        .catch(function (err) { showToast(err.message || "Failed to update division", true); });
}

function renameGroup() {
    var sel = document.getElementById("edit-group-select");
    var nameEl = document.getElementById("edit-group-name");
    var id = sel && sel.value ? parseInt(sel.value, 10) : null;
    var name = nameEl ? nameEl.value.trim() : "";
    if (!id) { showToast("Select group", true); return; }
    if (!name) { showToast("Enter new group name", true); return; }
    sendRenameRequest(
        ["/groups/" + id, "/groups/" + id + "/rename"],
        { name: name }
    )
        .then(function () {
            if (nameEl) nameEl.value = "";
            showToast("Group updated");
            loadHierarchyFormDropdowns();
            renderSidebarNavTree(true);
            loadTasks();
        })
        .catch(function (err) { showToast(err.message || "Failed to update group", true); });
}

function renameActivity() {
    var sel = document.getElementById("edit-activity-select");
    var nameEl = document.getElementById("edit-activity-name");
    var id = sel && sel.value ? parseInt(sel.value, 10) : null;
    var name = nameEl ? nameEl.value.trim() : "";
    if (!id) { showToast("Select activity or project", true); return; }
    if (!name) { showToast("Enter new activity name", true); return; }
    sendRenameRequest(
        ["/activities/" + id, "/activities/" + id + "/rename"],
        { name: name }
    )
        .then(function () {
            if (nameEl) nameEl.value = "";
            showToast("Activity updated");
            loadHierarchyFormDropdowns();
            renderSidebarNavTree(true);
            loadTasks();
        })
        .catch(function (err) { showToast(err.message || "Failed to update activity", true); });
}

function renameTeam() {
    var sel = document.getElementById("edit-team-select");
    var nameEl = document.getElementById("edit-team-name");
    var id = sel && sel.value ? parseInt(sel.value, 10) : null;
    var name = nameEl ? nameEl.value.trim() : "";
    if (!id) { showToast("Select team", true); return; }
    if (!name) { showToast("Enter new team name", true); return; }
    sendRenameRequest(
        ["/teams/" + id + "/rename", "/teams/" + id],
        { name: name }
    )
        .then(function () {
            if (nameEl) nameEl.value = "";
            showToast("Team updated");
            loadHierarchyFormDropdowns();
            renderSidebarNavTree(true);
            loadUserTeams();
            loadTasks();
        })
        .catch(function (err) { showToast(err.message || "Failed to update team", true); });
}

function addMemberToTeam() {
    var teamEl = document.getElementById("add-member-team");
    var userEl = document.getElementById("add-member-user");
    var roleEl = document.getElementById("add-member-role");
    var teamId = teamEl && teamEl.value ? parseInt(teamEl.value, 10) : null;
    var userId = userEl && userEl.value ? parseInt(userEl.value, 10) : null;

    if (!teamId) { showToast("Select a team", true); return; }
    if (!userId) { showToast("Select a user", true); return; }

    var role = roleEl ? roleEl.value : "Member";
    var url = "/teams/" + teamId + "/add-member?user_id=" + userId + "&role=" + encodeURIComponent(role);

    apiRequest(url, "POST")
        .then(function () {
            if (userEl) userEl.value = "";
            showToast("Member added to team");
        })
        .catch(function (err) { showToast(err.message || "Failed to add member", true); });
}

function getDeleteEntityOptions() {
    var role = getEffectiveRole();
    if (role === "admin") {
        return [
            { value: "division", label: "Division" },
            { value: "group", label: "Group" },
            { value: "activity", label: "Activity" },
            { value: "team", label: "Team" }
        ];
    }
    if (role === "division head") {
        return [
            { value: "group", label: "Group" },
            { value: "activity", label: "Activity" },
            { value: "team", label: "Team" }
        ];
    }
    if (role === "group head") {
        return [
            { value: "activity", label: "Activity" },
            { value: "team", label: "Team" }
        ];
    }
    return [];
}

function getDeleteScopedTree() {
    var tree = Array.isArray(_sidebarNavTreeCache) ? _sidebarNavTreeCache : [];
    var role = getEffectiveRole();
    var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
    if (role === "admin") return tree.slice();
    if (role === "division head") {
        return tree.filter(function (division) {
            return division && division.head_user_id === currentUserId;
        });
    }
    if (role === "group head") {
        return tree.map(function (division) {
            var groups = (division.groups || []).filter(function (group) {
                return group && group.head_user_id === currentUserId;
            });
            if (!groups.length) return null;
            return {
                id: division.id,
                name: division.name,
                head_user_id: division.head_user_id || null,
                groups: groups
            };
        }).filter(Boolean);
    }
    return [];
}

function initializeDeleteHierarchyBindings() {
    var typeSelect = document.getElementById("delete-entity-type");
    var divisionSelect = document.getElementById("delete-division-select");
    var groupSelect = document.getElementById("delete-group-select");
    var activitySelect = document.getElementById("delete-activity-select");

    if (typeSelect && !typeSelect._bound) {
        typeSelect._bound = true;
        typeSelect.addEventListener("change", function () {
            refreshDeleteHierarchySelectors();
        });
    }
    if (divisionSelect && !divisionSelect._bound) {
        divisionSelect._bound = true;
        divisionSelect.addEventListener("change", function () {
            populateDeleteGroupOptions(divisionSelect.value, "");
            populateDeleteActivityOptions("", "");
            populateDeleteTeamOptions("", "");
            updateDeleteEntitySummary();
        });
    }
    if (groupSelect && !groupSelect._bound) {
        groupSelect._bound = true;
        groupSelect.addEventListener("change", function () {
            populateDeleteActivityOptions(groupSelect.value, "");
            populateDeleteTeamOptions("", "");
            updateDeleteEntitySummary();
        });
    }
    if (activitySelect && !activitySelect._bound) {
        activitySelect._bound = true;
        activitySelect.addEventListener("change", function () {
            populateDeleteTeamOptions(activitySelect.value, "");
            updateDeleteEntitySummary();
        });
    }
    var teamSelect = document.getElementById("delete-team-select");
    if (teamSelect && !teamSelect._bound) {
        teamSelect._bound = true;
        teamSelect.addEventListener("change", updateDeleteEntitySummary);
    }
}

function populateDeleteEntityTypeOptions(selectedType) {
    var typeSelect = document.getElementById("delete-entity-type");
    if (!typeSelect) return;
    var options = getDeleteEntityOptions();
    typeSelect.innerHTML = "";
    addOption(typeSelect, "", options.length ? "Select level" : "No delete access", false);
    options.forEach(function (option) {
        addOption(typeSelect, option.value, option.label, option.value === selectedType);
    });
    typeSelect.disabled = options.length === 0;
    typeSelect.value = selectedType || "";
}

function populateDeleteDivisionOptions(selectedDivisionId) {
    var divisionSelect = document.getElementById("delete-division-select");
    if (!divisionSelect) return;
    var divisions = getDeleteScopedTree().map(function (division) {
        return { id: division.id, name: division.name };
    });
    divisionSelect.innerHTML = "";
    addOption(divisionSelect, "", divisions.length ? "Select division" : "No divisions available", false);
    divisions.forEach(function (division) {
        addOption(divisionSelect, division.id, division.name, String(selectedDivisionId) === String(division.id));
    });
    divisionSelect.disabled = divisions.length === 0;
    divisionSelect.value = selectedDivisionId ? String(selectedDivisionId) : "";
}

function populateDeleteGroupOptions(divisionId, selectedGroupId) {
    var groupSelect = document.getElementById("delete-group-select");
    if (!groupSelect) return;
    var division = getDeleteScopedTree().find(function (item) { return String(item.id) === String(divisionId); });
    var groups = division ? (division.groups || []).map(function (group) { return { id: group.id, name: group.name }; }) : [];
    groupSelect.innerHTML = "";
    addOption(groupSelect, "", divisionId ? (groups.length ? "Select group" : "No groups available") : "Select division first", false);
    groups.forEach(function (group) {
        addOption(groupSelect, group.id, group.name, String(selectedGroupId) === String(group.id));
    });
    groupSelect.disabled = !divisionId || groups.length === 0;
    groupSelect.value = selectedGroupId ? String(selectedGroupId) : "";
}

function populateDeleteActivityOptions(groupId, selectedActivityId) {
    var activitySelect = document.getElementById("delete-activity-select");
    if (!activitySelect) return;
    var groups = [];
    getDeleteScopedTree().forEach(function (division) {
        groups = groups.concat(division.groups || []);
    });
    var group = groups.find(function (item) { return String(item.id) === String(groupId); });
    var activities = group ? (group.activities || []).map(function (activity) { return { id: activity.id, name: activity.name, type: activity.type || "" }; }) : [];
    activitySelect.innerHTML = "";
    addOption(activitySelect, "", groupId ? (activities.length ? "Select activity or project" : "No activities/projects available") : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(activitySelect, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId) === String(activity.id));
    });
    activitySelect.disabled = !groupId || activities.length === 0;
    activitySelect.value = selectedActivityId ? String(selectedActivityId) : "";
}

function populateDeleteTeamOptions(activityId, selectedTeamId) {
    var teamSelect = document.getElementById("delete-team-select");
    if (!teamSelect) return;
    var activities = [];
    getDeleteScopedTree().forEach(function (division) {
        (division.groups || []).forEach(function (group) {
            activities = activities.concat(group.activities || []);
        });
    });
    var activity = activities.find(function (item) { return String(item.id) === String(activityId); });
    var teams = activity ? (activity.teams || []).map(function (team) { return { id: team.id, name: team.name }; }) : [];
    teamSelect.innerHTML = "";
    addOption(teamSelect, "", activityId ? (teams.length ? "Select team" : "No teams available") : "Select activity or project first", false);
    teams.forEach(function (team) {
        addOption(teamSelect, team.id, team.name, String(selectedTeamId) === String(team.id));
    });
    teamSelect.disabled = !activityId || teams.length === 0;
    teamSelect.value = selectedTeamId ? String(selectedTeamId) : "";
}

function updateDeleteEntitySummary() {
    var type = document.getElementById("delete-entity-type") ? document.getElementById("delete-entity-type").value : "";
    var helpEl = document.getElementById("delete-entity-help-text");
    var summaryEl = document.getElementById("delete-entity-target-summary");
    var divisionSelect = document.getElementById("delete-division-select");
    var groupSelect = document.getElementById("delete-group-select");
    var activitySelect = document.getElementById("delete-activity-select");
    var teamSelect = document.getElementById("delete-team-select");
    var divisionName = divisionSelect && divisionSelect.value && divisionSelect.selectedIndex >= 0 ? divisionSelect.options[divisionSelect.selectedIndex].textContent : "";
    var groupName = groupSelect && groupSelect.value && groupSelect.selectedIndex >= 0 ? groupSelect.options[groupSelect.selectedIndex].textContent : "";
    var activityName = activitySelect && activitySelect.value && activitySelect.selectedIndex >= 0 ? activitySelect.options[activitySelect.selectedIndex].textContent : "";
    var teamName = teamSelect && teamSelect.value && teamSelect.selectedIndex >= 0 ? teamSelect.options[teamSelect.selectedIndex].textContent : "";
    var helpText = "Select the hierarchy level first, then choose the exact item to delete.";
    if (type === "division") helpText = "Admin can delete divisions. A division must be empty before deletion.";
    else if (type === "group") helpText = "Admin and the relevant Division Head can delete groups. A group must be empty before deletion.";
    else if (type === "activity") helpText = "Admin, the relevant Division Head, and the relevant Group Head can delete activities or projects. They must be empty before deletion.";
    else if (type === "team") helpText = "Admin, the relevant Division Head, and the relevant Group Head can delete teams. A team must be empty before deletion.";
    if (helpEl) helpEl.textContent = helpText;
    if (!summaryEl) return;
    if (!type) {
        summaryEl.textContent = "The delete action will become available after you select the required hierarchy path.";
        return;
    }
    if (type === "division") {
        summaryEl.textContent = divisionName ? ("Selected division: " + divisionName) : "Select the division you want to delete.";
        return;
    }
    if (type === "group") {
        summaryEl.textContent = groupName ? ("Selected group: " + divisionName + " / " + groupName) : "Select division and group.";
        return;
    }
    if (type === "activity") {
        summaryEl.textContent = activityName ? ("Selected activity/project: " + divisionName + " / " + groupName + " / " + activityName) : "Select division, group, and activity/project.";
        return;
    }
    if (type === "team") {
        summaryEl.textContent = teamName ? ("Selected team: " + divisionName + " / " + groupName + " / " + activityName + " / " + teamName) : "Select division, group, activity/project, and team.";
    }
}

function refreshDeleteHierarchySelectors() {
    initializeDeleteHierarchyBindings();
    var typeSelect = document.getElementById("delete-entity-type");
    var selectedType = typeSelect ? typeSelect.value : "";
    var divisionId = document.getElementById("delete-division-select") ? document.getElementById("delete-division-select").value : "";
    var groupId = document.getElementById("delete-group-select") ? document.getElementById("delete-group-select").value : "";
    var activityId = document.getElementById("delete-activity-select") ? document.getElementById("delete-activity-select").value : "";
    var teamId = document.getElementById("delete-team-select") ? document.getElementById("delete-team-select").value : "";
    populateDeleteEntityTypeOptions(selectedType);
    populateDeleteDivisionOptions(divisionId);
    populateDeleteGroupOptions(divisionId, groupId);
    populateDeleteActivityOptions(groupId, activityId);
    populateDeleteTeamOptions(activityId, teamId);

    var divisionWrap = document.getElementById("delete-division-select") ? document.getElementById("delete-division-select").closest(".form-group") : null;
    var groupWrap = document.getElementById("delete-group-select") ? document.getElementById("delete-group-select").closest(".form-group") : null;
    var activityWrap = document.getElementById("delete-activity-select") ? document.getElementById("delete-activity-select").closest(".form-group") : null;
    var teamWrap = document.getElementById("delete-team-select") ? document.getElementById("delete-team-select").closest(".form-group") : null;
    if (divisionWrap) divisionWrap.style.display = selectedType ? "" : "none";
    if (groupWrap) groupWrap.style.display = (selectedType === "group" || selectedType === "activity" || selectedType === "team") ? "" : "none";
    if (activityWrap) activityWrap.style.display = (selectedType === "activity" || selectedType === "team") ? "" : "none";
    if (teamWrap) teamWrap.style.display = selectedType === "team" ? "" : "none";
    updateDeleteEntitySummary();
}

function confirmDeleteEntity() {
    var typeSelect = document.getElementById("delete-entity-type");
    var type = typeSelect ? typeSelect.value : "";
    if (!type) {
        showToast("Select what you want to delete first", true);
        return;
    }

    var configMap = {
        division: { selectId: "delete-division-select", path: "/divisions/", label: "division" },
        group: { selectId: "delete-group-select", path: "/groups/", label: "group" },
        activity: { selectId: "delete-activity-select", path: "/activities/", label: "activity or project" },
        team: { selectId: "delete-team-select", path: "/teams/", label: "team" }
    };
    var config = configMap[type];
    var selectEl = document.getElementById(config.selectId);
    if (!selectEl || !selectEl.value) {
        showToast("Select the " + config.label + " to delete", true);
        return;
    }

    var entityId = parseInt(selectEl.value, 10);
    var entityName = selectEl.options[selectEl.selectedIndex] ? selectEl.options[selectEl.selectedIndex].textContent : (config.label + " " + entityId);
    var message = "Delete " + config.label + " \"" + entityName + "\" permanently?\n\nThis action cannot be undone.";
    if (!confirm(message)) return;

    apiRequest(config.path + entityId, "DELETE")
        .then(function () {
            showToast(config.label.charAt(0).toUpperCase() + config.label.slice(1) + " deleted");
            refreshDeleteHierarchySelectors();
            renderSidebarNavTree(true);
            loadHierarchyFormDropdowns();
            loadUserTeams();
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || ("Failed to delete " + config.label), true);
        });
}

function confirmRemoveMember() {
    var selectedMembers = getSelectedRemoveMembers();
    if (!selectedMembers.length) {
        showToast("Select one or more members", true);
        return;
    }
    var sourceTeamIds = getRemoveScopeTeamIds();
    if (!sourceTeamIds.length) {
        showToast("Select a source division, group, activity/project, or team", true);
        return;
    }
    var actionEl = document.getElementById("remove-member-action");
    var action = actionEl ? actionEl.value : "remove";
    var destinationTeamEl = document.getElementById("remove-member-target-team");
    var destinationTeamId = destinationTeamEl && destinationTeamEl.value ? parseInt(destinationTeamEl.value, 10) : null;
    if (action === "shift") {
        if (!destinationTeamId) {
            showToast("Select a destination team", true);
            return;
        }
        if (sourceTeamIds.indexOf(destinationTeamId) !== -1) {
            showToast("Select a destination team outside the current source scope", true);
            return;
        }
    }
    var ok = confirm(
        action === "shift"
            ? ("Shift " + selectedMembers.length + " selected member(s) to the destination team?")
            : ("Remove " + selectedMembers.length + " selected member(s) from this team?")
    );
    if (!ok) return;

    var chain = Promise.resolve();
    var processed = 0;
    selectedMembers.forEach(function (member) {
        chain = chain.then(function () {
            if (action === "shift") {
                var addUrl = "/teams/" + destinationTeamId + "/add-member?user_id=" + member.id + "&role=" + encodeURIComponent(member.role || "Member");
                return apiRequest(addUrl, "POST")
                    .catch(function (err) {
                        var msg = err && err.message ? String(err.message).toLowerCase() : "";
                        if (msg.indexOf("already") !== -1 && msg.indexOf("member") !== -1) return null;
                        return Promise.reject(err);
                    })
                    .then(function () {
                        var removalChain = Promise.resolve();
                        (member.scopeTeamIds || []).forEach(function (sourceTeamId) {
                            removalChain = removalChain.then(function () {
                                return apiRequest("/teams/" + sourceTeamId + "/members/" + member.id, "DELETE");
                            });
                        });
                        return removalChain;
                    });
            }
            var removeChain = Promise.resolve();
            (member.scopeTeamIds || []).forEach(function (sourceTeamId) {
                removeChain = removeChain.then(function () {
                    return apiRequest("/teams/" + sourceTeamId + "/members/" + member.id, "DELETE");
                });
            });
            return removeChain;
        }).then(function () {
            processed += 1;
        });
    });

    chain.then(function () {
            showToast(action === "shift" ? (processed + " member(s) shifted successfully") : (processed + " member(s) removed successfully"));
            loadMembersForRemovalScope();
            loadUserTeams();
            loadTasks();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to apply member action", true);
        });
}

// Existing createActivity merged into the single chunk above



function loadTasks() {
    var params = [];
    var teamId = currentTeamIdForView;
    var status = getFilterStatus();
    var assignedTo = getFilterAssigned();
    if (teamId) params.push("team_id=" + teamId);
    if (status) params.push("status=" + encodeURIComponent(status));
    if (assignedTo) params.push("assigned_to=" + assignedTo);
    var url = "/tasks?" + params.join("&");

    apiRequest(url, "GET")
        .then(function (tasks) {
            var tbody = document.getElementById("task-table");
            var emptyEl = document.getElementById("tasks-empty");
            var statTasksEl = document.getElementById("stat-tasks");
            var statDueTodayEl = document.getElementById("stat-due-today");
            var statDueWeekEl = document.getElementById("stat-due-week");
            var statDueMonthEl = document.getElementById("stat-due-month");
            var taskList = Array.isArray(tasks) ? tasks : [];
            var todayStr = getTodayDateStr();
            var endOfWeekStr = getDateStrOffset(6);
            var dueTodayCount = taskList.filter(function (t) {
                var d = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
                return d === todayStr;
            }).length;
            var dueWeekCount = taskList.filter(function (t) {
                var d = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
                return d >= todayStr && d <= endOfWeekStr;
            }).length;
            var dueMonthCount = taskList.filter(function (t) {
                var d = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
                return isDateInCurrentMonth(d);
            }).length;
            if (statDueTodayEl) statDueTodayEl.textContent = dueTodayCount;
            if (statDueWeekEl) statDueWeekEl.textContent = dueWeekCount;
            if (statDueMonthEl) statDueMonthEl.textContent = dueMonthCount;
            var taskCount = taskList.length;
            if (statTasksEl) statTasksEl.textContent = taskCount;

            if (!tbody) return;

            if (!tasks || tasks.length === 0) {
                tbody.innerHTML = "";
                lastLoadedTasks = [];
                populateMilestoneTaskParentLevel1Options("");
                populateMilestoneTaskParentLevel2Options("", "");
                if (emptyEl) {
                    emptyEl.hidden = false;
                    var desc = emptyEl.querySelector && emptyEl.querySelector(".empty-state-desc");
                    if (desc) desc.textContent = "Create a task above to get started.";
                }
                if (tasksViewMode === "calendar") renderCalendarView([]);
                return;
            }
            if (emptyEl) emptyEl.hidden = true;

            var filteredTasks = tasks;
            if (currentActivityIdForView) {
                filteredTasks = (tasks || []).filter(function (t) { return t && t.activity_id === currentActivityIdForView; });
            }

            var taskCountFiltered = Array.isArray(filteredTasks) ? filteredTasks.length : 0;
            if (statTasksEl) statTasksEl.textContent = taskCountFiltered;

            if (!filteredTasks || filteredTasks.length === 0) {
                tbody.innerHTML = "";
                lastLoadedTasks = [];
                if (emptyEl) {
                    emptyEl.hidden = false;
                    var desc2 = emptyEl.querySelector && emptyEl.querySelector(".empty-state-desc");
                    if (desc2) desc2.textContent = currentActivityIdForView ? "No tasks for this activity yet." : "No tasks yet.";
                }
                if (tasksViewMode === "calendar") renderCalendarView([]);
                return;
            }
            if (emptyEl) emptyEl.hidden = true;
            lastLoadedTasks = filteredTasks;
            populateMilestoneTaskParentLevel1Options(document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "");
            populateMilestoneTaskParentLevel2Options(document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "", document.getElementById("milestone-task-parent-level-2") ? document.getElementById("milestone-task-parent-level-2").value : "");
            if (tasksViewMode === "calendar") {
                renderCalendarView(filteredTasks);
                tbody.innerHTML = "";
                return;
            }

            function buildRowHtml(t, isSubtask) {
                var dueRaw = t.due_date || null;
                var dueDisplayValue = getTaskScheduleDeadlineValue(t);
                var due = dueDisplayValue || "";
                var daysLeft = computeWorkingDaysLeft(dueDisplayValue);
                var daysLeftContent;
                if (typeof daysLeft === "number") {
                    var daysLeftClass = "days-left";
                    if (daysLeft < 0) {
                        daysLeftClass += " days-left--overdue";
                    } else if (daysLeft <= 3) {
                        daysLeftClass += " days-left--warning";
                    }
                    daysLeftContent = "<span class=\"" + daysLeftClass + "\">" + escapeHtml(String(daysLeft)) + "</span>";
                } else {
                    daysLeftContent = "—";
                }

                var assignees = t.assignees;
                daysLeftContent = buildDaysLeftContent(daysLeft);
                var hasMultiAssignees = assignees && assignees.length > 0;
                var assignedDisplay;
                var assignedCell;
                if (hasMultiAssignees) {
                    var n = assignees.length;
                    if (n === 1) {
                        // Exactly one assignee via multi-assign: show a simple label (no dropdown) to avoid duplicate-looking entries.
                        var aSingle = assignees[0];
                        var nameSingle = formatUserOptionLabel(aSingle, "User " + aSingle.user_id);
                        var pctSingle = aSingle.percent_share != null ? " " + aSingle.percent_share + "%" : "";
                        var leadSingle = aSingle.is_lead ? " (Lead)" : "";
                        assignedCell = "<span>" + escapeHtml(nameSingle + pctSingle + leadSingle) + "</span>";
                    } else {
                        var summaryText = getTaskAssignmentSummary(t, assignees);
                        var firstOpt = "<option value=\"\" selected disabled>" + escapeHtml(summaryText) + "</option>";
                        var restOpts = assignees.map(function (a) {
                            var name = formatUserOptionLabel(a, "User " + a.user_id);
                            var pct = a.percent_share != null ? " " + a.percent_share + "%" : "";
                            var lead = a.is_lead ? " Lead" : "";
                            return "<option value=\"\" disabled>" + escapeHtml(name + pct + lead) + "</option>";
                        }).join("");
                        assignedCell = "<select class=\"status-select assigned-select\" title=\"Assignees\">" + firstOpt + restOpts + "</select>";
                    }
                } else {
                    assignedDisplay = formatUserInline(t.assigned_username, t.assigned_designation, "—");
                    var isUnassigned = !t.assigned_to && !t.assigned_username;
                    var canAssign = canAssignTask() && isUnassigned && t.team_id;
                    if (canAssign) {
                        assignedCell = "<select class=\"assign-select\" data-task-id=\"" + t.id + "\" data-team-id=\"" + (t.team_id || "") + "\" onfocus=\"loadAssignDropdown(this)\" onchange=\"doAssignTask(this)\"><option value=\"\">Assign to...</option></select>";
                    } else {
                        assignedCell = "<span>" + escapeHtml(assignedDisplay) + "</span>";
                    }
                }
                // Status dropdown: show "Pending" when Pending Completion (disabled while awaiting approval)
                var displayStatus = (t.status === "Pending Completion") ? "Pending" : t.status;
                var statusDisabled = (t.status === "Pending Completion") ? " disabled" : "";
                var statusOpts = ["To Do", "In Progress", "Pending", "Completed"].map(function (s) {
                    var val = (s === "Pending") ? "Pending Completion" : s;
                    var sel = (t.status === val) ? " selected" : "";
                    return "<option value=\"" + val + "\"" + sel + ">" + s + "</option>";
                }).join("");
                if (isUserAdmin() || t.can_approve_completion === true) {
                    statusOpts += "<option value=\"\" disabled>—</option><option value=\"__change_due_date__\">Change due date</option>";
                    if (canAssignTask() && (t.assigned_to || t.assigned_username)) {
                        statusOpts += "<option value=\"__unassign_task__\">Unassign task</option>";
                    }
                    statusOpts += "<option value=\"__delete_task__\">Delete task</option><option value=\"__delete_activity__\">Delete activity</option>";
                }
                var statusClass = "status";
                var rawStatus = (t.status == null ? "" : String(t.status));
                var normalizedStatus = rawStatus.trim().toLowerCase();
                var isPendingCompletion = normalizedStatus === "pending completion" || rawStatus === "Pending Completion";
                var isCompletedStatus =
                    normalizedStatus === "completed" ||
                    normalizedStatus === "done" ||
                    (normalizedStatus.indexOf("complete") !== -1 && !isPendingCompletion);

                if (normalizedStatus === "to do") {
                    statusClass += " status-todo";
                } else if (normalizedStatus === "in progress") {
                    statusClass += " status-progress";
                } else if (isPendingCompletion) {
                    statusClass += " status-pending-completion";
                } else if (isCompletedStatus) {
                    statusClass += " status-done";
                }
                var titleEsc = escapeHtml(t.title);
                if (t.parent_task_id) {
                    titleEsc = "<span style=\"margin-left:20px; color:#6b778c;\">↳</span> " + titleEsc;
                }
                var taskNameClass = "task-name-link";

                var isCompleted = isCompletedStatus;
                if (isCompleted) {
                    // Completed tasks: always green name + green tick, regardless of daysLeft.
                    taskNameClass += " task-name--completed";
                    daysLeftContent = "<span class=\"days-left days-left--completed\" title=\"Completed\">&#10003;</span>";
                } else if (typeof daysLeft === "number") {
                    // Only apply warning/overdue colors for non-completed tasks.
                    if (daysLeft < 0) {
                        taskNameClass += " task-name--overdue";
                    } else if (daysLeft <= 3) {
                        taskNameClass += " task-name--warning";
                    }
                }

                // Extension request button state
                var extStatus = t.extension_status || null;
                var extBtnClass = "btn btn-sm btn-ext btn-ext--primary";
                var extBtnLabel = "Request";
                var extBtnAttrs = "type=\"button\"";
                var extDataAttrs = "";

                if (!extStatus || extStatus === "rejected" || extStatus === "approved") {
                    // Fresh or finished cycle – allow new request
                    extBtnLabel = "Request";
                    extBtnClass = "btn btn-sm btn-ext btn-ext--primary";
                    extBtnAttrs += " onclick=\"openExtensionRequest(" + t.id + ", '" + (dueRaw || "") + "')\"";
                } else if (extStatus === "pending") {
                    extBtnLabel = "Pending";
                    if (t.extension_reason) {
                        extDataAttrs += " data-ext-reason=\"" + escapeHtml(String(t.extension_reason)) + "\"";
                    }
                    if (t.extension_requested_due_date) {
                        extDataAttrs += " data-ext-date=\"" + escapeHtml(String(t.extension_requested_due_date)) + "\"";
                    }
                    if (isUserAdmin()) {
                        // Admin / Head can review
                        extBtnClass = "btn btn-sm btn-ext btn-ext--pending";
                        extBtnAttrs += " onclick=\"reviewExtensionRequest(" + (t.extension_request_id || 0) + ", " + t.id + ", this)\"";
                    } else {
                        // Regular user sees disabled pending state
                        extBtnClass = "btn btn-sm btn-ext btn-ext--pending";
                        extBtnAttrs += " disabled";
                    }
                }

                var extCellHtml = buildExtensionButtonHtml(t, dueRaw);

                // For Pending Completion: show per-file View/Download to submitter, TL/GH/PD, and approvers; Review only to approvers
                var compStatus = t.completion_status || null;
                var compRequestId = t.completion_request_id || null;
                var compAttachments = t.completion_attachments || (compRequestId ? [{ id: compRequestId, filename: t.completion_attachment_filename || "attachment" }] : []);
                var canApproveComp = t.can_approve_completion === true;
                var canViewProof = t.can_view_completion_proof === true;
                var statusExtraBtns = "";
                if (compStatus === "pending" && (canApproveComp || canViewProof) && compRequestId) {
                    statusExtraBtns += "<div class=\"completion-proof-files\">";
                    compAttachments.forEach(function (att) {
                        var label = att.filename && att.filename.length > 22 ? att.filename.slice(0, 20) + "…" : (att.filename || "file");
                        var fn = (att.filename || "attachment").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
                        statusExtraBtns += "<div class=\"completion-proof-file-row\">";
                        statusExtraBtns += "<span class=\"completion-proof-filename\" title=\"" + escapeHtml(att.filename || "file") + "\">" + escapeHtml(label) + "</span>";
                        statusExtraBtns += "<div class=\"completion-proof-file-actions\">";
                        statusExtraBtns += "<button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--primary\" onclick=\"viewCompletionAttachment(" + att.id + ")\" title=\"View " + escapeHtml(att.filename || "file") + "\">View</button>";
                        statusExtraBtns += " <button type=\"button\" class=\"btn btn-sm btn-ghost btn-sm\" onclick=\"downloadCompletionAttachment(" + att.id + ", '" + fn + "')\" title=\"Download " + escapeHtml(att.filename || "file") + "\">Download</button>";
                        statusExtraBtns += "</div></div>";
                    });
                    if (canApproveComp) {
                        var reviewTitle = compAttachments.length > 1 ? "Approve or reject all " + compAttachments.length + " proof files." : "";
                        statusExtraBtns += "<div class=\"completion-proof-file-row completion-proof-review-row\"><button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--pending\" onclick=\"reviewCompletionRequest(" + compRequestId + ", " + t.id + ", this, " + compAttachments.length + ")\" title=\"" + (reviewTitle || "Approve or reject") + "\">Review</button></div>";
                    }
                    statusExtraBtns += "</div>";
                }

                var taskType = t.task_type || "Others";
                var typeApprovalStatus = t.type_approval_status || "not_required";
                var canApproveType = t.can_approve_type === true;
                var typeCell = "<span class=\"task-type-badge " + getTaskTypeBadgeClass(taskType) + "\">" + escapeHtml(taskType) + "</span>";
                if (typeApprovalStatus === "pending") {
                    typeCell += " <span class=\"task-type-pending\">Pending approval</span>";
                    if (canApproveType) {
                        typeCell += " <button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--primary\" onclick=\"approveTaskType(" + t.id + ", true)\">Approve</button> <button type=\"button\" class=\"btn btn-sm btn-ghost\" onclick=\"approveTaskType(" + t.id + ", false)\">Reject</button>";
                    }
                } else if (typeApprovalStatus === "rejected") {
                    typeCell += " <span class=\"task-type-rejected\">Rejected</span>";
                }
                var descHtml = buildTaskDescriptionContentHtml(t);

                var parentAttr = t.parent_task_id ? ' data-parent-task-id="' + t.parent_task_id + '"' : "";
                var subtaskStyle = "";
                var descStyle = "";
                if (isSubtask) {
                    var parentIsOpen = !!openSubtaskParents[String(t.parent_task_id)];
                    subtaskStyle = ' style="display:' + (parentIsOpen ? "table-row" : "none") + ';"';
                    descStyle = ' style="display:none;"';
                }

                return (
                    "<tr data-task-id=\"" + t.id + "\"" + parentAttr + subtaskStyle + (isSubtask ? " class=\"subtask-row\"" : "") + ">" +
                    "<td class=\"col-task\"><button type=\"button\" class=\"" + taskNameClass + "\" onclick=\"toggleTaskDescription(" + t.id + ")\" title=\"Click to show description\">" + titleEsc + "</button></td>" +
                    "<td class=\"col-assigned\">" + assignedCell + "</td>" +
                    "<td class=\"col-type\">" + typeCell + "</td>" +
                    "<td><span class=\"priority priority-" + (t.priority || "Medium").toLowerCase() + "\">" + escapeHtml(t.priority || "Medium") + "</span></td>" +
                    "<td><span class=\"" + statusClass + "\">" + escapeHtml(displayStatus) + "</span>" + statusExtraBtns + "</td>" +
                    "<td class=\"col-due\">" + due + "</td>" +
                    "<td class=\"col-days-left\">" + daysLeftContent + "</td>" +
                    "<td class=\"col-ext\">" + extCellHtml + "</td>" +
                    "<td>" + buildActionsCellHtml(t, statusOpts, statusDisabled, dueRaw) + "</td>" +
                    "</tr>" +
                    "<tr class=\"task-description-row task-description-row-hidden\" id=\"task-desc-" + t.id + "\" data-task-id=\"" + t.id + "\"" + parentAttr + descStyle + ">" +
                    "<td colspan=\"9\"><div class=\"task-description\">" + descHtml + "</div></td>" +
                    "</tr>"
                );
            }

            function renderTaskRows(tasks) {
                return (tasks || []).map(function (task) {
                    var html = buildRowHtml(task, !!task.parent_task_id);
                    if (task.subtasks && task.subtasks.length > 0) {
                        html += renderTaskRows(task.subtasks);
                    }
                    return html;
                }).join("");
            }

            tbody.innerHTML = renderTaskRows(filteredTasks);
        })
        .catch(function (err) {
            var tbody = document.getElementById("task-table");
            if (tbody) tbody.innerHTML = "";
            var statTasksEl = document.getElementById("stat-tasks");
            if (statTasksEl) statTasksEl.textContent = "0";
            var statDueTodayEl = document.getElementById("stat-due-today");
            var statDueWeekEl = document.getElementById("stat-due-week");
            if (statDueTodayEl) statDueTodayEl.textContent = "0";
            if (statDueWeekEl) statDueWeekEl.textContent = "0";
            var emptyEl = document.getElementById("tasks-empty");
            if (emptyEl) {
                var title = emptyEl.querySelector && emptyEl.querySelector(".empty-state-title");
                var desc = emptyEl.querySelector && emptyEl.querySelector(".empty-state-desc");
                if (title) title.textContent = "Error loading tasks";
                if (desc) desc.textContent = err.message || "Try again later.";
                emptyEl.hidden = false;
            }
            showToast(err.message || "Failed to load tasks", true);
        });
}

function toggleTaskDescription(taskId) {
    var row = document.getElementById("task-desc-" + taskId);
    if (!row) return;
    row.classList.toggle("task-description-row-hidden");
    row.style.display = row.classList.contains("task-description-row-hidden") ? "none" : "table-row";
}

function setSubtaskRowsVisible(parentTaskId, visible) {
    var rows = document.querySelectorAll('[data-parent-task-id="' + parentTaskId + '"]');
    rows.forEach(function (row) {
        if (row.classList.contains("task-description-row")) {
            var shouldShowDesc = visible && !row.classList.contains("task-description-row-hidden");
            row.style.display = shouldShowDesc ? "table-row" : "none";
            if (!visible) {
                var descTaskId = row.getAttribute("data-task-id");
                if (descTaskId) setSubtaskRowsVisible(descTaskId, false);
            }
            return;
        }
        row.style.display = visible ? "table-row" : "none";
        var childTaskId = row.getAttribute("data-task-id");
        if (!visible && childTaskId) {
            setSubtaskRowsVisible(childTaskId, false);
            return;
        }
        if (visible && childTaskId && openSubtaskParents[String(childTaskId)]) {
            setSubtaskRowsVisible(childTaskId, true);
        }
    });
}

function toggleSubtasks(taskId) {
    var shouldOpen = !openSubtaskParents[String(taskId)];
    if (shouldOpen) {
        openSubtaskParents[String(taskId)] = true;
    } else {
        delete openSubtaskParents[String(taskId)];
    }
    saveOpenSubtaskParents();
    setSubtaskRowsVisible(taskId, shouldOpen);
    var toggleBtn = document.getElementById("subtasks-toggle-" + taskId);
    if (toggleBtn) {
        toggleBtn.innerHTML = (toggleBtn.getAttribute("data-count") || "0") + " Subtasks " + (shouldOpen ? "&#9654;" : "&#9660;");
        toggleBtn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    }
}

function canCurrentUserUpdateTaskStatus(task) {
    if (!task) return false;
    var role = getEffectiveRole();
    if (role === "admin" || role === "division head" || role === "group head" || role === "project director") {
        return true;
    }
    var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
    if (!currentUserId) return false;
    if (task.assigned_to === currentUserId) return true;
    if (Array.isArray(task.assignees)) {
        return task.assignees.some(function (a) { return a && a.user_id === currentUserId; });
    }
    return false;
}

function buildActionsCellHtml(t, statusOpts, statusDisabled, dueRaw) {
    var dependencyLocked = !!t.dependency_lock_active;
    var lockMessage = t.dependency_lock_message ? String(t.dependency_lock_message) : "Dependency is not resolved yet.";
    var extraDisabled = dependencyLocked ? " disabled" : "";
    var statusOwnershipDisabled = canCurrentUserUpdateTaskStatus(t) ? "" : " disabled";
    var effectiveDisabled = (statusDisabled || "") + extraDisabled + statusOwnershipDisabled;
    var selectTitle = "";
    if (dependencyLocked) {
        selectTitle = "Locked by dependency";
    } else if (statusDisabled) {
        selectTitle = "Awaiting approval";
    } else if (statusOwnershipDisabled) {
        selectTitle = "You can only update the status of your own tasks";
    }
    var baseSelect = "<select class=\"status-select\"" + effectiveDisabled +
        " data-due-date=\"" + escapeHtml(dueRaw || "") +
        "\" onchange=\"handleActionSelect(" + t.id + ", " +
        (t.activity_id != null ? t.activity_id : "null") + ", '" +
        String(t.status || "").replace(/'/g, "\\'") +
        "', this)\" title=\"" + selectTitle +
        "\">" + statusOpts + "</select>";

    // Add Create Subtask and Expand Subtasks buttons
    var subtaskBtn = "";
    if (canCreateSubtaskForTask(t)) {
        subtaskBtn = "<div style=\"margin-top:4px;\"><button type=\"button\" class=\"btn btn-sm btn-ghost\" onclick=\"openCreateSubtaskModal(" + t.id + ", " + (t.team_id || "null") + ", " + (t.activity_id || "null") + ")\"" + extraDisabled + ">+ Subtask</button>";
        if (t.subtasks && t.subtasks.length > 0) {
            subtaskBtn += " <button type=\"button\" class=\"btn btn-sm btn-secondary\" id=\"subtasks-toggle-" + t.id + "\" data-count=\"" + t.subtasks.length + "\" onclick=\"toggleSubtasks(" + t.id + ")\" style=\"margin-left:4px;\" aria-expanded=\"" + (!!openSubtaskParents[String(t.id)] ? "true" : "false") + "\"" + extraDisabled + ">" + t.subtasks.length + " Subtasks " + (!!openSubtaskParents[String(t.id)] ? "&#9654;" : "&#9660;") + "</button>";
        }
        subtaskBtn += "</div>";
    } else if (!t.parent_task_id && t.subtasks && t.subtasks.length > 0) {
        subtaskBtn = "<div style=\"margin-top:4px;\"><button type=\"button\" class=\"btn btn-sm btn-secondary\" id=\"subtasks-toggle-" + t.id + "\" data-count=\"" + t.subtasks.length + "\" onclick=\"toggleSubtasks(" + t.id + ")\" aria-expanded=\"" + (!!openSubtaskParents[String(t.id)] ? "true" : "false") + "\"" + extraDisabled + ">" + t.subtasks.length + " Subtasks " + (!!openSubtaskParents[String(t.id)] ? "&#9654;" : "&#9660;") + "</button></div>";
    }
    var actionButtons = "";
    if (canEditTaskDetails(t)) {
        actionButtons += "<button type=\"button\" class=\"btn btn-sm btn-ghost\" title=\"Edit\" aria-label=\"Edit\" style=\"margin-left:6px; padding:4px 8px;\" onclick=\"openEditTaskModal(" + t.id + ")\">&#9998;</button>";
    }
    if (canDeleteTaskDetails(t)) {
        actionButtons += "<button type=\"button\" class=\"btn btn-sm btn-danger\" title=\"Delete task\" aria-label=\"Delete task\" style=\"margin-left:6px; padding:4px 8px;\" onclick=\"deleteTaskDirect(" + t.id + ")\">&#128465;</button>";
    }

    var lockHtml = dependencyLocked
        ? "<div class=\"task-actions-lock\"><span class=\"task-actions-lock-icon\">&#128274;</span><div class=\"task-actions-lock-text\">" + escapeHtml(lockMessage) + "</div></div>"
        : "";

    var taskType = t.task_type || "Others";
    if (taskType !== "Procurement") {
        return baseSelect + actionButtons + subtaskBtn + lockHtml;
    }

    var stages = [
        "Specification Preparation",
        "Cost Estimation",
        "Demand Initiation",
        "Tendering",
        "TCEC",
        "CNC",
        "Purchase Order",
        "Delivery",
        "Acceptance / IDIV Issue"
    ];
    var currentStage = t.procurement_stage || "";
    var options = '<option value=\"\">Select stage</option>' + stages.map(function (s) {
        var sel = (s === currentStage) ? " selected" : "";
        return '<option value=\"' + escapeHtml(s) + '\"' + sel + '>' + escapeHtml(s) + '</option>';
    }).join("");

    var stageSelect = '<select class=\"status-select procurement-stage-select\" onchange=\"handleProcurementStageChange(' + t.id + ', this)\"' + extraDisabled + '>' + options + '</select>';

    return baseSelect + actionButtons + subtaskBtn + '<br><span class=\"procurement-stage-label\">Procurement stage:</span><br>' + stageSelect + lockHtml;
}

function findTaskByIdInTree(taskList, taskId) {
    if (!Array.isArray(taskList) || !taskId) return null;
    for (var i = 0; i < taskList.length; i++) {
        var task = taskList[i];
        if (task && task.id === taskId) return task;
        var nested = findTaskByIdInTree(task && task.subtasks ? task.subtasks : [], taskId);
        if (nested) return nested;
    }
    return null;
}

function canEditTaskDetails(task) {
    if (!task) return false;
    var role = getEffectiveRole();
    if (role === "admin" || role === "division head" || role === "group head") return true;
    if (!task.parent_task_id) return false;
    var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
    if (!currentUserId) return false;
    if (task.assigned_to === currentUserId) return true;
    if (Array.isArray(task.assignees)) {
        return task.assignees.some(function (a) { return a && a.user_id === currentUserId; });
    }
    return false;
}

function canDeleteTaskDetails(task) {
    if (!task) return false;
    var role = getEffectiveRole();
    return role === "admin" || role === "division head" || role === "group head";
}

function deleteTaskDirect(taskId) {
    if (!taskId) return;
    var ok = confirm("Delete this task and its related data?");
    if (!ok) return;
    apiRequest("/tasks/" + taskId, "DELETE")
        .then(function () {
            showToast("Task deleted");
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to delete task", true);
        });
}

function collectTaskDescendantIds(task) {
    var ids = {};
    function walk(items) {
        (items || []).forEach(function (item) {
            if (!item || !item.id || ids[item.id]) return;
            ids[item.id] = true;
            walk(item.subtasks || []);
        });
    }
    walk(task && task.subtasks ? task.subtasks : []);
    return ids;
}

function toggleEditTaskDependencyFields() {
    var enabled = !!(document.getElementById("edit-task-has-dependency") && document.getElementById("edit-task-has-dependency").checked);
    var startWrap = document.getElementById("edit-task-start-dependency-wrap");
    var finishWrap = document.getElementById("edit-task-finish-dependency-wrap");
    if (startWrap) startWrap.style.display = enabled ? "" : "none";
    if (finishWrap) finishWrap.style.display = enabled ? "" : "none";
    if (!enabled) {
        toggleDependencyOffsetInput("edit-task", "start", false);
        toggleDependencyOffsetInput("edit-task", "finish", false);
    } else {
        toggleDependencyOffsetInput("edit-task", "start");
        toggleDependencyOffsetInput("edit-task", "finish");
    }
    if (enabled) refreshDependencyTaskSelectors();
}

function populateEditTaskParentOptions(selectedParentId) {
    var select = document.getElementById("edit-task-parent-id");
    if (!select) return;
    var blocked = {};
    if (currentEditTaskRecord && currentEditTaskRecord.id) {
        blocked[currentEditTaskRecord.id] = true;
        var descendants = collectTaskDescendantIds(currentEditTaskRecord);
        Object.keys(descendants).forEach(function (id) { blocked[id] = true; });
    }
    var options = [];
    function walk(items, lineage) {
        (items || []).forEach(function (task) {
            if (!task || !task.id) return;
            var label = lineage ? (lineage + " / " + (task.title || ("Task " + task.id))) : (task.title || ("Task " + task.id));
            if (!blocked[task.id]) options.push({ id: task.id, label: label });
            walk(task.subtasks || [], label);
        });
    }
    walk(lastLoadedTasks || [], "");
    select.innerHTML = "";
    addOption(select, "", "Select parent", false);
    options.forEach(function (option) {
        addOption(select, option.id, option.label, String(selectedParentId || "") === String(option.id));
    });
    if (selectedParentId) select.value = String(selectedParentId);
}

function populateEditTaskDivisionOptions(selectedDivisionId) {
    var select = document.getElementById("edit-task-division");
    if (!select) return;
    select.innerHTML = "";
    addOption(select, "", "Select division", false);
    (taskCreateHierarchy.divisions || []).forEach(function (division) {
        addOption(select, division.id, division.name, String(selectedDivisionId || "") === String(division.id));
    });
    if (selectedDivisionId) select.value = String(selectedDivisionId);
}

function populateEditTaskGroupOptions(divisionId, selectedGroupId) {
    var select = document.getElementById("edit-task-group");
    if (!select) return;
    var groups = divisionId ? (taskCreateHierarchy.groupsByDivision[String(divisionId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", divisionId ? "Select group" : "Select division first", false);
    groups.forEach(function (group) {
        addOption(select, group.id, group.name, String(selectedGroupId || "") === String(group.id));
    });
    if (selectedGroupId) select.value = String(selectedGroupId);
}

function populateEditTaskActivityOptions(groupId, selectedActivityId) {
    var select = document.getElementById("edit-task-activity");
    if (!select) return;
    var activities = groupId ? (taskCreateHierarchy.activitiesByGroup[String(groupId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", groupId ? "Select activity / project" : "Select group first", false);
    activities.forEach(function (activity) {
        addOption(select, activity.id, formatActivityProjectName(activity.name, activity.type), String(selectedActivityId || "") === String(activity.id));
    });
    if (selectedActivityId) select.value = String(selectedActivityId);
}

function populateEditTaskTeamOptions(activityId, selectedTeamId) {
    var select = document.getElementById("edit-task-team");
    if (!select) return;
    var teams = activityId ? (taskCreateHierarchy.teamsByActivity[String(activityId)] || []) : [];
    select.innerHTML = "";
    addOption(select, "", activityId ? "Select team" : "Select activity / project first", false);
    teams.forEach(function (team) {
        addOption(select, team.id, team.name, String(selectedTeamId || "") === String(team.id));
    });
    if (selectedTeamId) select.value = String(selectedTeamId);
}

function initializeEditTaskHierarchyBindings() {
    var divisionSelect = document.getElementById("edit-task-division");
    var groupSelect = document.getElementById("edit-task-group");
    var activitySelect = document.getElementById("edit-task-activity");
    var teamSelect = document.getElementById("edit-task-team");
    var parentSelect = document.getElementById("edit-task-parent-id");
    var addAssigneeBtn = document.getElementById("edit-task-add-assignee");

    if (divisionSelect && !divisionSelect._editBound) {
        divisionSelect._editBound = true;
        divisionSelect.addEventListener("change", function () {
            populateEditTaskGroupOptions(divisionSelect.value, "");
            populateEditTaskActivityOptions("", "");
            populateEditTaskTeamOptions("", "");
            loadEditTaskMembers("", "", "", []);
        });
    }
    if (groupSelect && !groupSelect._editBound) {
        groupSelect._editBound = true;
        groupSelect.addEventListener("change", function () {
            populateEditTaskActivityOptions(groupSelect.value, "");
            populateEditTaskTeamOptions("", "");
            loadEditTaskMembers("", "", "", []);
        });
    }
    if (activitySelect && !activitySelect._editBound) {
        activitySelect._editBound = true;
        activitySelect.addEventListener("change", function () {
            populateEditTaskTeamOptions(activitySelect.value, "");
            loadEditTaskMembers("", "", "", []);
        });
    }
    if (teamSelect && !teamSelect._editBound) {
        teamSelect._editBound = true;
        teamSelect.addEventListener("change", function () {
            loadEditTaskMembers(teamSelect.value, "", "", []);
        });
    }
    if (parentSelect && !parentSelect._editBound) {
        parentSelect._editBound = true;
        parentSelect.addEventListener("change", function () {
            var selectedParentId = parentSelect.value ? parseInt(parentSelect.value, 10) : null;
            var selectedParent = selectedParentId ? findTaskByIdInTree(lastLoadedTasks || [], selectedParentId) : null;
            loadEditTaskMembers(selectedParent && selectedParent.team_id ? selectedParent.team_id : "", "", "", []);
        });
    }
    if (addAssigneeBtn && !addAssigneeBtn._bound) {
        addAssigneeBtn._bound = true;
        addAssigneeBtn.addEventListener("click", function () {
            addEditTaskAssigneeRow();
        });
    }
}

function populateEditTaskScopeFromTeam(teamId) {
    if (!teamId) {
        populateEditTaskDivisionOptions("");
        populateEditTaskGroupOptions("", "");
        populateEditTaskActivityOptions("", "");
        populateEditTaskTeamOptions("", "");
        return;
    }
    var scopeMaps = getSidebarScopeMaps();
    var teamInfo = scopeMaps && scopeMaps.teams ? scopeMaps.teams[parseInt(teamId, 10)] : null;
    var divisionId = teamInfo && teamInfo.division_id ? teamInfo.division_id : "";
    var groupId = teamInfo && teamInfo.group_id ? teamInfo.group_id : "";
    var activityId = teamInfo && teamInfo.activity_id ? teamInfo.activity_id : "";
    populateEditTaskDivisionOptions(divisionId);
    populateEditTaskGroupOptions(divisionId, groupId);
    populateEditTaskActivityOptions(groupId, activityId);
    populateEditTaskTeamOptions(activityId, teamId);
}

function loadEditTaskMembers(teamId, selectedAssigneeId, selectedLeadId, selectedAssignments) {
    var assigneeSelect = document.getElementById("edit-task-assignee");
    var leadSelect = document.getElementById("edit-task-lead");
    var list = document.getElementById("edit-task-assignees-list");
    if (!teamId) {
        if (assigneeSelect) { assigneeSelect.innerHTML = ""; addOption(assigneeSelect, "", "Optional (unassigned)", false); }
        if (leadSelect) { leadSelect.innerHTML = ""; addOption(leadSelect, "", "Optional (no lead)", false); }
        _editTaskAssigneesMembers = [];
        if (list) list.innerHTML = "";
        return;
    }
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            _editTaskAssigneesMembers = members || [];
            if (assigneeSelect) {
                assigneeSelect.innerHTML = "";
                addOption(assigneeSelect, "", "Optional (unassigned)", false);
                _editTaskAssigneesMembers.forEach(function (member) {
                    addOption(assigneeSelect, member.id, formatUserOptionLabel(member, "User " + member.id), String(selectedAssigneeId || "") === String(member.id));
                });
                if (selectedAssigneeId) assigneeSelect.value = String(selectedAssigneeId);
            }
            if (leadSelect) {
                leadSelect.innerHTML = "";
                addOption(leadSelect, "", "Optional (no lead)", false);
                _editTaskAssigneesMembers.forEach(function (member) {
                    addOption(leadSelect, member.id, formatUserOptionLabel(member, "User " + member.id), String(selectedLeadId || "") === String(member.id));
                });
                if (selectedLeadId) leadSelect.value = String(selectedLeadId);
            }
            if (list) {
                list.innerHTML = "";
                (selectedAssignments || []).forEach(function (assignment) {
                    addEditTaskAssigneeRow(assignment);
                });
            }
        })
        .catch(function () {
            if (assigneeSelect) { assigneeSelect.innerHTML = ""; addOption(assigneeSelect, "", "Optional (unassigned)", false); }
            if (leadSelect) { leadSelect.innerHTML = ""; addOption(leadSelect, "", "Optional (no lead)", false); }
            _editTaskAssigneesMembers = [];
            if (list) list.innerHTML = "";
        });
}

function syncEditTaskModeUI() {
    var itemKind = document.getElementById("edit-item-kind");
    var targetSelect = document.getElementById("edit-task-convert-target");
    var parentModeSelect = document.getElementById("edit-task-parent-mode");
    var dueLabel = document.getElementById("edit-task-due-label");
    var itemKindValue = itemKind ? String(itemKind.value || "task") : "task";
    var targetValue = targetSelect ? String(targetSelect.value || "task") : "task";
    var parentMode = parentModeSelect ? String(parentModeSelect.value || "main") : "main";
    var targetIsMilestone = targetValue === "milestone";
    var sourceIsMilestone = itemKindValue === "milestone";
    var taskModeVisible = !targetIsMilestone;
    var showingMainPlacement = parentMode === "main";
    var dependencyEnabled = !!(document.getElementById("edit-task-has-dependency") && document.getElementById("edit-task-has-dependency").checked);
    var canManageAssignments = sourceIsMilestone || canAssignTask() || canUseMultiAssign();

    function show(id, visible) {
        var el = document.getElementById(id);
        if (!el) return;
        if (el.hasAttribute("hidden")) el.hidden = !visible;
        else el.style.display = visible ? "" : "none";
    }

    if (dueLabel) dueLabel.textContent = targetIsMilestone ? "Milestone date" : "Due date";
    show("edit-task-description-wrap", taskModeVisible);
    show("edit-task-priority-wrap", taskModeVisible);
    show("edit-task-schedule-type-wrap", taskModeVisible);
    show("edit-task-tentative-start-wrap", taskModeVisible);
    show("edit-task-tentative-completion-wrap", taskModeVisible);
    show("edit-task-dependency-toggle-wrap", true);
    show("edit-task-start-dependency-wrap", dependencyEnabled);
    show("edit-task-finish-dependency-wrap", dependencyEnabled);
    show("edit-task-type-wrap", taskModeVisible);
    show("edit-task-custom-type-wrap", taskModeVisible && !!(document.getElementById("edit-task-type") && document.getElementById("edit-task-type").value === "Others"));
    show("edit-task-parent-mode-wrap", taskModeVisible);
    show("edit-task-parent-wrap", taskModeVisible && parentMode === "child");
    show("edit-task-main-placement-wrap", taskModeVisible && showingMainPlacement);
    show("edit-task-assignee-wrap", taskModeVisible && canManageAssignments && !canUseMultiAssign());
    show("edit-task-lead-wrap", taskModeVisible && canManageAssignments && !canUseMultiAssign());
    show("edit-task-share-wrap", taskModeVisible && canManageAssignments && !canUseMultiAssign());
    show("edit-task-multi-assign-wrap", taskModeVisible && canManageAssignments && canUseMultiAssign());
    toggleEditTaskScheduleType();
    toggleEditTaskDependencyFields();
}

function openEditTaskModal(taskId) {
    var task = findTaskByIdInTree(lastLoadedTasks || [], taskId);
    if (!task) {
        showToast("Task not found", true);
        return;
    }
    if (!canEditTaskDetails(task)) {
        showToast("You are not allowed to edit this item", true);
        return;
    }
    initializeEditTaskHierarchyBindings();
    currentEditTaskRecord = task;
    currentEditMilestoneRecord = null;
    var modal = document.getElementById("edit-task-modal");
    var itemKind = document.getElementById("edit-item-kind");
    var title = document.getElementById("edit-task-title");
    var desc = document.getElementById("edit-task-description");
    var prio = document.getElementById("edit-task-priority");
    var scheduleType = document.getElementById("edit-task-schedule-type");
    var dueDate = document.getElementById("edit-task-due");
    var tentativeStart = document.getElementById("edit-task-tentative-start");
    var tentativeCompletion = document.getElementById("edit-task-tentative-completion");
    var type = document.getElementById("edit-task-type");
    var customType = document.getElementById("edit-task-custom-type");
    var idEl = document.getElementById("edit-task-id");
    var isSubtaskEl = document.getElementById("edit-task-is-subtask");
    var titleEl = document.getElementById("edit-task-modal-title");
    var convertTarget = document.getElementById("edit-task-convert-target");
    var parentMode = document.getElementById("edit-task-parent-mode");
    var parentSelect = document.getElementById("edit-task-parent-id");
    var share = document.getElementById("edit-task-share");
    if (!modal || !title || !desc || !prio || !scheduleType || !dueDate || !type || !idEl || !isSubtaskEl) return;
    if (itemKind) itemKind.value = "task";
    idEl.value = String(task.id);
    isSubtaskEl.value = task.parent_task_id ? "1" : "0";
    if (titleEl) titleEl.textContent = task.parent_task_id ? "Edit subtask" : "Edit task";
    if (convertTarget) convertTarget.value = "task";
    title.value = task.title || "";
    desc.value = task.description || "";
    prio.value = task.priority || "Medium";
    var scheduleTypeValue = String(task.task_schedule_type || "").trim().toLowerCase();
    var isOngoingTask = scheduleTypeValue === "ongoing" || (!scheduleTypeValue && !task.due_date);
    scheduleType.value = isOngoingTask ? "Ongoing" : "Time Bound";
    dueDate.value = task.due_date || "";
    if (tentativeStart) tentativeStart.value = task.tentative_start_date || "";
    if (tentativeCompletion) tentativeCompletion.value = getTaskTentativeCompletionDateValue(task);
    var depToggle = document.getElementById("edit-task-has-dependency");
    var depStartTask = document.getElementById("edit-task-start-dependency-task");
    var depStartEvent = document.getElementById("edit-task-start-dependency-event");
    var depStartOffsetEnabled = document.getElementById("edit-task-start-dependency-offset-enabled");
    var depStartOffsetDays = document.getElementById("edit-task-start-dependency-offset-days");
    var depFinishTask = document.getElementById("edit-task-finish-dependency-task");
    var depFinishEvent = document.getElementById("edit-task-finish-dependency-event");
    var depFinishOffsetEnabled = document.getElementById("edit-task-finish-dependency-offset-enabled");
    var depFinishOffsetDays = document.getElementById("edit-task-finish-dependency-offset-days");
    if (depToggle) depToggle.checked = !!task.has_dependency;
    refreshDependencyTaskSelectors();
    if (depStartTask) depStartTask.value = task.start_dependency_task_id ? String(task.start_dependency_task_id) : "";
    if (depStartEvent) depStartEvent.value = task.start_dependency_event || "finish";
    if (depStartOffsetEnabled) depStartOffsetEnabled.checked = task.start_dependency_offset_days != null;
    if (depStartOffsetDays) depStartOffsetDays.value = task.start_dependency_offset_days != null ? String(task.start_dependency_offset_days) : "";
    if (depFinishTask) depFinishTask.value = task.finish_dependency_task_id ? String(task.finish_dependency_task_id) : "";
    if (depFinishEvent) depFinishEvent.value = task.finish_dependency_event || "finish";
    if (depFinishOffsetEnabled) depFinishOffsetEnabled.checked = task.finish_dependency_offset_days != null;
    if (depFinishOffsetDays) depFinishOffsetDays.value = task.finish_dependency_offset_days != null ? String(task.finish_dependency_offset_days) : "";
    if (isKnownTaskType(task.task_type)) {
        type.value = task.task_type;
        if (customType) customType.value = "";
    } else {
        type.value = "Others";
        if (customType) customType.value = task.task_type || "";
    }
    if (parentMode) parentMode.value = task.parent_task_id ? "child" : "main";
    populateEditTaskParentOptions(task.parent_task_id || "");
    if (parentSelect && task.parent_task_id) parentSelect.value = String(task.parent_task_id);
    populateEditTaskScopeFromTeam(task.team_id || "");
    if (share) share.value = task.percent_share != null ? String(task.percent_share) : "";
    loadEditTaskMembers(
        task.team_id || "",
        task.assigned_to || "",
        task.lead_person_id || "",
        Array.isArray(task.assignees) && task.assignees.length
            ? task.assignees
            : (task.assigned_to ? [{ user_id: task.assigned_to, percent_share: task.percent_share, is_lead: !!task.lead_person_id && String(task.lead_person_id) === String(task.assigned_to) }] : [])
    );
    syncEditTaskModeUI();
    modal.hidden = false;
}

function openEditMilestoneModal(milestoneId) {
    var milestone = (milestonesList || []).find(function (item) { return String(item.id) === String(milestoneId); });
    if (!milestone) {
        showToast("Milestone not found", true);
        return;
    }
    if (!canManageMilestones()) {
        showToast("You are not allowed to edit this milestone", true);
        return;
    }
    initializeEditTaskHierarchyBindings();
    currentEditTaskRecord = null;
    currentEditMilestoneRecord = milestone;
    var modal = document.getElementById("edit-task-modal");
    var itemKind = document.getElementById("edit-item-kind");
    var title = document.getElementById("edit-task-title");
    var desc = document.getElementById("edit-task-description");
    var prio = document.getElementById("edit-task-priority");
    var scheduleType = document.getElementById("edit-task-schedule-type");
    var dueDate = document.getElementById("edit-task-due");
    var tentativeStart = document.getElementById("edit-task-tentative-start");
    var tentativeCompletion = document.getElementById("edit-task-tentative-completion");
    var type = document.getElementById("edit-task-type");
    var customType = document.getElementById("edit-task-custom-type");
    var idEl = document.getElementById("edit-task-id");
    var isSubtaskEl = document.getElementById("edit-task-is-subtask");
    var titleEl = document.getElementById("edit-task-modal-title");
    var convertTarget = document.getElementById("edit-task-convert-target");
    var parentMode = document.getElementById("edit-task-parent-mode");
    if (!modal || !title || !dueDate || !idEl) return;
    if (itemKind) itemKind.value = "milestone";
    idEl.value = String(milestone.id);
    if (isSubtaskEl) isSubtaskEl.value = "0";
    if (titleEl) titleEl.textContent = "Edit milestone";
    if (convertTarget) convertTarget.value = "milestone";
    if (parentMode) parentMode.value = "main";
    title.value = milestone.name || "";
    if (desc) desc.value = "";
    if (prio) prio.value = "Medium";
    if (scheduleType) scheduleType.value = "Time Bound";
    dueDate.value = milestone.milestone_date || "";
    if (tentativeStart) tentativeStart.value = "";
    if (tentativeCompletion) tentativeCompletion.value = "";
    if (type) type.value = "Infrastructure Development";
    if (customType) customType.value = "";
    var depToggle = document.getElementById("edit-task-has-dependency");
    var depStartTask = document.getElementById("edit-task-start-dependency-task");
    var depStartEvent = document.getElementById("edit-task-start-dependency-event");
    var depFinishTask = document.getElementById("edit-task-finish-dependency-task");
    var depFinishEvent = document.getElementById("edit-task-finish-dependency-event");
    if (depToggle) depToggle.checked = !!milestone.has_dependency;
    refreshDependencyTaskSelectors();
    if (depStartTask) depStartTask.value = milestone.start_dependency_task_id ? String(milestone.start_dependency_task_id) : "";
    if (depStartEvent) depStartEvent.value = milestone.start_dependency_event || "finish";
    if (depFinishTask) depFinishTask.value = milestone.finish_dependency_task_id ? String(milestone.finish_dependency_task_id) : "";
    if (depFinishEvent) depFinishEvent.value = milestone.finish_dependency_event || "finish";
    populateEditTaskParentOptions("");
    populateEditTaskScopeFromTeam("");
    loadEditTaskMembers("", "", "", []);
    var share = document.getElementById("edit-task-share");
    if (share) share.value = "";
    syncEditTaskModeUI();
    modal.hidden = false;
}

function closeEditTaskModal() {
    var modal = document.getElementById("edit-task-modal");
    if (modal) modal.hidden = true;
    currentEditTaskRecord = null;
    currentEditMilestoneRecord = null;
}

function saveTaskDetailsEdit() {
    var itemKind = document.getElementById("edit-item-kind");
    var idEl = document.getElementById("edit-task-id");
    var title = document.getElementById("edit-task-title");
    var desc = document.getElementById("edit-task-description");
    var prio = document.getElementById("edit-task-priority");
    var scheduleType = document.getElementById("edit-task-schedule-type");
    var dueDate = document.getElementById("edit-task-due");
    var tentativeStart = document.getElementById("edit-task-tentative-start");
    var tentativeCompletion = document.getElementById("edit-task-tentative-completion");
    var type = document.getElementById("edit-task-type");
    var customType = document.getElementById("edit-task-custom-type");
    var targetType = document.getElementById("edit-task-convert-target");
    var parentMode = document.getElementById("edit-task-parent-mode");
    var parentSelect = document.getElementById("edit-task-parent-id");
    var teamSelect = document.getElementById("edit-task-team");
    var activitySelect = document.getElementById("edit-task-activity");
    var assigneeSelect = document.getElementById("edit-task-assignee");
    var leadSelect = document.getElementById("edit-task-lead");
    var share = document.getElementById("edit-task-share");
    var itemId = idEl && idEl.value ? parseInt(idEl.value, 10) : null;
    if (!itemId) { showToast("Item not selected", true); return; }
    var kind = itemKind ? String(itemKind.value || "task") : "task";
    var nextType = targetType ? String(targetType.value || "task") : "task";
    var nextParentMode = parentMode ? String(parentMode.value || "main") : "main";
    var dueValue = dueDate ? (dueDate.value || null) : null;
    var tentativeCompletionValue = tentativeCompletion ? (tentativeCompletion.value || null) : null;
    var dependencyPayload = collectDependencyPayload("edit-task");
    if (dependencyPayload === null) return;
    var payload = {
        title: title ? title.value.trim() : "",
        description: desc ? desc.value.trim() : "",
        priority: prio ? prio.value : "Medium",
        task_schedule_type: scheduleType ? scheduleType.value : "Time Bound",
        due_date: dueValue
    };
    if (!payload.title) {
        showToast("Name is required", true);
        return;
    }
    if (nextType === "milestone") {
        if (!payload.due_date) {
            showToast("Milestone date is required", true);
            return;
        }
    } else {
        if (payload.task_schedule_type === "Time Bound" && !payload.due_date) {
            showToast("Due date is required for Time Bound tasks", true);
            return;
        }
        if (payload.task_schedule_type === "Time Bound" && payload.due_date && isHolidayDate(payload.due_date)) {
            showToast("Selected due date is a holiday (" + getHolidayNameByDate(payload.due_date) + "). Choose a working day.", true);
            return;
        }
        if (payload.task_schedule_type === "Ongoing") {
            payload.due_date = null;
        }
        if (payload.task_schedule_type === "Ongoing" && !(tentativeStart && tentativeStart.value)) {
            showToast("Tentative start date is required for ongoing tasks", true);
            return;
        }
        if (payload.task_schedule_type === "Ongoing" && !tentativeCompletionValue) {
            showToast("Tentative completion date is required for ongoing tasks", true);
            return;
        }
        if (isTentativeCompletionBeforeStart(tentativeStart ? tentativeStart.value : "", tentativeCompletionValue)) {
            showToast("Tentative completion date cannot be earlier than tentative start date", true);
            return;
        }
        payload.tentative_start_date = tentativeStart ? (tentativeStart.value || null) : null;
        payload.tentative_completion_date = tentativeCompletionValue;
        payload.task_type = type ? (type.value || "Infrastructure Development") : "Infrastructure Development";
        payload.custom_type = customType ? (customType.value.trim() || null) : null;
        if (nextParentMode === "child") {
            if (!(parentSelect && parentSelect.value)) {
                showToast("Select a parent item", true);
                return;
            }
            payload.parent_task_id = parseInt(parentSelect.value, 10);
        } else {
            payload.parent_task_id = null;
            if (!(teamSelect && teamSelect.value)) {
                showToast("Select a team for the main task", true);
                return;
            }
            payload.team_id = parseInt(teamSelect.value, 10);
            payload.activity_id = activitySelect && activitySelect.value ? parseInt(activitySelect.value, 10) : null;
        }
        if (dependencyPayload) {
            Object.keys(dependencyPayload).forEach(function (key) {
                payload[key] = dependencyPayload[key];
            });
        }
        if (canUseMultiAssign()) {
            payload.assignments = getEditTaskAssigneesFromRows();
        } else if (canAssignTask()) {
            payload.assigned_to = assigneeSelect && assigneeSelect.value ? parseInt(assigneeSelect.value, 10) : null;
            payload.lead_person_id = leadSelect && leadSelect.value ? parseInt(leadSelect.value, 10) : null;
            payload.percent_share = share && share.value ? parseInt(share.value, 10) : null;
        }
    }

    var request;
    if (kind === "milestone" && nextType === "milestone") {
        request = apiRequest("/milestones/" + itemId, "PUT", {
            name: payload.title,
            milestone_date: payload.due_date,
            has_dependency: dependencyPayload.has_dependency,
            start_dependency_task_id: dependencyPayload.start_dependency_task_id,
            start_dependency_event: dependencyPayload.start_dependency_event,
            finish_dependency_task_id: dependencyPayload.finish_dependency_task_id,
            finish_dependency_event: dependencyPayload.finish_dependency_event
        });
    } else if (kind === "task" && nextType === "milestone") {
        request = apiRequest("/tasks/" + itemId + "/convert-to-milestone", "POST", {
            name: payload.title,
            milestone_date: payload.due_date,
            has_dependency: dependencyPayload.has_dependency,
            start_dependency_task_id: dependencyPayload.start_dependency_task_id,
            start_dependency_event: dependencyPayload.start_dependency_event,
            finish_dependency_task_id: dependencyPayload.finish_dependency_task_id,
            finish_dependency_event: dependencyPayload.finish_dependency_event
        });
    } else if (kind === "milestone" && nextType === "task") {
        request = apiRequest("/milestones/" + itemId + "/convert-to-task", "POST", payload);
    } else {
        request = apiRequest("/tasks/" + itemId + "/details", "PUT", payload);
    }

    request
        .then(function () {
            closeEditTaskModal();
            showToast("Saved successfully");
            loadMilestones();
            loadTasks();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to save", true);
        });
}

function handleProcurementStageChange(taskId, selectEl) {
    var val = selectEl.value || "";
    apiRequest("/tasks/" + taskId + "/procurement-stage", "PUT", {
        procurement_stage: val || null
    })
        .then(function () {
            showToast("Procurement stage updated");
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update procurement stage", true);
            // Reload tasks so the dropdown snaps back to the saved stage if backend rejected the change
            loadTasks();
        });
}

function handleActionSelect(taskId, activityId, currentStatus, selectEl) {
    var val = selectEl.value;
    if (val === "__change_due_date__") {
        var currentDue = (selectEl.getAttribute("data-due-date") || "").trim();
        var msg = "Enter new due date (YYYY-MM-DD):";
        if (currentDue) msg = "Current due date: " + currentDue + ".\n\n" + msg;
        var input = prompt(msg, currentDue || "");
        selectEl.value = currentStatus;
        if (input == null) return;
        var trimmed = (input || "").trim();
        if (!trimmed) {
            showToast("Due date cannot be empty", true);
            return;
        }
        if (isHolidayDate(trimmed)) {
            showToast("Selected due date is a holiday (" + getHolidayNameByDate(trimmed) + "). Choose a working day.", true);
            return;
        }
        var payload = { due_date: trimmed };
        apiRequest("/tasks/" + taskId + "/due-date", "PUT", payload)
            .then(function () {
                showToast("Due date updated");
                loadTasks();
                if (chatPanelOpen) loadActivityChat(true);
            })
            .catch(function (err) {
                showToast(err.message || "Failed to update due date", true);
            });
        return;
    }
    if (val === "__unassign_task__") {
        selectEl.value = currentStatus;
        var ok = confirm("Unassign this task? The task will show in the Assign to... dropdown for reassignment.");
        if (!ok) return;
        apiRequest("/tasks/" + taskId + "/assign", "PUT", { assigned_to: null })
            .then(function () {
                showToast("Task unassigned");
                loadTasks();
                if (chatPanelOpen) loadActivityChat(true);
            })
            .catch(function (err) {
                showToast(err.message || "Failed to unassign task", true);
            });
        return;
    }
    if (val === "__delete_task__") {
        var ok = confirm("Delete this task and its related data?");
        if (!ok) {
            selectEl.value = currentStatus;
            return;
        }
        apiRequest("/tasks/" + taskId, "DELETE")
            .then(function () {
                showToast("Task deleted");
                loadTasks();
                loadActivityLogs();
            })
            .catch(function (err) {
                showToast(err.message || "Failed to delete task", true);
                selectEl.value = currentStatus;
            });
        return;
    }
    if (val === "__delete_activity__") {
        if (activityId == null) {
            showToast("This task has no activity", true);
            selectEl.value = currentStatus;
            return;
        }
        var ok = confirm("Delete the entire activity and all its tasks? This cannot be undone.");
        if (!ok) {
            selectEl.value = currentStatus;
            return;
        }
        apiRequest("/activities/" + activityId, "DELETE")
            .then(function () {
                showToast("Activity deleted");
                loadUserTeams();
                loadTasks();
                loadActivityLogs();
            })
            .catch(function (err) {
                showToast(err.message || "Failed to delete activity", true);
                selectEl.value = currentStatus;
            });
        return;
    }
    updateStatus(taskId, val);
}

function updateStatus(taskId, status) {
    // Members must attach completion proof; only admins can directly complete
    if (status === "Completed" && !isUserAdmin()) {
        openCompletionProofModal(taskId);
        return;
    }
    apiRequest("/tasks/" + taskId + "/status", "PUT", { status: status })
        .then(function () {
            showToast("Status updated");
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update status", true);
            loadTasks();
        });
}

function openCompletionProofModal(taskId) {
    var modal = document.getElementById("completion-proof-modal");
    var taskIdEl = document.getElementById("completion-proof-task-id");
    var fileEl = document.getElementById("completion-proof-file");
    var countEl = document.getElementById("completion-proof-file-count");
    if (!modal || !taskIdEl || !fileEl) return;
    taskIdEl.value = taskId;
    fileEl.value = "";
    if (countEl) { countEl.hidden = true; countEl.textContent = ""; }
    modal.hidden = false;
}

function updateCompletionProofFileCount() {
    var fileEl = document.getElementById("completion-proof-file");
    var countEl = document.getElementById("completion-proof-file-count");
    if (!fileEl || !countEl) return;
    var files = fileEl.files;
    if (!files || files.length === 0) {
        countEl.hidden = true;
        return;
    }
    var n = files.length;
    var total = 0;
    for (var i = 0; i < n; i++) total += files[i].size;
    var sizeStr = (total / (1024 * 1024)).toFixed(2) + " MB";
    countEl.textContent = n === 1 ? "1 file selected (" + sizeStr + ")" : n + " files selected (" + sizeStr + ")";
    countEl.hidden = false;
}

function closeCompletionProofModal() {
    var modal = document.getElementById("completion-proof-modal");
    if (modal) modal.hidden = true;
    // Refresh task list so status dropdown shows actual server status (member may have cancelled without uploading)
    loadTasks();
}

function openTeamMembersModal(teamSelection, teamName) {
    var modal = document.getElementById("team-members-modal");
    var titleEl = document.getElementById("team-members-modal-title");
    var subtitleEl = document.getElementById("team-members-modal-subtitle");
    var listEl = document.getElementById("team-members-list");
    var emptyEl = document.getElementById("team-members-empty");
    var loadingEl = document.getElementById("team-members-loading");
    if (!modal || !titleEl || !listEl) return;
    var selectedTeams = Array.isArray(teamSelection)
        ? teamSelection.map(function (team) {
            if (team && typeof team === "object") return { id: parseInt(team.id, 10), name: team.name || "Unnamed team" };
            return { id: parseInt(team, 10), name: teamName || "Unnamed team" };
        }).filter(function (team) { return !!team.id; })
        : [{ id: parseInt(teamSelection, 10), name: teamName || "Unnamed team" }].filter(function (team) { return !!team.id; });
    titleEl.textContent = selectedTeams.length > 1 ? "Selected team members" : (selectedTeams[0] ? selectedTeams[0].name : "Team members");
    if (subtitleEl) {
        subtitleEl.textContent = selectedTeams.length > 1 ? selectedTeams.length + " teams selected" : "";
        subtitleEl.hidden = selectedTeams.length <= 1;
    }
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.hidden = true;
    if (loadingEl) loadingEl.hidden = false;
    modal.hidden = false;

    Promise.all(selectedTeams.map(function (team) {
        return apiRequest("/teams/" + team.id + "/members", "GET")
            .then(function (members) {
                return { team: team, members: members || [] };
            })
            .catch(function (err) {
                return { team: team, error: err };
            });
    }))
        .then(function (results) {
            if (loadingEl) loadingEl.hidden = true;
            if (!results.length) {
                if (emptyEl) emptyEl.hidden = false;
                return;
            }
            var hasAnyMembers = results.some(function (result) {
                return result.members && result.members.length > 0;
            });
            if (!hasAnyMembers && emptyEl) {
                emptyEl.textContent = selectedTeams.length > 1 ? "No members found in the selected teams." : "No members in this team.";
                emptyEl.hidden = false;
            }
            listEl.innerHTML = results.map(function (result) {
                var scopeMaps = getSidebarScopeMaps();
                var teamInfo = scopeMaps && scopeMaps.teams ? scopeMaps.teams[result.team.id] : null;
                var meta = teamInfo
                    ? "Division: " + (teamInfo.division_name || "-") + " | Group: " + (teamInfo.group_name || "-") + " | " + getActivityProjectLabel(teamInfo.activity_type) + ": " + (teamInfo.activity_name || "-")
                    : "";
                var body = "";
                if (result.error) {
                    body = "<p class=\"team-members-group-empty text-muted\">" + escapeHtml(result.error.message || "Could not load team members.") + "</p>";
                } else if (!result.members || result.members.length === 0) {
                    body = "<p class=\"team-members-group-empty text-muted\">No members in this team.</p>";
                } else {
                    body = "<ul class=\"team-members-group-list\">" + result.members.map(function (m) {
                        var name = m.username || "User " + m.id;
                        var role = (m.role || "Member").toString();
                        return "<li class=\"team-member-item\"><span class=\"team-member-name\">" + renderUserLabelHtml(name, m.designation, "User " + m.id) + "</span><span class=\"team-member-role\">" + escapeHtml(role) + "</span></li>";
                    }).join("") + "</ul>";
                }
                return "<li class=\"team-members-group\"><div class=\"team-members-group-head\"><h3 class=\"team-members-group-title\">" + escapeHtml(result.team.name || "Unnamed team") + "</h3>" + (meta ? "<p class=\"team-members-group-meta\">" + escapeHtml(meta) + "</p>" : "") + "</div>" + body + "</li>";
            }).join("");
        })
        .catch(function (err) {
            if (loadingEl) loadingEl.hidden = true;
            if (emptyEl) {
                emptyEl.textContent = err.message || "Could not load team members.";
                emptyEl.hidden = false;
            }
        });
}

function closeTeamMembersModal() {
    var modal = document.getElementById("team-members-modal");
    if (modal) modal.hidden = true;
    var subtitleEl = document.getElementById("team-members-modal-subtitle");
    if (subtitleEl) {
        subtitleEl.textContent = "";
        subtitleEl.hidden = true;
    }
    var listEl = document.getElementById("team-members-list");
    if (listEl) listEl.innerHTML = "";
}

function openCreateSubtaskModal(parentTaskId, teamId, activityId) {
    var modal = document.getElementById("create-subtask-modal");
    if (!modal) return;
    var parentTask = findTaskByIdInTree(lastLoadedTasks || [], parseInt(parentTaskId, 10));
    var subtitleEl = document.getElementById("create-subtask-modal-subtitle");
    var titleEl = document.getElementById("create-subtask-modal-title");
    var assigneeWrap = document.getElementById("subtask-assignee-wrap");
    var assigneeSelect = document.getElementById("subtask-assignee");
    document.getElementById("subtask-parent-id").value = parentTaskId || "";
    document.getElementById("subtask-team-id").value = teamId || "";
    document.getElementById("subtask-activity-id").value = activityId || "";
    document.getElementById("subtask-title").value = "";
    document.getElementById("subtask-desc").value = "";
    document.getElementById("subtask-due").value = "";
    document.getElementById("subtask-tentative-start").value = "";
    document.getElementById("subtask-tentative-completion").value = "";
    document.getElementById("subtask-priority").value = "Medium";
    var subtaskHasDependencyEl = document.getElementById("subtask-has-dependency");
    var subtaskStartDepTaskEl = document.getElementById("subtask-start-dependency-task");
    var subtaskFinishDepTaskEl = document.getElementById("subtask-finish-dependency-task");
    var subtaskStartDepEventEl = document.getElementById("subtask-start-dependency-event");
    var subtaskFinishDepEventEl = document.getElementById("subtask-finish-dependency-event");
    if (subtaskHasDependencyEl) subtaskHasDependencyEl.checked = false;
    if (subtaskStartDepTaskEl) subtaskStartDepTaskEl.value = "";
    if (subtaskFinishDepTaskEl) subtaskFinishDepTaskEl.value = "";
    if (subtaskStartDepEventEl) subtaskStartDepEventEl.value = "finish";
    if (subtaskFinishDepEventEl) subtaskFinishDepEventEl.value = "finish";
    if (titleEl) titleEl.textContent = parentTask && parentTask.parent_task_id ? "Create Sub-subtask" : "Create Subtask";
    if (subtitleEl) {
        subtitleEl.textContent = parentTask ? ('Under "' + (parentTask.title || "Task") + '"') : "";
        subtitleEl.hidden = !parentTask;
    }
    if (assigneeSelect) {
        assigneeSelect.innerHTML = "";
        addOption(assigneeSelect, "", "Inherit from parent / unassigned", false);
        assigneeSelect.value = "";
    }
    populateSubtaskAssigneeOptions(teamId, parentTask);
    refreshDependencyTaskSelectors(parentTaskId || null);
    toggleSubtaskDependencyFields(parentTaskId || null);
    if (assigneeWrap) assigneeWrap.hidden = !canAssignSubtaskToAnyUser();
    modal.hidden = false;
}

function closeCreateSubtaskModal() {
    var modal = document.getElementById("create-subtask-modal");
    if (modal) modal.hidden = true;
}

function canAssignSubtaskToAnyUser() {
    var role = (localStorage.getItem("role") || "").toLowerCase();
    return role === "admin" || role === "division head";
}

function populateSubtaskAssigneeOptions(teamId, parentTask) {
    var assigneeWrap = document.getElementById("subtask-assignee-wrap");
    var assigneeSelect = document.getElementById("subtask-assignee");
    if (!assigneeWrap || !assigneeSelect) return;
    if (!canAssignSubtaskToAnyUser()) {
        assigneeWrap.hidden = true;
        return;
    }
    assigneeWrap.hidden = false;
    var preferredUserId = parentTask && parentTask.assigned_to ? String(parentTask.assigned_to) : "";
    var fillOptions = function (users) {
        assigneeSelect.innerHTML = "";
        addOption(assigneeSelect, "", "Inherit from parent / unassigned", false);
        (users || []).forEach(function (u) {
            addOption(assigneeSelect, u.id, formatUserOptionLabel(u, "User " + u.id), false);
        });
        if (preferredUserId) assigneeSelect.value = preferredUserId;
    };
    if (Array.isArray(cachedAllUsers) && cachedAllUsers.length > 0) {
        fillOptions(cachedAllUsers);
        return;
    }
    apiRequest("/users", "GET")
        .then(function (users) {
            cachedAllUsers = sortUsersByDesignationSeniority(users || []);
            fillOptions(cachedAllUsers);
        })
        .catch(function () {
            fillOptions([]);
        });
}

function createSubtask() {
    var parentId = document.getElementById("subtask-parent-id").value;
    var teamId = document.getElementById("subtask-team-id").value;
    var activityId = document.getElementById("subtask-activity-id").value;
    var title = document.getElementById("subtask-title").value.trim();
    var desc = document.getElementById("subtask-desc").value.trim();
    var due = document.getElementById("subtask-due").value;
    var tentativeStart = document.getElementById("subtask-tentative-start").value;
    var tentativeCompletion = document.getElementById("subtask-tentative-completion").value;
    var priority = document.getElementById("subtask-priority").value;
    var assigneeEl = document.getElementById("subtask-assignee");
    var assignee = assigneeEl && assigneeEl.value ? parseInt(assigneeEl.value, 10) : null;

    if (!title) { showToast("Enter a subtask title", true); return; }
    if (due && isHolidayDate(due)) {
        showToast("Selected due date is a holiday (" + getHolidayNameByDate(due) + "). Choose a working day.", true);
        return;
    }
    if (isTentativeCompletionBeforeStart(tentativeStart, tentativeCompletion)) {
        showToast("Tentative completion date cannot be earlier than tentative start date", true);
        return;
    }
    var dependencyPayload = collectDependencyPayload("subtask");
    if (dependencyPayload === null) return;

    var payload = {
        title: title,
        description: desc || null,
        due_date: due || null,
        tentative_start_date: tentativeStart || null,
        tentative_completion_date: tentativeCompletion || null,
        priority: priority,
        status: "To Do",
        task_type: "Infrastructure Development",
        team_id: teamId ? parseInt(teamId, 10) : null,
        activity_id: activityId ? parseInt(activityId, 10) : null,
        parent_task_id: parseInt(parentId, 10)
    };
    Object.keys(dependencyPayload).forEach(function (key) {
        payload[key] = dependencyPayload[key];
    });
    if (assignee) payload.assigned_to = assignee;

    var parentTask = findTaskByIdInTree(lastLoadedTasks || [], parseInt(parentId, 10));
    var subtaskLabel = parentTask && parentTask.parent_task_id ? "sub-subtask" : "subtask";

    guardDuplicateNameBeforeCreate({
        entityLabel: subtaskLabel,
        name: title,
        sourceInputId: "subtask-title"
    }).then(function (finalName) {
        if (!finalName) return null;
        payload.title = finalName;
        apiRequest("/tasks", "POST", payload)
            .then(function () {
                closeCreateSubtaskModal();
                openSubtaskParents[String(parentId)] = true;
                saveOpenSubtaskParents();
                showToast(subtaskLabel === "sub-subtask" ? "Sub-subtask created" : "Subtask created");
                loadTasks();
            })
            .catch(function (err) {
                showToast(err.message || "Failed to create subtask", true);
            });
    });
}

function renderTasksTableMarkup(tasks, options) {
    options = options || {};

    function buildRowHtml(t, isSubtask, standalone, depth) {
        depth = depth || 0;
        var dueRaw = t.due_date || null;
        var dueDisplayValue = getTaskScheduleDeadlineValue(t);
        var due = dueDisplayValue || "";
        var daysLeft = computeWorkingDaysLeft(dueDisplayValue);
        var daysLeftContent;
        if (typeof daysLeft === "number") {
            var daysLeftClass = "days-left";
            if (daysLeft < 0) daysLeftClass += " days-left--overdue";
            else if (daysLeft <= 3) daysLeftClass += " days-left--warning";
            daysLeftContent = "<span class=\"" + daysLeftClass + "\">" + escapeHtml(String(daysLeft)) + "</span>";
        } else {
            daysLeftContent = "—";
        }

        var assignees = t.assignees;
        daysLeftContent = buildDaysLeftContent(daysLeft);
        var hasMultiAssignees = assignees && assignees.length > 0;
        var assignedCell;
        if (hasMultiAssignees) {
            var n = assignees.length;
            if (n === 1) {
                var aSingle = assignees[0];
                var nameSingle = formatUserOptionLabel(aSingle, "User " + aSingle.user_id);
                var pctSingle = aSingle.percent_share != null ? " " + aSingle.percent_share + "%" : "";
                var leadSingle = aSingle.is_lead ? " (Lead)" : "";
                assignedCell = "<span class=\"assigned-name-text\" title=\"" + escapeHtml(nameSingle + pctSingle + leadSingle) + "\">" + escapeHtml(nameSingle + pctSingle + leadSingle) + "</span>";
            } else {
                        var firstOpt = "<option value=\"\" selected disabled>" + escapeHtml(getTaskAssignmentSummary(t, assignees)) + "</option>";
                var restOpts = assignees.map(function (a) {
                    var name = formatUserOptionLabel(a, "User " + a.user_id);
                    var pct = a.percent_share != null ? " " + a.percent_share + "%" : "";
                    var lead = a.is_lead ? " Lead" : "";
                    return "<option value=\"\" disabled>" + escapeHtml(name + pct + lead) + "</option>";
                }).join("");
                assignedCell = "<select class=\"status-select assigned-select\" title=\"Assignees\">" + firstOpt + restOpts + "</select>";
            }
        } else {
            var assignedDisplay = formatUserInline(t.assigned_username, t.assigned_designation, "—");
            var isUnassigned = !t.assigned_to && !t.assigned_username;
            var canAssign = canAssignTask() && isUnassigned && t.team_id;
            assignedCell = canAssign
                ? "<select class=\"assign-select\" data-task-id=\"" + t.id + "\" data-team-id=\"" + (t.team_id || "") + "\" onfocus=\"loadAssignDropdown(this)\" onchange=\"doAssignTask(this)\"><option value=\"\">Assign to...</option></select>"
                : "<span class=\"assigned-name-text\" title=\"" + escapeHtml(assignedDisplay) + "\">" + escapeHtml(assignedDisplay) + "</span>";
        }

        var displayStatus = (t.status === "Pending Completion") ? "Pending" : t.status;
        var statusDisabled = (t.status === "Pending Completion") ? " disabled" : "";
        var statusOpts = ["To Do", "In Progress", "Pending", "Completed"].map(function (s) {
            var val = (s === "Pending") ? "Pending Completion" : s;
            var sel = (t.status === val) ? " selected" : "";
            return "<option value=\"" + val + "\"" + sel + ">" + s + "</option>";
        }).join("");
        if (isUserAdmin() || t.can_approve_completion === true) {
            statusOpts += "<option value=\"\" disabled>—</option><option value=\"__change_due_date__\">Change due date</option>";
            if (canAssignTask() && (t.assigned_to || t.assigned_username)) statusOpts += "<option value=\"__unassign_task__\">Unassign task</option>";
            statusOpts += "<option value=\"__delete_task__\">Delete task</option><option value=\"__delete_activity__\">Delete activity</option>";
        }

        var statusClass = "status";
        var rawStatus = (t.status == null ? "" : String(t.status));
        var normalizedStatus = rawStatus.trim().toLowerCase();
        var isPendingCompletion = normalizedStatus === "pending completion" || rawStatus === "Pending Completion";
        var isCompletedStatus = normalizedStatus === "completed" || normalizedStatus === "done" || (normalizedStatus.indexOf("complete") !== -1 && !isPendingCompletion);
        if (normalizedStatus === "to do") statusClass += " status-todo";
        else if (normalizedStatus === "in progress") statusClass += " status-progress";
        else if (isPendingCompletion) statusClass += " status-pending-completion";
        else if (isCompletedStatus) statusClass += " status-done";

        var titleEsc = escapeHtml(t.title);
        var indentClass = depth > 0 ? (" task-indent task-indent--level-" + Math.min(depth, 4)) : "";
        if (t.parent_task_id) {
            titleEsc = "<span class=\"task-indent-marker" + indentClass + "\">↳</span><span class=\"task-indent-label\">" + titleEsc + "</span>";
        }
        var taskNameClass = "task-name-link";
        if (isCompletedStatus) {
            taskNameClass += " task-name--completed";
            daysLeftContent = "<span class=\"days-left days-left--completed\" title=\"Completed\">&#10003;</span>";
        } else if (typeof daysLeft === "number") {
            if (daysLeft < 0) taskNameClass += " task-name--overdue";
            else if (daysLeft <= 3) taskNameClass += " task-name--warning";
        }

        var taskContextHtml = "";
        if (options.showTeamNameInTask && t.team_name) {
            taskContextHtml = "<div class=\"task-context-note\">Team: " + escapeHtml(t.team_name) + "</div>";
        }
        if (options.showHierarchyContext && t._hierarchy_parent_title) {
            taskContextHtml += "<div class=\"task-context-note\">Parent: " + escapeHtml(t._hierarchy_parent_title) + "</div>";
        }
        if (options.showHierarchyContext && t._hierarchy_root_title && t._hierarchy_root_title !== t._hierarchy_parent_title && currentTaskHierarchyLevel === "L3") {
            taskContextHtml += "<div class=\"task-context-note\">L1: " + escapeHtml(t._hierarchy_root_title) + "</div>";
        }

        var taskType = t.task_type || "Others";
        var typeApprovalStatus = t.type_approval_status || "not_required";
        var canApproveType = t.can_approve_type === true;
        var typeCell = "<span class=\"task-type-badge " + getTaskTypeBadgeClass(taskType) + "\">" + escapeHtml(taskType) + "</span>";
        if (typeApprovalStatus === "pending") {
            typeCell += " <span class=\"task-type-pending\">Pending approval</span>";
            if (canApproveType) {
                typeCell += " <button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--primary\" onclick=\"approveTaskType(" + t.id + ", true)\">Approve</button> <button type=\"button\" class=\"btn btn-sm btn-ghost\" onclick=\"approveTaskType(" + t.id + ", false)\">Reject</button>";
            }
        } else if (typeApprovalStatus === "rejected") {
            typeCell += " <span class=\"task-type-rejected\">Rejected</span>";
        }

        var descHtml = buildTaskDescriptionContentHtml(t);
        var parentAttr = t.parent_task_id ? ' data-parent-task-id="' + t.parent_task_id + '"' : "";
        var subtaskStyle = "";
        var descStyle = "";
        if (isSubtask && !standalone) {
            var parentIsOpen = !!openSubtaskParents[String(t.parent_task_id)];
            subtaskStyle = ' style="display:' + (parentIsOpen ? "table-row" : "none") + ';"';
            descStyle = ' style="display:none;"';
        }

        return (
            "<tr data-task-id=\"" + t.id + "\"" + parentAttr + subtaskStyle + (isSubtask ? " class=\"subtask-row\"" : "") + ">" +
            "<td class=\"col-task\"><button type=\"button\" class=\"" + taskNameClass + "\" onclick=\"toggleTaskDescription(" + t.id + ")\" title=\"" + escapeHtml(t.title || "") + "\">" + titleEsc + "</button>" + taskContextHtml + "</td>" +
            "<td class=\"col-assigned\">" + assignedCell + "</td>" +
            "<td class=\"col-type\">" + typeCell + "</td>" +
            "<td><span class=\"priority priority-" + (t.priority || "Medium").toLowerCase() + "\">" + escapeHtml(t.priority || "Medium") + "</span></td>" +
            "<td><span class=\"" + statusClass + "\">" + escapeHtml(displayStatus) + "</span></td>" +
            "<td class=\"col-due\">" + due + "</td>" +
            "<td class=\"col-days-left\">" + daysLeftContent + "</td>" +
            "<td class=\"col-ext\">" + buildExtensionButtonHtml(t, dueRaw) + "</td>" +
            "<td>" + buildActionsCellHtml(t, statusOpts, statusDisabled, dueRaw) + "</td>" +
            "</tr>" +
            "<tr class=\"task-description-row task-description-row-hidden\" id=\"task-desc-" + t.id + "\" data-task-id=\"" + t.id + "\"" + parentAttr + descStyle + ">" +
            "<td colspan=\"9\"><div class=\"task-description\">" + descHtml + "</div></td>" +
            "</tr>"
        );
    }

    function renderTaskRows(taskList, standalone, depth) {
        depth = depth || 0;
        var orderedTasks = sortTasksByTypeAndRecency(taskList || []);
        return orderedTasks.map(function (task) {
            var html = buildRowHtml(task, !!task.parent_task_id, !!standalone, depth);
            if (task.subtasks && task.subtasks.length > 0) html += renderTaskRows(task.subtasks, standalone, depth + 1);
            return html;
        }).join("");
    }

    return renderTaskRows(tasks || [], !!options.standalone, 0);
}

function getTaskTypeSortLabel(task) {
    var value = task && task.task_type ? String(task.task_type).trim() : "";
    return value || "Others";
}

function getTaskRecencySortValue(task) {
    var createdAt = task && task.created_at ? Date.parse(task.created_at) : NaN;
    if (!isNaN(createdAt)) return createdAt;
    var numericId = task && task.id != null ? parseInt(task.id, 10) : NaN;
    return isNaN(numericId) ? 0 : numericId;
}

function sortTasksByTypeAndRecency(tasks) {
    return (Array.isArray(tasks) ? tasks.slice() : []).sort(function (a, b) {
        var typeCompare = getTaskTypeSortLabel(a).localeCompare(getTaskTypeSortLabel(b), undefined, { sensitivity: "base" });
        if (typeCompare !== 0) return typeCompare;
        var recencyCompare = getTaskRecencySortValue(b) - getTaskRecencySortValue(a);
        if (recencyCompare !== 0) return recencyCompare;
        return String(a && a.title || "").localeCompare(String(b && b.title || ""), undefined, { sensitivity: "base" });
    });
}

function renderTasksFromRows(tasks) {
    var tbody = document.getElementById("task-table");
    var groupsEl = document.getElementById("tasks-table-groups");
    var tableCard = document.getElementById("tasks-table-card");
    var unassignedCard = document.getElementById("unassigned-tasks-card");
    var unassignedTbody = document.getElementById("unassigned-task-table");
    var unassignedEmptyEl = document.getElementById("unassigned-tasks-empty");
    var milestonesCard = document.getElementById("milestones-card");
    var emptyEl = document.getElementById("tasks-empty");
    var scopeLabelEl = document.getElementById("tasks-scope-label");
    var statTasksEl = document.getElementById("stat-tasks");
    var statDueTodayEl = document.getElementById("stat-due-today");
    var statDueWeekEl = document.getElementById("stat-due-week");
    var statDueMonthEl = document.getElementById("stat-due-month");
    var taskList = Array.isArray(tasks) ? tasks : [];
    var scopeMaps = getSidebarScopeMaps();
    var filteredTasks = taskList.filter(function (task) { return matchesCurrentTaskScope(task, scopeMaps); });
    var hierarchyTasks = getTasksForHierarchyLevel(filteredTasks, currentTaskHierarchyLevel);
    var flatFiltered = flattenTasksForCalendar(hierarchyTasks);
    var searchValue = normalizeSearchText(taskSearchQuery);
    var searchedHierarchyTasks = filterTasksByTitleSearch(hierarchyTasks, searchValue);
    var splitTasks = splitTasksByAssignment(searchedHierarchyTasks);
    var assignedTasks = splitTasks.assigned;
    var unassignedTasks = splitTasks.unassigned;
    var todayStr = getTodayDateStr();
    var endOfWeekStr = getDateStrOffset(6);
    var hasTaskSearch = !!searchValue;
    var renderStandaloneRows = currentTaskHierarchyLevel !== "L1" || hasTaskSearch;

    if (scopeLabelEl) scopeLabelEl.textContent = getCurrentTaskScopeLabel(scopeMaps);
    var isAllScope = !currentDivisionIdForView && !currentGroupIdForView && !currentActivityIdForView && !currentTeamIdForView;
    var hasScopeMap = Object.keys(scopeMaps.divisions || {}).length > 0;
    if (tasksViewMode === "table" && isAllScope && taskList.length > 0 && !hasScopeMap && groupedScopeResolveRetries < 2) {
        groupedScopeResolveRetries += 1;
        renderSidebarNavTree(true);
        setTimeout(function () { loadTasks(); }, 220);
        return;
    }
    if (hasScopeMap) groupedScopeResolveRetries = 0;
    if (statTasksEl) statTasksEl.textContent = flatFiltered.length;
    if (statDueTodayEl) statDueTodayEl.textContent = flatFiltered.filter(function (t) {
        var d = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
        return d === todayStr;
    }).length;
    if (statDueWeekEl) statDueWeekEl.textContent = flatFiltered.filter(function (t) {
        var d = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
        return d >= todayStr && d <= endOfWeekStr;
    }).length;
    if (statDueMonthEl) statDueMonthEl.textContent = flatFiltered.filter(function (t) {
        var d = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
        return isDateInCurrentMonth(d);
    }).length;

    if (tbody) tbody.innerHTML = "";
    if (groupsEl) groupsEl.innerHTML = "";
    if (unassignedTbody) unassignedTbody.innerHTML = "";
    renderMilestonesTable();

    if (!filteredTasks.length) {
        lastLoadedTasks = [];
        refreshDependencyTaskSelectors();
        if (tableCard) tableCard.hidden = tasksViewMode === "calendar";
        if (groupsEl) groupsEl.hidden = true;
        if (unassignedCard) unassignedCard.hidden = true;
        if (milestonesCard) {
            milestonesCard.hidden = tasksViewMode === "calendar";
            milestonesCard.style.display = tasksViewMode === "calendar" ? "none" : "";
        }
        if (emptyEl) setEmptyStateMessage(emptyEl, "No tasks yet", "No tasks for the selected scope yet.");
        if (tasksViewMode === "calendar") renderCalendarView([]);
        populateMilestoneTaskParentLevel1Options("");
        populateMilestoneTaskParentLevel2Options("", "");
        renderQuickNavTabs();
        return;
    }

    if (emptyEl) emptyEl.hidden = true;
    lastLoadedTasks = filteredTasks;
    refreshDependencyTaskSelectors();
    populateMilestoneTaskParentLevel1Options(document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "");
    populateMilestoneTaskParentLevel2Options(document.getElementById("milestone-task-parent-level-1") ? document.getElementById("milestone-task-parent-level-1").value : "", document.getElementById("milestone-task-parent-level-2") ? document.getElementById("milestone-task-parent-level-2").value : "");

    if (tasksViewMode === "calendar") {
        if (tableCard) {
            tableCard.hidden = true;
            tableCard.style.display = "none";
        }
        if (groupsEl) {
            groupsEl.hidden = true;
            groupsEl.style.display = "none";
        }
        if (unassignedCard) {
            unassignedCard.hidden = true;
            unassignedCard.style.display = "none";
        }
        if (milestonesCard) {
            milestonesCard.hidden = true;
            milestonesCard.style.display = "none";
        }
        renderCalendarView(hierarchyTasks);
        renderQuickNavTabs();
        return;
    }

    if (unassignedCard) {
        unassignedCard.hidden = unassignedTasks.length === 0;
        unassignedCard.style.display = unassignedTasks.length === 0 ? "none" : "";
    }
    if (milestonesCard) {
        milestonesCard.hidden = false;
        milestonesCard.style.display = "";
    }
    if (unassignedTbody) {
        unassignedTbody.innerHTML = renderTasksTableMarkup(unassignedTasks, {
            standalone: true,
            showHierarchyContext: currentTaskHierarchyLevel !== "L1"
        });
    }
    if (unassignedEmptyEl) unassignedEmptyEl.hidden = unassignedTasks.length > 0;

    if (groupsEl) {
        groupsEl.hidden = assignedTasks.length === 0;
        groupsEl.style.display = assignedTasks.length === 0 ? "none" : "";
    }

    var showGroupedTables = !currentDivisionIdForView && !currentGroupIdForView && !currentActivityIdForView && !currentTeamIdForView;
    if (showGroupedTables) {
        if (tableCard) tableCard.hidden = true;
        if (tableCard) tableCard.style.display = "none";
        var grouped = {};
        assignedTasks.forEach(function (task) {
            var info = getTaskScopeInfo(task, scopeMaps);
            var key = String(info.activity_id || "activity-unknown");
            if (!grouped[key]) grouped[key] = { info: info, tasks: [] };
            grouped[key].tasks.push(task);
        });
        if (groupsEl) {
            groupsEl.innerHTML = Object.keys(grouped).map(function (key) {
                var group = grouped[key];
                var title = formatActivityProjectName(group.info.activity_name || "Untitled", group.info.activity_type);
                var meta = "Division: " + (group.info.division_name || "-") + " | Group: " + (group.info.group_name || "-") + " | " + getActivityProjectLabel(group.info.activity_type) + ": " + (group.info.activity_name || "-");
                return (
                    "<section class=\"task-group-card\">" +
                    "<div class=\"task-group-head\"><h3 class=\"task-group-title\">" + escapeHtml(title) + "</h3><p class=\"task-group-meta\">" + escapeHtml(meta) + "</p></div>" +
                    "<div class=\"table-wrap table-wrap--scrollable\"><table class=\"data-table\"><thead><tr><th class=\"col-task\">Task</th><th>Assigned</th><th class=\"col-type\">Type</th><th>Priority</th><th>Status</th><th class=\"col-due\">Due</th><th class=\"col-days-left\">Days left</th><th class=\"col-ext\">Extension</th><th class=\"col-actions\">Actions</th></tr></thead><tbody>" + renderTasksTableMarkup(group.tasks, { showTeamNameInTask: true, standalone: renderStandaloneRows, showHierarchyContext: currentTaskHierarchyLevel !== "L1" }) + "</tbody></table></div>" +
                    "</section>"
                );
            }).join("");
        }
        if (assignedTasks.length === 0 && unassignedTasks.length === 0 && emptyEl) {
            setEmptyStateMessage(emptyEl, "No matching tasks", "Try another keyword or clear the search.");
        }
        renderQuickNavTabs();
        return;
    }

    if (groupsEl) groupsEl.innerHTML = "";
    if (tableCard) {
        tableCard.hidden = assignedTasks.length === 0;
        tableCard.style.display = assignedTasks.length === 0 ? "none" : "";
    }
    if (tbody) {
        tbody.innerHTML = renderTasksTableMarkup(assignedTasks, {
            standalone: renderStandaloneRows,
            showHierarchyContext: currentTaskHierarchyLevel !== "L1"
        });
    }
    if (assignedTasks.length === 0 && unassignedTasks.length === 0 && emptyEl) {
        setEmptyStateMessage(emptyEl, "No matching tasks", "Try another keyword or clear the search.");
    }
    renderQuickNavTabs();
}

function loadTasks() {
    var params = [];
    var status = getFilterStatus();
    var assignedTo = getFilterAssigned();
    if (status) params.push("status=" + encodeURIComponent(status));
    if (assignedTo) params.push("assigned_to=" + assignedTo);
    var url = "/tasks" + (params.length ? "?" + params.join("&") : "");

    apiRequest(url, "GET")
        .then(function (tasks) {
            lastFetchedTaskRows = Array.isArray(tasks) ? tasks : [];
            renderTasksFromRows(lastFetchedTaskRows);
        })
        .catch(function (err) {
            lastFetchedTaskRows = [];
            var tbody = document.getElementById("task-table");
            var groupsEl = document.getElementById("tasks-table-groups");
            var unassignedCard = document.getElementById("unassigned-tasks-card");
            var unassignedTbody = document.getElementById("unassigned-task-table");
            var milestonesCard = document.getElementById("milestones-card");
            var statTasksEl = document.getElementById("stat-tasks");
            var statDueTodayEl = document.getElementById("stat-due-today");
            var statDueWeekEl = document.getElementById("stat-due-week");
            var statDueMonthEl = document.getElementById("stat-due-month");
            if (tbody) tbody.innerHTML = "";
            if (groupsEl) groupsEl.innerHTML = "";
            if (unassignedTbody) unassignedTbody.innerHTML = "";
            if (unassignedCard) unassignedCard.hidden = true;
            if (milestonesCard) milestonesCard.hidden = false;
            renderMilestonesTable();
            if (statTasksEl) statTasksEl.textContent = "0";
            if (statDueTodayEl) statDueTodayEl.textContent = "0";
            if (statDueWeekEl) statDueWeekEl.textContent = "0";
            if (statDueMonthEl) statDueMonthEl.textContent = "0";
            var emptyEl = document.getElementById("tasks-empty");
            if (emptyEl) setEmptyStateMessage(emptyEl, "Error loading tasks", err.message || "Try again later.");
            renderQuickNavTabs();
            showToast(err.message || "Failed to load tasks", true);
        });
}

// ---------- History (header dropdown + modal) ----------
var historyModalMode = null; // "activity" | "task" | "member"
var historyDropdownClickHandler = null;
var historyRefreshIntervalId = null;
// Refresh history fairly quickly so it feels real-time, similar to chat.
// 3000ms = 3 seconds.
var HISTORY_POLL_INTERVAL_MS = 3000;
var historyHierarchyTree = [];

function toggleHistoryDropdown() {
    var dd = document.getElementById("history-dropdown");
    var btn = document.getElementById("history-btn");
    if (!dd || !btn) return;
    var wasOpen = !dd.hidden;
    dd.hidden = wasOpen;  // close if was open, open if was closed
    btn.setAttribute("aria-expanded", dd.hidden ? "false" : "true");
    if (wasOpen && historyDropdownClickHandler) {
        document.removeEventListener("click", historyDropdownClickHandler);
        historyDropdownClickHandler = null;
    } else if (!wasOpen) {
        historyDropdownClickHandler = function (e) {
            if (dd && !dd.contains(e.target) && btn && !btn.contains(e.target)) {
                dd.hidden = true;
                btn.setAttribute("aria-expanded", "false");
                document.removeEventListener("click", historyDropdownClickHandler);
                historyDropdownClickHandler = null;
            }
        };
        setTimeout(function () { document.addEventListener("click", historyDropdownClickHandler); }, 0);
    }
}

function openHistoryModal(mode) {
    var dd = document.getElementById("history-dropdown");
    if (dd) dd.hidden = true;
    var btn = document.getElementById("history-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (historyDropdownClickHandler) {
        document.removeEventListener("click", historyDropdownClickHandler);
        historyDropdownClickHandler = null;
    }

    historyModalMode = mode;
    var titleEl = document.getElementById("history-modal-title");
    var entityLabel = document.getElementById("history-entity-label");
    var teamSel = document.getElementById("history-team-select");
    var entitySel = document.getElementById("history-entity-select");
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var loadingEl = document.getElementById("history-modal-loading");
    var emptyEl = document.getElementById("history-modal-empty");

    if (mode === "activity") {
        if (titleEl) titleEl.textContent = "Activity / Project History";
        if (entityLabel) entityLabel.textContent = "Activity / Project";
    } else if (mode === "task") {
        if (titleEl) titleEl.textContent = "Task History";
        if (entityLabel) entityLabel.textContent = "Task";
    } else {
        if (titleEl) titleEl.textContent = "Member History";
        if (entityLabel) entityLabel.textContent = "Member";
    }

    if (teamSel) {
        teamSel.innerHTML = "";
        addOption(teamSel, "", "Select team", false);
        (userTeamOptionsForHistory || []).forEach(function (t) {
            addOption(teamSel, t.id, t.name, false);
        });
        teamSel.value = "";
    }
    if (entitySel) {
        entitySel.innerHTML = "";
        addOption(entitySel, "", "Select " + (mode === "activity" ? "activity or project" : mode === "task" ? "task" : "member"), false);
        entitySel.value = "";
    }
    if (hintEl) { hintEl.hidden = false; }
    if (listEl) { listEl.hidden = true; listEl.innerHTML = ""; }
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;

    // Show Clear History button only for admin/division head
    var clearBtn = document.getElementById("history-clear-btn");
    if (clearBtn) {
        var role = (localStorage.getItem("role") || "").toLowerCase();
        var isAdmin = role === "admin" || role === "division head";
        clearBtn.hidden = !isAdmin;
    }

    if (!teamSel._historyBound) {
        teamSel._historyBound = true;
        teamSel.addEventListener("change", function () {
            onHistoryTeamChange();
        });
    }
    if (!entitySel._historyBound) {
        entitySel._historyBound = true;
        entitySel.addEventListener("change", function () {
            onHistoryEntityChange();
        });
    }

    var modal = document.getElementById("history-modal");
    if (modal) modal.hidden = false;
}

function onHistoryTeamChange() {
    var teamId = document.getElementById("history-team-select").value;
    var entitySel = document.getElementById("history-entity-select");
    if (!entitySel) return;
    entitySel.innerHTML = "";
    addOption(entitySel, "", "Select " + (historyModalMode === "activity" ? "activity or project" : historyModalMode === "task" ? "task" : "member"), false);
    entitySel.value = "";
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var emptyEl = document.getElementById("history-modal-empty");
    if (hintEl) hintEl.hidden = false;
    if (listEl) { listEl.hidden = true; listEl.innerHTML = ""; }
    if (emptyEl) emptyEl.hidden = true;

    if (!teamId) return;

    if (historyModalMode === "activity") {
        apiRequest("/teams/" + teamId + "/activities", "GET")
            .then(function (activities) {
                var list = Array.isArray(activities) ? activities : [];
                list.forEach(function (a) {
                    addOption(entitySel, a.id, formatActivityProjectName(a.name || ("Untitled " + getActivityProjectLabel(a.type)), a.type), false);
                });
                if (list.length === 0) addOption(entitySel, "", "No activities/projects", false);
            })
            .catch(function () { addOption(entitySel, "", "Failed to load", false); });
    } else if (historyModalMode === "task") {
        apiRequest("/tasks?team_id=" + teamId, "GET")
            .then(function (tasks) {
                var list = Array.isArray(tasks) ? tasks : [];
                list.forEach(function (t) {
                    var label = (t.title || "Task " + t.id);
                    if (label.length > 50) label = label.slice(0, 47) + "…";
                    addOption(entitySel, t.id, label, false);
                });
                if (list.length === 0) addOption(entitySel, "", "No tasks", false);
            })
            .catch(function () { addOption(entitySel, "", "Failed to load", false); });
    } else {
        apiRequest("/teams/" + teamId + "/members?include_membership_id=true", "GET")
            .then(function (members) {
                var list = Array.isArray(members) ? members : [];
                list.forEach(function (m) {
                    var label = formatUserOptionLabel(m, "User " + m.id) + " (" + (m.role || "Member") + ")";
                    var id = m.membership_id != null ? m.membership_id : m.id;
                    addOption(entitySel, id, label, false);
                });
                if (list.length === 0) addOption(entitySel, "", "No members", false);
            })
            .catch(function () { addOption(entitySel, "", "Failed to load", false); });
    }
}

function renderHistoryList(logs, listEl, emptyEl) {
    if (!listEl) return;
    var list = Array.isArray(logs) ? logs : [];
    if (list.length === 0) {
        listEl.hidden = true;
        listEl.innerHTML = "";
        if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = "No history found."; }
        return;
    }
    if (emptyEl) emptyEl.hidden = true;
    
    // Parse timestamps and create sortable array
    var sortedList = list.map(function(log) {
        var ts = log.timestamp ? String(log.timestamp) : "";
        var sortTime = 0;
        var dateObj = null;
        
        if (ts) {
            // Parse timestamp using same logic as activity chat (formatBackendDateTimeToLocal)
            var str = String(ts);
            var isIsoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
            var hasTimezone = /[zZ]$/.test(str) || /[+\-]\d{2}:?\d{2}$/.test(str);
            
            if (isIsoLike && !hasTimezone) {
                // Treat naive backend timestamps as UTC
                dateObj = new Date(str + "Z");
            } else {
                dateObj = new Date(str);
            }
            
            if (!isNaN(dateObj.getTime())) {
                sortTime = dateObj.getTime();
            }
        }
        
        return {
            log: log,
            sortTime: sortTime,
            dateObj: dateObj
        };
    });
    
    // Sort by timestamp DESCENDING (newest first) - larger timestamp = newer
    sortedList.sort(function (a, b) {
        return b.sortTime - a.sortTime; // DESC: newest (larger time) first
    });
    
    // Render in sorted order (newest at top) - use same timezone formatting as activity chat
    var html = sortedList.map(function (item) {
        var log = item.log;
        var d = item.dateObj;
        var datePart = "";
        var timePart = "";
        
        if (d && !isNaN(d.getTime())) {
            // Use same timezone conversion as activity chat
            // formatBackendDateTimeToLocal treats naive timestamps as UTC, then formats in browser's local timezone
            // Since activity chat works correctly, we use the same approach: format in browser's local timezone
            // For India, browser should be set to IST, so getDate(), getHours() return IST values
            // Format as DD/MM/YYYY HH:mm:ss
            var day = String(d.getDate()).padStart(2, "0");
            var month = String(d.getMonth() + 1).padStart(2, "0");
            var year = d.getFullYear();
            var hour = String(d.getHours()).padStart(2, "0");
            var minute = String(d.getMinutes()).padStart(2, "0");
            var second = String(d.getSeconds()).padStart(2, "0");
            datePart = day + "/" + month + "/" + year;
            timePart = hour + ":" + minute + ":" + second;
        }
        
        var actor = log.username ? renderUserLabelHtml(log.username, log.designation, "User") : (log.user_id ? ("User " + log.user_id) : "System");
        var action = escapeHtml(log.action || "");
        return "<li><span class=\"history-time\">" + datePart + " " + timePart + "</span><span class=\"history-action\">" + action + "</span><span class=\"history-actor\">— " + actor + "</span></li>";
    }).join("");
    
    listEl.innerHTML = html;
    listEl.hidden = false;
}

function refreshHistoryIfOpen() {
    var modal = document.getElementById("history-modal");
    var entitySel = document.getElementById("history-entity-select");
    if (!modal || modal.hidden || !entitySel || !entitySel.value) return;
    var entityId = entitySel.value;
    var entityType = historyModalMode === "activity" ? "Activity" : historyModalMode === "task" ? "Task" : "TeamMember";
    var listEl = document.getElementById("history-modal-list");
    var emptyEl = document.getElementById("history-modal-empty");
    apiRequest("/activity?entity_type=" + encodeURIComponent(entityType) + "&entity_id=" + encodeURIComponent(entityId), "GET")
        .then(function (logs) {
            renderHistoryList(logs, listEl, emptyEl);
        })
        .catch(function () { /* keep current list on poll error */ });
}

function startHistoryPolling() {
    stopHistoryPolling();
    historyRefreshIntervalId = setInterval(refreshHistoryIfOpen, HISTORY_POLL_INTERVAL_MS);
}

function stopHistoryPolling() {
    if (historyRefreshIntervalId) {
        clearInterval(historyRefreshIntervalId);
        historyRefreshIntervalId = null;
    }
}

function onHistoryEntityChange() {
    var entityId = document.getElementById("history-entity-select").value;
    var clearBtn = document.getElementById("history-clear-btn");
    if (clearBtn) {
        var role = (localStorage.getItem("role") || "").toLowerCase();
        var isAdmin = role === "admin" || role === "division head";
        clearBtn.hidden = !isAdmin || !entityId;
    }
    if (!entityId) {
        stopHistoryPolling();
        return;
    }
    var entityType = historyModalMode === "activity" ? "Activity" : historyModalMode === "task" ? "Task" : "TeamMember";
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var loadingEl = document.getElementById("history-modal-loading");
    var emptyEl = document.getElementById("history-modal-empty");
    if (hintEl) hintEl.hidden = true;
    if (listEl) { listEl.hidden = true; listEl.innerHTML = ""; }
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;

    stopHistoryPolling();

    apiRequest("/activity?entity_type=" + encodeURIComponent(entityType) + "&entity_id=" + encodeURIComponent(entityId), "GET")
        .then(function (logs) {
            if (loadingEl) loadingEl.hidden = true;
            renderHistoryList(logs, listEl, emptyEl);
            startHistoryPolling();
        })
        .catch(function (err) {
            if (loadingEl) loadingEl.hidden = true;
            stopHistoryPolling();
            if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = err.message || "Failed to load history."; }
        });
}

function clearHistoryForEntity() {
    var entitySel = document.getElementById("history-entity-select");
    if (!entitySel || !entitySel.value) {
        showToast("Select an item to clear its history", true);
        return;
    }
    var entityId = entitySel.value;
    var entityType = historyModalMode === "activity" ? "Activity" : historyModalMode === "task" ? "Task" : "TeamMember";
    var entityName = entitySel.options[entitySel.selectedIndex] ? entitySel.options[entitySel.selectedIndex].textContent : "";
    
    var confirmMsg = "Are you sure you want to permanently delete all history for " + entityName + "?\n\nThis action cannot be undone.";
    if (!confirm(confirmMsg)) return;

    apiRequest("/activity?entity_type=" + encodeURIComponent(entityType) + "&entity_id=" + encodeURIComponent(entityId), "DELETE")
        .then(function () {
            showToast("History cleared");
            // Refresh the history list (should be empty now)
            onHistoryEntityChange();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to clear history", true);
        });
}

function closeHistoryModal() {
    var modal = document.getElementById("history-modal");
    if (modal) modal.hidden = true;
    stopHistoryPolling();
}

function resetHistorySelect(selectEl, placeholder, disabled) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    addOption(selectEl, "", placeholder, true);
    selectEl.value = "";
    selectEl.disabled = !!disabled;
}

function ensureHistoryHierarchyLoaded() {
    if (Array.isArray(_sidebarNavTreeCache) && _sidebarNavTreeCache.length > 0) {
        return Promise.resolve(_sidebarNavTreeCache);
    }
    return apiRequest("/nav/tree", "GET").then(function (tree) {
        _sidebarNavTreeCache = Array.isArray(tree) ? tree : [];
        return _sidebarNavTreeCache;
    });
}

function clearHistoryListState() {
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var loadingEl = document.getElementById("history-modal-loading");
    var emptyEl = document.getElementById("history-modal-empty");
    if (hintEl) hintEl.hidden = false;
    if (listEl) {
        listEl.hidden = true;
        listEl.innerHTML = "";
    }
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    stopHistoryPolling();
}

function populateHistoryDivisionOptions() {
    var divisionSel = document.getElementById("history-division-select");
    resetHistorySelect(divisionSel, "Select division", false);
    (historyHierarchyTree || []).forEach(function (division) {
        addOption(divisionSel, division.id, division.name, false);
    });
    resetHistorySelect(document.getElementById("history-group-select"), "Select division first", true);
    resetHistorySelect(document.getElementById("history-activity-select"), "Select group first", true);
    resetHistorySelect(document.getElementById("history-team-select"), "Select activity / project first", true);
    resetHistorySelect(document.getElementById("history-entity-select"), getHistoryEntityPlaceholder(), true);
    resetHistoryTaskCascade();
    clearHistoryListState();
}

function getHistorySelectedDivision() {
    var divisionId = parseInt((document.getElementById("history-division-select") || {}).value, 10);
    if (!divisionId) return null;
    for (var i = 0; i < historyHierarchyTree.length; i++) {
        if (historyHierarchyTree[i].id === divisionId) return historyHierarchyTree[i];
    }
    return null;
}

function getHistorySelectedGroup() {
    var division = getHistorySelectedDivision();
    var groupId = parseInt((document.getElementById("history-group-select") || {}).value, 10);
    if (!division || !groupId) return null;
    var groups = Array.isArray(division.groups) ? division.groups : [];
    for (var i = 0; i < groups.length; i++) {
        if (groups[i].id === groupId) return groups[i];
    }
    return null;
}

function getHistorySelectedActivity() {
    var group = getHistorySelectedGroup();
    var activityId = parseInt((document.getElementById("history-activity-select") || {}).value, 10);
    if (!group || !activityId) return null;
    var activities = Array.isArray(group.activities) ? group.activities : [];
    for (var i = 0; i < activities.length; i++) {
        if (activities[i].id === activityId) return activities[i];
    }
    return null;
}

function parseBackendDateTime(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    var str = String(value);
    var isIsoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
    var hasTimezone = /[zZ]$/.test(str) || /[+\-]\d{2}:?\d{2}$/.test(str);
    var date = isIsoLike && !hasTimezone ? parseNaiveBackendDateTimeAsIndia(str) : new Date(str);
    return isNaN(date.getTime()) ? null : date;
}

function formatBackendDateTimeToIndia(value) {
    var date = parseBackendDateTime(value);
    if (!date) return "";
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).format(date) + " IST";
}

function getHistoryEntityPlaceholder() {
    if (historyModalMode === "task") return "Select task";
    if (historyModalMode === "member") return "Select member";
    return "Select activity / project";
}

function getHistoryTaskOptions(taskList, depth, lineage) {
    var options = [];
    var currentDepth = depth || 0;
    var currentLineage = Array.isArray(lineage) ? lineage.slice() : [];
    (taskList || []).forEach(function (task) {
        if (!task) return;
        var title = String(task.title || ("Task " + task.id));
        var prefix = "";
        if (currentDepth > 0) {
            prefix = new Array(currentDepth + 1).join("-> ");
        }
        var lineageLabel = currentLineage.length > 0 ? (" (" + currentLineage.join(" / ") + ")") : "";
        options.push({
            id: task.id,
            label: prefix + title + lineageLabel
        });
        if (task.subtasks && task.subtasks.length > 0) {
            Array.prototype.push.apply(options, getHistoryTaskOptions(task.subtasks, currentDepth + 1, currentLineage.concat([title])));
        }
    });
    return options;
}

function resetHistoryTaskCascade() {
    historyTaskTree = [];
    resetHistorySelect(document.getElementById("history-task-level-1"), "Select parent task", true);
    resetHistorySelect(document.getElementById("history-task-level-2"), "Select parent task first", true);
    resetHistorySelect(document.getElementById("history-task-level-3"), "Select subtask first", true);
}

function populateHistoryTaskLevel(selectEl, tasks, placeholder) {
    resetHistorySelect(selectEl, placeholder, !(tasks && tasks.length));
    (tasks || []).forEach(function (task) {
        addOption(selectEl, task.id, task.title || ("Task " + task.id), false);
    });
}

function findTaskByIdForHistory(taskList, taskId) {
    var numericId = parseInt(taskId, 10);
    if (!numericId) return null;
    for (var i = 0; i < (taskList || []).length; i++) {
        var task = taskList[i];
        if (!task) continue;
        if (task.id === numericId) return task;
        var nested = findTaskByIdForHistory(task.subtasks || [], numericId);
        if (nested) return nested;
    }
    return null;
}

function onHistoryTaskLevel1Change() {
    var level1Sel = document.getElementById("history-task-level-1");
    var task = findTaskByIdForHistory(historyTaskTree, level1Sel && level1Sel.value);
    populateHistoryTaskLevel(document.getElementById("history-task-level-2"), task && task.subtasks ? task.subtasks : [], task ? "Select subtask" : "Select parent task first");
    resetHistorySelect(document.getElementById("history-task-level-3"), "Select subtask first", true);
    clearHistoryListState();
    loadHistoryForCurrentSelection();
}

function onHistoryTaskLevel2Change() {
    var level2Sel = document.getElementById("history-task-level-2");
    var task = findTaskByIdForHistory(historyTaskTree, level2Sel && level2Sel.value);
    populateHistoryTaskLevel(document.getElementById("history-task-level-3"), task && task.subtasks ? task.subtasks : [], task ? "Select sub-subtask" : "Select subtask first");
    clearHistoryListState();
    loadHistoryForCurrentSelection();
}

function onHistoryTaskLevel3Change() {
    clearHistoryListState();
    loadHistoryForCurrentSelection();
}

function getCurrentHistoryEntitySelection() {
    if (historyModalMode === "activity") {
        var activitySel = document.getElementById("history-activity-select");
        return activitySel && activitySel.value ? {
            entityType: "Activity",
            entityId: activitySel.value,
            entityName: activitySel.options[activitySel.selectedIndex] ? activitySel.options[activitySel.selectedIndex].textContent : ""
        } : null;
    }
    if (historyModalMode === "task") {
        var level3Sel = document.getElementById("history-task-level-3");
        var level2Sel = document.getElementById("history-task-level-2");
        var level1Sel = document.getElementById("history-task-level-1");
        var chosenSel = level3Sel && level3Sel.value ? level3Sel : (level2Sel && level2Sel.value ? level2Sel : (level1Sel && level1Sel.value ? level1Sel : null));
        return chosenSel ? {
            entityType: "Task",
            entityId: chosenSel.value,
            entityName: chosenSel.options[chosenSel.selectedIndex] ? chosenSel.options[chosenSel.selectedIndex].textContent : ""
        } : null;
    }
    var entitySel = document.getElementById("history-entity-select");
    if (!entitySel || !entitySel.value) return null;
    return {
        entityType: historyModalMode === "task" ? "Task" : "TeamMember",
        entityId: entitySel.value,
        entityName: entitySel.options[entitySel.selectedIndex] ? entitySel.options[entitySel.selectedIndex].textContent : ""
    };
}

function loadHistoryForCurrentSelection() {
    var selection = getCurrentHistoryEntitySelection();
    var clearBtn = document.getElementById("history-clear-btn");
    if (clearBtn) {
        var role = (localStorage.getItem("role") || "").toLowerCase();
        var isAdmin = role === "admin" || role === "division head";
        clearBtn.hidden = !isAdmin || !selection;
    }
    if (!selection) {
        stopHistoryPolling();
        return;
    }
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var loadingEl = document.getElementById("history-modal-loading");
    var emptyEl = document.getElementById("history-modal-empty");
    if (hintEl) hintEl.hidden = true;
    if (listEl) {
        listEl.hidden = true;
        listEl.innerHTML = "";
    }
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    stopHistoryPolling();
    apiRequest("/activity?entity_type=" + encodeURIComponent(selection.entityType) + "&entity_id=" + encodeURIComponent(selection.entityId), "GET")
        .then(function (logs) {
            if (loadingEl) loadingEl.hidden = true;
            renderHistoryList(logs, listEl, emptyEl);
            startHistoryPolling();
        })
        .catch(function (err) {
            if (loadingEl) loadingEl.hidden = true;
            stopHistoryPolling();
            if (emptyEl) {
                emptyEl.hidden = false;
                emptyEl.textContent = err.message || "Failed to load history.";
            }
        });
}

function openHistoryModal(mode) {
    var dd = document.getElementById("history-dropdown");
    if (dd) dd.hidden = true;
    var btn = document.getElementById("history-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (historyDropdownClickHandler) {
        document.removeEventListener("click", historyDropdownClickHandler);
        historyDropdownClickHandler = null;
    }

    historyModalMode = mode;
    var titleEl = document.getElementById("history-modal-title");
    var entityLabel = document.getElementById("history-entity-label");
    var divisionSel = document.getElementById("history-division-select");
    var groupSel = document.getElementById("history-group-select");
    var activitySel = document.getElementById("history-activity-select");
    var teamSel = document.getElementById("history-team-select");
    var entitySel = document.getElementById("history-entity-select");
    var teamGroup = document.getElementById("history-team-group");
    var entityGroup = document.getElementById("history-entity-group");
    var taskCascade = document.getElementById("history-task-cascade");
    var emptyEl = document.getElementById("history-modal-empty");

    if (mode === "activity") {
        if (titleEl) titleEl.textContent = "Activity / Project History";
        if (entityLabel) entityLabel.textContent = "Activity / Project";
    } else if (mode === "task") {
        if (titleEl) titleEl.textContent = "Task History";
        if (entityLabel) entityLabel.textContent = "Task";
    } else {
        if (titleEl) titleEl.textContent = "Member History";
        if (entityLabel) entityLabel.textContent = "Member";
    }

    if (teamGroup) teamGroup.style.display = mode === "activity" ? "none" : "";
    if (entityGroup) entityGroup.style.display = mode === "activity" || mode === "task" ? "none" : "";
    if (taskCascade) taskCascade.hidden = mode !== "task";
    resetHistorySelect(divisionSel, "Select division", false);
    resetHistorySelect(groupSel, "Select division first", true);
    resetHistorySelect(activitySel, "Select group first", true);
    resetHistorySelect(teamSel, "Select activity / project first", true);
    resetHistorySelect(entitySel, getHistoryEntityPlaceholder(), true);
    resetHistoryTaskCascade();
    clearHistoryListState();

    var clearBtn = document.getElementById("history-clear-btn");
    if (clearBtn) {
        var role = (localStorage.getItem("role") || "").toLowerCase();
        clearBtn.hidden = !(role === "admin" || role === "division head");
    }

    if (divisionSel && !divisionSel._historyBound2) {
        divisionSel._historyBound2 = true;
        divisionSel.addEventListener("change", onHistoryDivisionChange);
    }
    if (groupSel && !groupSel._historyBound2) {
        groupSel._historyBound2 = true;
        groupSel.addEventListener("change", onHistoryGroupChange);
    }
    if (activitySel && !activitySel._historyBound2) {
        activitySel._historyBound2 = true;
        activitySel.addEventListener("change", onHistoryActivityChange);
    }
    if (teamSel && !teamSel._historyBound2) {
        teamSel._historyBound2 = true;
        teamSel.addEventListener("change", onHistoryTeamChange);
    }
    if (entitySel && !entitySel._historyBound2) {
        entitySel._historyBound2 = true;
        entitySel.addEventListener("change", onHistoryEntityChange);
    }
    var taskLevel1Sel = document.getElementById("history-task-level-1");
    var taskLevel2Sel = document.getElementById("history-task-level-2");
    var taskLevel3Sel = document.getElementById("history-task-level-3");
    if (taskLevel1Sel && !taskLevel1Sel._historyBound2) {
        taskLevel1Sel._historyBound2 = true;
        taskLevel1Sel.addEventListener("change", onHistoryTaskLevel1Change);
    }
    if (taskLevel2Sel && !taskLevel2Sel._historyBound2) {
        taskLevel2Sel._historyBound2 = true;
        taskLevel2Sel.addEventListener("change", onHistoryTaskLevel2Change);
    }
    if (taskLevel3Sel && !taskLevel3Sel._historyBound2) {
        taskLevel3Sel._historyBound2 = true;
        taskLevel3Sel.addEventListener("change", onHistoryTaskLevel3Change);
    }

    var modal = document.getElementById("history-modal");
    if (modal) modal.hidden = false;
    ensureHistoryHierarchyLoaded().then(function (tree) {
        historyHierarchyTree = Array.isArray(tree) ? tree : [];
        populateHistoryDivisionOptions();
    }).catch(function () {
        if (emptyEl) {
            emptyEl.hidden = false;
            emptyEl.textContent = "Failed to load history hierarchy.";
        }
    });
}

function onHistoryDivisionChange() {
    var division = getHistorySelectedDivision();
    var groupSel = document.getElementById("history-group-select");
    resetHistorySelect(groupSel, division ? "Select group" : "Select division first", !division);
    resetHistorySelect(document.getElementById("history-activity-select"), "Select group first", true);
    resetHistorySelect(document.getElementById("history-team-select"), "Select activity / project first", true);
    resetHistorySelect(document.getElementById("history-entity-select"), getHistoryEntityPlaceholder(), true);
    resetHistoryTaskCascade();
    clearHistoryListState();
    if (!division) return;
    (division.groups || []).forEach(function (group) {
        addOption(groupSel, group.id, group.name, false);
    });
}

function onHistoryGroupChange() {
    var group = getHistorySelectedGroup();
    var activitySel = document.getElementById("history-activity-select");
    resetHistorySelect(activitySel, group ? "Select activity / project" : "Select group first", !group);
    resetHistorySelect(document.getElementById("history-team-select"), "Select activity / project first", true);
    resetHistorySelect(document.getElementById("history-entity-select"), getHistoryEntityPlaceholder(), true);
    resetHistoryTaskCascade();
    clearHistoryListState();
    if (!group) return;
    (group.activities || []).forEach(function (activity) {
        addOption(activitySel, activity.id, formatActivityProjectName(activity.name, activity.type), false);
    });
}

function onHistoryActivityChange() {
    var activity = getHistorySelectedActivity();
    var teamSel = document.getElementById("history-team-select");
    var entitySel = document.getElementById("history-entity-select");
    resetHistorySelect(teamSel, activity ? "Select team" : "Select activity / project first", !activity || historyModalMode === "activity");
    resetHistorySelect(entitySel, getHistoryEntityPlaceholder(), true);
    resetHistoryTaskCascade();
    clearHistoryListState();
    if (!activity) return;
    if (historyModalMode === "activity") {
        loadHistoryForCurrentSelection();
        return;
    }
    (activity.teams || []).forEach(function (team) {
        addOption(teamSel, team.id, team.name, false);
    });
}

function onHistoryTeamChange() {
    var teamId = document.getElementById("history-team-select").value;
    var entitySel = document.getElementById("history-entity-select");
    resetHistorySelect(entitySel, getHistoryEntityPlaceholder(), !teamId);
    resetHistoryTaskCascade();
    clearHistoryListState();
    if (!teamId) return;

    if (historyModalMode === "task") {
        apiRequest("/tasks?team_id=" + teamId, "GET")
            .then(function (tasks) {
                var list = Array.isArray(tasks) ? tasks : [];
                historyTaskTree = list;
                populateHistoryTaskLevel(document.getElementById("history-task-level-1"), list, "Select parent task");
            })
            .catch(function () {
                historyTaskTree = [];
                populateHistoryTaskLevel(document.getElementById("history-task-level-1"), [], "Failed to load tasks");
            });
        return;
    }

    apiRequest("/teams/" + teamId + "/members?include_membership_id=true", "GET")
        .then(function (members) {
            var list = Array.isArray(members) ? members : [];
            list.sort(function (a, b) {
                return formatUserOptionLabel(a, "User " + a.id).localeCompare(formatUserOptionLabel(b, "User " + b.id), undefined, { sensitivity: "base" });
            });
            list.forEach(function (m) {
                var label = formatUserOptionLabel(m, "User " + m.id) + " (" + (m.role || "Member") + ")";
                addOption(entitySel, m.membership_id != null ? m.membership_id : m.id, label, false);
            });
            entitySel.disabled = list.length === 0;
        })
        .catch(function () {
            addOption(entitySel, "", "Failed to load members", false);
            entitySel.disabled = true;
        });
}

function renderHistoryList(logs, listEl, emptyEl) {
    if (!listEl) return;
    var list = Array.isArray(logs) ? logs : [];
    if (list.length === 0) {
        listEl.hidden = true;
        listEl.innerHTML = "";
        if (emptyEl) {
            emptyEl.hidden = false;
            emptyEl.textContent = "No history found.";
        }
        return;
    }
    if (emptyEl) emptyEl.hidden = true;
    var sortedList = list.map(function (log) {
        var parsedDate = parseBackendDateTime(log.timestamp);
        return {
            log: log,
            sortTime: parsedDate ? parsedDate.getTime() : 0,
            sortId: parseInt(log && log.id, 10) || 0
        };
    });
    sortedList.sort(function (a, b) {
        if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime;
        return b.sortId - a.sortId;
    });
    listEl.innerHTML = sortedList.map(function (item) {
        var log = item.log;
        var actor = log.username ? renderUserLabelHtml(log.username, log.designation, "User") : (log.user_id ? ("User " + log.user_id) : "System");
        return "<li><span class=\"history-time\">" + escapeHtml(formatBackendDateTimeToIndia(log.timestamp)) + "</span><span class=\"history-action\">" + escapeHtml(log.action || "") + "</span><span class=\"history-actor\"> - " + actor + "</span></li>";
    }).join("");
    listEl.hidden = false;
}

function refreshHistoryIfOpen() {
    var modal = document.getElementById("history-modal");
    var selection = getCurrentHistoryEntitySelection();
    if (!modal || modal.hidden || !selection) return;
    var listEl = document.getElementById("history-modal-list");
    var emptyEl = document.getElementById("history-modal-empty");
    apiRequest("/activity?entity_type=" + encodeURIComponent(selection.entityType) + "&entity_id=" + encodeURIComponent(selection.entityId), "GET")
        .then(function (logs) {
            renderHistoryList(logs, listEl, emptyEl);
        })
        .catch(function () { });
}

function onHistoryEntityChange() {
    loadHistoryForCurrentSelection();
}

function clearHistoryForEntity() {
    var selection = getCurrentHistoryEntitySelection();
    if (!selection) {
        showToast("Select an item to clear its history", true);
        return;
    }
    var confirmMsg = "Are you sure you want to permanently delete all history for " + selection.entityName + "?\n\nThis action cannot be undone.";
    if (!confirm(confirmMsg)) return;
    apiRequest("/activity?entity_type=" + encodeURIComponent(selection.entityType) + "&entity_id=" + encodeURIComponent(selection.entityId), "DELETE")
        .then(function () {
            showToast("History cleared");
            loadHistoryForCurrentSelection();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to clear history", true);
        });
}

function closeHistoryModal() {
    var modal = document.getElementById("history-modal");
    if (modal) modal.hidden = true;
    stopHistoryPolling();
}

// History panel override: replaces dropdown + modal flow with a right sidebar.
var historyPanelOpen = false;
historyModalMode = historyModalMode || "member";

function getHistoryPanel() {
    return document.getElementById("history-panel");
}

function syncHistoryButtonState() {
    var btn = document.getElementById("history-btn");
    if (btn) btn.setAttribute("aria-expanded", historyPanelOpen ? "true" : "false");
}

function getHistoryPanelSubtitle(mode) {
    if (mode === "activity") return "Browse activity and project history from the hierarchy.";
    if (mode === "task") return "Browse task history from the selected team task tree.";
    return "Browse member history from the selected team.";
}

function bindHistoryPanelTabs() {
    ["member", "activity", "task"].forEach(function (tab) {
        var button = document.getElementById("history-tab-" + tab);
        if (!button || button._historyTabBound) return;
        button._historyTabBound = true;
        button.addEventListener("click", function () {
            switchHistoryPanelTab(tab);
        });
    });
}

function bindHistoryPanelControls() {
    var divisionSel = document.getElementById("history-division-select");
    var groupSel = document.getElementById("history-group-select");
    var activitySel = document.getElementById("history-activity-select");
    var teamSel = document.getElementById("history-team-select");
    var entitySel = document.getElementById("history-entity-select");
    var taskLevel1Sel = document.getElementById("history-task-level-1");
    var taskLevel2Sel = document.getElementById("history-task-level-2");
    var taskLevel3Sel = document.getElementById("history-task-level-3");

    if (divisionSel && !divisionSel._historyPanelBound) {
        divisionSel._historyPanelBound = true;
        divisionSel.addEventListener("change", onHistoryDivisionChange);
    }
    if (groupSel && !groupSel._historyPanelBound) {
        groupSel._historyPanelBound = true;
        groupSel.addEventListener("change", onHistoryGroupChange);
    }
    if (activitySel && !activitySel._historyPanelBound) {
        activitySel._historyPanelBound = true;
        activitySel.addEventListener("change", onHistoryActivityChange);
    }
    if (teamSel && !teamSel._historyPanelBound) {
        teamSel._historyPanelBound = true;
        teamSel.addEventListener("change", onHistoryTeamChange);
    }
    if (entitySel && !entitySel._historyPanelBound) {
        entitySel._historyPanelBound = true;
        entitySel.addEventListener("change", onHistoryEntityChange);
    }
    if (taskLevel1Sel && !taskLevel1Sel._historyPanelBound) {
        taskLevel1Sel._historyPanelBound = true;
        taskLevel1Sel.addEventListener("change", onHistoryTaskLevel1Change);
    }
    if (taskLevel2Sel && !taskLevel2Sel._historyPanelBound) {
        taskLevel2Sel._historyPanelBound = true;
        taskLevel2Sel.addEventListener("change", onHistoryTaskLevel2Change);
    }
    if (taskLevel3Sel && !taskLevel3Sel._historyPanelBound) {
        taskLevel3Sel._historyPanelBound = true;
        taskLevel3Sel.addEventListener("change", onHistoryTaskLevel3Change);
    }
}

function syncHistoryClearButton(selection) {
    var clearBtn = document.getElementById("history-clear-btn");
    if (!clearBtn) return;
    var role = (localStorage.getItem("role") || "").toLowerCase();
    var isAdmin = role === "admin" || role === "division head";
    clearBtn.hidden = !isAdmin || !selection;
}

function configureHistoryPanel(mode) {
    historyModalMode = mode || historyModalMode || "member";
    var titleEl = document.getElementById("history-modal-title");
    var subtitleEl = document.getElementById("history-panel-subtitle");
    var entityLabel = document.getElementById("history-entity-label");
    var teamGroup = document.getElementById("history-team-group");
    var entityGroup = document.getElementById("history-entity-group");
    var taskCascade = document.getElementById("history-task-cascade");

    if (titleEl) titleEl.textContent = "History";
    if (subtitleEl) subtitleEl.textContent = getHistoryPanelSubtitle(historyModalMode);
    if (entityLabel) {
        entityLabel.textContent = historyModalMode === "member" ? "Member" : historyModalMode === "task" ? "Task" : "Activity / Project";
    }
    if (teamGroup) teamGroup.style.display = historyModalMode === "activity" ? "none" : "";
    if (entityGroup) entityGroup.style.display = historyModalMode === "member" ? "" : "none";
    if (taskCascade) taskCascade.hidden = historyModalMode !== "task";

    ["member", "activity", "task"].forEach(function (tab) {
        var button = document.getElementById("history-tab-" + tab);
        if (!button) return;
        var isActive = tab === historyModalMode;
        button.classList.toggle("chat-tab--active", isActive);
        button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
}

function toggleHistoryPanel(forceOpen, mode) {
    if (typeof forceOpen === "boolean") historyPanelOpen = forceOpen;
    else historyPanelOpen = !historyPanelOpen;

    var panel = getHistoryPanel();
    if (!historyPanelOpen) {
        if (panel) panel.hidden = true;
        stopHistoryPolling();
        syncHistoryButtonState();
        return;
    }

    bindHistoryPanelTabs();
    bindHistoryPanelControls();
    configureHistoryPanel(mode || historyModalMode || "member");
    if (panel) panel.hidden = false;
    syncHistoryButtonState();

    ensureHistoryHierarchyLoaded().then(function (tree) {
        historyHierarchyTree = Array.isArray(tree) ? tree : [];
        populateHistoryDivisionOptions();
    }).catch(function () {
        var emptyEl = document.getElementById("history-modal-empty");
        if (emptyEl) {
            emptyEl.hidden = false;
            emptyEl.textContent = "Failed to load history hierarchy.";
        }
    });
}

function toggleHistoryDropdown() {
    toggleHistoryPanel();
}

function openHistoryModal(mode) {
    toggleHistoryPanel(true, mode || "member");
}

function closeHistoryModal() {
    toggleHistoryPanel(false);
}

function switchHistoryPanelTab(mode) {
    configureHistoryPanel(mode);
    populateHistoryDivisionOptions();
}

function clearHistoryListState() {
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var loadingEl = document.getElementById("history-modal-loading");
    var emptyEl = document.getElementById("history-modal-empty");
    if (hintEl) hintEl.hidden = false;
    if (listEl) {
        listEl.hidden = true;
        listEl.innerHTML = "";
    }
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    stopHistoryPolling();
    syncHistoryClearButton(null);
}

function refreshHistoryIfOpen() {
    var panel = getHistoryPanel();
    var selection = getCurrentHistoryEntitySelection();
    if (!panel || panel.hidden || !selection) return;
    var listEl = document.getElementById("history-modal-list");
    var emptyEl = document.getElementById("history-modal-empty");
    apiRequest("/activity?entity_type=" + encodeURIComponent(selection.entityType) + "&entity_id=" + encodeURIComponent(selection.entityId), "GET")
        .then(function (logs) {
            renderHistoryList(logs, listEl, emptyEl);
        })
        .catch(function () { });
}

function getCurrentHistoryEntitySelection() {
    if (historyModalMode === "activity") {
        var activitySel = document.getElementById("history-activity-select");
        return activitySel && activitySel.value ? {
            entityType: "Activity",
            entityId: activitySel.value,
            entityName: activitySel.options[activitySel.selectedIndex] ? activitySel.options[activitySel.selectedIndex].textContent : ""
        } : null;
    }
    if (historyModalMode === "task") {
        var level3Sel = document.getElementById("history-task-level-3");
        var level2Sel = document.getElementById("history-task-level-2");
        var level1Sel = document.getElementById("history-task-level-1");
        var chosenSel = level3Sel && level3Sel.value ? level3Sel : (level2Sel && level2Sel.value ? level2Sel : (level1Sel && level1Sel.value ? level1Sel : null));
        return chosenSel ? {
            entityType: "Task",
            entityId: chosenSel.value,
            entityName: chosenSel.options[chosenSel.selectedIndex] ? chosenSel.options[chosenSel.selectedIndex].textContent : ""
        } : null;
    }
    var entitySel = document.getElementById("history-entity-select");
    if (!entitySel || !entitySel.value) return null;
    return {
        entityType: "TeamMember",
        entityId: entitySel.value,
        entityName: entitySel.options[entitySel.selectedIndex] ? entitySel.options[entitySel.selectedIndex].textContent : ""
    };
}

function onHistoryEntityChange() {
    loadHistoryForCurrentSelection();
}

function loadHistoryForCurrentSelection() {
    var selection = getCurrentHistoryEntitySelection();
    syncHistoryClearButton(selection);
    if (!selection) {
        stopHistoryPolling();
        return;
    }
    var hintEl = document.getElementById("history-modal-hint");
    var listEl = document.getElementById("history-modal-list");
    var loadingEl = document.getElementById("history-modal-loading");
    var emptyEl = document.getElementById("history-modal-empty");
    if (hintEl) hintEl.hidden = true;
    if (listEl) {
        listEl.hidden = true;
        listEl.innerHTML = "";
    }
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    stopHistoryPolling();
    apiRequest("/activity?entity_type=" + encodeURIComponent(selection.entityType) + "&entity_id=" + encodeURIComponent(selection.entityId), "GET")
        .then(function (logs) {
            if (loadingEl) loadingEl.hidden = true;
            renderHistoryList(logs, listEl, emptyEl);
            startHistoryPolling();
        })
        .catch(function (err) {
            if (loadingEl) loadingEl.hidden = true;
            stopHistoryPolling();
            if (emptyEl) {
                emptyEl.hidden = false;
                emptyEl.textContent = err.message || "Failed to load history.";
            }
        });
}

function clearHistoryForEntity() {
    var selection = getCurrentHistoryEntitySelection();
    if (!selection) {
        showToast("Select an item to clear its history", true);
        return;
    }
    var confirmMsg = "Are you sure you want to permanently delete all history for " + selection.entityName + "?\n\nThis action cannot be undone.";
    if (!confirm(confirmMsg)) return;
    apiRequest("/activity?entity_type=" + encodeURIComponent(selection.entityType) + "&entity_id=" + encodeURIComponent(selection.entityId), "DELETE")
        .then(function () {
            showToast("History cleared");
            loadHistoryForCurrentSelection();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to clear history", true);
        });
}

var COMPLETION_PROOF_MAX_TOTAL_MB = 100;

function submitCompletionProof() {
    var taskIdEl = document.getElementById("completion-proof-task-id");
    var fileEl = document.getElementById("completion-proof-file");
    var submitBtn = document.getElementById("completion-proof-submit");
    if (!taskIdEl || !fileEl) return;
    var taskId = taskIdEl.value;
    var files = fileEl.files;
    if (!files || files.length === 0) {
        showToast("Please select at least one file", true);
        return;
    }
    var totalBytes = 0;
    var i;
    for (i = 0; i < files.length; i++) totalBytes += files[i].size;
    if (totalBytes > COMPLETION_PROOF_MAX_TOTAL_MB * 1024 * 1024) {
        showToast("Total file size must not exceed " + COMPLETION_PROOF_MAX_TOTAL_MB + " MB", true);
        return;
    }
    if (submitBtn) submitBtn.disabled = true;
    var formData = new FormData();
    for (i = 0; i < files.length; i++) formData.append("files", files[i]);
    apiRequestFormData("/tasks/" + taskId + "/completion-requests", "POST", formData)
        .then(function () {
            showToast("Completion proof submitted. Awaiting approval.");
            closeCompletionProofModal();
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to submit", true);
        })
        .finally(function () {
            if (submitBtn) submitBtn.disabled = false;
        });
}

function viewCompletionAttachment(requestId) {
    if (!requestId) return;
    var url = BASE_URL + "/tasks/completion-requests/" + requestId + "/attachment";
    var token = getSessionToken();
    var opts = { headers: {} };
    if (token) opts.headers["X-Session-Token"] = token;
    fetch(url, opts)
        .then(function (r) {
            if (!r.ok) throw new Error(r.statusText);
            return r.blob();
        })
        .then(function (blob) {
            var objectUrl = URL.createObjectURL(blob);
            window.open(objectUrl, "_blank");
            setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to load attachment", true);
        });
}

function downloadCompletionAttachment(requestId, filename) {
    if (!requestId) return;
    var url = BASE_URL + "/tasks/completion-requests/" + requestId + "/attachment";
    var token = getSessionToken();
    var opts = { headers: {} };
    if (token) opts.headers["X-Session-Token"] = token;
    fetch(url, opts)
        .then(function (r) {
            if (!r.ok) throw new Error(r.statusText);
            return r.blob();
        })
        .then(function (blob) {
            var objectUrl = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = objectUrl;
            a.download = filename || "attachment";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to download attachment", true);
        });
}

function reviewCompletionRequest(requestId, taskId, btnEl, fileCount) {
    if (!requestId) return;
    var msg = (fileCount && fileCount > 1)
        ? "Approve or reject all " + fileCount + " completion proof files?\n\nOK = Approve, Cancel = Reject."
        : "Approve or reject this completion proof?\n\nOK = Approve, Cancel = Reject.";
    var approve = confirm(msg);
    var payload = { status: approve ? "approved" : "rejected" };
    apiRequest("/tasks/completion-requests/" + requestId, "PUT", payload)
        .then(function () {
            showToast(payload.status === "approved" ? "Completion approved" : "Completion rejected");
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update completion request", true);
        });
}

function openExtensionRequest(taskId, currentDue) {
    if (!taskId) return;
    if (!currentDue) {
        showToast("Request extension is available only for time-bound tasks with a due date.", true);
        return;
    }
    var proposed = prompt("Enter new due date for this task (YYYY-MM-DD):", currentDue || "");
    if (!proposed) {
        return;
    }
    proposed = proposed.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed)) {
        showToast("Please enter date as YYYY-MM-DD", true);
        return;
    }
    var reason = prompt("Reason for extension request:");
    if (!reason) {
        showToast("Extension reason is required", true);
        return;
    }
    apiRequest("/tasks/" + taskId + "/extension-requests", "POST", {
        requested_due_date: proposed,
        reason: reason
    }).then(function () {
        showToast("Extension request submitted");
        loadTasks();
        loadActivityLogs();
        if (chatPanelOpen) loadActivityChat(true);
    }).catch(function (err) {
        showToast(err.message || "Failed to submit extension request", true);
    });
}

function reviewExtensionRequest(requestId, taskId, btnEl) {
    if (!requestId) return;
    if (!isUserAdmin()) {
        showToast("Only admins can decide extension requests", true);
        return;
    }
    var reason = btnEl && btnEl.getAttribute ? (btnEl.getAttribute("data-ext-reason") || "") : "";
    var requestedDate = btnEl && btnEl.getAttribute ? (btnEl.getAttribute("data-ext-date") || "") : "";
    var msgLines = [];
    if (requestedDate) {
        msgLines.push("Requested new due date: " + requestedDate);
    }
    if (reason) {
        msgLines.push("Reason: " + reason);
    }
    msgLines.push("");
    msgLines.push("Approve this extension request?");
    msgLines.push("OK = Approve, Cancel = Reject.");
    var approve = confirm(msgLines.join("\n"));
    var payload = { status: approve ? "approved" : "rejected" };

    if (approve) {
        var promptLabel = "Enter final due date for this task (YYYY-MM-DD).\nLeave blank to use the requested date: " + (requestedDate || "N/A");
        var finalInput = prompt(promptLabel, requestedDate || "");
        if (finalInput !== null && finalInput.trim() !== "") {
            finalInput = finalInput.trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(finalInput)) {
                showToast("Please enter date as YYYY-MM-DD", true);
                return;
            }
            payload.new_due_date = finalInput;
        }
    }

    apiRequest("/tasks/extension-requests/" + requestId, "PUT", payload)
        .then(function () {
            showToast(payload.status === "approved" ? "Extension approved" : "Extension rejected");
            loadTasks();
            loadActivityLogs();
            if (chatPanelOpen) loadActivityChat(true);
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update extension request", true);
        });
}

// Task-level comments have been replaced by activity-level chat.

function loadActivityLogs() {
    // Activity is now tracked in each activity's chat; no separate recent-activity card.
}

function logout() {
    var token = getSessionToken();
    if (token) {
        fetch(BASE_URL + "/logout?session_token=" + encodeURIComponent(token), { method: "POST" }).catch(function () { });
    }
    localStorage.removeItem("session_token");
    localStorage.removeItem("user_id");
    localStorage.removeItem("username");
    localStorage.removeItem("designation");
    localStorage.removeItem("role");
    window.location.href = "index.html";
}

bindInfoScopeControls();
setInfoScope(currentInfoScope);
applySidebarInfoCollapsedState();
loadUserTeams();
loadHolidays();
loadMilestones();
loadTasks();
initUsersManagementFilters();
toggleActivityCreationMode();
toggleTaskCustomTypeInput();
toggleTaskScheduleType();
toggleTaskDependencyFields();
toggleMilestoneTaskCreationFields();
toggleSubtaskDependencyFields();
(function () {
    var addBtn = document.getElementById("task-add-assignee");
    if (addBtn) addBtn.addEventListener("click", addTaskAssigneeRow);
})();
// Default: keep chat panel closed until user clicks "Chat".
toggleChatPanel(false);
updateChatSubtitle();

// Bind completion proof submit button (ensures click works even if inline handler fails)
(function () {
    var btn = document.getElementById("completion-proof-submit");
    if (btn) {
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            submitCompletionProof();
        });
    }
    var fileInput = document.getElementById("completion-proof-file");
    if (fileInput) {
        fileInput.addEventListener("change", updateCompletionProofFileCount);
    }
})();
function createTask() {
    var divisionId = document.getElementById("task-division").value;
    var groupId = document.getElementById("task-group").value;
    var teamId = document.getElementById("task-team").value;
    var activityId = document.getElementById("task-activity").value;
    var assignmentScope = getTaskAssignmentScope();
    var title = document.getElementById("task-title").value.trim();
    var desc = document.getElementById("task-desc").value.trim();

    var priority = document.getElementById("task-priority").value;
    var dueDate = document.getElementById("task-due").value;
    var tentativeStart = document.getElementById("task-tentative-start").value;
    var tentativeCompletion = document.getElementById("task-tentative-completion").value;
    var taskScheduleTypeEl = document.getElementById("task-schedule-type");
    var taskScheduleType = taskScheduleTypeEl ? (taskScheduleTypeEl.value || "Time Bound") : "Time Bound";
    var assigneeEl = document.getElementById("task-assignee");
    var assignee = assigneeEl ? assigneeEl.value : "";
    var leadId = document.getElementById("task-lead") ? document.getElementById("task-lead").value : "";
    var share = document.getElementById("task-share") ? document.getElementById("task-share").value : "";
    var closureId = document.getElementById("task-closure") ? document.getElementById("task-closure").value : "";
    var customTaskType = document.getElementById("task-custom-type") ? document.getElementById("task-custom-type").value.trim() : "";

    if (!divisionId) { showToast("Select a division first", true); return; }
    if (!groupId) { showToast("Select a group next", true); return; }
    if (!activityId) { showToast("Select an activity or project next", true); return; }
    if (assignmentScope !== "activity" && !teamId) { showToast("Select a team before filling task details", true); return; }
    if (!title) { showToast("Enter a task title", true); return; }
    if (taskScheduleType === "Time Bound" && !dueDate) { showToast("Select a due date for a Time Bound task", true); return; }
    if (taskScheduleType === "Time Bound" && dueDate && isHolidayDate(dueDate)) { showToast("Selected due date is a holiday (" + getHolidayNameByDate(dueDate) + "). Choose a working day.", true); return; }
    if (taskScheduleType === "Ongoing" && !tentativeStart) { showToast("Tentative start date is required for ongoing tasks", true); return; }
    if (taskScheduleType === "Ongoing" && !tentativeCompletion) { showToast("Tentative completion date is required for ongoing tasks", true); return; }
    if (isTentativeCompletionBeforeStart(tentativeStart, tentativeCompletion)) { showToast("Tentative completion date cannot be earlier than tentative start date", true); return; }
    var dependencyPayload = collectDependencyPayload("task");
    if (dependencyPayload === null) return;

    var taskTypeEl = document.getElementById("task-type");
    var taskType = taskTypeEl ? (taskTypeEl.value || "Infrastructure Development") : "Infrastructure Development";
    var payload = {
        title: title,
        description: desc || null,
        priority: priority,
        status: "To Do",
        task_type: taskType,
        custom_type: customTaskType || null,
        task_schedule_type: taskScheduleType,
        tentative_start_date: tentativeStart || null,
        tentative_completion_date: tentativeCompletion || null,
        team_id: teamId ? parseInt(teamId, 10) : null,
        activity_id: activityId ? parseInt(activityId, 10) : null,
        assignment_scope: assignmentScope,
        closure_approver_id: closureId ? parseInt(closureId, 10) : null
    };
    Object.keys(dependencyPayload).forEach(function (key) {
        payload[key] = dependencyPayload[key];
    });
    if (taskScheduleType === "Time Bound" && dueDate) payload.due_date = dueDate;

    if (assignmentScope === "individual") {
        var assigneesFromRows = canUseMultiAssign() ? getTaskAssigneesFromRows() : [];
        if (assigneesFromRows.length > 0) {
            payload.assignments = assigneesFromRows;
        } else {
            payload.assigned_to = assignee ? parseInt(assignee, 10) : null;
            payload.lead_person_id = leadId ? parseInt(leadId, 10) : null;
            payload.percent_share = share ? parseInt(share, 10) : null;
        }
    } else if (assignmentScope === "team" && !teamId) {
        showToast("Select a team to assign this task to the whole team", true);
        return;
    }

    guardDuplicateNameBeforeCreate({
        entityLabel: "task",
        name: title,
        sourceInputId: "task-title"
    }).then(function (finalName) {
        if (!finalName) return null;
        payload.title = finalName;
        return apiRequest("/tasks", "POST", payload)
            .then(function (t) {
                document.getElementById("task-title").value = "";
                var descEl = document.getElementById("task-desc");
                if (descEl) descEl.value = "";
                var dueEl = document.getElementById("task-due");
                if (dueEl) dueEl.value = "";
                var tentativeStartEl = document.getElementById("task-tentative-start");
                if (tentativeStartEl) tentativeStartEl.value = "";
                var tentativeCompletionEl = document.getElementById("task-tentative-completion");
                if (tentativeCompletionEl) tentativeCompletionEl.value = "";
                var scheduleEl = document.getElementById("task-schedule-type");
                if (scheduleEl) scheduleEl.value = "Time Bound";
                var taskTypeSelectEl = document.getElementById("task-type");
                if (taskTypeSelectEl) taskTypeSelectEl.value = "Infrastructure Development";
                var customTypeEl = document.getElementById("task-custom-type");
                if (customTypeEl) customTypeEl.value = "";
                var hasDependencyEl = document.getElementById("task-has-dependency");
                var startDepTaskEl = document.getElementById("task-start-dependency-task");
                var finishDepTaskEl = document.getElementById("task-finish-dependency-task");
                var startDepEventEl = document.getElementById("task-start-dependency-event");
                var finishDepEventEl = document.getElementById("task-finish-dependency-event");
                var startDepOffsetEnabledEl = document.getElementById("task-start-dependency-offset-enabled");
                var startDepOffsetDaysEl = document.getElementById("task-start-dependency-offset-days");
                var finishDepOffsetEnabledEl = document.getElementById("task-finish-dependency-offset-enabled");
                var finishDepOffsetDaysEl = document.getElementById("task-finish-dependency-offset-days");
                if (hasDependencyEl) hasDependencyEl.checked = false;
                if (startDepTaskEl) startDepTaskEl.value = "";
                if (finishDepTaskEl) finishDepTaskEl.value = "";
                if (startDepEventEl) startDepEventEl.value = "finish";
                if (finishDepEventEl) finishDepEventEl.value = "finish";
                if (startDepOffsetEnabledEl) startDepOffsetEnabledEl.checked = false;
                if (startDepOffsetDaysEl) startDepOffsetDaysEl.value = "";
                if (finishDepOffsetEnabledEl) finishDepOffsetEnabledEl.checked = false;
                if (finishDepOffsetDaysEl) finishDepOffsetDaysEl.value = "";
                var shareEl = document.getElementById("task-share");
                if (shareEl) shareEl.value = "";
                var scopeEl = document.getElementById("task-assignment-scope");
                if (scopeEl) scopeEl.value = "individual";
                var list = document.getElementById("task-assignees-list");
                if (list) list.innerHTML = "";
                toggleTaskCustomTypeInput();
                toggleTaskScheduleType();
                toggleTaskDependencyFields();
                syncTaskAssignmentScopeUI();

                if (t.type_approval_status === "pending") {
                    showToast("Task created and sent for type approval (Admin / Division Head / Team Lead / Project Director)");
                } else if (t.is_approved === false) {
                    showToast("Task submitted for approval");
                } else {
                    showToast("Task created");
                }
                loadTasks();
                loadActivityLogs();
            });
    }).catch(function (err) {
        if (!err) return;
        showToast(err.message || "Failed to create task", true);
    });
}

function approveTask(taskId) {
    apiRequest("/tasks/" + taskId + "/approve", "POST")
        .then(function () {
            showToast("Task approved");
            loadTasks();
            loadActivityLogs();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to approve task", true);
        });
}

// ---------------------------------------------------------
// User Management
// ---------------------------------------------------------

var cachedAllUsers = [];

function createUserOptionFromDashboard(optionType) {
    var isRole = optionType === "role";
    var inputEl = document.getElementById(isRole ? "admin-new-role" : "admin-new-designation");
    var value = inputEl ? (inputEl.value || "").trim() : "";
    if (!value) {
        showToast("Please enter a " + (isRole ? "role" : "designation"), true);
        return;
    }

    apiRequest("/user-options", "POST", {
        option_type: optionType,
        value: value
    })
        .then(function (item) {
            showToast((isRole ? "Role" : "Designation") + " created: " + ((item && item.value) || value));
            if (inputEl) inputEl.value = "";
            return loadUserOptionCatalog();
        })
        .then(function () {
            loadAllUsers();
        })
        .catch(function (err) {
            showToast(err.message || ("Failed to create " + optionType), true);
        });
}

function updateUserOptionFromDashboard(optionType) {
    var isRole = optionType === "role";
    var select = document.getElementById(isRole ? "admin-manage-role-select" : "admin-manage-designation-select");
    var inputEl = document.getElementById(isRole ? "admin-edit-role-name" : "admin-edit-designation-name");
    var optionId = select && select.value ? parseInt(select.value, 10) : null;
    var value = inputEl ? (inputEl.value || "").trim() : "";
    if (!optionId) {
        showToast("Select a " + optionType + " first", true);
        return;
    }
    if (!value) {
        showToast("Enter a new " + optionType + " name", true);
        return;
    }

    apiRequest("/user-options/" + optionId, "PUT", { value: value })
        .then(function () {
            showToast((isRole ? "Role" : "Designation") + " updated");
            return loadUserOptionCatalog();
        })
        .then(function () {
            loadAllUsers();
        })
        .catch(function (err) {
            showToast(err.message || ("Failed to update " + optionType), true);
        });
}

function deleteUserOptionFromDashboard(optionType) {
    var isRole = optionType === "role";
    var select = document.getElementById(isRole ? "admin-manage-role-select" : "admin-manage-designation-select");
    var optionId = select && select.value ? parseInt(select.value, 10) : null;
    var selectedText = select && select.options && select.selectedIndex >= 0 ? (select.options[select.selectedIndex].textContent || "") : optionType;
    if (!optionId) {
        showToast("Select a " + optionType + " first", true);
        return;
    }
    if (!confirm("Delete " + optionType + ' "' + selectedText + '"?')) return;

    apiRequest("/user-options/" + optionId, "DELETE")
        .then(function () {
            showToast((isRole ? "Role" : "Designation") + " deleted");
            return loadUserOptionCatalog();
        })
        .then(function () {
            loadAllUsers();
        })
        .catch(function (err) {
            showToast(err.message || ("Failed to delete " + optionType), true);
        });
}

function createUserFromDashboard() {
    var usernameEl = document.getElementById("admin-create-username");
    var passwordEl = document.getElementById("admin-create-password");
    var roleEl = document.getElementById("admin-create-role");
    var designationEl = document.getElementById("admin-create-designation");

    var username = usernameEl ? (usernameEl.value || "").trim() : "";
    var password = passwordEl ? (passwordEl.value || "") : "";
    var role = roleEl ? (roleEl.value || "Member") : "Member";
    var designation = designationEl ? (designationEl.value || "") : "";
    var designationToSave = roleHasNoDesignation(role) ? "" : designation;

    if (!username) {
        showToast("Please enter a username", true);
        return;
    }
    if (!password) {
        showToast("Please enter a password", true);
        return;
    }
    if (!roleHasNoDesignation(role) && !designationToSave) {
        showToast("Please select designation", true);
        return;
    }
    if (username.toLowerCase() === password.toLowerCase()) {
        showToast("Username must not be the same as password", true);
        return;
    }

    apiRequest("/users", "POST", {
        username: username,
        password: password,
        role: normalizeRoleValueForApi(role),
        designation: designationToSave || null
    })
        .then(function (res) {
            var createdId = res && res.id != null ? formatUserIdDisplay(res.id) : "N/A";
            showToast("Account created. User ID: " + createdId);
            if (usernameEl) usernameEl.value = "";
            if (passwordEl) passwordEl.value = "";
            if (roleEl) roleEl.value = "Member";
            if (designationEl) designationEl.value = "";
            loadAllUsers();
            loadHierarchyFormDropdowns();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to create account", true);
        });
}

function refreshDeleteAccountOptions() {
    var deleteSelect = document.getElementById("admin-delete-user");
    if (!deleteSelect) return;
    var previousValue = deleteSelect.value;
    deleteSelect.innerHTML = '<option value="">Select account to delete</option>';
    (cachedAllUsers || []).forEach(function (u) {
        addOption(deleteSelect, u.id, formatUserOptionLabel(u, "User " + u.id), String(previousValue) === String(u.id));
    });
    if (previousValue) deleteSelect.value = previousValue;
}

function deleteUserFromDashboard() {
    var deleteSelect = document.getElementById("admin-delete-user");
    var userId = deleteSelect && deleteSelect.value ? parseInt(deleteSelect.value, 10) : null;
    if (!userId) {
        showToast("Select an account to delete", true);
        return;
    }

    var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
    if (userId === currentUserId) {
        showToast("You cannot delete your own account while signed in", true);
        return;
    }

    var user = (cachedAllUsers || []).find(function (u) { return u.id === userId; });
    var userLabel = user ? formatUserInline(user.username, user.designation, "User " + userId) : ("User " + userId);
    if (!confirm("Delete account for " + userLabel + "? This action cannot be undone.")) return;

    apiRequest("/users/" + userId, "DELETE")
        .then(function (res) {
            showToast((res && res.message) ? res.message : "Account deleted");
            if (deleteSelect) deleteSelect.value = "";
            loadAllUsers();
            loadHierarchyFormDropdowns();
            loadUserTeams();
            loadTasks();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to delete account", true);
        });
}

function loadAllUsers() {
    var userRole = (localStorage.getItem("role") || "").toLowerCase();
    if (userRole !== "admin") return;

    apiRequest("/users", "GET")
        .then(function (users) {
            cachedAllUsers = sortUsersByDesignationSeniority(users || []);
            refreshDeleteAccountOptions();
            applyUsersFilter();
        })
        .catch(function (err) {
            console.error("Failed to load users", err);
            refreshDeleteAccountOptions();
        });
}

function getUsersSearchFilter() {
    var searchEl = document.getElementById("users-search");
    var roleEl = document.getElementById("users-role-filter");
    return {
        query: (searchEl && searchEl.value) ? searchEl.value.trim().toLowerCase() : "",
        role: (roleEl && roleEl.value) ? roleEl.value.trim().toLowerCase() : ""
    };
}

function applyUsersFilter() {
    var filter = getUsersSearchFilter();
    var filtered = cachedAllUsers.filter(function (u) {
        var username = (u.username || "").toLowerCase();
        var role = (u.role || "member").toLowerCase();
        if (filter.query && username.indexOf(filter.query) === -1) return false;
        if (filter.role && role !== filter.role) return false;
        return true;
    });
    renderUsers(filtered);
}

document.addEventListener("change", function (event) {
    var target = event && event.target;
    if (!target || !target.id) return;
    if (target.id === "admin-create-role") {
        toggleCreateDesignationField();
    }
    if (target.id === "edit-user-role") {
        toggleEditDesignationField();
    }
});

function renderUsers(users) {
    var tbody = document.getElementById("users-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    users.forEach(function (u) {
        var tr = document.createElement("tr");
        tr.setAttribute("data-user-id", u.id);

        var roleLower = (u.role || "member").toLowerCase();
        var roleDisplay = getRoleDisplayLabel(roleLower);

        // ID
        var tdId = document.createElement("td");
        tdId.textContent = formatUserIdDisplay(u.id);
        tr.appendChild(tdId);

        // Username
        var tdName = document.createElement("td");
        tdName.innerHTML = renderUserLabelHtml(u.username, u.designation, "User " + u.id);
        tr.appendChild(tdName);

        // Role
        var tdRole = document.createElement("td");
        tdRole.textContent = roleDisplay;
        tr.appendChild(tdRole);

        // Update user
        var tdAction = document.createElement("td");
        tdAction.className = "users-action-cell";

        var btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "btn btn-sm btn-primary";
        btnEdit.textContent = "Edit user";
        btnEdit.onclick = function () { openEditUserModal(u.id); };
        tdAction.appendChild(btnEdit);
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
    });
}

function setUserRoleConfirm(userId, username, newRole) {
    var roleLabel = newRole === "division head" ? "Division Head" : "Member";
    if (!confirm("Set \"" + (username || userId) + "\" to " + roleLabel + "?")) return;
    updateUserRole(userId, newRole);
}

function setDivisionHeadConfirm(userId, username) {
    var divisionSelect = document.getElementById("users-division-head-target");
    var divisionId = divisionSelect && divisionSelect.value ? parseInt(divisionSelect.value, 10) : null;
    if (!divisionId) {
        showToast("Select a division in Manage Users first", true);
        return;
    }
    var divisionName = "";
    if (divisionSelect && divisionSelect.options && divisionSelect.selectedIndex >= 0) {
        divisionName = divisionSelect.options[divisionSelect.selectedIndex].textContent || "";
    }
    if (!confirm("Set \"" + (username || userId) + "\" as Division Head for \"" + divisionName + "\"?")) return;
    apiRequest("/divisions/" + divisionId + "/head", "PUT", { user_id: userId })
        .then(function () {
            showToast("Division head updated for " + divisionName);
            var u = cachedAllUsers.find(function (x) { return x.id === userId; });
            if (u) u.role = "division head";
            var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
            if (userId === currentUserId) {
                localStorage.setItem("role", "division head");
                updateHeaderRole();
                setupRoleBasedUI("division head");
                loadUserTeams();
            }
            loadHierarchyFormDropdowns();
            applyUsersFilter();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to set division head", true);
        });
}

function setGroupHeadConfirm(userId, username) {
    var groupSelect = document.getElementById("users-group-head-target");
    var groupId = groupSelect && groupSelect.value ? parseInt(groupSelect.value, 10) : null;
    if (!groupId) {
        showToast("Select a group in Manage Users first", true);
        return;
    }
    var groupName = "";
    if (groupSelect && groupSelect.options && groupSelect.selectedIndex >= 0) {
        groupName = groupSelect.options[groupSelect.selectedIndex].textContent || "";
    }
    if (!confirm("Set \"" + (username || userId) + "\" as Group Head for \"" + groupName + "\"?")) return;
    apiRequest("/groups/" + groupId + "/head", "PUT", { user_id: userId })
        .then(function () {
            showToast("Group head updated for " + groupName);
            var u = cachedAllUsers.find(function (x) { return x.id === userId; });
            if (u && (u.role || "").toLowerCase() === "member") u.role = "group head";
            var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
            if (userId === currentUserId && (localStorage.getItem("role") || "member").toLowerCase() === "member") {
                localStorage.setItem("role", "group head");
                updateHeaderRole();
                setupRoleBasedUI("group head");
            }
            loadHierarchyFormDropdowns();
            applyUsersFilter();
            loadAllUsers();
            loadUserTeams();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to set group head", true);
        });
}

function updateUserRole(userId, newRole) {
    var roleLabel = getRoleDisplayLabel(newRole);

    apiRequest("/users/" + userId + "/role", "PUT", { role: roleLabel })
        .then(function () {
            showToast("Role updated to " + roleLabel);
            var u = cachedAllUsers.find(function (x) { return x.id === userId; });
            if (u) u.role = newRole;
            var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
            if (userId === currentUserId) {
                localStorage.setItem("role", newRole);
                updateHeaderRole();
                setupRoleBasedUI(newRole);
                loadUserTeams();
            }
            applyUsersFilter();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update role", true);
            applyUsersFilter();
        });
}

function updateUserDesignation(userId, designation) {
    apiRequest("/users/" + userId + "/designation", "PUT", { designation: designation })
        .then(function () {
            showToast("Designation updated to " + designation);
            var u = cachedAllUsers.find(function (x) { return x.id === userId; });
            if (u) u.designation = designation;
            cachedAllUsers = sortUsersByDesignationSeniority(cachedAllUsers);
            var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
            if (userId === currentUserId) {
                var currentRole = localStorage.getItem("role") || "";
                var displayDesignation = getDisplayDesignation(currentRole, designation);
                localStorage.setItem("designation", displayDesignation);
                var badge = document.getElementById("user-badge");
                var heroName = document.getElementById("hero-username");
                var heroNameDesc = document.getElementById("hero-username-desc");
                var username = localStorage.getItem("username") || "User";
                if (badge) setUserNameBlock(badge, username, displayDesignation);
                if (heroName) setUserNameBlock(heroName, username, displayDesignation);
                if (heroNameDesc) heroNameDesc.textContent = formatUserInline(username, displayDesignation, "User");
            }
            applyUsersFilter();
            loadTasks();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update designation", true);
            applyUsersFilter();
        });
}

function openEditUserModal(userId) {
    var user = cachedAllUsers.find(function (x) { return x.id === userId; });
    var modal = document.getElementById("edit-user-modal");
    var idEl = document.getElementById("edit-user-id");
    var usernameEl = document.getElementById("edit-user-username");
    var roleEl = document.getElementById("edit-user-role");
    var designationEl = document.getElementById("edit-user-designation");
    var subtitleEl = document.getElementById("edit-user-modal-subtitle");
    if (!user || !modal || !idEl || !usernameEl || !roleEl || !designationEl) return;

    idEl.value = String(user.id);
    usernameEl.value = user.username || "";
    populateUserOptionSelects();
    roleEl.value = (user.role || "member").toLowerCase();
    designationEl.value = getDisplayDesignation(user.role, user.designation || "");
    populateEditUserScopeDivisionOptions("");
    populateEditUserScopeGroupOptions("", "");
    populateEditUserScopeActivityOptions("", "");
    populateEditUserScopeTeamOptions("", "");
    toggleEditDesignationField();
    if (subtitleEl) {
        subtitleEl.innerHTML = renderUserLabelHtml(user.username, user.designation, "User " + user.id);
    }
    modal.hidden = false;
}

function closeEditUserModal() {
    var modal = document.getElementById("edit-user-modal");
    if (modal) modal.hidden = true;
}

function saveUserAdminEdit() {
    var idEl = document.getElementById("edit-user-id");
    var usernameEl = document.getElementById("edit-user-username");
    var roleEl = document.getElementById("edit-user-role");
    var designationEl = document.getElementById("edit-user-designation");
    var divisionScopeEl = document.getElementById("edit-user-scope-division");
    var groupScopeEl = document.getElementById("edit-user-scope-group");
    var activityScopeEl = document.getElementById("edit-user-scope-activity");
    var teamScopeEl = document.getElementById("edit-user-scope-team");
    var userId = idEl && idEl.value ? parseInt(idEl.value, 10) : null;
    var selectedUsername = usernameEl ? (usernameEl.value || "").trim() : "";
    var selectedRole = roleEl ? (roleEl.value || "member") : "member";
    var selectedDesignation = designationEl ? (designationEl.value || "") : "";
    var designationToSave = roleHasNoDesignation(selectedRole) ? "" : selectedDesignation;
    var user = cachedAllUsers.find(function (x) { return x.id === userId; });
    if (!userId || !user) {
        showToast("User not selected", true);
        return;
    }
    if (!selectedUsername) {
        showToast("Enter a username", true);
        return;
    }
    if (!roleHasNoDesignation(selectedRole) && !designationToSave) {
        showToast("Select a designation", true);
        return;
    }
    if (selectedRole === "division head" && !(divisionScopeEl && divisionScopeEl.value)) {
        showToast("Select a division for Division Head", true);
        return;
    }
    if (selectedRole === "group head" && (!(divisionScopeEl && divisionScopeEl.value) || !(groupScopeEl && groupScopeEl.value))) {
        showToast("Select division and group for Group Head", true);
        return;
    }
    if ((selectedRole === "team lead" || selectedRole === "project director") && (!(divisionScopeEl && divisionScopeEl.value) || !(groupScopeEl && groupScopeEl.value) || !(activityScopeEl && activityScopeEl.value) || !(teamScopeEl && teamScopeEl.value))) {
        showToast("Select division, group, activity/project, and team", true);
        return;
    }

    var usernameChanged = selectedUsername !== (user.username || "");
    var currentRole = (user.role || "member").toLowerCase();
    var roleChanged = selectedRole !== currentRole;
    var designationChanged = designationToSave !== getDisplayDesignation(user.role, user.designation || "");
    if (!usernameChanged && !roleChanged && !designationChanged) {
        showToast("No changes to save");
        return;
    }

    var chain = Promise.resolve();
    if (usernameChanged) {
        chain = chain.then(function () {
            return apiRequest("/users/" + userId + "/username", "PUT", {
                username: selectedUsername
            });
        });
    }
    if (roleChanged) {
        chain = chain.then(function () {
            return apiRequest("/users/" + userId + "/role", "PUT", {
                role: getRoleDisplayLabel(selectedRole)
            });
        });
    }
    if (selectedRole === "division head") {
        chain = chain.then(function () {
            return apiRequest("/divisions/" + parseInt(divisionScopeEl.value, 10) + "/head", "PUT", { user_id: userId });
        });
    }
    if (selectedRole === "group head") {
        chain = chain.then(function () {
            return apiRequest("/groups/" + parseInt(groupScopeEl.value, 10) + "/head", "PUT", { user_id: userId });
        });
    }
    if (selectedRole === "team lead" || selectedRole === "project director") {
        chain = chain.then(function () {
            return apiRequest("/teams/" + parseInt(teamScopeEl.value, 10) + "/members/" + userId + "/role?role=" + encodeURIComponent(getRoleDisplayLabel(selectedRole)), "PUT");
        });
    }
    if (designationChanged) {
        chain = chain.then(function () {
            return apiRequest("/users/" + userId + "/designation", "PUT", {
                designation: designationToSave
            });
        });
    }

    chain
        .then(function () {
            closeEditUserModal();
            showToast("User details updated");
            loadAllUsers();
            loadHierarchyFormDropdowns();
            loadUserTeams();
            loadTasks();
            var currentUserId = parseInt(localStorage.getItem("user_id"), 10);
            if (userId === currentUserId) {
                localStorage.setItem("username", selectedUsername);
                localStorage.setItem("role", selectedRole);
                localStorage.setItem("designation", designationToSave);
                updateTopbarIdentityFromStorage();
                applyDashboardUserProfile(selectedUsername, getDisplayDesignation(selectedRole, designationToSave));
                updateHeaderRole();
                setupRoleBasedUI(selectedRole);
            }
        })
        .catch(function (err) {
            showToast(err.message || "Failed to update user", true);
        });
}

function initUsersManagementFilters() {
    var searchEl = document.getElementById("users-search");
    var roleEl = document.getElementById("users-role-filter");
    if (searchEl) searchEl.addEventListener("input", applyUsersFilter);
    if (searchEl) searchEl.addEventListener("keyup", applyUsersFilter);
    if (roleEl) roleEl.addEventListener("change", applyUsersFilter);
}
