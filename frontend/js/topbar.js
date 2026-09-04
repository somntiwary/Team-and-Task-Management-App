function clearAuthSession() {
    localStorage.removeItem("session_token");
    localStorage.removeItem("user_id");
    localStorage.removeItem("username");
    localStorage.removeItem("designation");
    localStorage.removeItem("role");
}

function logout() {
    var token = getSessionToken();
    if (token) {
        fetch(BASE_URL + "/logout?session_token=" + encodeURIComponent(token), { method: "POST" }).catch(function () { });
    }
    clearAuthSession();
    window.location.href = "index.html";
}

function updateTopbarIdentityFromStorage() {
    var username = localStorage.getItem("username") || "User";
    var role = localStorage.getItem("role") || "member";
    var designation = typeof getDisplayDesignation === "function"
        ? getDisplayDesignation(role, localStorage.getItem("designation") || "")
        : (localStorage.getItem("designation") || "");
    var userId = getUserId() || "-";
    var badge = document.getElementById("user-badge");
    var avatar = document.getElementById("user-avatar");
    var roleEl = document.getElementById("user-role");
    var topbarUserId = document.getElementById("topbar-user-id");

    if (typeof setUserNameBlock === "function") setUserNameBlock(badge, username, designation);
    else if (badge) badge.textContent = username;

    if (avatar) avatar.textContent = (username.charAt(0) || "U").toUpperCase();
    if (roleEl && typeof formatRole === "function") roleEl.textContent = formatRole(role);
    if (topbarUserId && typeof formatUserIdDisplay === "function") topbarUserId.textContent = formatUserIdDisplay(userId);
}

function syncTopbarUserProfile() {
    return apiRequest("/users/me", "GET").then(function (me) {
        if (!me) return me;
        if (me.username) localStorage.setItem("username", me.username);
        if (me.role) localStorage.setItem("role", me.role);
        localStorage.setItem(
            "designation",
            typeof getDisplayDesignation === "function"
                ? getDisplayDesignation(me.role, me.designation || "")
                : (me.designation || "")
        );
        updateTopbarIdentityFromStorage();
        updateNotificationBadge(me.unread_notifications || 0);
        document.dispatchEvent(new CustomEvent("user-profile-updated", { detail: me }));
        return me;
    }).catch(function () {
        updateTopbarIdentityFromStorage();
        return null;
    });
}

function updateNotificationBadge(count) {
    var badge = document.getElementById("notification-count");
    if (!badge) return;
    var safeCount = parseInt(count, 10) || 0;
    badge.textContent = safeCount > 99 ? "99+" : String(safeCount);
    badge.hidden = safeCount <= 0;
}

function renderNotifications(items) {
    var dropdown = document.getElementById("notification-dropdown");
    if (!dropdown) return;
    if (!Array.isArray(items) || !items.length) {
        dropdown.innerHTML = '<div class="notification-empty">No notifications yet.</div>';
        return;
    }

    dropdown.innerHTML = items.map(function (item) {
        var createdAt = "";
        if (item && item.created_at) {
            var date = new Date(item.created_at);
            if (!isNaN(date.getTime())) createdAt = date.toLocaleString();
        }
        return (
            '<div class="notification-item' + (!item.is_read ? ' notification-item--unread' : '') + '">' +
                '<div class="notification-message">' + escapeHtmlTopbar(item.message || "") + '</div>' +
                '<div class="notification-time">' + escapeHtmlTopbar(createdAt) + '</div>' +
            '</div>'
        );
    }).join("");
}

function refreshNotifications(markAsRead) {
    return apiRequest("/notifications", "GET").then(function (items) {
        renderNotifications(items || []);
        var unreadCount = (items || []).filter(function (item) { return item && !item.is_read; }).length;
        updateNotificationBadge(unreadCount);
        if (markAsRead && unreadCount > 0) {
            return apiRequest("/notifications/read-all", "POST", {}).then(function () {
                updateNotificationBadge(0);
                var list = Array.isArray(items) ? items.map(function (item) {
                    item.is_read = true;
                    return item;
                }) : [];
                renderNotifications(list);
            }).catch(function () { });
        }
    }).catch(function () {
        renderNotifications([]);
    });
}

function toggleNotificationDropdown() {
    var dropdown = document.getElementById("notification-dropdown");
    var trigger = document.getElementById("notification-trigger");
    var profileDropdown = document.getElementById("profile-menu-dropdown");
    var profileTrigger = document.getElementById("profile-menu-trigger");
    if (!dropdown || !trigger) return;

    var willOpen = !!dropdown.hidden;
    dropdown.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (profileDropdown && !profileDropdown.hidden) {
        profileDropdown.hidden = true;
        if (profileTrigger) profileTrigger.setAttribute("aria-expanded", "false");
    }
    if (willOpen) refreshNotifications(true);
}

function toggleProfileMenu() {
    var dropdown = document.getElementById("profile-menu-dropdown");
    var trigger = document.getElementById("profile-menu-trigger");
    var notificationDropdown = document.getElementById("notification-dropdown");
    var notificationTrigger = document.getElementById("notification-trigger");
    if (!dropdown || !trigger) return;

    var willOpen = !!dropdown.hidden;
    dropdown.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (notificationDropdown && !notificationDropdown.hidden) {
        notificationDropdown.hidden = true;
        if (notificationTrigger) notificationTrigger.setAttribute("aria-expanded", "false");
    }
}

function closeTopbarMenus() {
    var ids = [
        ["notification-dropdown", "notification-trigger"],
        ["profile-menu-dropdown", "profile-menu-trigger"]
    ];
    ids.forEach(function (pair) {
        var dropdown = document.getElementById(pair[0]);
        var trigger = document.getElementById(pair[1]);
        if (dropdown) dropdown.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
}

function openEditNamePrompt() {
    closeTopbarMenus();
    var currentName = localStorage.getItem("username") || "";
    var newName = window.prompt("Enter your new username:", currentName);
    if (newName === null) return;
    newName = String(newName || "").trim();
    if (!newName) {
        if (typeof showToast === "function") showToast("Please enter a username", true);
        else alert("Please enter a username");
        return;
    }
    if (newName === currentName) return;

    apiRequest("/users/me/username", "PUT", { username: newName })
        .then(function (user) {
            localStorage.setItem("username", user.username || newName);
            if (user.role) localStorage.setItem("role", (user.role || "").toLowerCase());
            localStorage.setItem("designation", user.designation || "");
            updateTopbarIdentityFromStorage();
            document.dispatchEvent(new CustomEvent("user-profile-updated", { detail: user }));
            if (typeof showToast === "function") showToast("Username updated");
        })
        .then(function () {
            return refreshNotifications(false);
        })
        .catch(function (err) {
            if (typeof showToast === "function") showToast(err.message || "Failed to update username", true);
            else alert(err.message || "Failed to update username");
        });
}

function initializeTopbarControls() {
    updateTopbarIdentityFromStorage();
    refreshNotifications(false);

    var notificationTrigger = document.getElementById("notification-trigger");
    var profileTrigger = document.getElementById("profile-menu-trigger");
    var editNameAction = document.getElementById("profile-edit-name");
    var logoutAction = document.getElementById("profile-logout");

    if (notificationTrigger && !notificationTrigger._boundTopbar) {
        notificationTrigger._boundTopbar = true;
        notificationTrigger.addEventListener("click", function (event) {
            event.stopPropagation();
            toggleNotificationDropdown();
        });
    }

    if (profileTrigger && !profileTrigger._boundTopbar) {
        profileTrigger._boundTopbar = true;
        profileTrigger.addEventListener("click", function (event) {
            event.stopPropagation();
            toggleProfileMenu();
        });
    }

    if (editNameAction && !editNameAction._boundTopbar) {
        editNameAction._boundTopbar = true;
        editNameAction.addEventListener("click", function (event) {
            event.preventDefault();
            openEditNamePrompt();
        });
    }

    if (logoutAction && !logoutAction._boundTopbar) {
        logoutAction._boundTopbar = true;
        logoutAction.addEventListener("click", function (event) {
            event.preventDefault();
            logout();
        });
    }

    if (!document._topbarOutsideClickBound) {
        document._topbarOutsideClickBound = true;
        document.addEventListener("click", function (event) {
            var insideNotification = event.target && event.target.closest && event.target.closest(".notification-wrap");
            var insideProfile = event.target && event.target.closest && event.target.closest(".profile-menu");
            if (!insideNotification && !insideProfile) closeTopbarMenus();
        });
    }

    if (!window._topbarNotificationInterval) {
        window._topbarNotificationInterval = window.setInterval(function () {
            refreshNotifications(false);
        }, 30000);
    }
}

function escapeHtmlTopbar(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}
