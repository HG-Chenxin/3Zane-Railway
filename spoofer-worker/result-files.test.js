const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Module } = require('node:module');
const { PassThrough, Readable, Writable } = require('node:stream');
const test = require('node:test');

process.env.NODE_PATH = [
    process.env.NODE_PATH,
    path.join(__dirname, 'node_modules'),
].filter(Boolean).join(path.delimiter);
Module._initPaths();

const { createRobloxAssetBulkDownloadHandler } = require('../roblox-asset-download');

function createResponse() {
    const chunks = [];
    const response = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
    response.chunks = chunks;
    response.headers = {};
    response.status = (status) => {
        response.statusCode = status;
        return response;
    };
    response.setHeader = (name, value) => {
        response.headers[name.toLowerCase()] = value;
    };
    response.set = (name, value) => {
        response.setHeader(name, value);
        return response;
    };
    response.json = (payload) => {
        response.end(JSON.stringify(payload));
        return response;
    };
    return response;
}

test('keeps successful local assets downloadable when ZIP creation fails', async (t) => {
    const tempDirectory = await fs.mkdtemp(path.join(__dirname, '.result-files-test-'));
    t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));

    const progressId = '12345678-1234-4234-8234-123456789abc';
    const ownerKey = '123456789';
    const handler = createRobloxAssetBulkDownloadHandler({
        apiKey: 'test-api-key',
        downloaderUrl: 'http://downloader.example.invalid',
        tempDirectory,
        getOwnerKey: (req) => req.ownerKey,
        post: async () => ({
            status: 200,
            data: Readable.from([Buffer.from('asset bytes')]),
            headers: { 'x-asset-filename': 'asset.rbxm' },
        }),
        createArchive: () => {
            const archive = new PassThrough();
            archive.file = () => archive;
            archive.append = () => archive;
            archive.finalize = async () => archive.end(Buffer.from('incomplete archive'));
            return archive;
        },
    });
    const response = createResponse();
    await handler({
        body: { asset_ids: ['12345', '67890'], roblox_cookie: 'test-cookie' },
        headers: { 'x-api-key': 'test-api-key', 'x-progress-id': progressId },
        ownerKey,
        once() {},
        removeListener() {},
    }, response);

    assert.equal(response.statusCode, 202);
    let progress;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const progressResponse = createResponse();
        handler.getProgress({ params: { progressId }, ownerKey }, progressResponse);
        progress = JSON.parse(Buffer.concat(progressResponse.chunks).toString('utf8'));
        if (progress.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(progress.state, 'failed', JSON.stringify(progress));
    assert.equal(progress.assets[0].status, 'success');
    const assetResponse = createResponse();
    await handler.getAsset({ params: { progressId, assetId: '12345' }, ownerKey }, assetResponse);
    assert.equal(assetResponse.statusCode, 200);
    assert.equal(Buffer.concat(assetResponse.chunks).toString(), 'asset bytes');
});
