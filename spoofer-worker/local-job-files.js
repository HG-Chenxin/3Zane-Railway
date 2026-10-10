const fs = require('node:fs/promises');
const path = require('node:path');

const JOB_DIRECTORY_PREFIX = '3zane-roblox-spoofer-';

function serializeLocalJobFiles(job) {
    if (!job.tempDir) return null;
    return {
        directory: path.basename(job.tempDir),
        archive: job.archivePath ? path.relative(job.tempDir, job.archivePath) : null,
        assets: Object.fromEntries(
            [...job.assetPaths].map(([assetId, filePath]) => [assetId, path.relative(job.tempDir, filePath)]),
        ),
    };
}

function resolveJobDirectory(baseDirectory, directory) {
    if (typeof directory !== 'string'
        || path.basename(directory) !== directory
        || !directory.startsWith(JOB_DIRECTORY_PREFIX)) {
        return null;
    }
    const basePath = path.resolve(baseDirectory);
    const jobPath = path.resolve(basePath, directory);
    if (path.dirname(jobPath) !== basePath) return null;
    return jobPath;
}

function resolveLocalJobFile(baseDirectory, localFiles, relativeFile) {
    const jobDirectory = resolveJobDirectory(baseDirectory, localFiles?.directory);
    if (!jobDirectory
        || typeof relativeFile !== 'string'
        || !relativeFile
        || path.isAbsolute(relativeFile)) {
        return null;
    }

    const filePath = path.resolve(jobDirectory, relativeFile);
    const relativePath = path.relative(jobDirectory, filePath);
    if (!relativePath
        || relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)) {
        return null;
    }
    return filePath;
}

async function removeLocalJobFiles(baseDirectory, directory) {
    const jobDirectory = resolveJobDirectory(baseDirectory, directory);
    if (!jobDirectory) {
        throw new Error('Refusing to clean up a Spoofer directory outside the configured file storage.');
    }
    await fs.rm(jobDirectory, { recursive: true, force: true });
}

module.exports = { removeLocalJobFiles, resolveLocalJobFile, serializeLocalJobFiles };
