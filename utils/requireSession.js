/**
 * requireSession.js
 *
 * Tier 3 of the inbound auth model (see SECURITY.md): guards all /api/v1/*
 * routes (except /api/v1/shell-session-init) and /web-container-context.
 *
 * A session token is issued by one of the two auth flows:
 *   - Mobile WebContainer POST -> token set as the `fsm_session` cookie.
 *   - Web UI shell-session-init -> token returned in the JSON body, sent back
 *     by the frontend as `Authorization: Bearer <token>`.
 *
 * This middleware accepts EITHER source: cookie first, then Bearer header. A
 * valid token refreshes the session's expiry (sliding TTL). Missing or invalid
 * tokens return 401.
 *
 * The session store is owned by index.js and injected via createRequireSession
 * so this module holds no state of its own.
 *
 * @file utils/requireSession.js
 * @module utils/requireSession
 */
'use strict';

/**
 * Parse the `fsm_session` value out of a raw Cookie header. We avoid a
 * cookie-parser dependency since we only need this one cookie.
 * @param {string} cookieHeader - req.headers.cookie
 * @returns {string|null}
 */
function readSessionCookie(cookieHeader) {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        if (name === 'fsm_session') {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

/**
 * Extract a Bearer token from an Authorization header.
 * @param {string} authHeader - req.headers.authorization
 * @returns {string|null}
 */
function readBearer(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    return m ? m[1].trim() : null;
}

/**
 * Build the requireSession middleware bound to a given session store + TTL.
 *
 * @param {Object} opts
 * @param {Map<string, {contextKey: string, expires: number}>} opts.sessionStore
 *        Map from session token -> { contextKey, expires }.
 * @param {number} opts.ttlMs - sliding TTL in ms (e.g. 60 min).
 * @returns {Function} Express middleware
 */
function createRequireSession({ sessionStore, ttlMs }) {
    return function requireSession(req, res, next) {
        // Cookie first (Mobile), then Bearer (Web UI).
        let token = readSessionCookie(req.headers.cookie);
        let source = 'cookie';
        if (!token) {
            token = readBearer(req.headers.authorization);
            source = token ? 'bearer' : 'none';
        }

        if (!token) {
            console.error(`AUTH: rejected ${req.method} ${req.path} — missing-credential source=none`);
            return res.status(401).json({ message: 'Authentication required.' });
        }

        const entry = sessionStore.get(token);
        if (!entry || entry.expires < Date.now()) {
            if (entry) sessionStore.delete(token); // evict expired
            console.error(`AUTH: rejected ${req.method} ${req.path} — invalid-or-expired source=${source}`);
            return res.status(401).json({ message: 'Session invalid or expired.' });
        }

        // Sliding TTL: every authenticated request extends the session.
        entry.expires = Date.now() + ttlMs;
        sessionStore.set(token, entry);

        // Expose the resolved identity to downstream handlers.
        req.sessionContextKey = entry.contextKey;
        req.sessionSource = source;
        next();
    };
}

module.exports = { createRequireSession, readSessionCookie, readBearer };