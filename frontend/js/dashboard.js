/**
 * Dashboard — all backend features: teams, add member, tasks, comments, activity.
 */

var currentTeamIdForView = null; // null = all teams
var currentActivityIdForView = null; // null = all activities within selected team (or all teams)
var _sidebarTeamActivitiesCache = {}; // teamId -> activities array
var sidebarOpenTeamId = null; // which team's activity dropdown is open
var chatPanelOpen = false;
var chatMessagesCache = {}; // activityId -> messages array
// Effective role for header & multi-assign: global role (Admin/Division Head) OR team role (Project Director/Group Head/Team Lead)
var effectiveDisplayRole = null;

(function () {
    if (!isLoggedIn()) {
        window.location.href = "index.html";
        return;
    }

    var username = localStorage.getItem("username") || "User";
    var role = (localStorage.getItem("role") || "member").toLowerCase();

    var badge = document.getElementById("user-badge");
    if (badge) badge.textContent = username;
    var avatar = document.getElementById("user-avatar");
    if (avatar) avatar.textContent = (username.charAt(0) || "U").toUpperCase();
    updateHeaderRole();
    var heroName = document.getElementById("hero-username");
    if (heroName) heroName.textContent = username;
    var heroNameDesc = document.getElementById("hero-username-desc");
    if (heroNameDesc) heroNameDesc.textContent = username;
    var uid = getUserId();
    var heroUserId = document.getElementById("hero-user-id");
    if (heroUserId && uid) heroUserId.textContent = uid;
    var topbarUserId = document.getElementById("topbar-user-id");
    if (topbarUserId && uid) topbarUserId.textContent = uid;

    setupRoleBasedUI(role);

    // Sync current user from server so role/name changes (e.g. promoted to Division Head / Group Head) apply without re-login
    apiRequest("/users/me", "GET")
        .then(function (me) {
            if (!me) return;
            var serverRole = (me.role || "member").toLowerCase();
            var serverName = me.username || "";
            if (serverName) localStorage.setItem("username", serverName);
            var roleChanged = serverRole !== (localStorage.getItem("role") || "member").toLowerCase();
            if (roleChanged) {
                localStorage.setItem("role", serverRole);
                setupRoleBasedUI(serverRole);
                loadUserTeams();
                loadTasks();
            }
            updateHeaderRole();
            if (serverName && badge) badge.textContent = serverName;
            if (serverName && heroName) heroName.textContent = serverName;
            if (serverName && heroNameDesc) heroNameDesc.textContent = serverName;
            if (serverName && avatar) avatar.textContent = (serverName.charAt(0) || "U").toUpperCase();
        })
        .catch(function () { /* keep existing localStorage on error */ });
})();

function getEffectiveRole() {
    if (effectiveDisplayRole !== null && effectiveDisplayRole !== undefined) {
        return effectiveDisplayRole.toLowerCase();
    }
    return (localStorage.getItem("role") || "member").toLowerCase();
}

function updateHeaderRole() {
    var role = getEffectiveRole();
    var roleEl = document.getElementById("user-role");
    if (roleEl) {
        if (role === "admin") roleEl.textContent = "Admin";
        else if (role === "division head") roleEl.textContent = "Division Head";
        else if (role === "group head") roleEl.textContent = "Group Head";
        else if (role === "project director") roleEl.textContent = "Project Director";
        else if (role === "team lead") roleEl.textContent = "Team Lead";
        else roleEl.textContent = "Member";
    }
}

function setupRoleBasedUI(userRole) {
    // Normalize to lowercase so "Admin" and "admin" both work
    var role = (userRole || "member").toLowerCase();
    var isAdmin = role === "admin" || role === "division head";
    var canCreateTeam = isAdmin || role === "team lead" || role === "project director" || role === "group head";
    var canRemoveMember = isAdmin || role === "project director" || role === "group head" || role === "team lead";

    // Hide team creation for non-privileged users
    var teamSection = document.getElementById("team-section");
    if (teamSection) {
        teamSection.style.display = canCreateTeam ? "" : "none";
    }

    // Add member section: hidden by default; shown when user has admin teams (set in loadUserTeams)
    var memberSection = document.getElementById("member-section");
    if (memberSection) {
        memberSection.style.display = "none";
    }

    // Admin-only maintenance cards (delete team, remove member)
    var deleteTeamCard = document.getElementById("delete-team-card");
    if (deleteTeamCard) {
        deleteTeamCard.style.display = isAdmin ? "" : "none";
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

    // Show user management for global admins / division heads
    var userSection = document.getElementById("users-section");
    if (userSection) {
        if (isAdmin) {
            userSection.style.display = "block";
            loadAllUsers();
        } else {
            userSection.style.display = "none";
        }
    }

    // Create task: Admin, Division Head, Group Head, Project Director, Team Lead can add assignees when creating. Members see no assign/lead/share UI.
    var multiWrap = document.getElementById("task-multi-assign-wrap");
    var singleWrap = document.getElementById("task-single-assign-wrap");
    var leadWrap = document.getElementById("task-lead-wrap");
    var shareWrap = document.getElementById("task-share-wrap");
    if (multiWrap && singleWrap) {
        multiWrap.style.display = "none";
        singleWrap.style.display = "none";
        if (leadWrap) leadWrap.style.display = "none";
        if (shareWrap) shareWrap.style.display = "none";
        if (canUseMultiAssign()) {
            multiWrap.style.display = "block";
        } else if (canAssignTask()) {
            singleWrap.style.display = "";
            if (leadWrap) leadWrap.style.display = "";
            if (shareWrap) shareWrap.style.display = "";
        }
    }
    var typeHint = document.getElementById("task-type-hint");
    if (typeHint) typeHint.style.display = !canAssignTask() && !canUseMultiAssign() ? "block" : "none";
}

function isUserAdmin() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head";
}

// Only Admin and Division Head can assign/unassign tasks (Assign to... dropdown, Unassign). Team Lead / Group Head / Project Director cannot.
function canAssignTask() {
    var role = (localStorage.getItem("role") || "member").toLowerCase();
    return role === "admin" || role === "division head";
}

// Admin, Division Head, Group Head, Project Director, Team Lead can create tasks with multiple assignees (create form only).
function canUseMultiAssign() {
    var role = getEffectiveRole();
    return ["admin", "division head", "group head", "team lead", "project director"].indexOf(role) !== -1;
}

function getSelectedTeamId() {
    var v = document.getElementById("task-team");
    return v && v.value ? parseInt(v.value, 10) : null;
}

function getFilterStatus() {
    var v = document.getElementById("filter-status");
    return v && v.value ? v.value : null;
}

function getFilterAssigned() {
    var v = document.getElementById("filter-assigned");
    return v && v.value ? parseInt(v.value, 10) : null;
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

    var date;
    if (isIsoLike && !hasTimezone) {
        // Treat naive backend timestamps as UTC
        date = new Date(str + "Z");
    } else {
        // Let the browser parse as-is (handles offsets / Z correctly)
        date = new Date(str);
    }

    if (isNaN(date.getTime())) {
        return "";
    }
    return date.toLocaleString();
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

function addOption(sel, value, text, selected) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (selected) opt.selected = true;
    sel.appendChild(opt);
}

function loadUserTeams() {
    Promise.all([
        apiRequest("/users/" + getUserId() + "/teams", "GET"),
        apiRequest("/users", "GET")
    ]).then(function (results) {
        var teams = Array.isArray(results[0]) ? results[0] : [];
        // User list must be an array of { id, username } from API only - never use credentials
        var rawUsers = results[1];
        var users = Array.isArray(rawUsers)
            ? rawUsers.filter(function (u) { return u && typeof u.id !== "undefined" && u.username != null; })
            : [];
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
        updateHeaderRole();
        setupRoleBasedUI(effectiveDisplayRole);
        var teamOptions = teams.map(function (t) { return { id: t.id, name: t.name }; });
        var adminTeamOptions = teams.filter(function (t) {
            return t.user_role === "Admin" || getEffectiveRole() === "division head" || getEffectiveRole() === "admin";
        }).map(function (t) { return { id: t.id, name: t.name }; });
        var removeMemberTeamOptions = teams.filter(function (t) {
            var r = (t.user_role || "").toLowerCase();
            return adminTeamOptions.some(function (a) { return a.id === t.id; }) ||
                r === "project director" || r === "group head" || r === "team lead";
        }).map(function (t) { return { id: t.id, name: t.name }; });

        var select = document.getElementById("task-team");
        var activitySelect = document.getElementById("task-activity");
        var createActivityTeamSelect = document.getElementById("activity-team");
        var addMemberSelect = document.getElementById("add-member-team");
        var addMemberUserSelect = document.getElementById("add-member-user");
        var filterAssignedSelect = document.getElementById("filter-assigned");
        var sidebarListEl = document.getElementById("team-nav-list");

        if (select) {
            select.innerHTML = "";
            addOption(select, "", "Select team", false);
            teamOptions.forEach(function (t) { addOption(select, t.id, t.name, false); });
            if (!select._bound) {
                select._bound = true;
                select.addEventListener("change", function () {
                    loadTeamMembersForAssignee(select.value);
                    loadTeamMembersForLead(select.value);
                    loadClosureApprovers(select.value);
                    loadActivitiesForTeam(select.value);
                });
            }
        }
        if (sidebarListEl) {
            if (!teams || teams.length === 0) {
                sidebarListEl.innerHTML = "<div class=\"sidebar-empty\">No teams yet</div>";
            } else {
                sidebarListEl.innerHTML = teams.map(function (t) {
                    return (
                        "<div class=\"sidebar-team\" id=\"team-nav-wrap-" + t.id + "\" role=\"listitem\">" +
                        "<button type=\"button\" class=\"sidebar-item sidebar-team-btn\" id=\"team-nav-" + t.id + "\" onclick=\"selectTeamForView(" + t.id + ")\">" +
                        "<span class=\"sidebar-dot\" aria-hidden=\"true\"></span>" +
                        "<span class=\"sidebar-label\">" + escapeHtml(t.name) + "</span>" +
                        "<span class=\"sidebar-caret\" aria-hidden=\"true\"></span>" +
                        "</button>" +
                        "<div class=\"sidebar-sublist\" id=\"team-activities-" + t.id + "\" hidden></div>" +
                        "</div>"
                    );
                }).join("");
            }
        }
        if (addMemberSelect) {
            addMemberSelect.innerHTML = "";
            if (adminTeamOptions.length > 0) {
                addOption(addMemberSelect, "", "Select team", false);
                adminTeamOptions.forEach(function (t) { addOption(addMemberSelect, t.id, t.name, false); });
                var memberSection = document.getElementById("member-section");
                if (memberSection) memberSection.style.display = "block";
            } else {
                addOption(addMemberSelect, "", "No teams to manage", false);
                addMemberSelect.disabled = true;
            }
        }
        if (createActivityTeamSelect) {
            createActivityTeamSelect.innerHTML = "";
            addOption(createActivityTeamSelect, "", "Select team", false);
            teamOptions.forEach(function (t) { addOption(createActivityTeamSelect, t.id, t.name, false); });
        }
        // Admin delete-team and remove-member team dropdowns (admin teams only)
        var deleteTeamSelect = document.getElementById("delete-team-select");
        if (deleteTeamSelect) {
            deleteTeamSelect.innerHTML = "";
            if (adminTeamOptions.length > 0) {
                addOption(deleteTeamSelect, "", "Select team", false);
                adminTeamOptions.forEach(function (t) { addOption(deleteTeamSelect, t.id, t.name, false); });
            } else {
                addOption(deleteTeamSelect, "", "No admin teams", false);
                deleteTeamSelect.disabled = true;
            }
        }
        var removeMemberTeamSelect = document.getElementById("remove-member-team");
        if (removeMemberTeamSelect) {
            removeMemberTeamSelect.innerHTML = "";
            if (removeMemberTeamOptions.length > 0) {
                addOption(removeMemberTeamSelect, "", "Select team", false);
                removeMemberTeamOptions.forEach(function (t) { addOption(removeMemberTeamSelect, t.id, t.name, false); });
                if (!removeMemberTeamSelect._bound) {
                    removeMemberTeamSelect._bound = true;
                    removeMemberTeamSelect.addEventListener("change", function () {
                        loadTeamMembersForRemoval(removeMemberTeamSelect.value);
                    });
                }
            } else {
                addOption(removeMemberTeamSelect, "", "No teams to manage", false);
                removeMemberTeamSelect.disabled = true;
            }
        }
        if (addMemberUserSelect) {
            addMemberUserSelect.innerHTML = "";
            addOption(addMemberUserSelect, "", "Select user", false);
            users.forEach(function (u) {
                var label = typeof u.username === "string" ? u.username : ("User " + u.id);
                addOption(addMemberUserSelect, u.id, label + " (ID: " + u.id + ")", false);
            });
        }
        if (filterAssignedSelect) {
            filterAssignedSelect.innerHTML = "";
            addOption(filterAssignedSelect, "", "Assigned to", true);
            users.forEach(function (u) {
                var label = typeof u.username === "string" ? u.username : ("User " + u.id);
                addOption(filterAssignedSelect, u.id, label, false);
            });
        }

        var statTeams = document.getElementById("stat-teams");
        if (statTeams) statTeams.textContent = teams && teams.length !== undefined ? teams.length : 0;

        var listEl = document.getElementById("teams-list");
        if (listEl) {
            if (!teams || teams.length === 0) {
                listEl.innerHTML = "<p class=\"empty-state empty-state--inline\">No teams yet. Create one above.</p>";
            } else {
                var currentRole = getEffectiveRole();
                listEl.innerHTML = teams.map(function (t) {
                    var displayRole = currentRole === "division head" ? "Division Head" : (currentRole === "admin" ? "Admin" : (t.user_role || "Member"));
                    return "<span class=\"team-tag\">" + escapeHtml(t.name) + " <small>(" + escapeHtml(displayRole) + ")</small></span>";
                }).join("");
            }
        }

        // Keep default as "All teams" on initial load; do not auto-switch to first team.
        updateTeamNavActiveState();
    }).catch(function (err) {
        var statTeams = document.getElementById("stat-teams");
        if (statTeams) statTeams.textContent = "0";
        showToast(err.message || "Failed to load teams", true);
    });
}

function selectTeamForView(teamId) {
    currentTeamIdForView = teamId ? parseInt(teamId, 10) : null;
    currentActivityIdForView = null; // reset activity when changing team
    sidebarOpenTeamId = currentTeamIdForView;
    var allBtn = document.getElementById("team-nav-all");
    if (allBtn) {
        allBtn.setAttribute("data-explicit", currentTeamIdForView === null ? "1" : "0");
    }
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

function updateTeamNavActiveState() {
    var allBtn = document.getElementById("team-nav-all");
    if (allBtn) {
        allBtn.classList.toggle("sidebar-item--active", currentTeamIdForView === null);
    }
    var listEl = document.getElementById("team-nav-list");
    if (!listEl) return;
    var buttons = listEl.querySelectorAll ? listEl.querySelectorAll(".sidebar-team-btn") : [];
    for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var idAttr = b && b.id ? b.id : "";
        var match = /^team-nav-(\d+)$/.exec(idAttr);
        var id = match ? parseInt(match[1], 10) : null;
        b.classList.toggle("sidebar-item--active", id !== null && currentTeamIdForView === id);
    }

    // Activity selection styling (if any)
    var subBtns = listEl.querySelectorAll ? listEl.querySelectorAll(".sidebar-subitem") : [];
    for (var j = 0; j < subBtns.length; j++) {
        var sb = subBtns[j];
        var sbId = sb && sb.getAttribute ? sb.getAttribute("data-activity-id") : null;
        var actId = sbId ? parseInt(sbId, 10) : null;
        sb.classList.toggle("sidebar-subitem--active", currentActivityIdForView !== null && actId === currentActivityIdForView);
    }
}

function syncCreateTaskTeamToView() {
    // Optional UX: when you pick a team in the sidebar, pre-select it in "Create task"
    // so the user doesn't have to pick team again.
    var select = document.getElementById("task-team");
    if (!select) return;
    if (currentTeamIdForView === null) return; // All teams: don't force selection
    var v = String(currentTeamIdForView);
    if (select.value !== v) {
        select.value = v;
        // Trigger dependent dropdown loads
        loadTeamMembersForAssignee(v);
        loadTeamMembersForLead(v);
        loadClosureApprovers(v);
        loadActivitiesForTeam(v);
    }
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
            subListEl.innerHTML = "<div class=\"sidebar-subempty\">No activities</div>";
        });
}

function renderTeamActivities(teamId, activities) {
    var subListEl = document.getElementById("team-activities-" + teamId);
    if (!subListEl) return;

    if (!activities || activities.length === 0) {
        subListEl.innerHTML = "<div class=\"sidebar-subempty\">No activities</div>";
        return;
    }

    // Include an "All activities" item for the selected team.
    var html = "";
    html += (
        "<button type=\"button\" class=\"sidebar-subitem" + (currentActivityIdForView === null ? " sidebar-subitem--active" : "") + "\" " +
        "onclick=\"selectActivityForView(" + teamId + ", null)\">All activities</button>"
    );

    html += activities.map(function (a) {
        var label = escapeHtml(a.name) + (a.type ? " <span class=\"sidebar-submeta\">(" + escapeHtml(a.type) + ")</span>" : "");
        var isActive = currentActivityIdForView !== null && a.id === currentActivityIdForView;
        return (
            "<button type=\"button\" class=\"sidebar-subitem" + (isActive ? " sidebar-subitem--active" : "") + "\" " +
            "data-activity-id=\"" + a.id + "\" onclick=\"selectActivityForView(" + teamId + ", " + a.id + ")\">" + label + "</button>"
        );
    }).join("");

    subListEl.innerHTML = html;
    updateTeamNavActiveState();
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

function loadActivityChat(forceRefresh) {
    updateChatSubtitle();
    var box = document.getElementById("chat-messages");
    var input = document.getElementById("chat-input");
    if (!box) return;

    if (!currentActivityIdForView) {
        box.innerHTML = "<div class=\"chat-empty\">Select a specific activity to view its discussion.</div>";
        if (input) input.disabled = true;
        return;
    }

    if (input) input.disabled = false;

    var cacheKey = String(currentActivityIdForView);
    if (!forceRefresh && chatMessagesCache[cacheKey]) {
        renderChatMessages(chatMessagesCache[cacheKey]);
        return;
    }

    box.innerHTML = "<div class=\"chat-empty\">Loading…</div>";
    apiRequest("/activities/" + currentActivityIdForView + "/messages?limit=200", "GET")
        .then(function (msgs) {
            var list = Array.isArray(msgs) ? msgs : [];
            chatMessagesCache[cacheKey] = list;
            renderChatMessages(list);
        })
        .catch(function (err) {
            box.innerHTML = "<div class=\"chat-empty\">Failed to load chat. " + escapeHtml(err.message || "") + "</div>";
        });
}

function renderChatMessages(messages) {
    var box = document.getElementById("chat-messages");
    if (!box) return;
    if (!messages || messages.length === 0) {
        box.innerHTML = "<div class=\"chat-empty\">No messages yet.</div>";
        return;
    }
    box.innerHTML = messages.map(function (m) {
        var isSystem = m && m.message_type === "system";
        var who = isSystem ? "System" : (m.username || "User");
        var when = m && m.created_at ? formatBackendDateTimeToLocal(m.created_at) : "";
        var cls = isSystem ? "chat-msg chat-msg--system" : "chat-msg";
        return (
            "<div class=\"" + cls + "\">" +
            "<div class=\"chat-meta\"><span class=\"chat-who\">" + escapeHtml(who) + "</span><span class=\"chat-when\">" + escapeHtml(when) + "</span></div>" +
            "<div class=\"chat-text\">" + escapeHtml(m.content || "") + "</div>" +
            "</div>"
        );
    }).join("");
    try { box.scrollTop = box.scrollHeight; } catch (e) { }
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
                opt.textContent = m.username || "User " + m.id;
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
            (members || []).forEach(function (m) { addOption(assigneeSelect, m.id, m.username, false); });
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
            addOption(sel, m.id, m.username, false);
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
            (members || []).forEach(function (m) { addOption(sel, m.id, m.username, false); });
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
                addOption(sel, m.id, m.username + " (" + m.role + ")", false);
            });
        })
        .catch(function () { });
}

function loadTeamMembersForRemoval(teamId) {
    var memberSelect = document.getElementById("remove-member-user");
    if (!memberSelect || !teamId) {
        if (memberSelect) {
            memberSelect.innerHTML = "";
            addOption(memberSelect, "", "Select team first", false);
        }
        return;
    }
    apiRequest("/teams/" + teamId + "/members", "GET")
        .then(function (members) {
            memberSelect.innerHTML = "";
            if (!members || members.length === 0) {
                addOption(memberSelect, "", "No members in team", false);
                return;
            }
            addOption(memberSelect, "", "Select member", false);
            members.forEach(function (m) {
                var label = (m.username || "User " + m.id) + " (ID: " + m.id + ")";
                addOption(memberSelect, m.id, label, false);
            });
        })
        .catch(function () {
            memberSelect.innerHTML = "";
            addOption(memberSelect, "", "Failed to load members", false);
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
                addOption(activitySelect, "", "No activities yet", false);
                return;
            }
            addOption(activitySelect, "", "Select activity", false);
            activities.forEach(function (a) {
                var label = a.name + " (" + a.type + ")";
                addOption(activitySelect, a.id, label, false);
            });
        })
        .catch(function () {
            activitySelect.innerHTML = "";
            addOption(activitySelect, "", "Failed to load activities", false);
        });
}

function createTeam() {
    var name = document.getElementById("team-name").value.trim();
    if (!name) { showToast("Enter a team name", true); return; }

    apiRequest("/teams", "POST", { name: name })
        .then(function () {
            document.getElementById("team-name").value = "";
            showToast("Team created");
            loadUserTeams();
        })
        .catch(function (err) { showToast(err.message || "Failed to create team", true); });
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

function confirmDeleteTeam() {
    var sel = document.getElementById("delete-team-select");
    if (!sel || !sel.value) {
        showToast("Select a team to delete", true);
        return;
    }
    var teamId = parseInt(sel.value, 10);
    var name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : ("Team " + teamId);
    var ok = confirm("Are you sure you want to permanently delete team \"" + name + "\"?\n\nTeams with members, activities, or tasks cannot be deleted.");
    if (!ok) return;
    apiRequest("/teams/" + teamId, "DELETE")
        .then(function () {
            showToast("Team deleted");
            loadUserTeams();
            loadTasks();
            loadActivityLogs();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to delete team", true);
        });
}

function confirmRemoveMember() {
    var teamSel = document.getElementById("remove-member-team");
    var userSel = document.getElementById("remove-member-user");
    if (!teamSel || !teamSel.value) {
        showToast("Select a team", true);
        return;
    }
    if (!userSel || !userSel.value) {
        showToast("Select a member to remove", true);
        return;
    }
    var teamId = parseInt(teamSel.value, 10);
    var userId = parseInt(userSel.value, 10);
    var userLabel = userSel.options[userSel.selectedIndex] ? userSel.options[userSel.selectedIndex].textContent : ("User " + userId);
    var ok = confirm("Remove " + userLabel + " from this team?");
    if (!ok) return;
    apiRequest("/teams/" + teamId + "/members/" + userId, "DELETE")
        .then(function () {
            showToast("Member removed from team");
            loadTeamMembersForRemoval(teamId);
            loadTasks();
        })
        .catch(function (err) {
            showToast(err.message || "Failed to remove member", true);
        });
}

function createActivity() {
    var teamEl = document.getElementById("activity-team");
    var nameEl = document.getElementById("activity-name");
    var typeEl = document.getElementById("activity-type");

    var teamId = teamEl && teamEl.value ? parseInt(teamEl.value, 10) : null;
    var name = nameEl && nameEl.value ? nameEl.value.trim() : "";
    var type = typeEl ? typeEl.value : "Division";

    if (!teamId) { showToast("Select a team for this activity", true); return; }
    if (!name) { showToast("Enter an activity name", true); return; }

    apiRequest("/activities", "POST", {
        team_id: teamId,
        name: name,
        type: type
    }).then(function () {
        nameEl.value = "";
        showToast("Activity created");

        // If the same team is selected in the task form, refresh its activities list.
        var currentTaskTeamId = getSelectedTeamId();
        if (currentTaskTeamId && currentTaskTeamId === teamId) {
            loadActivitiesForTeam(teamId);
        }
    }).catch(function (err) {
        showToast(err.message || "Failed to create activity", true);
    });
}



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
            if (statDueTodayEl) statDueTodayEl.textContent = dueTodayCount;
            if (statDueWeekEl) statDueWeekEl.textContent = dueWeekCount;
            var taskCount = taskList.length;
            if (statTasksEl) statTasksEl.textContent = taskCount;

            if (!tbody) return;

            if (!tasks || tasks.length === 0) {
                tbody.innerHTML = "";
                if (emptyEl) {
                    emptyEl.hidden = false;
                    var desc = emptyEl.querySelector && emptyEl.querySelector(".empty-state-desc");
                    if (desc) desc.textContent = "Create a task above to get started.";
                }
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
                if (emptyEl) {
                    emptyEl.hidden = false;
                    var desc2 = emptyEl.querySelector && emptyEl.querySelector(".empty-state-desc");
                    if (desc2) desc2.textContent = currentActivityIdForView ? "No tasks for this activity yet." : "No tasks yet.";
                }
                return;
            }
            if (emptyEl) emptyEl.hidden = true;

            tbody.innerHTML = filteredTasks.map(function (t) {
                var dueRaw = t.due_date || null;
                var due = dueRaw || "—";
                var daysLeft = computeWorkingDaysLeft(dueRaw);
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
                var hasMultiAssignees = assignees && assignees.length > 0;
                var assignedDisplay;
                var assignedCell;
                if (hasMultiAssignees) {
                    var n = assignees.length;
                    if (n === 1) {
                        // Exactly one assignee via multi-assign: show a simple label (no dropdown) to avoid duplicate-looking entries.
                        var aSingle = assignees[0];
                        var nameSingle = aSingle.username || "User " + aSingle.user_id;
                        var pctSingle = aSingle.percent_share != null ? " " + aSingle.percent_share + "%" : "";
                        var leadSingle = aSingle.is_lead ? " (Lead)" : "";
                        assignedCell = "<span>" + escapeHtml(nameSingle + pctSingle + leadSingle) + "</span>";
                    } else {
                        var summaryText = n + " assignees";
                        var firstOpt = "<option value=\"\" selected disabled>" + escapeHtml(summaryText) + "</option>";
                        var restOpts = assignees.map(function (a) {
                            var name = a.username || "User " + a.user_id;
                            var pct = a.percent_share != null ? " " + a.percent_share + "%" : "";
                            var lead = a.is_lead ? " Lead" : "";
                            return "<option value=\"\" disabled>" + escapeHtml(name + pct + lead) + "</option>";
                        }).join("");
                        assignedCell = "<select class=\"status-select assigned-select\" title=\"Assignees\">" + firstOpt + restOpts + "</select>";
                    }
                } else {
                    assignedDisplay = t.assigned_username || "—";
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

                var extCellHtml = "<button " + extBtnAttrs + extDataAttrs + " class=\"" + extBtnClass + "\">" + extBtnLabel + "</button>";

                // For Pending Completion: show View/Review in status cell (admin only)
                var compStatus = t.completion_status || null;
                var compRequestId = t.completion_request_id || null;
                var canApproveComp = t.can_approve_completion === true;
                var statusExtraBtns = "";
                if (compStatus === "pending" && canApproveComp) {
                    statusExtraBtns = " <button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--primary\" onclick=\"viewCompletionAttachment(" + compRequestId + ")\">View</button> <button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--pending\" onclick=\"reviewCompletionRequest(" + compRequestId + ", " + t.id + ", this)\">Review</button>";
                }

                var taskType = t.task_type || "Normal";
                var typeApprovalStatus = t.type_approval_status || "not_required";
                var canApproveType = t.can_approve_type === true;
                var typeCell = "<span class=\"task-type-badge task-type-" + taskType.toLowerCase() + "\">" + escapeHtml(taskType) + "</span>";
                if (typeApprovalStatus === "pending") {
                    typeCell += " <span class=\"task-type-pending\">Pending approval</span>";
                    if (canApproveType) {
                        typeCell += " <button type=\"button\" class=\"btn btn-sm btn-ext btn-ext--primary\" onclick=\"approveTaskType(" + t.id + ", true)\">Approve</button> <button type=\"button\" class=\"btn btn-sm btn-ghost\" onclick=\"approveTaskType(" + t.id + ", false)\">Reject</button>";
                    }
                } else if (typeApprovalStatus === "rejected") {
                    typeCell += " <span class=\"task-type-rejected\">Rejected</span>";
                }
                var descHtml = (t.description && t.description.trim())
                    ? escapeHtml(t.description).replace(/\n/g, "<br>")
                    : "<em class=\"text-muted\">No description</em>";
                return (
                    "<tr data-task-id=\"" + t.id + "\">" +
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
                    "<tr class=\"task-description-row task-description-row-hidden\" id=\"task-desc-" + t.id + "\" data-task-id=\"" + t.id + "\">" +
                    "<td colspan=\"9\"><div class=\"task-description\">" + descHtml + "</div></td>" +
                    "</tr>"
                );
            }).join("");
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
}

function buildActionsCellHtml(t, statusOpts, statusDisabled, dueRaw) {
    var baseSelect = "<select class=\"status-select\"" + statusDisabled +
        " data-due-date=\"" + escapeHtml(dueRaw || "") +
        "\" onchange=\"handleActionSelect(" + t.id + ", " +
        (t.activity_id != null ? t.activity_id : "null") + ", '" +
        String(t.status || "").replace(/'/g, "\\'") +
        "', this)\" title=\"" + (statusDisabled ? "Awaiting approval" : "") +
        "\">" + statusOpts + "</select>";

    var taskType = t.task_type || "Normal";
    if (taskType !== "Procurement") {
        return baseSelect;
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

    var stageSelect = '<select class=\"status-select procurement-stage-select\" onchange=\"handleProcurementStageChange(' + t.id + ', this)\">' + options + '</select>';

    return baseSelect + '<br><span class=\"procurement-stage-label\">Procurement stage:</span><br>' + stageSelect;
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
    if (!modal || !taskIdEl || !fileEl) return;
    taskIdEl.value = taskId;
    fileEl.value = "";
    modal.hidden = false;
}

function closeCompletionProofModal() {
    var modal = document.getElementById("completion-proof-modal");
    if (modal) modal.hidden = true;
}

function submitCompletionProof() {
    var taskIdEl = document.getElementById("completion-proof-task-id");
    var fileEl = document.getElementById("completion-proof-file");
    var submitBtn = document.getElementById("completion-proof-submit");
    if (!taskIdEl || !fileEl) return;
    var taskId = taskIdEl.value;
    var file = fileEl.files && fileEl.files[0];
    if (!file) {
        showToast("Please select a file", true);
        return;
    }
    if (submitBtn) submitBtn.disabled = true;
    var formData = new FormData();
    formData.append("file", file);
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

function reviewCompletionRequest(requestId, taskId, btnEl) {
    if (!requestId) return;
    var msg = "Approve or reject this completion proof?\n\nOK = Approve, Cancel = Reject.";
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
    localStorage.removeItem("role");
    window.location.href = "index.html";
}

loadUserTeams();
loadTasks();
initUsersManagementFilters();
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
})();
function createTask() {
    var teamId = document.getElementById("task-team").value;
    var activityId = document.getElementById("task-activity").value;
    var title = document.getElementById("task-title").value.trim();
    var desc = document.getElementById("task-desc").value.trim();

    var priority = document.getElementById("task-priority").value;
    var dueDate = document.getElementById("task-due").value;
    var assigneeEl = document.getElementById("task-assignee");
    var assignee = assigneeEl ? assigneeEl.value : "";
    var leadId = document.getElementById("task-lead") ? document.getElementById("task-lead").value : "";
    var share = document.getElementById("task-share") ? document.getElementById("task-share").value : "";
    var closureId = document.getElementById("task-closure") ? document.getElementById("task-closure").value : "";

    if (!teamId && !activityId) { showToast("Select a team or activity", true); return; }
    if (!title) { showToast("Enter a task title", true); return; }

    var taskTypeEl = document.getElementById("task-type");
    var taskType = taskTypeEl ? (taskTypeEl.value || "Normal") : "Normal";
    var payload = {
        title: title,
        description: desc || null,
        priority: priority,
        status: "To Do",
        task_type: taskType,
        team_id: teamId ? parseInt(teamId, 10) : null,
        activity_id: activityId ? parseInt(activityId, 10) : null,
        closure_approver_id: closureId ? parseInt(closureId, 10) : null
    };
    if (dueDate) payload.due_date = dueDate;

    var assigneesFromRows = canUseMultiAssign() ? getTaskAssigneesFromRows() : [];
    if (assigneesFromRows.length > 0) {
        payload.assignments = assigneesFromRows;
    } else {
        payload.assigned_to = assignee ? parseInt(assignee, 10) : null;
        payload.lead_person_id = leadId ? parseInt(leadId, 10) : null;
        payload.percent_share = share ? parseInt(share, 10) : null;
    }

    apiRequest("/tasks", "POST", payload)
        .then(function (t) {
            document.getElementById("task-title").value = "";
            var descEl = document.getElementById("task-desc");
            if (descEl) descEl.value = "";
            var dueEl = document.getElementById("task-due");
            if (dueEl) dueEl.value = "";
            var shareEl = document.getElementById("task-share");
            if (shareEl) shareEl.value = "";
            var list = document.getElementById("task-assignees-list");
            if (list) list.innerHTML = "";

            if (t.type_approval_status === "pending") {
                showToast("Task created and sent for type approval (Admin / Division Head / Team Lead / Project Director)");
            } else if (t.is_approved === false) {
                showToast("Task submitted for approval");
            } else {
                showToast("Task created");
            }
            loadTasks();
            loadActivityLogs();
        })
        .catch(function (err) {
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

function loadAllUsers() {
    var userRole = (localStorage.getItem("role") || "").toLowerCase();
    if (userRole !== "admin" && userRole !== "division head") return;

    apiRequest("/users", "GET")
        .then(function (users) {
            cachedAllUsers = users || [];
            applyUsersFilter();
        })
        .catch(function (err) {
            console.error("Failed to load users", err);
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

function renderUsers(users) {
    var tbody = document.getElementById("users-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    users.forEach(function (u) {
        var tr = document.createElement("tr");
        tr.setAttribute("data-user-id", u.id);

        var roleLower = (u.role || "member").toLowerCase();
        var roleDisplay = roleLower === "division head" ? "Division Head" : (roleLower === "admin" ? "Admin" : "Member");

        // ID
        var tdId = document.createElement("td");
        tdId.textContent = u.id;
        tr.appendChild(tdId);

        // Username
        var tdName = document.createElement("td");
        tdName.textContent = u.username;
        tr.appendChild(tdName);

        // Role
        var tdRole = document.createElement("td");
        tdRole.textContent = roleDisplay;
        tr.appendChild(tdRole);

        // Change role: quick buttons only (no dropdown)
        var tdAction = document.createElement("td");
        tdAction.className = "users-action-cell";

        var btnWrap = document.createElement("span");
        btnWrap.className = "users-quick-btns";
        if (roleLower !== "division head") {
            var btnDivHead = document.createElement("button");
            btnDivHead.type = "button";
            btnDivHead.className = "btn btn-sm btn-ghost";
            btnDivHead.textContent = "Set Division Head";
            btnDivHead.onclick = function () { setUserRoleConfirm(u.id, u.username, "division head"); };
            btnWrap.appendChild(btnDivHead);
        }
        if (roleLower !== "member") {
            var btnMember = document.createElement("button");
            btnMember.type = "button";
            btnMember.className = "btn btn-sm btn-ghost";
            btnMember.textContent = "Set Member";
            btnMember.onclick = function () { setUserRoleConfirm(u.id, u.username, "member"); };
            btnWrap.appendChild(btnMember);
        }
        tdAction.appendChild(btnWrap);
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
    });
}

function setUserRoleConfirm(userId, username, newRole) {
    var roleLabel = newRole === "division head" ? "Division Head" : "Member";
    if (!confirm("Set \"" + (username || userId) + "\" to " + roleLabel + "?")) return;
    updateUserRole(userId, newRole);
}

function updateUserRole(userId, newRole) {
    var roleLabel = (newRole === "division head" ? "Division Head" : (newRole === "admin" ? "Admin" : "Member"));

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

function initUsersManagementFilters() {
    var searchEl = document.getElementById("users-search");
    var roleEl = document.getElementById("users-role-filter");
    if (searchEl) searchEl.addEventListener("input", applyUsersFilter);
    if (searchEl) searchEl.addEventListener("keyup", applyUsersFilter);
    if (roleEl) roleEl.addEventListener("change", applyUsersFilter);
}
