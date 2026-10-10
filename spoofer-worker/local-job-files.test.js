const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    removeLocalJobFiles,
    resolveLocalJobFile,
    serializeLocalJobFiles,
} = require('./local-job-files');

test('serializes and resolves files under an isolated Spoofer job directory', async (t) => {
    const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), '3zane-spoofer-files-test-'));
    t.after(() => fs.rm(baseDirectory, { recursive: true, force: true }));
    const directory = await fs.mkdtemp(path.join(baseDirectory, '3zane-roblox-spoofer-'));
    const archivePath = path.join(directory, 'roblox-spoofer-assets.zip');
    const assetPath = path.join(directory, '0.asset');
    await fs.writeFile(archivePath, 'zip');
    await fs.writeFile(assetPath, 'asset');

    const localFiles = serializeLocalJobFiles({
        tempDir: directory,
        archivePath,
        assetPaths: new Map([['123', assetPath]]),
    });

    assert.equal(
        resolveLocalJobFile(baseDirectory, localFiles, localFiles.archive),
        archivePath,
    );
    assert.equal(
        resolveLocalJobFile(baseDirectory, localFiles, localFiles.assets['123']),
        assetPath,
    );
    assert.equal(resolveLocalJobFile(baseDirectory, localFiles, '../outside'), null);
    assert.equal(resolveLocalJobFile(baseDirectory, { directory: '../outside' }, 'file.zip'), null);

    await removeLocalJobFiles(baseDirectory, localFiles.directory);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('does not remove directories outside the Spoofer job namespace', async () => {
    await assert.rejects(
        removeLocalJobFiles(os.tmpdir(), 'other-data'),
        /Refusing to clean up a Spoofer directory/,
    );
});
