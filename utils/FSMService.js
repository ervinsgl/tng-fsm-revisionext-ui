/**
 * FSMService.js
 *
 * Backend service for SAP FSM (Field Service Management) API integration.
 *
 * Scope (revision extension):
 * - Authenticated Query API requests (/api/query/v1)
 * - Read closed ChecklistInstances (smartforms) for an Activity
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

    // ========================================
    // CHECKLIST INSTANCES (SMARTFORMS)
    // ========================================

    /**
     * Get all closed ChecklistInstances (smartforms) for an Activity.
     *
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<{id: string, description: string}>>}
     *          List shaped for the UI. `description` falls back to the ID
     *          when the source description is empty.
     */
    async getChecklistInstancesForActivity(objectId) {
        try {
            if (!objectId) return [];

            const query = `SELECT w FROM ChecklistInstance w WHERE w.object.objectId = '${objectId}' AND w.closed = true`;
            const data = await this.makeQueryRequest(query, 'ChecklistInstance.20');

            if (!data.data || data.data.length === 0) return [];

            return data.data.map(item => {
                const w = item.w;
                const desc = (w.description && w.description.trim()) ? w.description.trim() : null;
                return {
                    id: w.id,
                    // Smartform Description: real description, else fall back to the ID.
                    description: desc ? `${desc} (${w.id})` : w.id
                };
            });
        } catch (error) {
            console.error('FSMService: Error fetching checklist instances:', error.message);
            return [];
        }
    }
}

module.exports = new FSMService();