const express = require('express');
const ReferenceFileService = require('../../src/services/ReferenceFileService');
const { buildOperationGuard } = require('../server/security');

module.exports = function registerReferenceFileRoutes(server) {
    const router = express.Router();
    const requireReferenceAdmin = buildOperationGuard(server, 'reference_file_operation');

    function ensureLocalFileAccess(req, res) {
        if (server.isLocalRequest(req)) return true;
        res.status(403).json({ error: 'Reference files are only available from the local dashboard.' });
        return false;
    }

    function handleError(res, error) {
        const status = error && error.statusCode ? error.statusCode : 500;
        return res.status(status).json({ error: error.message || String(error) });
    }

    router.get('/api/reference-files', (req, res) => {
        try {
            return res.json({ files: ReferenceFileService.list() });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.get('/api/reference-files/browse', requireReferenceAdmin, (req, res) => {
        if (!ensureLocalFileAccess(req, res)) return;
        try {
            return res.json(ReferenceFileService.browse(req.query.path));
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.post('/api/reference-files', requireReferenceAdmin, (req, res) => {
        if (!ensureLocalFileAccess(req, res)) return;
        try {
            const { path, name, description, tags } = req.body || {};
            if (!path) return res.status(400).json({ error: 'Missing path.' });
            const result = ReferenceFileService.addPath(path, { name, description, tags });
            return res.json({ success: true, ...result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.patch('/api/reference-files/:id', requireReferenceAdmin, (req, res) => {
        try {
            const file = ReferenceFileService.update(req.params.id, req.body || {});
            if (!file) return res.status(404).json({ error: 'Reference file not found.' });
            return res.json({ success: true, file });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.post('/api/reference-files/:id/reindex', requireReferenceAdmin, (req, res) => {
        if (!ensureLocalFileAccess(req, res)) return;
        try {
            const file = ReferenceFileService.indexFile(req.params.id);
            return res.json({ success: true, file });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.post('/api/reference-files/reindex-all', requireReferenceAdmin, (req, res) => {
        if (!ensureLocalFileAccess(req, res)) return;
        try {
            return res.json({ success: true, files: ReferenceFileService.reindexAll() });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.delete('/api/reference-files/:id', requireReferenceAdmin, (req, res) => {
        try {
            const removed = ReferenceFileService.remove(req.params.id);
            if (!removed) return res.status(404).json({ error: 'Reference file not found.' });
            return res.json({ success: true });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.post('/api/reference-files/batch-delete', requireReferenceAdmin, (req, res) => {
        try {
            const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
            const result = ReferenceFileService.removeMany(ids);
            return res.json({ success: true, ...result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.get('/api/reference-files/search', (req, res) => {
        try {
            const query = String(req.query.query || '');
            const limit = Number(req.query.limit || 5);
            return res.json({ results: ReferenceFileService.search(query, { limit }) });
        } catch (error) {
            return handleError(res, error);
        }
    });

    router.get('/api/reference-files/:id/read', (req, res) => {
        if (!ensureLocalFileAccess(req, res)) return;
        try {
            const maxChars = Number(req.query.maxChars || 12000);
            const file = ReferenceFileService.read(req.params.id, { maxChars });
            if (!file) return res.status(404).json({ error: 'Reference file not found.' });
            return res.json({ file });
        } catch (error) {
            return handleError(res, error);
        }
    });

    return router;
};
