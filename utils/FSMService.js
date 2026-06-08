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
        const query = `SELECT w FROM ChecklistInstance w WHERE w.object.objectId = '${objectId}' AND w.closed = true`;
        const data = await this.makeQueryRequest(query, 'ChecklistInstance.20');

        if (!data.data || data.data.length === 0) return [];

        return data.data.map(item => {
            const w = item.w;
            const desc = (w.description && w.description.trim()) ? w.description.trim() : null;
            return {
                id: w.id,
                // Smartform Description: real description, else fall back to the ID.
                description: desc ? `${desc} (${w.id})` : w.id,
                template: w.template || null
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
}

module.exports = new FSMService();