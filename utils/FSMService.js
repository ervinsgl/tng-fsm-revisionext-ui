/**
 * FSMService.js
 *
 * Backend service for SAP FSM (Field Service Management) API integration.
 *
 * Scope (revision extension):
 * - Authenticated Query API requests (/api/query/v1)
 * - Read closed ChecklistInstances (smartforms) for an Activity, enrich each
 *   with its ChecklistTemplate name, filter to those tagged "Inspection", and
 *   attach their Attachment file names.
 *
 * Query chain (no CoreSQL joins; JS glue between sequential HTTP queries,
 * using IN clauses with deduplicated, batched IDs - no per-row looping):
 *   1. ChecklistInstance  WHERE object.objectId = <activity> AND closed = true
 *   2. ChecklistTemplate  WHERE id IN (<distinct template ids>)   -> name, tags
 *   3. ChecklistTag       WHERE id IN (<distinct tag ids>)        -> name
 *   --> keep only instances whose template carries the "Inspection" tag
 *   4. Attachment         WHERE sourceObject.objectId IN (<surviving ids>)
 *
 * The outbound destination name is defined ONCE below (DESTINATION_NAME).
 * If the destination ever changes, change it in that single place.
 *
 * @file FSMService.js
 * @module utils/FSMService
 * @requires axios
 * @requires ./DestinationService
 * @requires ./TokenCache
 */
const axios = require('axios');
const DestinationService = require('./DestinationService');
const TokenCache = require('./TokenCache');

/**
 * The single BTP destination used for all outbound FSM calls in this app.
 * Change here only.
 * @type {string}
 */
const DESTINATION_NAME = 'FSM_S4E';

/**
 * The tag name a smartform's template must carry to be shown.
 * @type {string}
 */
const REQUIRED_TAG = 'Inspection';

class FSMService {
    constructor() {
        /**
         * Default FSM account/company configuration.
         * Used as a fallback when the destination does not carry these values.
         * @type {{account: string, company: string}}
         */
        this.config = {
            account: 'TUEV-NORD_T1',
            company: 'TUEV-NORD_S4E'
        };
    }

    /**
     * Make a Query API request (/api/query/v1).
     * @param {string} query - FSM CoreSQL query string
     * @param {string} dtos  - DTO version string (e.g. 'ChecklistInstance.20')
     * @returns {Promise<Object>} API response data ({ data: [...] })
     * @throws {Error} If the request fails
     */
    async makeQueryRequest(query, dtos) {
        try {
            const destination = await DestinationService.getDestination(DESTINATION_NAME);
            const token = await TokenCache.getToken(destination);

            const config = destination.destinationConfiguration;
            const baseUrl = config.URL;
            const queryUrl = `${baseUrl}/api/query/v1`;

            const queryParams = {
                query,
                dtos,
                account: config.account || this.config.account,
                company: config.company || this.config.company
            };

            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-Account-ID': config['URL.headers.X-Account-ID'],
                'X-Company-ID': config['URL.headers.X-Company-ID'],
                'X-Client-ID': config['URL.headers.X-Client-ID'],
                'X-Client-Version': config['URL.headers.X-Client-Version']
            };

            const response = await axios.get(queryUrl, { params: queryParams, headers });
            return response.data;

        } catch (error) {
            console.error('FSMService: Query API Error:', error.response?.data || error.message);
            throw error;
        }
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
        const data = await this.makeQueryRequest(query, 'Attachment.19');

        if (!data.data || data.data.length === 0) return null;

        const w = data.data[0].w;
        return {
            fileName: w.fileName || '',
            description: this._udf(w, 'Z_Attachment_Description') || ''
        };
    }

    /**
     * Build a CoreSQL IN-list literal from an array of UUIDs.
     * Deduplicates and quotes each value: ['a','b'] -> "'a','b'".
     * @param {Array<string>} ids
     * @returns {string} comma-separated quoted list (empty string if no ids)
     * @private
     */
    _toInList(ids) {
        const unique = [...new Set((ids || []).filter(Boolean))];
        return unique.map(id => `'${id}'`).join(',');
    }

    // ========================================
    // CHECKLIST INSTANCES (SMARTFORMS)
    // ========================================

    /**
     * Query 1 - closed ChecklistInstances for an Activity.
     * Carries the template UUID through so the chain can resolve names/tags.
     *
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<{id: string, description: string, template: string}>>}
     * @private
     */
    async _getChecklistInstances(objectId) {
        const query = `SELECT w.id, w.template, w.description, w.udf.Z_PreviousChecklist FROM ChecklistInstance w WHERE w.object.objectId = '${objectId}' AND w.closed = true`;
        const data = await this.makeQueryRequest(query, 'ChecklistInstance.20');

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
                // Z_PreviousChecklist links a smartform to its predecessor;
                // when it equals own id, the smartform is an original (root).
                // Selecting w.udf.Z_PreviousChecklist explicitly makes FSM return
                // it inside udfValues WITH the `name` field (a bare SELECT w omits
                // `name`, leaving only meta/value, which cannot be matched).
                previousChecklist: this._udf(w, 'Z_PreviousChecklist')
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
        const inList = this._toInList(templateIds);
        if (!inList) return new Map();

        const query = `SELECT w.id, w.name, w.tags FROM ChecklistTemplate w WHERE w.id IN (${inList})`;
        const data = await this.makeQueryRequest(query, 'ChecklistTemplate.21');

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
        const inList = this._toInList(tagIds);
        if (!inList) return new Map();

        const query = `SELECT w.id, w.name FROM ChecklistTag w WHERE w.id IN (${inList})`;
        const data = await this.makeQueryRequest(query, 'ChecklistTag.10');

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
     *          Map of sourceObject id -> array of attachments.
     * @private
     */
    async _getAttachmentsBySourceIds(sourceObjectIds) {
        const inList = this._toInList(sourceObjectIds);
        if (!inList) return new Map();

        const query = `SELECT w FROM Attachment w WHERE w.sourceObject.objectId IN (${inList})`;
        const data = await this.makeQueryRequest(query, 'Attachment.19');

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
     * Orchestrate the three-query chain for an Activity and return the
     * smartforms whose template is tagged "Inspection".
     *
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<{id: string, description: string, name: string, attachments: Array<{id: string, fileName: string}>}>>}
     *          UI-shaped list. Only Inspection-tagged instances are included,
     *          each with its attachments (may be empty).
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
            console.error('FSMService: Error building inspection smartforms:', error.message);
            return [];
        }
    }

    // ========================================
    // ACTIVITY REVISION TREE
    // ========================================

    /**
     * Read a UDF value by name from a DTO's udfValues array.
     * @param {Object} w - DTO object that may carry udfValues
     * @param {string} udfName - e.g. 'Z_revisionNumber'
     * @returns {string|null}
     * @private
     */
    _udf(w, udfName) {
        const vals = (w && w.udfValues) || [];
        const hit = vals.find(u => u && u.name === udfName);
        return hit && hit.value != null ? hit.value : null;
    }

    /**
     * Activity core fields by Activity id.
     * Used both to classify the context activity (original vs revision) and
     * to read the original's code/subject.
     * @param {string} activityId
     * @returns {Promise<{id: string, previousActivity: string|null, code: string|null, subject: string|null}|null>}
     * @private
     */
    async _getActivityCore(activityId) {
        const query = `SELECT w.id, w.previousActivity, w.code, w.subject FROM Activity w WHERE w.id = '${activityId}'`;
        const data = await this.makeQueryRequest(query, 'Activity.43');

        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return {
            id: w.id || activityId,
            previousActivity: w.previousActivity || null,
            code: w.code != null ? w.code : null,
            subject: w.subject != null ? w.subject : null
        };
    }

    /**
     * Revision ServiceCalls for an original activity code.
     * Maps ServiceCall id -> revision number via the Z_revisionNumber UDF.
     * @param {string} originalCode - the original activity's code (e.g. '19846')
     * @returns {Promise<Map<string, number>>} ServiceCall id -> revision number
     * @private
     */
    async _getRevisionServiceCalls(originalCode) {
        if (!originalCode) return new Map();

        const query = `SELECT w.id, w.udf.Z_RevisionOfActivity, w.udf.Z_revisionNumber FROM ServiceCall w WHERE w.udf.Z_RevisionOfActivity = '${originalCode}'`;
        const data = await this.makeQueryRequest(query, 'ServiceCall.27');

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (!w || !w.id) return;
                const num = this._udf(w, 'Z_revisionNumber');
                map.set(w.id, num != null ? parseInt(num, 10) : null);
            });
        }
        return map;
    }

    /**
     * Revision Activities for an original activity id.
     * object.objectId on these rows is the ServiceCall id, used to join the
     * revision number from _getRevisionServiceCalls.
     * @param {string} originalActivityId
     * @returns {Promise<Array<{id: string, serviceCallId: string|null, subject: string|null, code: string|null}>>}
     * @private
     */
    async _getRevisionActivities(originalActivityId) {
        const query = `SELECT w.id, w.object.objectId, w.subject, w.code FROM Activity w WHERE w.previousActivity = '${originalActivityId}' AND w.udf.Z_Activity_Type = '-7'`;
        const data = await this.makeQueryRequest(query, 'Activity.43');

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
     *
     * Resolves the original activity (whether context is the original or a
     * revision), then lists the original plus all its revisions ordered by
     * revision number ascending.
     *
     * @param {string} contextActivityId - Activity id from the FSM context
     * @returns {Promise<Array<{isOriginal: boolean, revisionLabel: string, revisionNumber: number|null, id: string, code: string|null, subject: string|null}>>}
     */
    async getActivityRevisionTree(contextActivityId) {
        try {
            if (!contextActivityId) return [];

            // 1) Classify the context activity.
            const ctx = await this._getActivityCore(contextActivityId);
            if (!ctx) return [];

            // 2) Resolve the original activity (id + code + subject).
            let original;
            if (!ctx.previousActivity) {
                // Context IS the original.
                original = { id: ctx.id, code: ctx.code, subject: ctx.subject };
            } else {
                // Context is a revision; previousActivity is the original's id.
                const orig = await this._getActivityCore(ctx.previousActivity);
                if (!orig) return [];
                original = { id: orig.id, code: orig.code, subject: orig.subject };
            }

            // 3) Revision ServiceCalls (id -> revision number) by original code.
            const scNumberMap = await this._getRevisionServiceCalls(original.code);

            // 4) Revision Activities for the original, joined to revision number.
            const revActivities = await this._getRevisionActivities(original.id);

            const revisions = revActivities.map(ra => {
                const num = ra.serviceCallId ? scNumberMap.get(ra.serviceCallId) : null;
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
                subject: original.subject
            };

            return [originalRow, ...revisions];
        } catch (error) {
            console.error('FSMService: Error building activity revision tree:', error.message);
            return [];
        }
    }

    /**
     * Resolve a smartform's root (original) id by following the
     * Z_PreviousChecklist chain until a self-reference is found.
     * A smartform whose previousChecklist === own id is itself a root.
     * Guards against missing links and cycles.
     *
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
     *
     * Fetches Inspection smartforms for EVERY activity (original + revisions),
     * then groups them into tables by their root (original) smartform, using
     * the Z_PreviousChecklist chain. Within each table, every smartform sits
     * on the row of the activity it belongs to.
     *
     * Row shape (per table):
     *   revisionLabel, code, id, subject        - activity columns
     *   smartformDescription, smartformName     - populated where a smartform
     *                                             exists for that activity
     *   attachmentDescription, attachmentName,
     *   revisionName                            - empty for now
     *   isOriginal, hasSmartform                - flags
     *
     * @param {string} contextActivityId - Activity id from the FSM context
     * @returns {Promise<{activities: Array<Object>, tables: Array<Object>}>}
     */
    async getActivityTreeWithSmartforms(contextActivityId) {
        try {
            const tree = await this.getActivityRevisionTree(contextActivityId);
            if (!tree || tree.length === 0) {
                return { activities: [], tables: [] };
            }

            // Shared activity lineage (already ordered: original, then revisions).
            const activities = tree.map(a => ({
                isOriginal: !!a.isOriginal,
                revisionLabel: a.revisionLabel,
                code: a.code != null ? a.code : '',
                id: a.id,
                subject: a.subject != null ? a.subject : ''
            }));

            // 1) Fetch Inspection smartforms for every activity, tag with activityId.
            const perActivity = await Promise.all(
                activities.map(async act => {
                    const sfs = await this.getInspectionSmartformsForActivity(act.id);
                    return (sfs || []).map(sf => ({ ...sf, activityId: act.id }));
                })
            );
            const allSmartforms = perActivity.flat();

            // 2) Index by id for chain resolution.
            const byId = new Map();
            allSmartforms.forEach(sf => byId.set(sf.id, sf));

            // 3) Tables are defined by root smartforms (previousChecklist === own id),
            //    ordered as they appear on the ORIGINAL activity.
            const originalActivityId = (activities.find(a => a.isOriginal) || {}).id;
            const roots = allSmartforms.filter(sf =>
                sf.activityId === originalActivityId &&
                (!sf.previousChecklist || sf.previousChecklist === sf.id)
            );

            // Build a table skeleton per root: one row per activity.
            const tableByRootId = new Map();
            const tables = roots.map(root => {
                const rowByActivityId = new Map();
                const rows = activities.map(act => {
                    const row = {
                        isOriginal: act.isOriginal,
                        revisionLabel: act.revisionLabel,
                        code: act.code,
                        id: act.id,
                        subject: act.subject,
                        smartformId: '',
                        smartformDescription: '',
                        smartformName: '',
                        attachmentDescription: '',
                        attachmentName: '',
                        revisionName: '',
                        hasSmartform: false
                    };
                    rowByActivityId.set(act.id, row);
                    return row;
                });
                const table = {
                    rootSmartformId: root.id,
                    smartformName: root.name || '',
                    smartformDescription: root.rawDescription || root.description || '',
                    rows: rows,
                    _rowByActivityId: rowByActivityId
                };
                tableByRootId.set(root.id, table);
                return table;
            });

            // 4) Place every smartform into its root's table, on its activity row.
            allSmartforms.forEach(sf => {
                const rootId = this._resolveRootChecklistId(sf.id, byId);
                if (!rootId) return;
                const table = tableByRootId.get(rootId);
                if (!table) return; // root not among original-activity roots
                const row = table._rowByActivityId.get(sf.activityId);
                if (!row) return; // smartform's activity not in this lineage
                // First smartform per activity row wins (shouldn't collide normally).
                if (!row.hasSmartform) {
                    row.smartformId = sf.id;
                    row.smartformDescription = sf.rawDescription || sf.description || '';
                    row.smartformName = sf.name || '';
                    row.hasSmartform = true;
                }
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

            // Drop internal helper map before returning.
            tables.forEach(t => { delete t._rowByActivityId; });

            return { activities, tables };
        } catch (error) {
            console.error('FSMService: Error building tree with smartforms:', error.message);
            return { activities: [], tables: [] };
        }
    }
}

module.exports = new FSMService();