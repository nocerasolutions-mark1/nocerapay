"use strict";
// Product photos and the bank QR image live in a Railway Bucket (S3-compatible).
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const cfg = {
  endpoint: process.env.ENDPOINT,
  region: process.env.REGION || "auto",
  bucket: process.env.BUCKET,
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
};
const enabled = !!(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
if (!enabled) console.warn("Bucket variables (ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY) are missing. Photo uploads are off.");

const s3 = enabled ? new S3Client({
  endpoint: cfg.endpoint,
  region: cfg.region,
  forcePathStyle: process.env.BUCKET_PATH_STYLE === "true",
  credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
}) : null;

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function putImage(buf, contentType) {
  if (!enabled) throw Object.assign(new Error("Photo storage isn’t set up. Add a Railway Bucket to the project."), { status: 503 });
  const ext = TYPES[contentType];
  if (!ext) throw Object.assign(new Error("Use a JPG, PNG or WebP image."), { status: 415 });
  const key = `photos/${crypto.randomBytes(12).toString("hex")}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: buf, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }));
  return key;
}

async function streamImage(key, res) {
  if (!enabled || !/^photos\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(key)) return res.status(404).end();
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    res.setHeader("Content-Type", out.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    out.Body.pipe(res);
  } catch (e) {
    res.status(e.$metadata && e.$metadata.httpStatusCode === 404 ? 404 : 502).end();
  }
}

module.exports = { enabled, putImage, streamImage };
