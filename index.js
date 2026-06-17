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
const FSMService = require('./utils/FSMService');

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
 * Remove sessions older than SESSION_TTL_MS.
 * Runs every 10 minutes.
 */
setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let removed = 0;
    Object.keys(sessions).forEach(key => {
        if (sessions[key]._timestamp < cutoff) {
            delete sessions[key];
            removed++;
        }
    });
    if (removed > 0) {
        console.log(`Session cleanup: removed ${removed} expired session(s). Active: ${Object.keys(sessions).length}`);
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

    console.log(`Web container opened | user: ${userName} | objectType: ${body?.objectType} | session: ${key}`);

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
 * GET /web-container-context?session=<key>
 *
 * Frontend calls this on load to retrieve its own stored context.
 * Returns 404 if no session key is provided or the key is not found
 * (e.g. app opened directly in a browser, or session expired).
 */
app.get('/web-container-context', (req, res) => {
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
 * GET /api/checklist-instances?objectId=<activityObjectId>
 *
 * Returns all closed ChecklistInstances (smartforms) for the given Activity
 * objectId, shaped for the UI list: [{ id, description }].
 *
 * objectId is the cloudId resolved from the FSM context (mobile or shell),
 * passed by the frontend. This keeps the route source-agnostic.
 */
app.get('/api/checklist-instances', async (req, res) => {
    const objectId = req.query.objectId;

    if (!objectId) {
        return res.status(400).json({ message: 'Missing objectId query parameter.' });
    }

    try {
        const instances = await FSMService.getInspectionSmartformsForActivity(objectId);
        return res.json({ data: instances });
    } catch (error) {
        console.error('checklist-instances route error:', error.message);
        return res.status(502).json({ message: 'Failed to fetch checklist instances from FSM.' });
    }
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
app.get('/api/activity-revisions', async (req, res) => {
    const objectId = req.query.objectId;

    if (!objectId) {
        return res.status(400).json({ message: 'Missing objectId query parameter.' });
    }

    try {
        const tree = await FSMService.getActivityTreeWithSmartforms(objectId);
        return res.json({ data: tree });
    } catch (error) {
        console.error('activity-revisions route error:', error.message);
        return res.status(502).json({ message: 'Failed to fetch activity revisions from FSM.' });
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