const fs = require('node:fs');
const { stat } = require('node:fs/promises');
const { DeleteObjectCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const RAILWAY_BUCKET_ENV = [
    'RAILWAY_BUCKET_ENDPOINT',
    'RAILWAY_BUCKET_NAME',
    'RAILWAY_BUCKET_ACCESS_KEY_ID',
    'RAILWAY_BUCKET_SECRET_ACCESS_KEY',
];

function createRailwayObjectStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region = 'auto',
    client,
}) {
    const config = { endpoint, bucket, accessKeyId, secretAccessKey, region };
    const missing = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']
        .filter((key) => !String(config[key] || '').trim());
    if (missing.length) {
        throw new Error(`Railway Bucket configuration is incomplete: ${missing.join(', ')}.`);
    }

    const s3 = client || new S3Client({
        endpoint: config.endpoint,
        region: config.region || 'auto',
        forcePathStyle: true,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });

    function objectInput(key) {
        return { Bucket: config.bucket, Key: key };
    }

    return {
        async uploadFile(filePath, key, contentType) {
            const { size } = await stat(filePath);
            const Body = fs.createReadStream(filePath);
            await s3.send(new PutObjectCommand({
                ...objectInput(key),
                Body,
                ContentLength: size,
                ContentType: contentType,
            }));
        },
        getObject(key, range) {
            return s3.send(new GetObjectCommand({
                ...objectInput(key),
                ...(range ? { Range: range } : {}),
            }));
        },
        async deleteObject(key) {
            await s3.send(new DeleteObjectCommand(objectInput(key)));
        },
        async exists(key) {
            try {
                await s3.send(new HeadObjectCommand(objectInput(key)));
                return true;
            } catch (error) {
                if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                    return false;
                }
                throw error;
            }
        },
    };
}

function createRailwayObjectStorageFromEnv(env = process.env) {
    const values = {
        endpoint: (env.RAILWAY_BUCKET_ENDPOINT || '').trim(),
        bucket: (env.RAILWAY_BUCKET_NAME || '').trim(),
        accessKeyId: (env.RAILWAY_BUCKET_ACCESS_KEY_ID || '').trim(),
        secretAccessKey: (env.RAILWAY_BUCKET_SECRET_ACCESS_KEY || '').trim(),
        region: (env.RAILWAY_BUCKET_REGION || 'auto').trim(),
    };
    const configuredCount = RAILWAY_BUCKET_ENV
        .filter((name) => String(env[name] || '').trim()).length;

    if (configuredCount === 0) return null;

    const missing = RAILWAY_BUCKET_ENV.filter((name) => !String(env[name] || '').trim());
    if (missing.length) {
        throw new Error(`Railway Bucket is partially configured. Set: ${missing.join(', ')}.`);
    }

    return createRailwayObjectStorage(values);
}

module.exports = { createRailwayObjectStorage, createRailwayObjectStorageFromEnv };
