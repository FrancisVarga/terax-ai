import type { DataTab } from "@/modules/tabs";

export { DataStack } from "./DataStack";

/**
 * Map a file path to a previewable tabular format, or `null` if it isn't one.
 * Single source of truth for "is this a data file" — used by the explorer to
 * gate the context-menu item and by App routing to decide click behavior.
 */
export function dataFormatForPath(path: string): DataTab["format"] | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
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
    default:
      return null;
  }
}
