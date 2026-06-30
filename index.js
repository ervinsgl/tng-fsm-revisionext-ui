/**
 * index.js - Backend Server
 *
 * Express.js server for the FSM Mobile Web Container app.
 * Receives the FSM Mobile POST context, stores it per-session,
 * and serves the UI5 frontend.
 *
 * Session fix: each user gets their own context slot keyed by
 * userName + cloudId. Avoids one user's POST overwriting another's.
 * Sessions are cleaned up after 1 hour to prevent unbounded growth.
 *
 * @file index.js
 * @requires express
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const readSvc = require('./utils/RevisionReadService');
const writeSvc = require('./utils/RevisionWriteService');
const jwtValidator = require('./utils/FSMJwtValidator');
const { createRequireSession } = require('./utils/requireSession');

const app = express();

// ===========================
// SESSION CONTEXT STORAGE
// ===========================

/**
 * Map of sessionKey -> { ...fsmContext, _timestamp }
 * Key format: "<userName>-<cloudId>"
 * One entry per user+object combination, cleaned up after SESSION_TTL_MS.
 */
const sessions = {};
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Map of sessionToken -> { contextKey, expires }
 * Issued by BOTH auth flows (Mobile cookie / Web UI Bearer) and validated by
 * the requireSession middleware on every /api/v1/* call. Sliding 60-min TTL.
 */
const sessionStore = new Map();

/**
 * Issue a new opaque session token bound to a context key, store it with a
 * sliding TTL, and return the token string.
 * @param {string} contextKey - "<userName>-<cloudId>" or shell identity key
 * @returns {string} the session token
 */
function issueSessionToken(contextKey) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessionStore.set(token, { contextKey, expires: Date.now() + SESSION_TTL_MS });
    return token;
}

// Tier 3 middleware bound to this server's store + TTL.
const requireSession = createRequireSession({ sessionStore, ttlMs: SESSION_TTL_MS });

/**
 * Remove sessions older than SESSION_TTL_MS.
 * Runs every 10 minutes.
 */
setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    Object.keys(sessions).forEach(key => {
        if (sessions[key]._timestamp < cutoff) {
            delete sessions[key];
        }
    });
    // Evict expired session tokens too.
    const now = Date.now();
    for (const [token, entry] of sessionStore) {
        if (entry.expires < now) sessionStore.delete(token);
    }
}, 10 * 60 * 1000);

// ===========================
// MIDDLEWARE
// ===========================
app.use((req, res, next) => {
    // Required: allows FSM Mobile WebView to embed this app
    res.removeHeader('X-Frame-Options');
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.enable('trust proxy');

// ===========================
// WEB CONTAINER ENTRY POINT
// ===========================

/**
 * Stores FSM Mobile context in the session map and redirects to the app root.
 * The session key is passed as a URL query param so the frontend can
 * retrieve exactly its own context, even if other users open simultaneously.
 *
 * @param {Object} body - FSM Mobile POST body
 * @param {Object} res  - Express response
 */
function handleMobilePost(body, res) {
    const userName = body?.userName || 'unknown';
    const cloudId  = body?.cloudId  || 'unknown';
    const key = `${userName}-${cloudId}`;

    sessions[key] = { ...body, _timestamp: Date.now() };

    // Issue a session token for this context and deliver it as an HttpOnly
    // cookie (Mobile WebView stores first-party cookies reliably).
    const token = issueSessionToken(key);
    res.cookie('fsm_session', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        path: '/',
        maxAge: SESSION_TTL_MS
    });

    console.log(`WC-ACCESS-POINT: context stored, session issued | user: ${userName} | objectType: ${body?.objectType} | session: ${key}`);

    const host = res.req.protocol + '://' + res.req.get('host');
    res.redirect(`${host}/?session=${encodeURIComponent(key)}`);
}

/**
 * POST /web-container-access-point
 *
 * FSM Mobile sends a POST here when opening the web container.
 * Configure this URL in FSM Admin > Company > Web Containers.
 *
 * Context body contains:
 * { userName, authToken, cloudAccount, companyName, cloudId,
 *   objectType, language, dataCloudFullQualifiedDomainName }
 */
app.post('/web-container-access-point', (req, res) => {
    handleMobilePost(req.body || {}, res);
});

// Fallback: some FSM versions POST to root
app.post('/', (req, res) => {
    handleMobilePost(req.body || {}, res);
});

/**
 * POST /api/v1/shell-session-init
 * Body: { authToken: <FSM Shell JWT> }
 *
 * Web UI Shell flow (Tier 2 + Tier 3). Verifies the FSM-issued JWT against
 * FSM's JWKS, then issues a session token returned in the JSON body (no cookie
 * — browsers won't store a third-party cookie in the Shell iframe). The
 * frontend sends this token as `Authorization: Bearer <token>` thereafter.
 * This endpoint is intentionally NOT behind requireSession (it bootstraps it).
 */
app.post('/api/v1/shell-session-init', async (req, res) => {
    const authToken = req.body?.authToken;
    if (!authToken) {
        console.error('SHELL-INIT: rejected — missing authToken in body');
        return res.status(400).json({ message: 'Missing authToken.' });
    }

    try {
        const decoded = await jwtValidator.verify(authToken);
        // Identity from the verified payload; fall back gracefully on claim names.
        const userName = decoded.user_name || decoded.userName || decoded.sub || 'shell-user';
        const account = decoded.account || decoded.accountName || 'unknown';
        const contextKey = `${userName}-${account}`;
        const token = issueSessionToken(contextKey);
        console.log(`SHELL-INIT: session issued | user: ${userName}`);
        return res.json({ data: { sessionToken: token } });
    } catch (error) {
        console.error('SHELL-INIT: rejected — JWT validation failed:', error.message);
        return res.status(401).json({ message: 'JWT validation failed.' });
    }
});

/**
 * GET /web-container-context?session=<key>
 *
 * Frontend calls this on load to retrieve its own stored context.
 * Returns 404 if no session key is provided or the key is not found
 * (e.g. app opened directly in a browser, or session expired).
 */
app.get('/web-container-context', requireSession, (req, res) => {
    const key = req.query.session;

    if (!key) {
        return res.status(404).json({ message: 'No session key provided. Open from FSM Mobile.' });
    }

    const context = sessions[key];
    if (!context) {
        return res.status(404).json({ message: `Session '${key}' not found or expired.` });
    }

    // Return context without the internal timestamp field
    const { _timestamp, ...contextData } = context;
    return res.json(contextData);
});

/**
 * GET /api/activity-revisions?objectId=<activityId>
 *
 * Returns the activity revision tree (original first, then revisions by
 * revision number) with Inspection smartforms attached to the original
 * activity. Each row:
 *   { isOriginal, revisionLabel, revisionNumber, id, code, subject,
 *     smartforms: [{ id, description, name }] }
 *
 * objectId is the cloudId (Activity UUID) resolved from the FSM context.
 */
app.get('/api/v1/activity-revisions', requireSession, async (req, res) => {
    const objectId = req.query.objectId;

    if (!objectId) {
        return res.status(400).json({ message: 'Missing objectId query parameter.' });
    }

    try {
        const tree = await readSvc.getActivityTreeWithSmartforms(objectId);
        return res.json({ data: tree });
    } catch (error) {
        console.error('activity-revisions route error:', error.message);
        return res.status(502).json({ message: 'Failed to fetch activity revisions from FSM.' });
    }
});

/**
 * GET /api/service-call-tree
 *   ?serviceCallId=<id>&keepActivityId=<id>&originalCode=<code>
 *   &rootSmartformId=<id>&lastSmartformId=<id>&rootPruefberichtNr=<val>
 *
 * Builds the next-revision payload: transformed ServiceCall header + activity,
 * plus the new-revision smartform payload for the table whose button was
 * pressed. The next revision number is computed live (max + 1).
 */
app.get('/api/v1/service-call-tree', requireSession, async (req, res) => {
    const serviceCallId = req.query.serviceCallId;
    const keepActivityId = req.query.keepActivityId;
    const originalCode = req.query.originalCode;

    const smartform = {
        rootSmartformId: req.query.rootSmartformId,
        lastSmartformId: req.query.lastSmartformId,
        rootPruefberichtNr: req.query.rootPruefberichtNr,
        nextRevisionNumber: req.query.nextRevisionNumber
    };

    if (!serviceCallId) {
        return res.status(400).json({ message: 'Missing serviceCallId query parameter.' });
    }

    try {
        const tree = await writeSvc.buildNewRevisionPayload(serviceCallId, keepActivityId, originalCode, smartform);
        return res.json({ data: tree });
    } catch (error) {
        console.error('service-call-tree route error:', error.message);
        return res.status(502).json({ message: 'Failed to build new revision payload from FSM.' });
    }
});

/**
 * POST /api/create-revision
 * Body: { serviceCallId, keepActivityId, originalCode, smartform: {...} }
 *
 * Executes the full create flow: PATCH ServiceCall (create/append) -> POST
 * smartform (with the created activity id) -> PATCH original activity's
 * Z_FollowUpRevisions (only when a new revision activity was created).
 */
app.post('/api/v1/create-revision', requireSession, async (req, res) => {
    const { serviceCallId, keepActivityId, originalCode, smartform } = req.body || {};

    if (!serviceCallId) {
        return res.status(400).json({ message: 'Missing serviceCallId in request body.' });
    }

    try {
        const result = await writeSvc.createRevision(serviceCallId, keepActivityId, originalCode, smartform);
        return res.json({ data: result });
    } catch (error) {
        console.error('create-revision route error:', error.message);
        return res.status(502).json({ message: 'Failed to create revision: ' + error.message });
    }
});

// ===========================
// STATIC FILES (UI5 frontend)
// ===========================
app.use(express.static(path.join(__dirname, 'webapp')));

// ===========================
// START SERVER
// ===========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`FSM Web Container app running on port ${PORT}`);
});