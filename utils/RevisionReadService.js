/**
 * RevisionReadService.js
 *
 * The READ half of the FSM revision workflow. Everything that fetches and
 * reshapes existing FSM data lives here: the Inspection-smartform query chain,
 * the activity revision tree, and the per-smartform table assembly the UI
 * renders. No data is written from this module.
 *
 * All HTTP goes through FsmHttpClient (makeQueryRequest / toInList); all magic
 * strings come from fsmConstants. The CoreSQL constraints this code works
 * around (no subqueries, no reliable cross-DTO joins) are handled by sequential
 * queries with batched IN clauses and JS glue — never per-row looping.
 *
 * Three methods are public because the write service consumes them:
 *   getRevisionServiceCalls, getServiceCallIdByRevision, getRevisionActivityId.
 * The rest of the surface is the two UI entry points:
 *   getInspectionSmartformsForActivity, getActivityRevisionTree,
 *   getActivityTreeWithSmartforms.
 *
 * @file utils/RevisionReadService.js
 * @module utils/RevisionReadService
 * @requires ./FsmHttpClient
 * @requires ./fsmConstants
 */
'use strict';

const fsmHttp = require('./FsmHttpClient');
const DestinationService = require('./DestinationService');
const { DTO, UDF, REQUIRED_TAG, APPROVAL, DESTINATION_NAME } = require('./fsmConstants');

class RevisionReadService {

    // ─────────────────────────────────────────────────────────────────
    //  SMALL HELPERS
    // ─────────────────────────────────────────────────────────────────

    /**
     * Read a UDF value by name from a Query-API DTO's udfValues array.
     * Query API shape: { name, value } (differs from composite-tree).
     * @param {Object} w - DTO object that may carry udfValues
     * @param {string} udfName - e.g. UDF.REVISION_NUMBER
     * @returns {string|null}
     * @private
     */
    _udf(w, udfName) {
        const vals = (w && w.udfValues) || [];
        const hit = vals.find(u => u && u.name === udfName);
        return hit && hit.value != null ? hit.value : null;
    }

    /**
     * Parse the revision number from an activity/ServiceCall code.
     * Matches the trailing 'Rev-<n>' segment, tolerating leading zeros and an
     * FSM auto-suffix (e.g. '20103-Rev-007' -> 7, '8200002124-Rev-004-7' -> 4).
     * @param {string} code
     * @returns {number|null}
     * @private
     */
    _revisionNumberFromCode(code) {
        if (!code) return null;
        const m = /-Rev-0*(\d+)/i.exec(String(code));
        return m ? parseInt(m[1], 10) : null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  CHECKLIST INSTANCES (SMARTFORMS) — Inspection query chain
    // ─────────────────────────────────────────────────────────────────

    /**
     * Query 1 - closed ChecklistInstances for an Activity.
     * Carries the template UUID through so the chain can resolve names/tags.
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<Object>>}
     * @private
     */
    async _getChecklistInstances(objectId) {
        const query = `SELECT w.id, w.template, w.description, w.closed, w.lastChanged, w.udf.Z_PreviousChecklist, w.udf.Z_PruefberichtNr FROM ChecklistInstance w WHERE w.object.objectId = '${objectId}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.CHECKLIST_INSTANCE);

        if (!data.data || data.data.length === 0) return [];

        return data.data.map(item => {
            const w = item.w;
            const desc = (w.description && w.description.trim()) ? w.description.trim() : null;
            return {
                id: w.id,
                // Smartform Description: real description, else fall back to the ID.
                description: desc ? `${desc} (${w.id})` : w.id,
                // Clean description (no ID concat) for table cells.
                rawDescription: desc || '',
                template: w.template || null,
                // Open/closed status (now that open smartforms are shown too).
                closed: w.closed === true,
                // Epoch-millis last-changed; used to sort tables newest-first.
                lastChanged: w.lastChanged != null ? Number(w.lastChanged) : 0,
                // Z_PreviousChecklist links a smartform to its predecessor;
                // when it equals own id, the smartform is an original (root).
                // Selecting w.udf.Z_PreviousChecklist explicitly makes FSM return
                // it inside udfValues WITH the `name` field (a bare SELECT w omits
                // `name`, leaving only meta/value, which cannot be matched).
                previousChecklist: this._udf(w, UDF.PREVIOUS_CHECKLIST),
                // Z_PruefberichtNr (report number) carried for the smartform payload.
                pruefberichtNr: this._udf(w, UDF.PRUEFBERICHT_NR)
            };
        });
    }

    /**
     * Query 2 - ChecklistTemplates by id (batched IN clause).
     * Requests w.id explicitly so results can be keyed back to instances.
     * @param {Array<string>} templateIds
     * @returns {Promise<Map<string, {name: string, tags: Array<string>}>>}
     * @private
     */
    async _getTemplatesByIds(templateIds) {
        const inList = fsmHttp.toInList(templateIds);
        if (!inList) return new Map();

        const query = `SELECT w.id, w.name, w.tags FROM ChecklistTemplate w WHERE w.id IN (${inList})`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.CHECKLIST_TEMPLATE);

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (w && w.id) {
                    map.set(w.id, { name: w.name || null, tags: w.tags || [] });
                }
            });
        }
        return map;
    }

    /**
     * Query 3 - ChecklistTag names by id (batched IN clause).
     * Requests w.id explicitly so each name maps back to its tag UUID.
     * @param {Array<string>} tagIds
     * @returns {Promise<Map<string, string>>} Map of tag id -> tag name.
     * @private
     */
    async _getTagNamesByIds(tagIds) {
        const inList = fsmHttp.toInList(tagIds);
        if (!inList) return new Map();

        const query = `SELECT w.id, w.name FROM ChecklistTag w WHERE w.id IN (${inList})`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.CHECKLIST_TAG);

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (w && w.id) map.set(w.id, w.name || null);
            });
        }
        return map;
    }

    /**
     * Query 4 - Attachments for a set of source objects (batched IN clause).
     * Groups results by sourceObject.objectId, since one smartform may have
     * several attachments.
     * @param {Array<string>} sourceObjectIds - ChecklistInstance UUIDs
     * @returns {Promise<Map<string, Array<{id: string, fileName: string}>>>}
     * @private
     */
    async _getAttachmentsBySourceIds(sourceObjectIds) {
        const inList = fsmHttp.toInList(sourceObjectIds);
        if (!inList) return new Map();

        const query = `SELECT w FROM Attachment w WHERE w.sourceObject.objectId IN (${inList})`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.ATTACHMENT);

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                const srcId = w && w.sourceObject ? w.sourceObject.objectId : null;
                if (!srcId) return;
                if (!map.has(srcId)) map.set(srcId, []);
                map.get(srcId).push({ id: w.id, fileName: w.fileName || null });
            });
        }
        return map;
    }

    /**
     * Fetch the attachment for a specific smartform on a specific activity.
     * Matched by BOTH sourceObject.objectId (smartform) and object.objectId
     * (activity), so each smartform row gets its own activity-specific file.
     * Returns the first attachment found, or null if none.
     *
     * @param {string} smartformId - ChecklistInstance id (sourceObject.objectId)
     * @param {string} activityId  - Activity id (object.objectId)
     * @returns {Promise<{fileName: string, description: string}|null>}
     * @private
     */
    async _getAttachmentForSmartform(smartformId, activityId) {
        if (!smartformId || !activityId) return null;

        const query = `SELECT w.udf.Z_Attachment_Description, w.fileName FROM Attachment w WHERE w.sourceObject.objectId = '${smartformId}' AND w.object.objectId = '${activityId}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.ATTACHMENT);

        if (!data.data || data.data.length === 0) return null;

        const w = data.data[0].w;
        return {
            fileName: w.fileName || '',
            description: this._udf(w, UDF.ATTACHMENT_DESCRIPTION) || ''
        };
    }

    /**
     * Orchestrate the three-query chain for an Activity and return the
     * smartforms whose template is tagged "Inspection".
     *
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<Object>>} UI-shaped list; only Inspection-tagged
     *          instances, each with its attachments (may be empty).
     */
    async getInspectionSmartformsForActivity(objectId) {
        try {
            if (!objectId) return [];

            // 1) Instances for the activity.
            const instances = await this._getChecklistInstances(objectId);
            if (instances.length === 0) return [];

            // 2) Resolve template name + tags for all distinct templates at once.
            const templateIds = instances.map(i => i.template).filter(Boolean);
            const templateMap = await this._getTemplatesByIds(templateIds);

            // 3) Resolve all distinct tag UUIDs across those templates at once.
            const allTagIds = [];
            templateMap.forEach(t => { (t.tags || []).forEach(id => allTagIds.push(id)); });
            const tagNameMap = await this._getTagNamesByIds(allTagIds);

            // Glue: attach template name, decide Inspection membership, filter.
            const result = [];
            instances.forEach(inst => {
                const tmpl = inst.template ? templateMap.get(inst.template) : null;
                if (!tmpl) return; // no template resolved -> cannot qualify

                const tagNames = (tmpl.tags || []).map(id => tagNameMap.get(id)).filter(Boolean);
                const isInspection = tagNames.includes(REQUIRED_TAG);
                if (!isInspection) return; // filtered out

                result.push({
                    id: inst.id,
                    description: inst.description,
                    rawDescription: inst.rawDescription || '',
                    previousChecklist: inst.previousChecklist || null,
                    pruefberichtNr: inst.pruefberichtNr || null,
                    closed: inst.closed === true,
                    lastChanged: inst.lastChanged || 0,
                    name: tmpl.name || null,
                    attachments: []
                });
            });

            if (result.length === 0) return [];

            // 4) Attachments for the surviving smartforms only (batched IN).
            const survivingIds = result.map(r => r.id);
            const attachmentMap = await this._getAttachmentsBySourceIds(survivingIds);
            result.forEach(r => {
                r.attachments = attachmentMap.get(r.id) || [];
            });

            return result;
        } catch (error) {
            console.error('RevisionReadService: Error building inspection smartforms:', error.message);
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  ACTIVITY REVISION TREE
    // ─────────────────────────────────────────────────────────────────

    /**
     * Build the FSM shell deep-link for an activity (same format used for the
     * revision links written into activity UDFs). Returns '' if either input is
     * missing, so the frontend can treat empty href as "not a link".
     * @param {string} activityId
     * @param {string} baseUrl - FSM base URL (trailing slashes trimmed)
     * @param {string} companyId - numeric company id
     * @returns {string} full URL or ''
     * @private
     */
    _activityDeepLink(activityId, baseUrl, companyId) {
        if (!activityId || !baseUrl || companyId == null || companyId === '') return '';
        const base = String(baseUrl).replace(/\/+$/, '');
        return `${base}/shell/#/planning-dispatching/activities/view/${activityId}/details?selectedCompanyId=${companyId}`;
    }

    /**
     * Look up a smartform's (ChecklistInstance's) approval status via the
     * Linker_Object UDO. Joins UdoValue -> UdoMeta and reads the
     * z_Linker_ApprovalActivity_Status UDF for the linker row whose
     * z_Linker_Checklist_Instance1 equals the smartform id.
     *
     * Returns the raw status string (e.g. 'Genehmigt', 'Offen') or null when no
     * linker row exists ({ data: [] }) or the value is absent.
     *
     * @param {string} smartformId - ChecklistInstance id
     * @returns {Promise<string|null>} status value, or null
     * @private
     */
    async _getSmartformApprovalStatus(smartformId) {
        if (!smartformId) return null;
        const dtos = `${DTO.UDO_META};${DTO.UDO_VALUE}`;
        const query =
            `SELECT w.udf.${UDF.LINKER_APPROVAL_STATUS} FROM UdoValue w ` +
            `JOIN UdoMeta m ON m.id = w.meta ` +
            `WHERE m.name = '${APPROVAL.LINKER_META_NAME}' ` +
            `AND w.udf.${UDF.LINKER_CHECKLIST_INSTANCE} = '${smartformId}'`;

        try {
            const data = await fsmHttp.makeQueryRequest(query, dtos);
            const rows = (data && Array.isArray(data.data)) ? data.data : [];
            if (rows.length === 0) {
                return null;
            }

            // Read the status value from the first row's udfValues (Query API
            // shape: { name, value }). Name-match is defensive in case the
            // projection returns multiple UDFs.
            const w = rows[0] && rows[0].w;
            const udfVals = (w && Array.isArray(w.udfValues)) ? w.udfValues : [];
            const hit = udfVals.find(u => u && u.name === UDF.LINKER_APPROVAL_STATUS);
            const value = (hit && hit.value != null) ? hit.value : null;
            return value;
        } catch (error) {
            // On error, return null. The caller treats null as "not approved"
            // -> the smartform is hidden (fail-closed).
            console.error(`RevisionReadService: approval lookup failed for smartform ${smartformId}:`, error.message);
            return null;
        }
    }

    /**
     * Activity core fields by Activity id. Used both to classify the context
     * activity (original vs revision) and to read the original's
     * code/subject/serviceCallId. object.objectId is the parent ServiceCall id.
     * @param {string} activityId
     * @returns {Promise<Object|null>}
     * @private
     */
    async _getActivityCore(activityId) {
        const query = `SELECT w.id, w.previousActivity, w.code, w.subject, w.object.objectId FROM Activity w WHERE w.id = '${activityId}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.ACTIVITY);

        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return {
            id: w.id || activityId,
            previousActivity: w.previousActivity || null,
            code: w.code != null ? w.code : null,
            subject: w.subject != null ? w.subject : null,
            // CoreSQL returns the dotted alias as a flat key on w.
            serviceCallId: w['object.objectId'] || (w.object ? w.object.objectId : null) || null
        };
    }

    /**
     * Look up a revision ServiceCall id by its revision UDFs (suffix-proof).
     * Decides whether a revision ServiceCall already exists (append) or must be
     * created. Public: consumed by the write service.
     * @param {string} originalCode - original activity code (e.g. '19846')
     * @param {number} n - revision number
     * @returns {Promise<string|null>} existing SC id, or null if none
     */
    async getServiceCallIdByRevision(originalCode, n) {
        if (!originalCode || n == null) return null;
        // Match by the revision UDFs, NOT the code: FSM auto-suffixes duplicate
        // ServiceCall codes (e.g. '8200002124-Rev-004-7'), so a bare-code match
        // would never find the SC it just created and would create a new one
        // every time. The UDFs are stable regardless of the stored code.
        const query = `SELECT w.id, w.udf.Z_RevisionOfActivity, w.udf.Z_revisionNumber FROM ServiceCall w WHERE w.udf.Z_RevisionOfActivity = '${originalCode}' AND w.udf.Z_revisionNumber = '${n}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.SERVICE_CALL);
        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return (w && w.id) ? w.id : null;
    }

    /**
     * Look up the revision Activity for a given level (one activity per level).
     * Matched via its ServiceCall (suffix-proof): the activity's object.objectId
     * points at the level-N ServiceCall. Public: consumed by the write service.
     * @param {string} originalActivityId - the original activity id
     * @param {string} serviceCallId - the level-N ServiceCall id (or null)
     * @returns {Promise<string|null>} existing activity id, or null if none
     */
    async getRevisionActivityId(originalActivityId, serviceCallId) {
        if (!originalActivityId || !serviceCallId) return null;
        // The revision activity links to its ServiceCall via object.objectId, is
        // a revision type, and points back to the original via previousActivity.
        const query = `SELECT w.id, w.object.objectId FROM Activity w WHERE w.previousActivity = '${originalActivityId}' AND w.udf.Z_Activity_Type = '-7' AND w.object.objectId = '${serviceCallId}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.ACTIVITY);
        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return (w && w.id) ? w.id : null;
    }

    /**
     * Revision ServiceCalls for an original activity code.
     * Maps ServiceCall id -> revision number via the Z_revisionNumber UDF.
     * Public: consumed by the write service (fallback next-number computation).
     * @param {string} originalCode - the original activity's code (e.g. '19846')
     * @returns {Promise<Map<string, number>>} ServiceCall id -> revision number
     */
    async getRevisionServiceCalls(originalCode) {
        if (!originalCode) return new Map();

        const query = `SELECT w.id, w.udf.Z_RevisionOfActivity, w.udf.Z_revisionNumber FROM ServiceCall w WHERE w.udf.Z_RevisionOfActivity = '${originalCode}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.SERVICE_CALL);

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (!w || !w.id) return;
                const num = this._udf(w, UDF.REVISION_NUMBER);
                map.set(w.id, num != null ? parseInt(num, 10) : null);
            });
        }
        return map;
    }

    /**
     * Revision Activities for an original activity id.
     * object.objectId on these rows is the ServiceCall id, used to join the
     * revision number from getRevisionServiceCalls.
     * @param {string} originalActivityId
     * @returns {Promise<Array<Object>>}
     * @private
     */
    async _getRevisionActivities(originalActivityId) {
        const query = `SELECT w.id, w.object.objectId, w.subject, w.code FROM Activity w WHERE w.previousActivity = '${originalActivityId}' AND w.udf.Z_Activity_Type = '-7'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.ACTIVITY);

        if (!data.data) return [];

        return data.data.map(item => {
            const w = item.w;
            return {
                id: w.id || null,
                // CoreSQL returns the dotted alias as a flat key on w.
                serviceCallId: w['object.objectId'] || (w.object ? w.object.objectId : null) || null,
                subject: w.subject != null ? w.subject : null,
                code: w.code != null ? w.code : null
            };
        });
    }

    /**
     * Build the activity revision tree for the activity currently in context.
     * Resolves the original activity (whether context is original or revision),
     * then lists original + all revisions ordered by revision number ascending.
     *
     * @param {string} contextActivityId - Activity id from the FSM context
     * @returns {Promise<Array<Object>>}
     */
    async getActivityRevisionTree(contextActivityId) {
        try {
            if (!contextActivityId) return [];

            // 1) Classify the context activity.
            const ctx = await this._getActivityCore(contextActivityId);
            if (!ctx) return [];

            // 2) Resolve the original activity (id + code + subject + serviceCallId).
            let original;
            if (!ctx.previousActivity) {
                // Context IS the original.
                original = { id: ctx.id, code: ctx.code, subject: ctx.subject, serviceCallId: ctx.serviceCallId };
            } else {
                // Context is a revision; previousActivity is the original's id.
                const orig = await this._getActivityCore(ctx.previousActivity);
                if (!orig) return [];
                original = { id: orig.id, code: orig.code, subject: orig.subject, serviceCallId: orig.serviceCallId };
            }

            // 3) Revision ServiceCalls (id -> revision number) by original code.
            const scNumberMap = await this.getRevisionServiceCalls(original.code);

            // 4) Revision Activities for the original, joined to revision number.
            const revActivities = await this._getRevisionActivities(original.id);

            const revisions = revActivities.map(ra => {
                // Primary: parse the revision number from the activity code
                // (e.g. '20103-Rev-007' -> 7). The code is a reliable top-level
                // field. Fallback: the ServiceCall id -> number join (only works
                // if object.objectId came back on the activity rows).
                let num = this._revisionNumberFromCode(ra.code);
                if (num == null && ra.serviceCallId) {
                    const joined = scNumberMap.get(ra.serviceCallId);
                    if (joined != null) num = joined;
                }
                return {
                    isOriginal: false,
                    revisionNumber: (num != null ? num : null),
                    revisionLabel: (num != null ? `Rev-${num}` : 'Rev-?'),
                    id: ra.id,
                    code: ra.code,
                    subject: ra.subject
                };
            });

            // Sort by revision number ascending; unknowns last.
            revisions.sort((a, b) => {
                if (a.revisionNumber == null) return 1;
                if (b.revisionNumber == null) return -1;
                return a.revisionNumber - b.revisionNumber;
            });

            // 5) Original first, then revisions.
            const originalRow = {
                isOriginal: true,
                revisionNumber: 0,
                revisionLabel: 'Original',
                id: original.id,
                code: original.code,
                subject: original.subject,
                serviceCallId: original.serviceCallId
            };

            return [originalRow, ...revisions];
        } catch (error) {
            console.error('RevisionReadService: Error building activity revision tree:', error.message);
            return [];
        }
    }

    /**
     * Resolve a smartform's root (original) id by following the
     * Z_PreviousChecklist chain until a self-reference is found.
     * A smartform whose previousChecklist === own id is itself a root.
     * Guards against missing links and cycles.
     * @param {string} smartformId
     * @param {Map<string, Object>} byId - id -> smartform { id, previousChecklist }
     * @returns {string|null} root smartform id, or null if unresolvable
     * @private
     */
    _resolveRootChecklistId(smartformId, byId) {
        let currentId = smartformId;
        const seen = new Set();

        while (currentId && !seen.has(currentId)) {
            seen.add(currentId);
            const sf = byId.get(currentId);
            if (!sf) return null; // predecessor not among fetched smartforms
            const prev = sf.previousChecklist;
            if (!prev || prev === currentId) {
                return currentId; // self-reference (or no link) => this is the root
            }
            currentId = prev;
        }
        return null; // cycle or dead end
    }

    /**
     * Build the per-smartform table structure across the whole activity tree.
     * Fetches Inspection smartforms for EVERY activity (original + revisions),
     * groups them into tables by root (original) smartform via the
     * Z_PreviousChecklist chain, and fills attachment columns per populated row.
     *
     * @param {string} contextActivityId - Activity id from the FSM context
     * @returns {Promise<{activities: Array<Object>, tables: Array<Object>, originalServiceCallId?: string, originalActivityId?: string, originalCode?: string}>}
     */
    async getActivityTreeWithSmartforms(contextActivityId) {
        try {
            const tree = await this.getActivityRevisionTree(contextActivityId);
            if (!tree || tree.length === 0) {
                return { activities: [], tables: [] };
            }

            // Base URL + company id for the per-row activity deep-links (Code
            // column hyperlinks). Same destination the write pipeline uses for
            // revision links. Failure is non-fatal: links fall back to ''.
            let linkBaseUrl = '';
            let linkCompanyId = '';
            try {
                const destination = await DestinationService.getDestination(DESTINATION_NAME);
                const dcfg = (destination && destination.destinationConfiguration) || {};
                linkBaseUrl = dcfg.URL || '';
                linkCompanyId = dcfg['URL.headers.X-Company-ID'] || '';
            } catch (e) {
                console.error('RevisionReadService: destination lookup failed for activity deep-links:', e.message);
            }

            // Shared activity lineage (already ordered: original, then revisions).
            const activities = tree.map(a => ({
                isOriginal: !!a.isOriginal,
                revisionLabel: a.revisionLabel,
                revisionNumber: a.revisionNumber,
                code: a.code != null ? a.code : '',
                id: a.id,
                subject: a.subject != null ? a.subject : '',
                // Deep-link to this activity for the clickable Code column.
                activityUrl: this._activityDeepLink(a.id, linkBaseUrl, linkCompanyId)
            }));

            // Original activity's ServiceCall id + activity id, for the Create
            // Revision composite-tree fetch.
            const originalEntry = tree.find(a => a.isOriginal) || {};
            const originalServiceCallId = originalEntry.serviceCallId || null;
            const originalActivityId = originalEntry.id || null;
            const originalCode = originalEntry.code || null;

            // 1) Fetch Inspection smartforms for every activity, tag with activityId.
            const perActivity = await Promise.all(
                activities.map(async act => {
                    const sfs = await this.getInspectionSmartformsForActivity(act.id);
                    return (sfs || []).map(sf => ({ ...sf, activityId: act.id }));
                })
            );
            // On the ORIGINAL activity, only show CLOSED smartforms (open ones are
            // still being worked on and shouldn't form a table). On REVISION
            // activities, show both (status column reflects open/closed).
            const allSmartforms = perActivity.flat().filter(sf =>
                sf.activityId !== originalActivityId || sf.closed === true
            );

            // 2) Index by id for chain resolution.
            const byId = new Map();
            allSmartforms.forEach(sf => byId.set(sf.id, sf));

            // 3) Group every smartform under its resolved root (via the
            //    Z_PreviousChecklist chain). Each smartform belongs to exactly
            //    one root's bucket.
            const smartformsByRoot = new Map(); // rootId -> [smartform, ...]
            allSmartforms.forEach(sf => {
                const rootId = this._resolveRootChecklistId(sf.id, byId);
                if (!rootId) return;
                if (!smartformsByRoot.has(rootId)) smartformsByRoot.set(rootId, []);
                smartformsByRoot.get(rootId).push(sf);
            });

            // Roots = smartforms on the ORIGINAL activity that are their own
            // root (previousChecklist self/null). One table per root.
            const candidateRoots = allSmartforms.filter(sf =>
                sf.activityId === originalActivityId &&
                (!sf.previousChecklist || sf.previousChecklist === sf.id)
            );

            // Only show originals whose approval status is APPROVED ('Genehmigt').
            // A non-approved original (e.g. 'Offen') doesn't get a table, since
            // revisions are only relevant once the original is approved. The
            // status comes from the Linker_Object UDO lookup (fail-closed: a
            // null/error status hides the smartform).
            const rootApprovals = await Promise.all(
                candidateRoots.map(sf => this._getSmartformApprovalStatus(sf.id))
            );
            const roots = candidateRoots.filter(
                (sf, i) => rootApprovals[i] === APPROVAL.APPROVED_STATUS
            );

            // Activity lookup (lineage order preserved) for row construction.
            const activityById = new Map();
            activities.forEach(act => activityById.set(act.id, act));

            // 4) Build one table per root. Rows are ONLY the activities whose
            //    smartforms belong to this root's chain (per-chain), with the
            //    original activity always present. Built in lineage order.
            const tables = roots.map(root => {
                const bucket = smartformsByRoot.get(root.id) || [];

                // The activity ids this table covers: every activity carrying a
                // smartform in this root's chain, plus the original activity.
                const sfByActivityId = new Map(); // activityId -> smartform (first wins)
                bucket.forEach(sf => {
                    if (!sfByActivityId.has(sf.activityId)) {
                        sfByActivityId.set(sf.activityId, sf);
                    }
                });
                const coveredActivityIds = new Set(sfByActivityId.keys());
                coveredActivityIds.add(originalActivityId); // original row always shown

                // Rows in lineage order, restricted to covered activities.
                const rows = activities
                    .filter(act => coveredActivityIds.has(act.id))
                    .map(act => {
                        const sf = sfByActivityId.get(act.id) || null;
                        return {
                            isOriginal: act.isOriginal,
                            revisionLabel: act.revisionLabel,
                            revisionNumber: act.revisionNumber,
                            code: act.code,
                            id: act.id,
                            subject: act.subject,
                            // Deep-link for the clickable Code column (carried
                            // from the activities lineage; '' when unavailable).
                            activityUrl: act.activityUrl || '',
                            smartformId: sf ? sf.id : '',
                            smartformDescription: sf ? (sf.rawDescription || sf.description || '') : '',
                            smartformName: sf ? (sf.name || '') : '',
                            attachmentDescription: '',
                            attachmentName: '',
                            hasSmartform: !!sf,
                            // Open/Closed status for the smartform on this row.
                            closed: sf ? (sf.closed === true) : false,
                            statusText: sf ? (sf.closed === true ? 'Closed' : 'Open') : ''
                        };
                    });

                return {
                    rootSmartformId: root.id,
                    smartformName: root.name || '',
                    smartformDescription: root.rawDescription || root.description || '',
                    rootPruefberichtNr: root.pruefberichtNr || null,
                    rootLastChanged: root.lastChanged || 0,
                    rows: rows
                };
            });

            // Per table: the LAST populated smartform row (highest revision with
            // a smartform). Rows are ordered Original -> Rev-1 -> ...; walk from
            // the end. Falls back to the root smartform if only it is populated.
            // Also compute this table's next revision number = (number of
            // revision rows in THIS table) + 1. Counting is per-table (per
            // smartform lineage), not global to the original activity.
            tables.forEach(t => {
                let lastId = t.rootSmartformId;
                for (let i = t.rows.length - 1; i >= 0; i--) {
                    if (t.rows[i].hasSmartform && t.rows[i].smartformId) {
                        lastId = t.rows[i].smartformId;
                        break;
                    }
                }
                t.lastSmartformId = lastId;

                const revisionRowCount = t.rows.filter(r => !r.isOriginal).length;
                t.nextRevisionNumber = revisionRowCount + 1;
            });

            // 5) Fetch attachments for every populated row (smartform + activity)
            //    and fill the attachment columns. Empty rows are skipped.
            const populatedRows = [];
            tables.forEach(t => {
                t.rows.forEach(row => {
                    if (row.hasSmartform && row.smartformId) {
                        populatedRows.push(row);
                    }
                });
            });

            await Promise.all(populatedRows.map(async row => {
                const att = await this._getAttachmentForSmartform(row.smartformId, row.id);
                if (att) {
                    row.attachmentName = att.fileName || '';
                    row.attachmentDescription = att.description || '';
                }
            }));

            // Sort tables by their root smartform's lastChanged, newest first.
            tables.sort((a, b) => (b.rootLastChanged || 0) - (a.rootLastChanged || 0));

            return { activities, tables, originalServiceCallId, originalActivityId, originalCode };
        } catch (error) {
            console.error('RevisionReadService: Error building tree with smartforms:', error.message);
            return { activities: [], tables: [] };
        }
    }
}

module.exports = new RevisionReadService();