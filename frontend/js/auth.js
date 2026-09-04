/**
 * Login and registration — connected to backend /login and /users.
 */

function showAuthMsg(text, isError = false) {
    const msg = document.getElementById("auth-msg");
    if (!msg) return;
    msg.textContent = text;
    msg.className = "auth-msg " + (isError ? "error" : "success");
    msg.hidden = false;
}

function formatUserIdDisplay(value) {
    const n = parseInt(value, 10);
    if (!n || n < 0) return String(value || "");
    if (n <= 999) return String(n).padStart(3, "0");
    return String(n);
}

function getDefaultLandingPage(roleValue) {
    return "workspace-views.html";
}

if (typeof isLoggedIn === "function" && isLoggedIn()) {
    window.location.href = getDefaultLandingPage();
}

function loadRegistrationDesignations() {
    const designationSelect = document.getElementById("reg-designation");
    if (!designationSelect) return;

    apiRequest("/user-options?option_type=designation", "GET", null, false)
        .then((items) => {
            const values = (Array.isArray(items) ? items : [])
                .filter((item) => item && item.value)
                .map((item) => String(item.value).trim())
                .filter((value, index, arr) => value && arr.indexOf(value) === index);
            if (!values.length) return;
            const previous = designationSelect.value || "";
            designationSelect.innerHTML = "";
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = "Select designation";
            designationSelect.appendChild(placeholder);
            values.forEach((value) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = value;
                if (previous === value) option.selected = true;
                designationSelect.appendChild(option);
            });
            if (previous) designationSelect.value = previous;
        })
        .catch(() => {
            // Keep fallback hardcoded options when catalog load fails.
        });
}

function login(event) {
    if (event) event.preventDefault();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    if (!username || !password) {
        showAuthMsg("Please enter username and password", true);
        return;
    }

    showAuthMsg("Signing in…");

    apiRequest("/login", "POST", { username, password }, false)
        .then((res) => {
            if (res.session_token) {
                localStorage.setItem("session_token", res.session_token);
                localStorage.setItem("user_id", res.user_id);
                localStorage.setItem("username", res.username || username);
                // Store role in lowercase so header and UI (e.g. multi-assign) work for all roles
                const role = (res.role || "member").toLowerCase();
                localStorage.setItem("role", role);
                localStorage.setItem("designation", res.designation || "");
                window.location.href = getDefaultLandingPage(role);
            } else {
                showAuthMsg(res.detail || "Login failed", true);
            }
        })
        .catch((err) => {
            showAuthMsg(err.message || "Invalid username or password", true);
        });
}

function showResetHelp(kind) {
    const detail = document.getElementById("auth-support-detail");
    const usernamePanel = document.getElementById("reset-username-panel");
    const passwordPanel = document.getElementById("reset-password-panel");

    if (detail) {
        detail.hidden = true;
        detail.textContent = "";
    }

    if (usernamePanel) {
        usernamePanel.hidden = kind !== "username";
    }
    if (passwordPanel) {
        passwordPanel.hidden = kind !== "password";
    }
}

function signup(event) {
    if (event) event.preventDefault();
    const username = document.getElementById("reg-username").value.trim();
    const password = document.getElementById("reg-password").value;
    const role = document.getElementById("reg-role").value;
    const designation = document.getElementById("reg-designation").value;

    if (!username || !password) {
        showAuthMsg("Please enter username and password", true);
        return;
    }
    if (!designation) {
        showAuthMsg("Please select designation", true);
        return;
    }
    if (username.toLowerCase() === password.toLowerCase()) {
        showAuthMsg("Username must not be the same as your password", true);
        return;
    }

    showAuthMsg("Creating account…");

    // Send role in lowercase so backend stores consistently (Admin -> admin, Member -> member)
    const roleNormalized = (role === "Admin" ? "admin" : "member");
    apiRequest("/users", "POST", { username, password, role: roleNormalized, designation }, false)
        .then((res) => {
            const id = res && res.id != null ? res.id : "—";
            showAuthMsg("Account created. Your user ID is " + formatUserIdDisplay(id) + ". Share this ID when someone assigns you a task or adds you to a team. Please sign in.", false);
            document.getElementById("username").value = username;
            document.getElementById("password").value = "";
            document.getElementById("password").focus();
        })
        .catch((err) => {
            showAuthMsg(err.message || "Registration failed", true);
        });
}

function resetUsername(event) {
    if (event) event.preventDefault();

    const userIdVal = document.getElementById("reset-username-user-id").value;
    const currentPassword = document.getElementById("reset-current-password").value;
    const newUsername = document.getElementById("reset-new-username").value.trim();

    const userId = parseInt(userIdVal, 10);
    if (!userId || userId <= 0) {
        showAuthMsg("Please enter a valid user ID", true);
        return;
    }
    if (!currentPassword || !newUsername) {
        showAuthMsg("Please fill in all username reset fields", true);
        return;
    }

    apiRequest("/auth/reset-username", "POST", {
        user_id: userId,
        current_password: currentPassword,
        new_username: newUsername
    }, false)
        .then(() => {
            showAuthMsg("Username updated successfully. You can now sign in with your new username.", false);
        })
        .catch((err) => {
            showAuthMsg(err.message || "Failed to reset username", true);
        });
}

function resetPassword(event) {
    if (event) event.preventDefault();

    const userIdVal = document.getElementById("reset-password-user-id").value;
    const username = document.getElementById("reset-password-username").value.trim();
    const newPassword = document.getElementById("reset-new-password").value;
    const confirmPassword = document.getElementById("reset-new-password-confirm").value;

    const userId = parseInt(userIdVal, 10);
    if (!userId || userId <= 0) {
        showAuthMsg("Please enter a valid user ID", true);
        return;
    }
    if (!username || !newPassword || !confirmPassword) {
        showAuthMsg("Please fill in all password reset fields", true);
        return;
    }
    if (newPassword !== confirmPassword) {
        showAuthMsg("New password and confirmation do not match", true);
        return;
    }

    apiRequest("/auth/reset-password", "POST", {
        user_id: userId,
        username,
        new_password: newPassword
    }, false)
        .then(() => {
            showAuthMsg("Password updated successfully. You can now sign in with your new password.", false);
        })
        .catch((err) => {
            showAuthMsg(err.message || "Failed to reset password", true);
        });
}

loadRegistrationDesignations();
