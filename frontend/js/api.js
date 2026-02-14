/**
 * API client for Saralta backend.
 * Uses session token for authenticated requests.
 */

// Use same host as frontend when opened via file; override for LAN
const BASE_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8000"
    : `${window.location.protocol}//${window.location.hostname}:8000`;

function getSessionToken() {
    return localStorage.getItem("session_token");
}

function getUserId() {
    return localStorage.getItem("user_id");
}

function isLoggedIn() {
    return !!getSessionToken();
}

/**
 * Make an authenticated API request.
 * @param {string} endpoint - e.g. "/login", "/tasks"
 * @param {string} method - GET, POST, PUT, DELETE
 * @param {object|null} data - body for POST/PUT
 * @param {boolean} useAuth - if false, do not send session token (e.g. login)
 */
async function apiRequest(endpoint, method, data = null, useAuth = true) {
    const options = {
        method,
        headers: { "Content-Type": "application/json" }
    };

    if (useAuth) {
        const token = getSessionToken();
        if (token) options.headers["X-Session-Token"] = token;
    }

    if (data && (method === "POST" || method === "PUT")) {
        options.body = JSON.stringify(data);
    }

    const url = BASE_URL + endpoint;
    const response = await fetch(url, options);

    let result;
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
        result = await response.json();
    } else {
        result = { detail: response.statusText || "Request failed" };
    }

    if (response.status === 401) {
        localStorage.removeItem("session_token");
        localStorage.removeItem("user_id");
        localStorage.removeItem("username");
        localStorage.removeItem("role");
        if (window.location.pathname.indexOf("dashboard") !== -1) {
            window.location.href = "index.html";
        }
        throw new Error(result.detail || "Session expired");
    }

    if (!response.ok) {
        const msg = result.detail || (typeof result.detail === "string" ? result.detail : JSON.stringify(result));
        throw new Error(msg);
    }

    return result;
}

/**
 * Make an authenticated API request with FormData (for file uploads).
 * @param {string} endpoint - e.g. "/tasks/123/completion-requests"
 * @param {string} method - POST
 * @param {FormData} formData - form data with file
 */
async function apiRequestFormData(endpoint, method, formData) {
    const options = {
        method,
        body: formData
    };

    const token = getSessionToken();
    if (token) options.headers = { "X-Session-Token": token };

    const url = BASE_URL + endpoint;
    const response = await fetch(url, options);

    let result;
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
        result = await response.json();
    } else {
        result = { detail: response.statusText || "Request failed" };
    }

    if (response.status === 401) {
        localStorage.removeItem("session_token");
        localStorage.removeItem("user_id");
        localStorage.removeItem("username");
        localStorage.removeItem("role");
        if (window.location.pathname.indexOf("dashboard") !== -1) {
            window.location.href = "index.html";
        }
        throw new Error(result.detail || "Session expired");
    }

    if (!response.ok) {
        const msg = result.detail || (typeof result.detail === "string" ? result.detail : JSON.stringify(result));
        throw new Error(msg);
    }

    return result;
}
