import { writeFileSync, createReadStream, statSync } from "node:fs";
// cos-nodejs-sdk-v5 ships CommonJS; default-import the constructor.
import COS from "cos-nodejs-sdk-v5";
import { config } from "./config.js";

/**
 * Thin Tencent COS wrapper. Each job stores two objects:
 *   jobs/<jobId>/input.zip   (uploaded project)
 *   jobs/<jobId>/output.zip  (optimized result)
 * Downloads are served to the browser via a short-lived presigned GET URL.
 */

const { secretId, secretKey, bucket, region } = config.cos;

export const cosEnabled = Boolean(secretId && secretKey && bucket);

const cos = cosEnabled ? new COS({ SecretId: secretId, SecretKey: secretKey }) : null;

export const inputKey = (jobId: string) => `jobs/${jobId}/input.zip`;
export const outputKey = (jobId: string) => `jobs/${jobId}/output.zip`;

function ensure(): COS {
  if (!cos) throw new Error("COS is not configured (set COS_SECRET_ID/KEY/BUCKET).");
  return cos;
}

/** Upload a local file to COS. */
export function putFile(key: string, filePath: string): Promise<void> {
  const client = ensure();
  return new Promise((resolve, reject) => {
    client.putObject(
      {
        Bucket: bucket,
        Region: region,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: statSync(filePath).size,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** Download a COS object to a local file. */
export function getToFile(key: string, filePath: string): Promise<void> {
  const client = ensure();
  return new Promise((resolve, reject) => {
    client.getObject({ Bucket: bucket, Region: region, Key: key }, (err, data) => {
      if (err) return reject(err);
      writeFileSync(filePath, data.Body as Buffer);
      resolve();
    });
  });
}

/** Short-lived presigned GET URL for direct browser download. */
export function presignedGetUrl(key: string, expiresSeconds = 3600): Promise<string> {
  const client = ensure();
  return new Promise((resolve, reject) => {
    client.getObjectUrl(
      { Bucket: bucket, Region: region, Key: key, Sign: true, Expires: expiresSeconds },
      (err, data) => (err ? reject(err) : resolve(data.Url)),
    );
  });
}
