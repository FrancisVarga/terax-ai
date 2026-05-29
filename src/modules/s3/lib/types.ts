/**
 * Wire types for the `s3_*` Rust commands plus a key→preview-format helper.
 *
 * The Rust side serializes its structs with serde's *default* field naming, so
 * the keys arrive over IPC in snake_case (`force_path_style`, `is_prefix`, …) —
 * these types mirror those names exactly. Do NOT rename them to camelCase: a
 * mismatch would silently read `undefined` at runtime.
 */

/**
 * A saved S3 connection profile. Mirrors the Rust `S3Connection` struct
 * field-for-field. Credentials are NOT part of this type — they're stored
 * out-of-band by the backend and passed separately on save.
 */
export type S3Connection = {
  id: string;
  name: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (MinIO, R2, …); null = AWS. */
  endpoint: string | null;
  /** MinIO-style path addressing (`endpoint/bucket`) vs virtual-host style. */
  force_path_style: boolean;
  /** Optional default bucket. When set, the tree can skip the bucket-list step. */
  bucket: string | null;
};

/**
 * One row returned by `s3_list`. When listing buckets (empty `bucket` arg) each
 * entry is a bucket: `is_prefix` is true and `key` holds the bucket name.
 * Otherwise entries are the immediate children of a prefix under the "/"
 * delimiter — `is_prefix` true for sub-prefixes ("folders"), false for objects.
 */
export type S3Entry = {
  name: string;
  key: string;
  is_prefix: boolean;
  /** Object byte size; null for prefixes and buckets. */
  size: number | null;
};

/** Credentials supplied alongside a connection on save. */
export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
};

/** Wire shape of `s3_get_object_bytes`. `base64` is the raw object bytes. */
export type S3ObjectBytes = {
  base64: string;
  content_type: string | null;
  size: number;
};

/**
 * Preview formats S3 objects can be rendered as. The tabular trio
 * (sqlite/csv/parquet) feeds the AG Grid data preview; json/image/pdf get
 * dedicated viewers; everything else is `null` (no preview).
 */
export type S3Format =
  | "sqlite"
  | "csv"
  | "parquet"
  | "json"
  | "image"
  | "pdf";

/**
 * Map an object key (or any path) to a previewable format, or `null` if we
 * have no viewer for it. Single source of truth for "can S3 preview this key".
 * Matches `dataFormatForPath` from `@/modules/data` for the tabular trio and
 * extends it with json/image/pdf.
 */
export function s3FormatForKey(key: string): S3Format | null {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "sqlite":
    case "sqlite3":
    case "db":
      return "sqlite";
    case "csv":
      return "csv";
    case "parquet":
    case "pq":
      return "parquet";
    case "json":
      return "json";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "bmp":
    case "ico":
      return "image";
    case "pdf":
      return "pdf";
    default:
      return null;
  }
}
