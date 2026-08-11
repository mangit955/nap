/**
 * `ObjectStore` over Cloudflare R2.
 *
 * R2 speaks the S3 API, so this is the AWS S3 client pointed at an R2 endpoint with the region
 * fixed to `auto` — R2 has no regions, and the signature requires one anyway. Nothing about the
 * bucket is special: the port's whole surface is put, get and delete by key.
 *
 * **The SDK is injected as a narrow three-method client**, the same shape `E2BSandboxManager`
 * uses. What is worth testing here is the error mapping, and the mapping is the part a network
 * cannot be asked about on demand — a stub that throws exactly the failure under discussion
 * makes each case a two-line test instead of an unreproducible one.
 *
 * The distinction the mapping exists to preserve: **an object that is not there and a store
 * that cannot be reached are different answers.** Restoring a project falls back to a fresh
 * template for the first and refuses to open for the second, because a fresh template handed
 * out during an outage invites the next teardown to overwrite a good snapshot with nothing.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ObjectStore, ObjectStoreError } from "@nap/shared/ports/object-store";
import type { Result, VoidResult } from "@nap/shared/result";

/** Exactly what this adapter asks of an object store, and nothing the SDK adds around it. */
export type R2Client = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Throws when the key is absent; the store below is what turns that into a value. */
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
};

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** R2 gives every account one endpoint; the bucket is a path within it, not a hostname. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function createR2Client(config: R2Config): R2Client {
  const client = new S3Client({
    // R2 has no regions, but SigV4 signs one in, and `auto` is what Cloudflare documents.
    region: "auto",
    endpoint: r2Endpoint(config.accountId),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async put(key, bytes) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes }));
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (response.Body === undefined) {
        throw new Error(`R2 returned no body for ${key}`);
      }
      return await response.Body.transformToByteArray();
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

export class R2ObjectStore implements ObjectStore {
  readonly #client: R2Client;

  constructor(client: R2Client) {
    this.#client = client;
  }

  async put(key: string, bytes: Uint8Array): Promise<VoidResult<ObjectStoreError>> {
    try {
      await this.#client.put(key, bytes);
      return { ok: true, value: undefined };
    } catch (cause) {
      return { ok: false, error: toObjectStoreError(cause) };
    }
  }

  async get(key: string): Promise<Result<Uint8Array, ObjectStoreError>> {
    try {
      return { ok: true, value: await this.#client.get(key) };
    } catch (cause) {
      return { ok: false, error: toObjectStoreError(cause) };
    }
  }

  async delete(key: string): Promise<VoidResult<ObjectStoreError>> {
    try {
      await this.#client.delete(key);
      return { ok: true, value: undefined };
    } catch (cause) {
      // Already gone is the outcome the caller wanted. Reporting it as a failure would make
      // deleting a project fail on the one snapshot that had already been cleaned up.
      if (toObjectStoreError(cause).code === "not_found") return { ok: true, value: undefined };
      return { ok: false, error: toObjectStoreError(cause) };
    }
  }
}

/**
 * Matched on `name` and HTTP status rather than `instanceof`.
 *
 * The SDK raises `NoSuchKey` for a missing object and `NotFound` for a missing head — two
 * classes with one meaning — and both carry a 404. Reading the status as well as the name means
 * a third class with the same meaning does not need this function edited to be understood.
 */
function toObjectStoreError(cause: unknown): ObjectStoreError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "";
  const status =
    typeof cause === "object" && cause !== null && "$metadata" in cause
      ? (cause.$metadata as { httpStatusCode?: number }).httpStatusCode
      : undefined;

  if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
    return { code: "not_found", message };
  }

  return { code: "unavailable", message };
}
